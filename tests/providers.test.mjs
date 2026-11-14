import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'test-gemini-key-not-real';
process.env.TAVILY_API_KEY = 'test-tavily-key-not-real';
process.env.GEMINI_MODEL = 'gemini-test-model';
process.env.GEMINI_REQUESTS_PER_MINUTE = '600';
process.env.GEMINI_THINKING_LEVEL = 'low';
delete process.env.GEMINI_TEMPERATURE;

const gemini = await import('../src/llm/gemini.mjs?provider-tests');
const tavily = await import('../src/search/tavily.mjs?provider-tests');

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function sseResponse(parts, status = 200) {
  const data = `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts } }] })}\n\n`;
  return new Response(data, { status, headers: { 'content-type': 'text/event-stream' } });
}

test('replays the complete Gemini model parts including thoughtSignature', async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return sseResponse([{ functionCall: { name: 'web_search', args: { queries: [{ q: 'example' }] } }, thoughtSignature: 'signature-preserved' }]);
  };
  try {
    const first = await gemini.generateStream({
      contents: [{ role: 'user', parts: [{ text: 'Search.' }] }],
      systemInstruction: 'system', toolDeclaration: gemini.webSearchDeclaration,
    });
    assert.equal(first.modelParts[0].thoughtSignature, 'signature-preserved');
    await gemini.generateStream({
      contents: [
        { role: 'user', parts: [{ text: 'Search.' }] },
        { role: 'model', parts: first.modelParts },
        { role: 'user', parts: [{ functionResponse: { name: 'web_search', response: { ok: true } } }] },
      ],
      systemInstruction: 'system',
    });
    const replayed = calls[1].body.contents.find((item) => item.role === 'model');
    assert.deepEqual(replayed.parts, first.modelParts);
    assert.equal(calls[1].body.tools, undefined);
    assert.equal(calls[0].body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
    assert.equal(calls[0].body.generationConfig.temperature, undefined);
  } finally { globalThis.fetch = previousFetch; }
});


test('retries Gemini streaming without thinkingConfig after a supported 400 response', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    if (requests.length === 1) {
      return jsonResponse({ error: { message: 'Unknown name thinkingConfig' } }, 400);
    }
    return sseResponse([{ text: 'Thinking fallback accepted.' }]);
  };
  try {
    const result = await gemini.generateStream({
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      systemInstruction: 'system',
    });
    assert.equal(result.text, 'Thinking fallback accepted.');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
    assert.equal(requests[1].body.generationConfig.thinkingConfig, undefined);
  } finally { globalThis.fetch = previousFetch; }
});

test('retries Gemini structured extraction without thinkingConfig after a supported 400', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (requests.length === 1) {
      return jsonResponse({ error: { message: 'Invalid argument: thinkingConfig' } }, 400);
    }
    return jsonResponse({ candidates: [{ content: { parts: [{ text: '{"claims":[]}' }] } }] });
  };
  try {
    const result = await gemini.generateJson({ prompt: 'extract', schema: { type: 'OBJECT' } });
    assert.deepEqual(result, { claims: [] });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].generationConfig.thinkingConfig.thinkingLevel, 'LOW');
    assert.equal(requests[1].generationConfig.thinkingConfig, undefined);
  } finally { globalThis.fetch = previousFetch; }
});

test('retries one Gemini streaming 429 and records the retry', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  let retries = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: { message: 'quota exceeded' } }, 429, { 'retry-after': '0' });
    return sseResponse([{ text: 'Ready.' }]);
  };
  try {
    const result = await gemini.generateStream({
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }], systemInstruction: 'system',
      onRetry: () => { retries += 1; },
    });
    assert.equal(result.text, 'Ready.');
    assert.equal(result.retries, 1);
    assert.equal(calls, 2);
    assert.equal(retries, 1);
  } finally { globalThis.fetch = previousFetch; }
});

test('retries a Gemini structured-output 5xx once', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  let retries = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: { message: 'temporarily unavailable' } }, 503, { 'retry-after': '0' });
    return jsonResponse({ candidates: [{ content: { parts: [{ text: '{"claims":[]}' }] } }] });
  };
  try {
    const result = await gemini.generateJson({ prompt: 'extract', schema: { type: 'OBJECT' }, onRetry: () => { retries += 1; } });
    assert.deepEqual(result, { claims: [] });
    assert.equal(calls, 2);
    assert.equal(retries, 1);
  } finally { globalThis.fetch = previousFetch; }
});

test('rejects blocked and empty Gemini responses with a clear provider error', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] });
  try {
    await assert.rejects(() => gemini.generateJson({ prompt: 'blocked', schema: { type: 'OBJECT' } }), /blocked the prompt/);
  } finally { globalThis.fetch = previousFetch; }
  globalThis.fetch = async () => jsonResponse({ candidates: [] });
  try {
    await assert.rejects(() => gemini.generateJson({ prompt: 'empty', schema: { type: 'OBJECT' } }), /no candidates/);
  } finally { globalThis.fetch = previousFetch; }
});

test('uses accepted Tavily request fields and sends extract URLs as an array', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return jsonResponse({ results: [] });
  };
  try {
    await tavily.tavilySearch({ q: 'pricing', topic: 'general' });
    await tavily.tavilySearch({ q: 'announcements', topic: 'news', since: '2026-11-01' });
    await tavily.tavilyExtract('https://example.com/pricing');
    assert.equal(requests[0].body.topic, 'general');
    assert.equal(requests[0].body.start_date, undefined);
    assert.equal(requests[0].body.include_published_date, undefined);
    assert.equal(requests[0].body.safe_search, undefined);
    assert.equal(requests[1].body.start_date, '2026-11-01');
    assert.deepEqual(requests[2].body.urls, ['https://example.com/pricing']);
  } finally { globalThis.fetch = previousFetch; }
});


test('preserves Tavily news dates and extracted page text from provider responses', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const endpoint = String(url);
    requests.push({ endpoint, body: JSON.parse(options.body) });
    if (endpoint.endsWith('/search')) {
      return jsonResponse({ results: [{
        url: 'https://example.com/news',
        title: 'Release note',
        published_date: '2026-11-12',
        content: 'A short result snippet.',
      }] });
    }
    return jsonResponse({ results: [{
      url: 'https://example.com/news',
      raw_content: 'Full extracted page text.',
    }] });
  };
  try {
    const news = await tavily.tavilySearch({
      q: 'release announcement', topic: 'news', since: '2026-11-01',
    });
    const extracted = await tavily.tavilyExtract('https://example.com/news');
    assert.equal(requests[0].body.start_date, '2026-11-01');
    assert.equal(news.results[0].published_date, '2026-11-12');
    assert.equal(extracted.results[0].raw_content, 'Full extracted page text.');
  } finally { globalThis.fetch = previousFetch; }
});

test('retries a Tavily 5xx once and reports provider diagnostics', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  let retries = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ detail: { error: 'temporary service issue' } }, 502, { 'retry-after': '0' });
    return jsonResponse({ results: [{ url: 'https://example.com' }] });
  };
  try {
    const result = await tavily.tavilySearch({ q: 'example', onRetry: () => { retries += 1; } });
    assert.equal(result.results.length, 1);
    assert.equal(calls, 2);
    assert.equal(retries, 1);
  } finally { globalThis.fetch = previousFetch; }
});
