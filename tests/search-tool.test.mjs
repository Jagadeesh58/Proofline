import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/memory/store.mjs';
import { runWebSearch, ToolInputError, resolveTargetNewsSince } from '../src/search/tool.mjs';
import { buildComparisonCards } from '../src/evidence/compare.mjs';

function withStore(run) {
  const store = new Store(':memory:');
  const turn = store.createTurn({ userText: 'A search test', timezone: 'Asia/Kolkata' });
  try { return run(store, turn); }
  catch (error) { store.close(); throw error; }
}

const pageText = 'Pricing page. HubSpot Starter is $20 per user per month. Billed annually. '.repeat(6);

 test('preflights free-query extracts, extracts in parallel and respects the per-query cap', async () => {
  await withStore(async (store, turn) => {
    let active = 0;
    let maximumActive = 0;
    let searchCalls = 0;
    const budget = { searches: 0, extracts: 0, geminiCalls: 0 };
    const result = await runWebSearch({
      rawInput: { queries: ['one', 'two', 'three', 'four'].map((q) => ({ q })) },
      store, turnId: turn.id, timezone: 'Asia/Kolkata', budget,
      searchFn: async ({ q }) => {
        searchCalls += 1;
        return { results: [{ url: `https://${q}.example.com/pricing`, title: `${q} pricing`, content: 'pricing result', score: 0.9 }] };
      },
      extractFn: async (url) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return { results: [{ url, raw_content: pageText }] };
      },
    });
    assert.equal(searchCalls, 4);
    assert.equal(budget.searches, 4);
    assert.equal(budget.extracts, 4);
    assert.ok(maximumActive > 1);
    assert.equal(result.sources.filter((item) => item.retrieval_kind === 'page_text').length, 4);
    store.close();
  });
});

test('rejects an over-budget free-query request before any provider call', async () => {
  await withStore(async (store, turn) => {
    let calls = 0;
    const budget = { searches: 0, extracts: 7, geminiCalls: 0 };
    await assert.rejects(() => runWebSearch({
      rawInput: { queries: [{ q: 'first' }, { q: 'second' }] },
      store, turnId: turn.id, timezone: 'Asia/Kolkata', budget,
      searchFn: async () => { calls += 1; return { results: [] }; },
      extractFn: async () => { calls += 1; return { results: [] }; },
    }), ToolInputError);
    assert.equal(calls, 0);
    assert.equal(budget.searches, 0);
    assert.equal(budget.extracts, 7);
    store.close();
  });
});

test('a failed baseline URL does not trigger an additional search', async () => {
  await withStore(async (store, turn) => {
    const old = store.importTurn({ user_text: 'HubSpot pricing', assistant_text: 'Starter costs $20 per user per month.', created_at: '2026-10-20T08:00:00Z' });
    store.updateTurn(old.id, { status: 'completed', claims_status: 'done' });
    const source = store.addSource({
      turnId: old.id, url: 'https://hubspot.com/old-pricing', domain: 'hubspot.com', title: 'HubSpot pricing',
      pageText: pageText, retrievalKind: 'page_text', pageTextOrigin: 'extract', retrievedAt: '2026-10-20T08:00:00Z',
    });
    store.addClaim({
      turn_id: old.id, entity_key: 'hubspot', attribute: 'price', plan_key: 'starter',
      value_text: '$20 per user per month', amount: 20, currency: 'USD', price_unit: 'per_seat', period: 'month',
      commitment: 'unknown', qualifiers: [], evidence_quote: 'Starter costs $20 per user per month.', source_id: source.id,
      observed_at_utc: '2026-10-20T08:00:00Z', baseline_basis: 'page_text',
    });
    let searches = 0;
    let extracts = 0;
    const budget = { searches: 0, extracts: 0, geminiCalls: 0 };
    await runWebSearch({
      rawInput: { targets: [{ entity: 'HubSpot', checks: ['pricing'] }] },
      store, turnId: turn.id, timezone: 'Asia/Kolkata', budget,
      searchFn: async ({ q }) => {
        searches += 1;
        return { results: [{ url: 'https://hubspot.com/new-pricing', title: q, content: 'new pricing' }] };
      },
      extractFn: async (url) => {
        extracts += 1;
        if (url.includes('old-pricing')) return { results: [] };
        return { results: [{ url, raw_content: pageText }] };
      },
    });
    assert.equal(searches, 0);
    assert.equal(extracts, 1);
    assert.equal(budget.searches, 0);
    assert.equal(budget.extracts, 1);
    store.close();
  });
});

