import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/memory/store.mjs';
import { runWebSearch } from '../src/search/tool.mjs';
import { buildComparisonCards } from '../src/evidence/compare.mjs';

function makeFixturePage(text = 'Pricing details for Acme. Pro plan costs $50 per month.') {
  return text.repeat(4);
}

test('first-time lookup uses cache; check turn bypasses cache and calls network extractor', async () => {
  const store = new Store(':memory:');
  try {
    const url = 'https://acme.example.com/pricing';
    let extractCalls = 0;

    const extractFn = async (targetUrl) => {
      extractCalls += 1;
      return { results: [{ url: targetUrl, raw_content: makeFixturePage() }] };
    };

    const searchFn = async () => ({
      results: [{ url, title: 'Acme Pricing', content: 'Acme pricing page', score: 0.95 }],
    });

    // Turn 1: First-time general query populates cache
    const turn1 = store.createTurn({ userText: 'What is Acme pricing?', timezone: 'Asia/Kolkata' });
    const budget1 = { searches: 0, extracts: 0, geminiCalls: 0 };
    await runWebSearch({
      rawInput: { queries: [{ q: 'Acme pricing' }] },
      store,
      turnId: turn1.id,
      timezone: 'Asia/Kolkata',
      budget: budget1,
      useCache: true,
      searchFn,
      extractFn,
    });

    assert.equal(extractCalls, 1, 'First lookup must call extractor');

    // Turn 2: Second identical general query uses cache (first-time lookup reuses cache)
    const turn2 = store.createTurn({ userText: 'Acme pricing again', timezone: 'Asia/Kolkata' });
    const budget2 = { searches: 0, extracts: 0, geminiCalls: 0 };
    await runWebSearch({
      rawInput: { queries: [{ q: 'Acme pricing' }] },
      store,
      turnId: turn2.id,
      timezone: 'Asia/Kolkata',
      budget: budget2,
      useCache: true,
      searchFn,
      extractFn,
    });

    assert.equal(extractCalls, 1, 'Subsequent general query must reuse cached page');

    // Turn 3: Check turn with target bypasses cache and calls network extractor
    const turn3 = store.createTurn({ userText: 'Has Acme pricing changed?', timezone: 'Asia/Kolkata' });
    const budget3 = { searches: 0, extracts: 0, geminiCalls: 0 };
    await runWebSearch({
      rawInput: {
        targets: [{ entity: 'Acme', checks: ['pricing', 'news'], since: '2026-11-01' }],
      },
      store,
      turnId: turn3.id,
      timezone: 'Asia/Kolkata',
      budget: budget3,
      useCache: true,
      searchFn,
      extractFn,
    });

    assert.equal(extractCalls, 2, 'Check turn must bypass cache and call extractor');
  } finally {
    store.close();
  }
});

test('if cached page is used on a Check turn, comparison status becomes Could not confirm with cached_page', () => {
  const store = new Store(':memory:');
  try {
    const turn = store.createTurn({ userText: 'Check pricing', timezone: 'Asia/Kolkata' });
    const cachedSource = store.addSource({
      turnId: turn.id,
      url: 'https://acme.example.com/pricing',
      domain: 'acme.example.com',
      title: 'Acme Pricing',
      retrievalKind: 'page_text',
      pageText: 'Acme Pro costs $50 per month billed monthly.',
      pageTextOrigin: 'extract',
      fromCache: true,
      retrievedAt: new Date(Date.now() - 600_000).toISOString(),
    });

    const currentClaim = {
      entity: 'Acme',
      entity_key: 'acme',
      attribute: 'price',
      plan_name: 'Pro',
      plan_key: 'pro',
      numeric_value: 50,
      currency: 'USD',
      period: 'month',
      commitment: 'none',
      evidence_quote: 'Acme Pro costs $50 per month billed monthly.',
      source_id: cachedSource.id,
      from_cache: true,
      retrieved_at_utc: cachedSource.retrieved_at_utc,
    };

    const baselineClaim = {
      entity: 'Acme',
      entity_key: 'acme',
      attribute: 'price',
      plan_name: 'Pro',
      plan_key: 'pro',
      numeric_value: 50,
      currency: 'USD',
      period: 'month',
      commitment: 'none',
      evidence_quote: 'Acme Pro costs $50 per month billed monthly.',
      observed_at_utc: new Date(Date.now() - 86400_000).toISOString(),
    };

    const [group] = buildComparisonCards({
      store,
      targets: [{
        entity: 'Acme',
        entity_key: 'acme',
        checks: ['pricing'],
        page: cachedSource,
      }],
      currentClaims: [currentClaim],
      baselineClaims: [baselineClaim],
    });

    assert.ok(group, 'Comparison card group must be generated');
    const card = group.cards[0];
    assert.equal(card.status, 'Couldn’t confirm');
    assert.equal(card.reason, 'cached_page');
    assert.equal(card.current.from_cache, true);
    assert.ok(card.current.retrieved_at_utc);
  } finally {
    store.close();
  }
});
