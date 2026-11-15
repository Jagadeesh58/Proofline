import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { Store } from '../src/memory/store.mjs';
import { createServer, getClientIp } from '../src/http/server.mjs';
import { config } from '../src/config.mjs';

async function withServer(run, options = {}) {
  const store = new Store(':memory:');
  const server = createServer(store, options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
}

test('serves the single-page UI and local health/config endpoints', async () => {
  await withServer(async (base) => {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const mjsModule = await fetch(`${base}/markdown.mjs`);
    assert.equal(mjsModule.status, 200);
    assert.match(mjsModule.headers.get('content-type'), /text\/javascript/);
    assert.match(await page.text(), /Evidence-first/);
    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(health.storage, 'sqlite');
    const configPayload = await fetch(`${base}/api/config`).then((r) => r.json());
    assert.equal(configPayload.timezone, config.timezone);
  });
});

test('imports history atomically and returns it from the local history API', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turns: [
        { user_text: 'What did we discuss?', assistant_text: 'We discussed databases.', created_at: '2026-11-02T10:00:00Z', source_created_at: '2026-10-20T10:00:00Z' },
      ] }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).imported, 1);
    const history = await fetch(`${base}/api/history`).then((r) => r.json());
    assert.equal(history.turns.length, 1);
    assert.equal(history.turns[0].source_created_at_utc, '2026-10-20T10:00:00.000Z');
  });
});

test('rejects malformed import requests without changing local history', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turns: [{ user_text: 'First', created_at: '2026-11-01T00:00:00Z' }, { user_text: 'Bad', created_at: 'not-a-date' }] }),
    });
    assert.equal(response.status, 400);
    const history = await fetch(`${base}/api/history`).then((r) => r.json());
    assert.equal(history.turns.length, 0);
  });
});

test('returns 400 for malformed percent-encoding and remains available afterwards', async () => {
  await withServer(async (base) => {
    const malformed = await fetch(`${base}/%E0%A4%A`);
    assert.equal(malformed.status, 400);
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
  });
});

test('converts a throwing request hook to 500 and serves the next request', async () => {
  await withServer(async (base) => {
    const failed = await fetch(`${base}/api/throw`);
    assert.equal(failed.status, 500);
    assert.equal((await failed.json()).error, 'The server could not complete this request.');
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  }, {
    beforeRequest: (request) => {
      if (request.url === '/api/throw') throw new Error('synthetic handler failure');
    },
  });
});

test('rejects foreign origins and non-JSON POSTs before they reach application routes', async () => {
  await withServer(async (base) => {
    const foreignOrigin = await fetch(`${base}/api/import`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify([]),
    });
    assert.equal(foreignOrigin.status, 403);
    const wrongType = await fetch(`${base}/api/import`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: '[]',
    });
    assert.equal(wrongType.status, 415);
    const ok = await fetch(`${base}/api/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ user_text: 'Allowed', assistant_text: 'Local' }]),
    });
    assert.equal(ok.status, 200);
  });
});


test('rejects a foreign Host on GET API routes while allowing loopback hosts', async () => {
  await withServer(async (base) => {
    const parsed = new URL(base);
    const blocked = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: parsed.hostname, port: parsed.port, path: '/api/history', headers: { host: 'attacker.example' } }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(blocked.status, 403);
    const allowed = await fetch(`${base}/api/history`, { headers: { host: new URL(base).host } });
    assert.equal(allowed.status, 200);
  });
});

test('accepts both array and wrapped-object history import formats', async () => {
  await withServer(async (base) => {
    const arrayResponse = await fetch(`${base}/api/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ user_text: 'Array turn', assistant_text: 'Array answer' }]),
    });
    assert.equal(arrayResponse.status, 200);
    const objectResponse = await fetch(`${base}/api/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timezone: 'Asia/Kolkata', turns: [{ user_text: 'Object turn', assistant_text: 'Object answer' }] }),
    });
    assert.equal(objectResponse.status, 200);
    const history = await fetch(`${base}/api/history`).then((response) => response.json());
    assert.equal(history.turns.length, 2);
  });
});

test('loads three dated demo turns idempotently and labels them as demo', async () => {
  await withServer(async (base) => {
    const first = await fetch(`${base}/api/demo-history`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((response) => response.json());
    const second = await fetch(`${base}/api/demo-history`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((response) => response.json());
    assert.equal(first.imported, 3);
    assert.equal(second.imported, 0);
    const history = await fetch(`${base}/api/history`).then((response) => response.json());
    assert.equal(history.turns.length, 3);
    assert.ok(history.turns.every((turn) => turn.is_demo === 1));
    assert.deepEqual(new Set(history.turns.map((turn) => turn.local_date)), new Set(['2026-11-03', '2026-11-09', '2026-11-10']));
    assert.ok(history.turns.some((turn) => turn.user_text.startsWith('On Monday we shortlisted')));
  });
});

test('reports a missing Gemini key through the streaming chat interface', async () => {
  const mockRunTurn = async ({ send }) => {
    send('error', { message: 'Gemini is not configured. Add GEMINI_API_KEY to your local .env file to enable model answers.', code: 'missing_key' });
    send('done', { status: 'failed' });
  };
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Hello', timezone: 'Asia/Kolkata' }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const stream = await response.text();
    assert.match(stream, /event: error/);
    assert.match(stream, /missing_key/);
  }, { runTurnFn: mockRunTurn });
});

test('health endpoint reports ok status, process uptime and memory usage', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const health = await res.json();
    assert.equal(health.status, 'ok');
    assert.equal(health.ok, true);
    assert.equal(typeof health.uptime, 'number');
    assert.ok(health.uptime >= 0);
    assert.ok(health.memory && typeof health.memory.heapUsed === 'number');
    assert.ok(health.memory.rss > 0);
  });
});

test('ignores x-session-id header and relies exclusively on session cookie', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/history`, {
      headers: { 'x-session-id': 'forged-attacker-session-id' },
    });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie') || '';
    assert.match(setCookie, /proofline_session=/);
    assert.doesNotMatch(setCookie, /forged-attacker-session-id/);
  });
});