test('uses separate explicit and baseline dates for each entity', () => {
  const claims = [
    { entity_key: 'hubspot', observed_at_utc: '2026-11-09T10:00:00Z', source_created_at_utc: '2026-11-03T10:00:00Z' },
    { entity_key: 'neon', observed_at_utc: '2026-11-10T10:00:00Z', source_created_at_utc: '2026-11-10T10:00:00Z' },
  ];
  const hubspot = resolveTargetNewsSince({ entity: 'HubSpot', checks: ['news'], since: '2026-11-01' }, [], 'Asia/Kolkata', '2026-11-12', { baselineClaims: claims });
  const neon = resolveTargetNewsSince({ entity: 'Neon', checks: ['news'], since: '2026-11-01' }, [], 'Asia/Kolkata', '2026-11-12', { baselineClaims: claims });
  assert.equal(hubspot.since, '2026-11-03');
  assert.equal(neon.since, '2026-11-10');
  const explicit = resolveTargetNewsSince({ entity: 'HubSpot', checks: ['news'], since: '2026-11-01' }, [], 'Asia/Kolkata', '2026-11-12', { explicitSince: '2026-11-11', baselineClaims: claims });
  assert.equal(explicit.since, '2026-11-11');
  assert.equal(explicit.baselineSince, '2026-11-03');
  assert.equal(explicit.explicitSince, '2026-11-11');
});

test('ignores unrelated recalled turns when choosing a target news baseline', () => {
  const result = resolveTargetNewsSince({ entity: 'Neon', checks: ['news'], since: '2026-11-01' }, [{
    origin: 'live', user_text: 'We discussed HubSpot CRM pricing.', assistant_text: 'HubSpot costs...', created_at_utc: '2026-11-11T20:00:00Z',
  }], 'Asia/Kolkata', '2026-11-12');
  assert.equal(result.since, '2026-11-01');
  assert.equal(result.baselineSince, null);
});

test('labels a target source by its URL rather than a matching article title', async () => {
  await withStore(async (store, turn) => {
    const budget = { searches: 0, extracts: 0, geminiCalls: 0 };
    const result = await runWebSearch({
      rawInput: { targets: [{ entity: 'HubSpot', checks: ['pricing'] }] },
      store, turnId: turn.id, timezone: 'Asia/Kolkata', budget,
      searchFn: async () => ({ results: [{ url: 'https://review-blog.example/hubspot-pricing', title: 'HubSpot pricing review', content: 'HubSpot pricing' }] }),
      extractFn: async (url) => ({ results: [{ url, raw_content: pageText }] }),
    });
    const source = result.sources.find((item) => item.retrieval_kind === 'page_text');
    assert.equal(result.sourceTrust[source.source_id], 'Third party');
    store.close();
  });
});

test('assigns source citation order deterministically for tied timestamps', () => {
  withStore((store, turn) => {
    for (let index = 0; index < 20; index += 1) {
      store.addSource({
        turnId: turn.id, url: `https://example${index}.com/`, domain: `example${index}.com`, title: `Source ${index}`,
        snippetText: 'snippet', retrievalKind: 'snippet', retrievedAt: '2026-11-12T10:00:00.000Z',
      });
    }
    assert.deepEqual(store.getSources(turn.id).map((item) => item.title), Array.from({ length: 20 }, (_, index) => `Source ${index}`));
    store.close();
  });
});

test('expands independent pricing and limit checks into separate search queries', async () => {
  await withStore(async (store, turn) => {
    const queries = [];
    const budget = { searches: 0, extracts: 0, geminiCalls: 0 };
    await runWebSearch({
      rawInput: { targets: [{ entity: 'Acme Cloud', checks: ['pricing', 'limit'] }] },
      store, turnId: turn.id, timezone: 'Asia/Kolkata', budget,
      searchFn: async ({ q }) => {
        queries.push(q);
        return { results: [{ url: 'https://acmecloud.com/pricing', title: 'Acme Cloud pricing and limits', content: 'Pricing and limits.' }] };
      },
      extractFn: async (url) => ({ results: [{ url, raw_content: 'Acme Cloud pricing and plan limits. '.repeat(10) }] }),
    });
    assert.deepEqual(queries, ['Acme Cloud pricing', 'Acme Cloud plan limits']);
    assert.equal(budget.searches, 2);
    store.close();
  });
});

test('uses the earlier real generation date when an explicit since date hides the gap', async () => {
  const recalled = [{
    origin: 'imported', user_text: 'We discussed HubSpot pricing.', assistant_text: 'HubSpot Starter costs $20 per user.',
    created_at_utc: '2026-11-09T10:00:00.000Z', source_created_at_utc: '2026-10-20T10:00:00.000Z',
  }];
  const resolved = resolveTargetNewsSince({ entity: 'HubSpot', checks: ['news'], since: '2026-11-09' }, recalled,
    'Asia/Kolkata', '2026-11-13', { explicitSince: '2026-11-09' });
  assert.equal(resolved.since, '2026-10-20');
  assert.equal(resolved.explicitSince, '2026-11-09');
  assert.match(resolved.generationGapText, /20 Oct \(24 days ago\)/);

  await withStore(async (store, turn) => {
    let searchSince = null;
    const result = await runWebSearch({
      rawInput: { targets: [{ entity: 'HubSpot', checks: ['news'], since: '2026-11-09' }] },
      store, turnId: turn.id, timezone: 'Asia/Kolkata', recallTurns: recalled,
      explicitSince: '2026-11-09', budget: { searches: 0, extracts: 0, geminiCalls: 0 },
      today: '2026-11-13',
      searchFn: async ({ since }) => {
        searchSince = since;
        return { results: [{ url: 'https://hubspot.com/news/launch', title: 'HubSpot launch', content: 'Launch announced', raw_content: 'HubSpot launch announcement. '.repeat(12) }] };
      },
      extractFn: async () => ({ results: [] }),
    });
    assert.equal(searchSince, '2026-10-20');
    assert.match(result.targets[0].earlier_answer_gap, /20 Oct \(24 days ago\)/);
    store.close();
  });
});


