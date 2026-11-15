import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/memory/store.mjs';
import { createServer } from '../src/http/server.mjs';
import { config } from '../src/config.mjs';

async function withDemoServer(run) {
  const previousDemo = process.env.DEMO_MODE;
  process.env.DEMO_MODE = '1';
  const store = new Store(':memory:');
  const server = createServer(store);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`, store);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    if (previousDemo === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = previousDemo;
  }
}

test('brand-new visitor session automatically loads demo history and answers prompt 3', async () => {
  await withDemoServer(async (base) => {
    // 1. Initial request without cookie receives fresh session and demo history
    const historyRes = await fetch(`${base}/api/history`);
    assert.equal(historyRes.status, 200);
    const setCookie = historyRes.headers.get('set-cookie');
    assert.ok(setCookie, 'Should set a session cookie for new visitor');
    const cookie = setCookie.split(';')[0];

    const historyData = await historyRes.json();
    assert.ok(Array.isArray(historyData.turns));
    assert.equal(historyData.turns.length, 3, 'New session should have 3 demo turns');
    assert.ok(historyData.turns.every((t) => t.is_demo === 1));

    // 2. Chat request on official prompt 3 using this session cookie
    const chatRes = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
      },
      body: JSON.stringify({
        message: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
      }),
    });
    assert.equal(chatRes.status, 200);

    const raw = await chatRes.text();
    const lines = raw.split('\n');
    let fullText = '';
    const cards = [];
    const figureMarkers = [];

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const payload = JSON.parse(line.slice(6));
          if (payload.token) fullText += payload.token;
          if (payload.text) fullText += payload.text;
          if (payload.card) cards.push(payload.card);
          if (payload.cards) cards.push(...payload.cards);
          if (payload.marker) figureMarkers.push(payload.marker);
        } catch {
          // ignore non-json SSE lines
        }
      }
    }

    assert.ok(fullText.length > 50, 'Should produce an answer');
    assert.match(fullText, /Neon/i);
    assert.match(fullText, /Supabase/i);
    assert.doesNotMatch(fullText, /\(figure not verified\)/i, 'Scripted demo must not have unverified figure markers');
    assert.equal(figureMarkers.length, 0, 'No figure marker events in scripted demo');
  });
});