test('session isolation ensures visitor A cookie cannot access visitor B history', async () => {
  const store = new Store(':memory:');
  store.createTurn({ userText: 'Visitor A Question', timezone: 'UTC', sessionId: 'session-a' });
  store.createTurn({ userText: 'Visitor B Question', timezone: 'UTC', sessionId: 'session-b' });

  const server = createServer(store);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const resA = await fetch(`${base}/api/history`, {
      headers: { cookie: 'proofline_session=session-a' },
    });
    const historyA = await resA.json();
    assert.equal(historyA.turns.length, 1);
    assert.equal(historyA.turns[0].user_text, 'Visitor A Question');

    const resB = await fetch(`${base}/api/history`, {
      headers: { cookie: 'proofline_session=session-b' },
    });
    const historyB = await resB.json();
    assert.equal(historyB.turns.length, 1);
    assert.equal(historyB.turns[0].user_text, 'Visitor B Question');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});

test('extracts client IP from x-forwarded-for when TRUST_PROXY=1 and socket when TRUST_PROXY=0', () => {
  const originalTrust = process.env.TRUST_PROXY;
  try {
    process.env.TRUST_PROXY = '1';
    const reqWithProxy = {
      headers: { 'x-forwarded-for': ' 203.0.113.195, 70.41.3.18 ' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    assert.equal(getClientIp(reqWithProxy), '203.0.113.195');

    process.env.TRUST_PROXY = '0';
    assert.equal(getClientIp(reqWithProxy), '127.0.0.1');

    delete process.env.TRUST_PROXY;
    assert.equal(getClientIp(reqWithProxy), '127.0.0.1');
  } finally {
    if (originalTrust !== undefined) process.env.TRUST_PROXY = originalTrust;
    else delete process.env.TRUST_PROXY;
  }
});

test('quota exhaustion returns 429 when per-session budget is exceeded', async () => {
  const mockRunTurn = async ({ send }) => {
    send('done', { status: 'completed' });
  };
  await withServer(async (base) => {
    const sessionCookie = 'proofline_session=budget-session-test';
    const r1 = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ message: 'Request 1' }),
    });
    assert.equal(r1.status, 200);

    const r2 = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ message: 'Request 2' }),
    });
    assert.equal(r2.status, 429);
    const body2 = await r2.json();
    assert.match(body2.error, /Demo limit reached\. Try running locally using the instructions in README\.md\./);
  }, { runTurnFn: mockRunTurn, sessionBudget: 1 });
});

test('quota exhaustion returns 429 when global daily budget is exceeded', async () => {
  const mockRunTurn = async ({ send }) => {
    send('done', { status: 'completed' });
  };
  await withServer(async (base) => {
    const r1 = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'proofline_session=visitor-1' },
      body: JSON.stringify({ message: 'Visitor 1 Request' }),
    });
    assert.equal(r1.status, 200);

    const r2 = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'proofline_session=visitor-2' },
      body: JSON.stringify({ message: 'Visitor 2 Request' }),
    });
    assert.equal(r2.status, 429);
    const body2 = await r2.json();
    assert.match(body2.error, /Demo limit reached\. Try running locally using the instructions in README\.md\./);
  }, { runTurnFn: mockRunTurn, globalDailyBudget: 1 });
});

test('allows requests matching configured PUBLIC_ORIGIN', async () => {
  const origOrigin = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = 'https://demo.example.com';
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/import`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://demo.example.com',
        },
        body: JSON.stringify([{ user_text: 'Allowed from public origin', assistant_text: 'OK' }]),
      });
      assert.equal(res.status, 200);
    });
  } finally {
    if (origOrigin !== undefined) process.env.PUBLIC_ORIGIN = origOrigin;
    else delete process.env.PUBLIC_ORIGIN;
  }
});
