import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'mock-gemini-key';
process.env.TAVILY_API_KEY = '';
process.env.SEARCH_BACKEND = 'replay';
process.env.GEMINI_MODEL = 'gemini-e2e-mock';
process.env.GEMINI_REQUESTS_PER_MINUTE = '600';
process.env.MAX_TOOL_ROUNDS = '3';

const [{ Store }, { runTurn }, { runWebSearch }] = await Promise.all([
  import('../src/memory/store.mjs?e2e'),
  import('../src/agent/run-turn.mjs?e2e'),
  import('../src/search/tool.mjs?e2e'),
]);

const NEON_QUOTE = 'Neon Launch costs $19 per month on usage billing.';
const CALL_ARGS = {
  queries: [],
  targets: [{ entity: 'Neon', checks: ['pricing'] }],
};

function streamResponse(parts) {
  const payload = { candidates: [{ content: { role: 'model', parts } }] };
  return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function installGeminiMock({ answer = 'Neon Launch is listed at $19 per month.', toolCalls = 1 } = {}) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let streamCount = 0;
  globalThis.fetch = async (url, options = {}) => {
    const endpoint = String(url);
    const body = options.body ? JSON.parse(options.body) : {};
    requests.push({ endpoint, body });
    if (endpoint.includes('streamGenerateContent')) {
      streamCount += 1;
      if (streamCount <= toolCalls) {
        return streamResponse([{
          functionCall: { name: 'web_search', args: CALL_ARGS, id: `search-${streamCount}` },
          thoughtSignature: `mock-signature-${streamCount}`,
        }]);
      }
      return streamResponse([{ text: answer }]);
    }
    if (endpoint.includes('generateContent')) {
      const prompt = body.contents?.[0]?.parts?.[0]?.text || '';
      const sourceId = prompt.match(/SOURCE_ID:\s*([a-f0-9-]+)/i)?.[1];
      assert.ok(sourceId, 'claim extraction prompt must contain the stored source ID');
      return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        claims: [{
          source_id: sourceId,
          entity: 'Neon',
          attribute: 'price',
          plan_name: 'Launch',
          value_text: '$19 per month',
          amount: 19,
          currency: 'USD',
          price_unit: 'unknown',
          period: 'month',
          commitment: 'unknown',
          evidence_quote: NEON_QUOTE,
        }],
      }) }] } }] });
    }
    throw new Error(`Unexpected mocked network request: ${endpoint}`);
  };
  return {
    requests,
    restore() { globalThis.fetch = originalFetch; },
  };
}

async function seedBaseline(store, { amount = 19, commitment = 'unknown' } = {}) {
  const turn = store.createTurn({
    userText: 'Compare Neon Launch pricing.', timezone: 'Asia/Kolkata',
    now: new Date('2026-10-20T08:00:00.000Z'),
  });
  store.updateTurn(turn.id, {
    assistant_text: `Neon Launch costs $${amount} per month.`,
    status: 'completed', claims_status: 'done',
  });
  const source = store.addSource({
    id: `baseline-${amount}-${commitment}`,
    turnId: turn.id,
    url: 'https://neon.tech/pricing',
    domain: 'neon.tech',
    title: 'Neon pricing',
    pageText: `Neon Launch costs $${amount} per month.`,
    retrievalKind: 'page_text',
    pageTextOrigin: 'extract',
    retrievedAt: '2026-10-20T08:00:00.000Z',
  });
  store.addClaim({
    turn_id: turn.id,
    entity_key: 'neon',
    attribute: 'price',
    plan_key: 'launch',
    value_text: `$${amount} per month`,
    amount,
    currency: 'USD',
    price_unit: 'usage',
    period: 'month',
    commitment,
    evidence_quote: `Neon Launch costs $${amount} per month.`,
    source_id: source.id,
    observed_at_utc: '2026-10-20T08:00:00.000Z',
    baseline_basis: 'page_text',
  });
  return turn;
}

async function runMockedTurn({ store, answer, toolCalls = 1 }) {
  const mock = installGeminiMock({ answer, toolCalls });
  const events = [];
  try {
    const result = await runTurn({
      userText: 'Check Neon pricing.',
      timezone: 'Asia/Kolkata',
      store,
      send: (type, data) => events.push({ type, data }),
    });
    return { result, events, requests: mock.requests };
  } finally {
    mock.restore();
  }
}

test('mocked Search turn stores page evidence, claims and a first baseline card', async () => {
  const store = new Store(':memory:');
  try {
    const { result } = await runMockedTurn({ store });
    assert.match(result.text, /Neon Launch is listed/);
    assert.equal(store.getSources(result.turnId).some((source) => source.retrieval_kind === 'page_text'), true);
    assert.equal(store.getClaimsForTurn(result.turnId).length, 1);
    assert.equal(result.cards[0].cards[0].status, 'No earlier record to compare');
    assert.equal(store.getTurn(result.turnId).status, 'completed');
  } finally { store.close(); }
});

