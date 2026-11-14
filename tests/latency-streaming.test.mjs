import './test-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/memory/store.mjs';
import { runTurn } from '../src/agent/run-turn.mjs';
import { mapConcurrent } from '../src/search/tool.mjs';
import { generateStream, ProviderError } from '../src/llm/gemini.mjs';
import { config } from '../src/config.mjs';

function streamResponse(parts) {
  const payload = { candidates: [{ content: { role: 'model', parts } }] };
  return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('recall block is emitted before model call on recall turns', async () => {
  const store = new Store(':memory:');
  const pastTurn = store.importTurn({
    user_text: 'What are the top CRM tools for 20 people?',
    assistant_text: 'We shortlisted HubSpot, Pipedrive, Zoho, Monday, and Freshsales.',
    created_at: '2026-11-03T10:00:00.000Z',
    source_created_at: '2026-11-03T10:00:00.000Z',
  }, 'Asia/Kolkata');
  store.updateTurn(pastTurn.id, { status: 'completed', claims_status: 'done' });

  const events = [];
  let modelCallObserved = false;
  let memoryEmittedBeforeModel = false;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const endpoint = String(url);
    if (endpoint.includes('streamGenerateContent') || endpoint.includes('generateContent')) {
      modelCallObserved = true;
      const memoryIdx = events.findIndex((e) => e.type === 'memory');
      if (memoryIdx !== -1) {
        memoryEmittedBeforeModel = true;
      }
      return streamResponse([{ text: 'Your question on 3 November was about CRM tools.' }]);
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    await runTurn({
      userText: 'What did I ask you on 3 November? Is your answer still correct today?',
      timezone: 'Asia/Kolkata',
      store,
      send: (type, data) => events.push({ type, data, modelSeen: modelCallObserved }),
    });

    assert.ok(modelCallObserved, 'Model should have been called');
    assert.ok(memoryEmittedBeforeModel, 'Recall memory event must be emitted before model call');
    const memoryEvent = events.find((e) => e.type === 'memory');
    assert.ok(memoryEvent, 'Memory event must be present in emitted events');
    assert.ok(memoryEvent.data?.turns?.length > 0, 'Memory event must include recalled turns');
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});

test('streaming produces tokens progressively before turn completes', async () => {
  const store = new Store(':memory:');
  const originalFetch = globalThis.fetch;
  const tokenTimes = [];
  let turnResolved = false;

  globalThis.fetch = async (url) => {
    const endpoint = String(url);
    if (endpoint.includes('streamGenerateContent')) {
      const stream = new ReadableStream({
        async start(controller) {
          const sentences = [
            'HubSpot CRM is widely used by growing sales teams. ',
            'Pipedrive offers pipeline-focused tracking features. ',
            'Both options continue to serve 20-person teams well. ',
          ];
          for (const sentence of sentences) {
            await new Promise((resolve) => setTimeout(resolve, 30));
            const payload = { candidates: [{ content: { role: 'model', parts: [{ text: sentence }] } }] };
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
          }
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const turnPromise = runTurn({
      userText: 'Hello! What can you help me with?',
      timezone: 'Asia/Kolkata',
      store,
      send: (type) => {
        if (type === 'token') {
          tokenTimes.push({ time: Date.now(), turnResolved });
        }
      },
    });

    await turnPromise;
    turnResolved = true;

    assert.ok(tokenTimes.length > 0, 'Tokens must be emitted');
    const tokensBeforeResolution = tokenTimes.filter((t) => !t.turnResolved);
    assert.ok(
      tokensBeforeResolution.length >= 1,
      'At least one token must be emitted before turn resolution'
    );
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});

test('mapConcurrent respects the maximum concurrency limit', async () => {
  let active = 0;
  let maxActive = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);

  await mapConcurrent(items, 3, async () => {
    active += 1;
    if (active > maxActive) maxActive = active;
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
  });

  assert.equal(active, 0);
  assert.ok(maxActive <= 3, `Expected max concurrency <= 3, got ${maxActive}`);
  assert.ok(maxActive >= 2, `Expected concurrency to reach at least 2, got ${maxActive}`);
});

test('backoff wait cap terminates runaway retry loops', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  globalThis.fetch = async () => {
    callCount += 1;
    return new Response(JSON.stringify({ error: { message: 'Resource exhausted' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '12' },
    });
  };

  try {
    await assert.rejects(
      async () => {
        await generateStream({
          contents: [{ role: 'user', parts: [{ text: 'Test prompt' }] }],
          onStatus: () => {},
        });
      },
      (error) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.status, 429);
        return true;
      }
    );
    assert.ok(callCount <= 2, 'Should not endlessly retry when retry-after exceeds budget cap');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('card emission occurs before commentary stream completes', async () => {
  const store = new Store(':memory:');
  const pastTurn = store.importTurn({
    user_text: 'Check Neon pricing.',
    assistant_text: 'Neon Launch costs $19 per month on usage billing.',
    created_at: '2026-10-20T10:00:00.000Z',
    source_created_at: '2026-10-20T10:00:00.000Z',
  }, 'Asia/Kolkata');
  store.updateTurn(pastTurn.id, { status: 'completed', claims_status: 'done' });
  const source = store.addSource({
    id: 'neon-src-1',
    turnId: pastTurn.id,
    url: 'https://neon.tech/pricing',
    domain: 'neon.tech',
    title: 'Neon pricing',
    pageText: 'Neon Launch costs $19 per month on usage billing.',
    retrievalKind: 'page_text',
  });
  store.addClaim({
    turn_id: pastTurn.id,
    entity_key: 'neon',
    attribute: 'price',
    plan_key: 'launch',
    value_text: '$19 per month',
    amount: 19,
    currency: 'USD',
    price_unit: 'usage',
    period: 'month',
    commitment: 'none',
    evidence_quote: 'Neon Launch costs $19 per month on usage billing.',
    source_id: source.id,
    baseline_basis: 'page_text',
  });

  const originalFetch = globalThis.fetch;
  const events = [];
  let streamCount = 0;

  globalThis.fetch = async (url) => {
    const endpoint = String(url);
    if (endpoint.includes('streamGenerateContent')) {
      streamCount += 1;
      if (streamCount === 1) {
        return streamResponse([{
          functionCall: {
            name: 'web_search',
            args: { queries: [], targets: [{ entity: 'Neon', checks: ['pricing'] }] },
          },
        }]);
      }
      return streamResponse([{ text: 'Neon pricing has remained the same at $19 per month.' }]);
    }
    if (endpoint.includes('generateContent')) {
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                claims: [{
                  source_id: source.id,
                  entity: 'Neon',
                  attribute: 'price',
                  plan_name: 'Launch',
                  value_text: '$19 per month',
                  amount: 19,
                  currency: 'USD',
                  price_unit: 'usage',
                  period: 'month',
                  commitment: 'none',
                  evidence_quote: 'Neon Launch costs $19 per month on usage billing.',
                }],
              }),
            }],
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await runTurn({
      userText: 'Check Neon pricing.',
      timezone: 'Asia/Kolkata',
      store,
      send: (type, data) => events.push({ type, data }),
    });

    const cardsIndex = events.findIndex((e) => e.type === 'cards');
    const doneIndex = events.findIndex((e) => e.type === 'done');
    assert.ok(cardsIndex !== -1, 'Cards must be emitted');
    assert.ok(doneIndex !== -1, 'Done event must be emitted');
    assert.ok(cardsIndex < doneIndex, 'Cards must be emitted before the turn completes');
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});

