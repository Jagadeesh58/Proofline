import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'free-extraction-budget-test-key';
process.env.TAVILY_API_KEY = '';
process.env.SEARCH_BACKEND = 'replay';
process.env.MAX_GEMINI_CALLS = '2';
process.env.EXTRACTION_MODE = 'per_entity';
process.env.GEMINI_REQUESTS_PER_MINUTE = '600';

const [{ Store }, { runTurn }, { config }] = await Promise.all([
  import('../src/memory/store.mjs?free-extraction-budget'),
  import('../src/agent/run-turn.mjs?free-extraction-budget'),
  import('../src/config.mjs?free-extraction-budget'),
]);

function eventStream(parts) {
  return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts } }] })}\n\n`, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
}
function jsonResponse(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('reports extraction_skipped_budget when a mixed turn cannot afford the non-target extraction', async () => {
  assert.equal(config.maxGeminiCalls, 2);
  const store = new Store(':memory:');
  const originalFetch = globalThis.fetch;
  const events = [];
  let streamCount = 0;
  globalThis.fetch = async (url, options = {}) => {
    const endpoint = String(url);
    const body = options.body ? JSON.parse(options.body) : {};
    if (endpoint.includes('streamGenerateContent')) {
      streamCount += 1;
      return streamCount === 1
        ? eventStream([{ functionCall: { name: 'web_search', id: 'budget-mixed', args: {
          targets: [{ entity: 'Neon', checks: ['pricing'] }], queries: [{ q: 'PostgreSQL version' }],
        } }, thoughtSignature: 'budget-mixed-signature' }])
        : eventStream([{ text: 'This response should not be requested after the cap is reached.' }]);
    }
    if (endpoint.includes('generateContent')) {
      const prompt = body.contents?.[0]?.parts?.[0]?.text || '';
      const sourceId = prompt.match(/SOURCE_ID:\s*([a-f0-9-]+)/i)?.[1];
      return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({ claims: [{
        source_id: sourceId, entity: 'Neon', attribute: 'price', plan_name: 'Launch',
        value_text: '$19 per month', amount: 19, currency: 'USD', price_unit: 'usage',
        period: 'month', commitment: 'unknown', evidence_quote: 'Neon Launch costs $19 per month on usage billing.',
      }] }) }] } }] });
    }
    throw new Error(`Unexpected provider URL ${endpoint}`);
  };
  try {
    const result = await runTurn({
      userText: 'Check Neon pricing and research the PostgreSQL version.', timezone: 'Asia/Kolkata', store,
      send: (type, data) => events.push({ type, data }),
    });
    assert.equal(result.budgets.geminiCalls, 2);
    assert.equal(result.timings.extraction_skipped_budget, true);
    const timingsEvent = events.find((event) => event.type === 'timings');
    assert.equal(timingsEvent.data.timings.extraction_skipped_budget, true);
    assert.ok(store.getClaimsForTurn(result.turnId).some((claim) => claim.entity_key === 'neon'));
    assert.ok(!store.getClaimsForTurn(result.turnId).some((claim) => claim.entity_key === 'postgresql'));
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});