test('mocked Check turn reuses the baseline URL and assigns Same as before', async () => {
  const store = new Store(':memory:');
  try {
    await seedBaseline(store, { amount: 19 });
    const { result, requests } = await runMockedTurn({ store });
    assert.equal(result.budgets.searches, 0);
    assert.equal(result.budgets.extracts, 1);
    assert.equal(store.getSources(result.turnId)[0].url, 'https://neon.tech/pricing');
    assert.equal(result.cards[0].cards[0].status, 'Same as before (billing terms not stated)');
    assert.equal(requests.filter((item) => item.endpoint.includes('streamGenerateContent')).length, 2);
  } finally { store.close(); }
});

test('mocked Check turn assigns Changed when the quote-backed amount differs', async () => {
  const store = new Store(':memory:');
  try {
    await seedBaseline(store, { amount: 18 });
    const { result } = await runMockedTurn({ store });
    assert.equal(result.cards[0].cards[0].status, 'Changed (billing terms not stated)');
  } finally { store.close(); }
});

test('mocked Check turn refuses to compare annual against unstated billing terms', async () => {
  const store = new Store(':memory:');
  try {
    await seedBaseline(store, { amount: 18, commitment: 'annual' });
    const { result } = await runMockedTurn({ store });
    assert.equal(result.cards[0].cards[0].status, 'Can’t compare: terms differ');
    assert.equal(result.cards[0].cards[0].reason, 'terms_unknown');
  } finally { store.close(); }
});

test('mocked answer marks a fabricated figure that does not match the retrieved page', async () => {
  const store = new Store(':memory:');
  try {
    const { result, events } = await runMockedTurn({
      store, answer: 'Neon Launch is listed at $999 per month.',
    });
    assert.match(result.text, /\(figure not verified\)/);
    assert.ok(events.some((event) => event.type === 'figure_marker'));
  } finally { store.close(); }
});

test('mocked agent omits tools on the final allowed model round', async () => {
  const store = new Store(':memory:');
  try {
    const { requests } = await runMockedTurn({ store, toolCalls: 2 });
    const streamRequests = requests.filter((item) => item.endpoint.includes('streamGenerateContent'));
    assert.equal(streamRequests.length, 3);
    assert.ok(streamRequests[0].body.tools);
    assert.ok(streamRequests[1].body.tools);
    assert.equal(streamRequests[2].body.tools, undefined);
  } finally { store.close(); }
});


test('five target checks plus three free queries fit the per-turn search and extract caps', async () => {
  const store = new Store(':memory:');
  const turn = store.createTurn({ userText: 'Compare five vendors.', timezone: 'Asia/Kolkata' });
  const budget = { searches: 0, extracts: 0, geminiCalls: 0 };
  let searchCalls = 0;
  let extractCalls = 0;
  try {
    const targets = Array.from({ length: 5 }, (_, index) => ({
      entity: `Vendor ${index + 1}`,
      checks: ['pricing'],
    }));
    const queries = Array.from({ length: 3 }, (_, index) => ({
      q: `Independent research query ${index + 1}`,
    }));
    const searchFn = async ({ q }) => {
      searchCalls += 1;
      const slug = q.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const url = `https://example-${searchCalls}.com/${slug}`;
      return { results: [{ url, title: q, content: `Evidence for ${q}`, score: 1 }] };
    };
    const extractFn = async (url) => {
      extractCalls += 1;
      return { results: [{ url, title: 'Retrieved page', raw_content: `Verified source content for ${url}. `.repeat(12) }] };
    };
    const result = await runWebSearch({
      rawInput: { queries, targets }, store, turnId: turn.id,
      timezone: 'Asia/Kolkata', budget, searchFn, extractFn,
    });
    assert.equal(result.ok, true);
    assert.equal(searchCalls, 8);
    assert.equal(extractCalls, 8);
    assert.equal(budget.searches, 8);
    assert.equal(budget.extracts, 8);
    assert.ok(budget.searches <= 14);
    assert.ok(budget.extracts <= 8);
  } finally {
    store.close();
  }
});