test('does not turn an imported display date into a generation-date news window', () => {
  const unknown = {
    origin: 'imported', user_text: 'Compare HubSpot pricing.',
    assistant_text: 'HubSpot Starter costs $15 per user per month.',
    created_at_utc: '2026-11-09T10:00:00.000Z', source_created_at_utc: null,
  };
  const baseline = {
    entity_key: 'hubspot', origin: 'imported', source_created_at_utc: null,
    created_at_utc: unknown.created_at_utc, observed_at_utc: unknown.created_at_utc,
  };
  const automatic = resolveTargetNewsSince({ entity: 'HubSpot', since: null }, [unknown], 'Asia/Kolkata', '2026-11-13', { baselineClaims: [baseline] });
  assert.equal(automatic.since, null);
  assert.equal(automatic.unavailableReason, 'generation_date_unknown');
  assert.equal(automatic.generationGapText, undefined);

  const explicit = resolveTargetNewsSince({ entity: 'HubSpot', since: null }, [unknown], 'Asia/Kolkata', '2026-11-13', {
    explicitSince: '2026-11-10', baselineClaims: [baseline],
  });
  assert.equal(explicit.since, '2026-11-10');
  assert.equal(explicit.generationGapText, undefined);
});


test('demo history uses its generation date for a since window and reports a later release', () => {
  const store = new Store(':memory:');
  try {
    const demo = store.importTurn({
      user_text: 'HubSpot shortlist and pricing',
      assistant_text: 'Earlier HubSpot answer',
      created_at: '2026-11-09T08:30:00.000Z',
      source_created_at: '2026-10-20T08:30:00.000Z',
      timezone: 'Asia/Kolkata',
      demo: true,
    });
    assert.equal(demo.local_date, '2026-11-09');
    assert.equal(demo.source_created_at_utc, '2026-10-20T08:30:00.000Z');

    const resolved = resolveTargetNewsSince(
      { entity: 'HubSpot', checks: ['news'], since: '2026-11-09' },
      [demo],
      'Asia/Kolkata',
      '2026-11-13',
      { explicitSince: '2026-11-09' },
    );
    assert.equal(resolved.since, '2026-10-20');
    assert.match(resolved.generationGapText, /20 Oct \(24 days ago\)/);

    const currentTurn = store.createTurn({
      userText: 'Has HubSpot shipped anything since 20 October?',
      timezone: 'Asia/Kolkata',
      now: new Date('2026-11-12T10:00:00.000Z'),
    });
    const source = store.addSource({
      turnId: currentTurn.id,
      url: 'https://hubspot.com/changelog/feature',
      domain: 'hubspot.com',
      title: 'HubSpot feature launch',
      providerDate: '2026-11-05',
      pageText: 'HubSpot released a new reporting feature on 5 November 2026.',
      retrievalKind: 'page_text',
      pageTextOrigin: 'extract',
      retrievedAt: '2026-11-12T10:00:00.000Z',
    });
    const releaseClaim = store.addClaim({
      turn_id: currentTurn.id,
      entity_key: 'hubspot',
      attribute: 'release',
      plan_key: 'unspecified',
      value_text: 'New reporting feature',
      price_unit: 'none',
      period: 'unknown',
      commitment: 'unknown',
      qualifiers: [],
      evidence_quote: 'HubSpot released a new reporting feature on 5 November 2026.',
      source_id: source.id,
      observed_at_utc: '2026-11-12T10:00:00.000Z',
      baseline_basis: 'page_text',
    });
    const [group] = buildComparisonCards({
      store,
      targets: [{ entity: 'HubSpot', entity_key: 'hubspot', checks: ['news'], since: resolved.since, page: null }],
      currentClaims: [releaseClaim],
      baselineClaims: [],
      sinceByEntity: { hubspot: resolved.since },
    });
    assert.equal(group.reported_since_label, 'Reported since 2026-10-20');
    assert.deepEqual(group.reported.map((item) => item.date), ['2026-11-05']);
    assert.equal(group.reported[0].title, 'HubSpot feature launch');
  } finally {
    store.close();
  }
});
