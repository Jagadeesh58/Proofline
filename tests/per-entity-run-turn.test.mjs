import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.GEMINI_API_KEY = 'per-entity-test-key';
process.env.TAVILY_API_KEY = '';
process.env.SEARCH_BACKEND = 'replay';
process.env.EXTRACTION_MODE = 'per_entity';
process.env.GEMINI_REQUESTS_PER_MINUTE = '600';
process.env.GEMINI_MODEL = 'gemini-per-entity-test';

const [{ Store }, { runTurn }, { getReplayCorpus }, { config }] = await Promise.all([
  import('../src/memory/store.mjs?per-entity'),
  import('../src/agent/run-turn.mjs?per-entity'),
  import('../src/search/replay.mjs?per-entity'),
  import('../src/config.mjs?per-entity'),
]);

function eventStream(parts) {
  const payload = { candidates: [{ content: { role: 'model', parts } }] };
  return new Response(`data: ${JSON.stringify(payload)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

const TARGETS = [
  { entity: 'HubSpot', checks: ['pricing'] },
  { entity: 'Pipedrive', checks: ['pricing'] },
  { entity: 'Neon', checks: ['pricing'] },
  { entity: 'Supabase', checks: ['pricing'] },
  { entity: 'GitHub', checks: ['pricing'] },
];

const CURRENT = {
  HubSpot: { quote: 'HubSpot CRM Starter costs $20 per user per month with monthly billing and no annual commitment.', plan: 'Starter', amount: 20, unit: 'per_seat', commitment: 'none' },
  Pipedrive: { quote: 'Pipedrive CRM Essential costs $15 per user per month, billed monthly with no commitment.', plan: 'Essential', amount: 15, unit: 'per_seat', commitment: 'none' },
  Neon: { quote: 'Neon Launch costs $19 per month on usage billing.', plan: 'Launch', amount: 19, unit: 'usage', commitment: 'unknown' },
  Supabase: { quote: 'Supabase Pro costs $25 per month with a monthly commitment.', plan: 'Pro', amount: 25, unit: 'per_month', commitment: 'monthly' },
  GitHub: { quote: 'GitHub Team costs $4 per user per month with monthly billing.', plan: 'Team', amount: 4, unit: 'per_seat', commitment: 'unknown' },
};

function seedPriorPage(store, name, fixture) {
  const priorTurn = store.importTurn({
    user_text: `Check ${name} pricing.`,
    assistant_text: `${name} earlier price was recorded for its current plan.`,
    created_at: '2026-10-20T10:00:00.000Z',
    source_created_at: '2026-10-20T10:00:00.000Z',
    timezone: 'Asia/Kolkata',
  });
  store.updateTurn(priorTurn.id, { status: 'completed', claims_status: 'done' });
  const source = store.addSource({
    id: randomUUID(), turnId: priorTurn.id, url: fixture.url,
    domain: new URL(fixture.url).hostname.replace(/^www\./, ''), title: fixture.title,
    pageText: fixture.page_text, retrievalKind: 'page_text', pageTextOrigin: 'extract',
    retrievedAt: '2026-10-20T10:00:00.000Z',
  });
  const now = CURRENT[name];
  store.addClaim({
    id: randomUUID(), turn_id: priorTurn.id, entity_key: name.toLowerCase(), attribute: 'price',
    plan_key: now.plan.toLowerCase(), value_text: `$${Math.max(1, now.amount - 1)} per ${now.unit === 'per_seat' ? 'user ' : ''}month`,
    amount: Math.max(1, now.amount - 1), currency: 'USD', price_unit: now.unit,
    period: 'month', commitment: now.commitment, qualifiers: [],
    evidence_quote: fixture.page_text.split('. ')[1] || fixture.page_text.slice(0, 120),
    source_id: source.id, observed_at_utc: '2026-10-20T10:00:00.000Z', baseline_basis: 'page_text',
  });
}

test('Check uses one extraction per entity, emits cards as entities resolve, and isolates one failure', async () => {
  assert.equal(config.extractionMode, 'per_entity');
  const store = new Store(':memory:');
  const originalFetch = globalThis.fetch;
  const requests = [];
  let streamCount = 0;
  let failedExtractionAttempts = 0;
  const corpus = getReplayCorpus();
  const officialDomains = { HubSpot: 'hubspot.com', Pipedrive: 'pipedrive.com', Neon: 'neon.tech', Supabase: 'supabase.com', GitHub: 'github.com' };
  for (const target of TARGETS) {
    const fixture = corpus.search({ q: `${target.entity} pricing`, topic: 'general', limit: 10 })
      .find((item) => new URL(item.url).hostname.replace(/^www\./, '') === officialDomains[target.entity] && item.url.includes('/pricing'));
    assert.ok(fixture, `an official replay pricing fixture exists for ${target.entity}`);
    const page = corpus.extract(fixture.url);
    seedPriorPage(store, target.entity, { ...fixture, page_text: page.raw_content });
  }

  globalThis.fetch = async (url, options = {}) => {
    const endpoint = String(url);
    const body = options.body ? JSON.parse(options.body) : {};
    requests.push({ endpoint, body });
    if (endpoint.includes('streamGenerateContent')) {
      streamCount += 1;
      if (streamCount === 1) {
        return eventStream([{ functionCall: { name: 'web_search', id: 'five-targets', args: { queries: [], targets: TARGETS } }, thoughtSignature: 'multi-target-signature' }]);
      }
      return eventStream([{ text: 'I checked the five requested plans independently.' }]);
    }
    if (endpoint.includes('generateContent')) {
      const prompt = body.contents?.[0]?.parts?.[0]?.text || '';
      const sourceId = prompt.match(/SOURCE_ID:\s*([a-f0-9-]+)/i)?.[1];
      const entity = prompt.match(/ENTITY_HINT:\s*([^\n]+)/i)?.[1]?.trim();
      assert.ok(sourceId, 'one source ID is provided to each extraction');
      assert.ok(CURRENT[entity], `expected target entity hint, received ${entity}`);
      if (entity === 'Pipedrive') {
        failedExtractionAttempts += 1;
        return jsonResponse({ error: { message: 'synthetic extraction failure' } }, 503);
      }
      const value = CURRENT[entity];
      return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({ claims: [{
        source_id: sourceId,
        entity: `${entity} product family`,
        attribute: 'price',
        plan_name: value.plan,
        value_text: value.amount === 19 || value.amount === 25 ? `$${value.amount} per month` : `$${value.amount} per user per month`,
        amount: value.amount,
        currency: 'USD',
        price_unit: value.unit,
        period: 'month',
        commitment: value.commitment,
        evidence_quote: value.quote,
      }] }) }] } }] });
    }
    throw new Error(`Unexpected provider URL ${endpoint}`);
  };

  const events = [];
  try {
    const result = await runTurn({
      userText: 'Check the latest pricing for HubSpot, Pipedrive, Neon, Supabase and GitHub.',
      timezone: 'Asia/Kolkata', store,
      send: (type, data) => events.push({ type, data }),
    });
    const extractionCalls = requests.filter((item) => item.endpoint.includes('generateContent')).length;
    assert.equal(extractionCalls, 6, 'five logical entity calls with one retry for the deliberately failing entity');
    assert.equal(failedExtractionAttempts, 2);
    assert.equal(result.budgets.geminiCalls, 7, 'two model rounds plus five entity extraction calls');
    assert.ok(result.budgets.geminiCalls <= 10);
    assert.equal(store.getClaimsForTurn(result.turnId).length, 4);
    const progressive = events.filter((event) => event.type === 'cards').map((event) => event.data.cards.length);
    assert.deepEqual(progressive, [1, 2, 3, 4, 5],
      `each of the five entities should emit once, without a duplicate final snapshot; got ${progressive.join(',')}`);
    const failedCard = result.cards.find((group) => group.entity === 'Pipedrive')?.cards[0];
    assert.equal(failedCard.status, 'Couldn’t confirm');
    assert.equal(failedCard.reason, 'extraction_failed');
    for (const name of ['HubSpot', 'Neon', 'Supabase', 'GitHub']) {
      const card = result.cards.find((group) => group.entity === name)?.cards[0];
      assert.ok(card, `card exists for ${name}`);
      assert.notEqual(card.reason, 'extraction_failed', `${name} extraction must finish even when Pipedrive fails`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});

test('Check without history still extracts each target independently and emits no-earlier cards before commentary', async () => {
  const store = new Store(':memory:');
  const originalFetch = globalThis.fetch;
  const events = [];
  let streamCount = 0;
  const extractionRequests = [];
  globalThis.fetch = async (url, options = {}) => {
    const endpoint = String(url);
    const body = options.body ? JSON.parse(options.body) : {};
    if (endpoint.includes('streamGenerateContent')) {
      streamCount += 1;
      if (streamCount === 1) {
        return eventStream([{ functionCall: { name: 'web_search', id: 'no-history-check', args: { queries: [], targets: TARGETS } }, thoughtSignature: 'no-history-signature' }]);
      }
      const cards = events.findLast((event) => event.type === 'cards' && event.data.cards.length === TARGETS.length);
      assert.ok(cards, 'all code-assigned cards must be emitted before the commentary request');
      assert.ok(cards.data.cards.every((group) => group.cards[0].status === 'No earlier record to compare'));
      return eventStream([{ text: 'No earlier comparison record exists for these targets.' }]);
    }
    if (endpoint.includes('generateContent')) {
      extractionRequests.push(body.contents?.[0]?.parts?.[0]?.text || '');
      const prompt = extractionRequests.at(-1);
      const blocks = [...prompt.matchAll(/SOURCE_ID:\s*([a-f0-9-]+)[\s\S]*?ENTITY_HINT:\s*([^\n]+)/gi)];
      const claims = blocks.map((match) => {
        const entity = match[2].trim();
        const value = CURRENT[entity];
        assert.ok(value, `expected one entity extraction for ${entity}`);
        return {
          source_id: match[1], entity: `${entity} product family`, attribute: 'price',
          plan_name: value.plan,
          value_text: value.amount === 19 || value.amount === 25 ? `$${value.amount} per month` : `$${value.amount} per user per month`,
          amount: value.amount, currency: 'USD', price_unit: value.unit, period: 'month',
          commitment: value.commitment, evidence_quote: value.quote,
        };
      });
      return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({ claims }) }] } }] });
    }
    throw new Error(`Unexpected provider URL ${endpoint}`);
  };
  try {
    const result = await runTurn({
      userText: 'Check current pricing for HubSpot, Pipedrive, Neon, Supabase and GitHub.',
      timezone: 'Asia/Kolkata', store, send: (type, data) => events.push({ type, data }),
    });
    assert.equal(extractionRequests.length, 5, 'five independent target extractions are required without history');
    assert.equal(result.budgets.geminiCalls, 7, 'one initial call, five extractions and one commentary call');
    assert.equal(result.cards.length, 5);
    assert.ok(result.cards.every((group) => group.cards[0].status === 'No earlier record to compare'));
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});

test('five-target imported-history Check uses eight Gemini calls including one answer-baseline extraction', async () => {
  const store = new Store(':memory:');
  const quotes = [
    ['HubSpot', 'Starter', 19, '$19 per user per month', 'none'],
    ['Pipedrive', 'Essential', 14, '$14 per user per month', 'none'],
    ['Neon', 'Launch', 18, '$18 per month', 'unknown'],
    ['Supabase', 'Pro', 24, '$24 per month', 'monthly'],
    ['GitHub', 'Team', 3, '$3 per user per month', 'monthly'],
  ];
  const baselineAnswer = quotes.map(([entity, plan, amount, value, commitment]) => {
    const suffix = commitment === 'none' ? ' with no commitment' : commitment === 'monthly' ? ' with monthly billing' : ' on usage billing';
    return `${entity} ${plan} costs ${value}${suffix}.`;
  }).join(' ');
  const imported = store.importTurn({
    user_text: 'We discussed HubSpot, Pipedrive, Neon, Supabase and GitHub pricing.',
    assistant_text: baselineAnswer,
    created_at: '2026-10-20T08:30:00.000Z', source_created_at: '2026-10-20T08:30:00.000Z',
    timezone: 'Asia/Kolkata',
  });
  const baselineClaims = quotes.map(([entity, plan, amount, value]) => ({
    entity: `${entity} ${plan}`,
    attribute: 'price', plan_name: plan, value_text: value, amount, currency: 'USD',
    price_unit: entity === 'Neon' || entity === 'Supabase' ? 'flat' : 'per_seat',
    period: 'month', commitment: 'unknown', evidence_quote: baselineAnswer.match(new RegExp(`${entity} ${plan} costs [^.]+`))[0] + '.',
  }));
  const originalFetch = globalThis.fetch;
  const events = [];
  let streamCount = 0;
  const generatedJsonPrompts = [];
  globalThis.fetch = async (url, options = {}) => {
    const endpoint = String(url);
    const body = options.body ? JSON.parse(options.body) : {};
    if (endpoint.includes('streamGenerateContent')) {
      streamCount += 1;
      if (streamCount === 1) {
        return eventStream([{ functionCall: { name: 'web_search', id: 'imported-five-targets', args: { queries: [], targets: TARGETS } }, thoughtSignature: 'imported-signature' }]);
      }
      return eventStream([{ text: 'I checked all five current plans against the imported answer.' }]);
    }
    if (endpoint.includes('generateContent')) {
      const prompt = body.contents?.[0]?.parts?.[0]?.text || '';
      generatedJsonPrompts.push(prompt);
      if (prompt.includes('Earlier answer text is unverified')) {
        return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({ claims: baselineClaims }) }] } }] });
      }
      const blocks = [...prompt.matchAll(/SOURCE_ID:\s*([a-f0-9-]+)[\s\S]*?ENTITY_HINT:\s*([^\n]+)/gi)];
      const claims = blocks.map((match) => {
        const entity = match[2].trim();
        const value = CURRENT[entity];
        assert.ok(value, `expected current extraction for ${entity}`);
        return {
          source_id: match[1], entity: `${entity} latest offering`, attribute: 'price', plan_name: value.plan,
          value_text: value.amount === 19 || value.amount === 25 ? `$${value.amount} per month` : `$${value.amount} per user per month`,
          amount: value.amount, currency: 'USD', price_unit: value.unit, period: 'month',
          commitment: value.commitment, evidence_quote: value.quote,
        };
      });
      return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({ claims }) }] } }] });
    }
    throw new Error(`Unexpected provider URL ${endpoint}`);
  };
  try {
    const result = await runTurn({
      userText: 'What did I ask you on 20 October 2026? Check the latest pricing for HubSpot, Pipedrive, Neon, Supabase and GitHub.',
      timezone: 'Asia/Kolkata', store, send: (type, data) => events.push({ type, data }),
    });
    assert.equal(imported.source_created_at_utc, '2026-10-20T08:30:00.000Z');
    assert.equal(generatedJsonPrompts.filter((prompt) => prompt.includes('Earlier answer text is unverified')).length, 1);
    assert.equal(generatedJsonPrompts.length, 6, 'one baseline extraction plus five independent current extractions');
    assert.equal(result.budgets.geminiCalls, 8, 'one initial call, one baseline extraction, five target extractions and commentary');
    assert.ok(result.budgets.geminiCalls <= 10);
    assert.ok(result.cards.length === 5);
    assert.ok(result.cards.some((group) => group.cards[0].status.startsWith('Differs from my earlier answer')), JSON.stringify(result.cards.map((group) => ({ entity: group.entity, status: group.cards[0]?.status, reason: group.cards[0]?.reason }))));
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});


test('mixed target and free-form searches extract claims from both page groups', async () => {
  const store = new Store(':memory:');
  const originalFetch = globalThis.fetch;
  const corpus = getReplayCorpus();
  const events = [];
  const extractionPrompts = [];
  let streamCount = 0;
  globalThis.fetch = async (url, options = {}) => {
    const endpoint = String(url);
    const body = options.body ? JSON.parse(options.body) : {};
    if (endpoint.includes('streamGenerateContent')) {
      streamCount += 1;
      if (streamCount === 1) {
        return eventStream([{ functionCall: { name: 'web_search', id: 'mixed-target-free', args: {
          targets: [{ entity: 'Neon', checks: ['pricing'] }],
          queries: [{ q: 'PostgreSQL version' }],
        } }, thoughtSignature: 'mixed-signature' }]);
      }
      return eventStream([{ text: 'The target and free-form evidence were both extracted.' }]);
    }
    if (endpoint.includes('generateContent')) {
      const prompt = body.contents?.[0]?.parts?.[0]?.text || '';
      extractionPrompts.push(prompt);
      const sourceId = prompt.match(/SOURCE_ID:\s*([a-f0-9-]+)/i)?.[1];
      assert.ok(sourceId, 'each extraction uses the exact stored source ID');
      const isTarget = /ENTITY_HINT:\s*Neon/i.test(prompt);
      const claim = isTarget ? {
        source_id: sourceId, entity: 'Neon family', attribute: 'price', plan_name: 'Launch',
        value_text: '$19 per month', amount: 19, currency: 'USD', price_unit: 'usage',
        period: 'month', commitment: 'unknown', evidence_quote: 'Neon Launch costs $19 per month on usage billing.',
      } : {
        source_id: sourceId, entity: 'PostgreSQL', attribute: 'version', plan_name: '',
        value_text: '18.2', amount: null, currency: '', price_unit: 'none',
        period: 'unknown', commitment: 'unknown', evidence_quote: 'PostgreSQL stable release version 18.2 is used only as a comparison test value.',
      };
      return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({ claims: [claim] }) }] } }] });
    }
    throw new Error(`Unexpected provider URL ${endpoint}`);
  };
  try {
    const result = await runTurn({
      userText: 'Check Neon pricing and research the PostgreSQL version.',
      timezone: 'Asia/Kolkata', store, send: (type, data) => events.push({ type, data }),
    });
    const claims = store.getClaimsForTurn(result.turnId);
    assert.ok(claims.some((claim) => claim.entity_key === 'neon'), 'target claims use the code-assigned target key');
    assert.ok(claims.some((claim) => claim.entity_key === 'postgresql'), 'free-form claims retain the model entity as an opaque key');
    assert.equal(extractionPrompts.length, 2, 'one target extraction plus one batched non-target extraction');
    assert.ok(result.budgets.geminiCalls <= 10);
    assert.ok(events.find((event) => event.type === 'timings').data.budgets.geminiCalls <= 10);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});