test('a provider 429 leaves a failed turn without an answer and never leaks into later model context', async () => {
  const store = new Store(':memory:');
  const originalFetch = globalThis.fetch;
  const failedRequests = [];
  try {
    globalThis.fetch = async (url, options = {}) => {
      failedRequests.push({ url: String(url), body: options.body ? JSON.parse(options.body) : {} });
      return new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
        status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' },
      });
    };
    const failed = await runTurn({ userText: 'Explain Neon pricing.', timezone: 'Asia/Kolkata', store, send: () => {} });
    const failedTurn = store.getTurn(failed.turnId);
    assert.equal(failedTurn.status, 'failed');
    assert.equal(failedTurn.assistant_text, '');
    assert.match(failed.text, /rate limit/i);

    let nextBody;
    globalThis.fetch = async (url, options = {}) => {
      nextBody = JSON.parse(options.body);
      return streamResponse([{ text: 'Neon is a hosted database service.' }]);
    };
    const next = await runTurn({ userText: 'What is Neon?', timezone: 'Asia/Kolkata', store, send: () => {} });
    assert.match(next.text, /hosted database/);
    const contextText = JSON.stringify(nextBody.contents);
    assert.doesNotMatch(contextText, /quota exceeded|rate limit was reached/i);
    assert.equal(store.lastTurns(8).some((turn) => turn.id === failed.turnId), false);
    assert.equal(store.searchByTopic(['neon'], 12).some((turn) => turn.id === failed.turnId), false);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});

test('an aborted provider request is stored as interrupted without an assistant answer', async () => {
  const store = new Store(':memory:');
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  try {
    globalThis.fetch = async () => {
      controller.abort(new Error('browser disconnected'));
      throw new Error('The operation was aborted.');
    };
    const result = await runTurn({
      userText: 'Explain Neon.', timezone: 'Asia/Kolkata', store,
      send: () => {}, signal: controller.signal,
    });
    const turn = store.getTurn(result.turnId);
    assert.equal(turn.status, 'interrupted');
    assert.equal(turn.assistant_text, '');
    assert.equal(store.lastTurns(8).some((item) => item.id === turn.id), false);
    assert.equal(store.searchByTopic(['neon'], 12).some((item) => item.id === turn.id), false);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});

test('mocked check turn with bare queries derives target and generates comparison card', async () => {
  const store = new Store(':memory:');
  const originalFetch = globalThis.fetch;
  let streamCount = 0;
  try {
    await seedBaseline(store, { amount: 19 });
    globalThis.fetch = async (url, options = {}) => {
      const endpoint = String(url);
      const body = options.body ? JSON.parse(options.body) : {};
      if (endpoint.includes('streamGenerateContent')) {
        streamCount += 1;
        if (streamCount === 1) {
          return streamResponse([{
            functionCall: {
              name: 'web_search',
              args: { queries: [{ q: 'Neon pricing 2026' }] },
              id: 'search-1',
            },
          }]);
        }
        return streamResponse([{ text: 'Neon pricing remains unchanged at $19 per month.' }]);
      }
      if (endpoint.includes('generateContent')) {
        const prompt = body.contents?.[0]?.parts?.[0]?.text || '';
        const sourceId = prompt.match(/SOURCE_ID:\s*([a-f0-9-]+)/i)?.[1] || 'mock-source-id';
        return jsonResponse({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  claims: [{
                    source_id: sourceId,
                    entity: 'Neon',
                    attribute: 'price',
                    plan_name: 'Launch',
                    value_text: '$19 per month',
                    amount: 19,
                    currency: 'USD',
                    price_unit: 'usage',
                    period: 'month',
                    commitment: 'unknown',
                    evidence_quote: NEON_QUOTE,
                  }],
                }),
              }],
            },
          }],
        });
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    };

    const result = await runTurn({
      userText: 'Has Neon pricing changed since last Tuesday?',
      timezone: 'Asia/Kolkata',
      store,
      send: () => {},
    });

    assert.ok(result.cards.length >= 1);
    assert.equal(result.cards[0].entity, 'Neon');
    assert.equal(result.cards[0].cards[0].status, 'Same as before (billing terms not stated)');
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});

test('mocked check turn with unconfirmed provider replaces no-pricing-changes claim with unconfirmed notice', async () => {
  const store = new Store(':memory:');
  const originalFetch = globalThis.fetch;
  let streamCount = 0;
  try {
    await seedBaseline(store, { amount: 19 });
    globalThis.fetch = async (url, options = {}) => {
      const endpoint = String(url);
      if (endpoint.includes('streamGenerateContent')) {
        streamCount += 1;
        if (streamCount === 1) {
          return streamResponse([{
            functionCall: {
              name: 'web_search',
              args: { queries: [{ q: 'Neon pricing 2026' }] },
              id: 'search-1',
            },
          }]);
        }
        return streamResponse([{ text: 'No pricing changes have been reported for Neon since last Tuesday.' }]);
      }
      if (endpoint.includes('generateContent')) {
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ claims: [] }) }] } }],
        });
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    };

    const result = await runTurn({
      userText: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
      timezone: 'Asia/Kolkata',
      store,
      send: () => {},
    });

    assert.ok(result.cards.length >= 1);
    assert.equal(result.cards[0].cards[0].status, 'Couldn’t confirm');
    assert.doesNotMatch(result.text, /no pricing changes have been reported for Neon/i);
    assert.match(result.text, /pricing for Neon could not be confirmed/i);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});
