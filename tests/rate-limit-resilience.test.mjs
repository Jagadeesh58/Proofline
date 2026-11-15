import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GEMINI_MODELS = 'gemini-3.5-flash,gemini-3.5-flash-lite';
process.env.GEMINI_REQUESTS_PER_MINUTE = '600';
process.env.SEARCH_BACKEND = 'replay';

const [{ runTurn }, { Store }, { config }, gemini, { getReplayCorpus }] = await Promise.all([
  import('../src/agent/run-turn.mjs'),
  import('../src/memory/store.mjs'),
  import('../src/config.mjs'),
  import('../src/llm/gemini.mjs'),
  import('../src/search/replay.mjs'),
]);

function sseResponse(parts) {
  const payload = parts.map((part) => (
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [part] } }] })}\n\n`
  )).join('') + 'data: [DONE]\n\n';
  return new Response(payload, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('fallback to second model when primary returns 429 with high retry-after', async () => {
  gemini.resetThrottle();
  const previousFetch = globalThis.fetch;
  const modelsRequested = [];
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('gemini-3.5-flash:')) {
      modelsRequested.push('gemini-3.5-flash');
      return jsonResponse({ error: { message: 'Quota exhausted on primary' } }, 429, { 'retry-after': '30' });
    }
    if (urlStr.includes('gemini-3.5-flash-lite:')) {
      modelsRequested.push('gemini-3.5-flash-lite');
      return sseResponse([{ text: 'Answer from lite fallback.' }]);
    }
    return jsonResponse({ error: { message: 'Unknown model' } }, 404);
  };

  try {
    const result = await gemini.generateStream({
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
    });
    assert.equal(result.effectiveModel, 'gemini-3.5-flash-lite');
    assert.equal(result.text, 'Answer from lite fallback.');
    assert.ok(modelsRequested.includes('gemini-3.5-flash'));
    assert.ok(modelsRequested.includes('gemini-3.5-flash-lite'));
  } finally {
    globalThis.fetch = previousFetch;
    gemini.resetThrottle();
  }
});

test('runTurn completes successfully on fallback model and records effective_model in timings', async () => {
  gemini.resetThrottle();
  const store = new Store(':memory:');
  const previousFetch = globalThis.fetch;
  const events = [];

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('gemini-3.5-flash:')) {
      return jsonResponse({ error: { message: 'Quota exceeded' } }, 429, { 'retry-after': '25' });
    }
    if (urlStr.includes('gemini-3.5-flash-lite:')) {
      return sseResponse([{ text: 'Direct answer from fallback.' }]);
    }
    return jsonResponse({ error: { message: 'Not found' } }, 404);
  };

  try {
    const result = await runTurn({
      userText: 'Hello world',
      store,
      send: (type, data) => events.push({ type, data }),
    });

    assert.equal(result.text, 'Direct answer from fallback.');
    assert.equal(result.timings.effective_model, 'gemini-3.5-flash-lite');
    const timingsEvent = events.find((e) => e.type === 'timings');
    assert.ok(timingsEvent);
    assert.equal(timingsEvent.data.timings.effective_model, 'gemini-3.5-flash-lite');
  } finally {
    globalThis.fetch = previousFetch;
    store.close();
    gemini.resetThrottle();
  }
});

test('runTurn shows clear quota exhaustion message when all models hit 429', async () => {
  gemini.resetThrottle();
  const store = new Store(':memory:');
  const previousFetch = globalThis.fetch;
  const events = [];

  globalThis.fetch = async () => {
    return jsonResponse({ error: { message: 'Resource has been exhausted' } }, 429, { 'retry-after': '25' });
  };

  try {
    const result = await runTurn({
      userText: 'Check pricing',
      store,
      send: (type, data) => events.push({ type, data }),
    });

    const errorEvent = events.find((e) => e.type === 'error');
    assert.ok(errorEvent, 'An error event must be emitted');
    assert.match(
      errorEvent.data.message,
      /The Gemini (?:rate limit or )?quota for this key is used up\. Try again in about 20 seconds, or set a different GEMINI_API_KEY or GEMINI_MODELS\./
    );
    const doneEvent = events.find((e) => e.type === 'done');
    assert.ok(doneEvent);
    assert.equal(doneEvent.data.status, 'failed');
  } finally {
    globalThis.fetch = previousFetch;
    store.close();
    gemini.resetThrottle();
  }
});

test('three-target check turn batches claim extraction into at most 3 Gemini calls', async () => {
  gemini.resetThrottle();
  const store = new Store(':memory:');
  const previousFetch = globalThis.fetch;
  let geminiCalls = 0;

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('generativelanguage.googleapis.com')) {
      geminiCalls += 1;
      if (urlStr.includes('streamGenerateContent')) {
        if (geminiCalls === 1) {
          return sseResponse([{
            functionCall: {
              name: 'web_search',
              args: {
                targets: [
                  { entity: 'HubSpot', checks: ['pricing'] },
                  { entity: 'Pipedrive', checks: ['pricing'] },
                  { entity: 'Neon', checks: ['pricing'] },
                ],
              },
            },
          }]);
        }
        return sseResponse([{ text: 'Here are the pricing details for all three tools.' }]);
      }
      if (urlStr.includes('generateContent')) {
        return jsonResponse({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  claims: [
                    {
                      entity: 'HubSpot',
                      attribute: 'price',
                      numeric_value: 20,
                      currency: 'USD',
                      period: 'month',
                      evidence_quote: 'HubSpot CRM Starter costs $20 per user per month with monthly billing and no annual commitment.',
                    },
                    {
                      entity: 'Pipedrive',
                      attribute: 'price',
                      numeric_value: 15,
                      currency: 'USD',
                      period: 'month',
                      evidence_quote: 'Pipedrive CRM Essential costs $15 per user per month, billed monthly with no commitment.',
                    },
                    {
                      entity: 'Neon',
                      attribute: 'price',
                      numeric_value: 19,
                      currency: 'USD',
                      period: 'month',
                      evidence_quote: 'Neon Launch costs $19 per month on usage billing.',
                    },
                  ],
                }),
              }],
            },
          }],
        });
      }
    }
    return jsonResponse({});
  };

  try {
    const result = await runTurn({
      userText: 'Check pricing for HubSpot, Pipedrive and Neon',
      store,
      send: () => {},
    });

    assert.ok(result.text.includes('Here are the pricing details'));
    assert.ok(
      result.budgets.geminiCalls <= 3,
      `Expected at most 3 Gemini calls for 3 targets, got ${result.budgets.geminiCalls}`
    );
    assert.equal(geminiCalls, 3);
  } finally {
    globalThis.fetch = previousFetch;
    store.close();
    gemini.resetThrottle();
  }
});

test('no throttle wait occurs before the first 429 response', async () => {
  gemini.resetThrottle();
  const previousFetch = globalThis.fetch;
  let throttleWait = 0;

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('streamGenerateContent')) {
      return sseResponse([{ text: 'Instant response without waiting.' }]);
    }
    return jsonResponse({});
  };

  try {
    const start = Date.now();
    const result = await gemini.generateStream({
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      onTiming: (t) => {
        if (t.throttle_wait_ms) throttleWait += t.throttle_wait_ms;
      },
    });

    assert.equal(throttleWait, 0, 'No throttle wait before first 429');
    assert.equal(result.text, 'Instant response without waiting.');
    assert.ok(Date.now() - start < 1000, 'Request should finish without artificial delay');
  } finally {
    globalThis.fetch = previousFetch;
    gemini.resetThrottle();
  }
});
