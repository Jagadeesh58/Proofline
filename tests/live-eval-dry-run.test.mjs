import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET_KEY = 'super-secret-dry-run-key-xyz987';

test('scripts/live-eval.mjs offline dry run records latency, call counts and budgets without leaking keys', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofline-live-eval-dry-run-'));
  const preloadPath = path.join(tmpDir, 'mock-fetch.mjs');
  const dbPath = path.join(tmpDir, 'dry-run-live.sqlite');
  const outDir = path.join(tmpDir, 'results');

  const preloadCode = `
    const SECRET_KEY = ${JSON.stringify(SECRET_KEY)};
    process.env.GEMINI_API_KEY = SECRET_KEY;
    process.env.TAVILY_API_KEY = '';
    process.env.SEARCH_BACKEND = 'replay';
    process.env.GEMINI_MODEL = 'gemini-3.8-flash';
    process.env.LIVE_EVAL_RUNS = '1';
    process.env.LIVE_EVAL_DELAY_MS = '0';
    process.env.LIVE_EVAL_LIMIT = '2';
    process.env.LIVE_EVAL_DB_PATH = ${JSON.stringify(dbPath)};
    process.env.LIVE_EVAL_OUT_DIR = ${JSON.stringify(outDir)};

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      const urlStr = String(url);
      const body = options.body ? JSON.parse(options.body) : {};

      if (urlStr.includes('streamGenerateContent')) {
        const contentsText = JSON.stringify(body.contents || []);
        const hasFunctionResponse = contentsText.includes('functionResponse');
        if (hasFunctionResponse) {
          const payload = {
            candidates: [{
              content: {
                role: 'model',
                parts: [{ text: 'HubSpot, Pipedrive, Zoho, Monday, and Freshsales CRM pricing reviewed.' }],
              },
            }],
          };
          return new Response('data: ' + JSON.stringify(payload) + '\\n\\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }

        if (contentsText.includes('3 November') || contentsText.includes('November 3')) {
          const payload = {
            candidates: [{
              content: {
                role: 'model',
                parts: [{ text: 'On 3 November you asked about Postgres hosting for a small backend. That advice remains correct today.' }],
              },
            }],
          };
          return new Response('data: ' + JSON.stringify(payload) + '\\n\\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }

        const payload = {
          candidates: [{
            content: {
              role: 'model',
              parts: [{
                functionCall: {
                  name: 'web_search',
                  args: {
                    queries: ['HubSpot CRM Starter monthly pricing'],
                    targets: [
                      { entity: 'HubSpot', checks: ['pricing'] },
                      { entity: 'Pipedrive', checks: ['pricing'] },
                      { entity: 'Zoho', checks: ['pricing'] },
                      { entity: 'Monday', checks: ['pricing'] },
                      { entity: 'Freshsales', checks: ['pricing'] },
                    ],
                  },
                  id: 'search-call-1',
                },
                thoughtSignature: 'dry-run-signature',
              }],
            },
          }],
        };
        return new Response('data: ' + JSON.stringify(payload) + '\\n\\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }

      if (urlStr.includes('generateContent')) {
        const payload = {
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  claims: [{
                    entity: 'HubSpot',
                    metric: 'pricing',
                    value: '$20/mo',
                    quote: 'HubSpot CRM Starter is $20 per user per month.',
                  }],
                }),
              }],
            },
          }],
        };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({}), { status: 200 });
    };
  `;

  fs.writeFileSync(preloadPath, preloadCode, 'utf8');

  try {
    const scriptPath = path.join(ROOT, 'scripts/live-eval.mjs');
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preloadPath).href, scriptPath], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });

    const fullOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
    assert.equal(result.status, 0, `Process exited with code ${result.status}:\n${fullOutput}`);

    // Assert that the secret API key is never printed
    assert.ok(!fullOutput.includes(SECRET_KEY), 'stdout/stderr must not leak the secret API key');

    // Assert stdout captures latency, call counts, budgets and first-token metrics
    assert.match(result.stdout, /Starting live evaluation: 2 questions/);
    assert.match(result.stdout, /Result: TTFT \d+ms, total \d+ms, searches \d+, extracts \d+, cards \d+/);
    assert.match(result.stdout, /Summary: 2\/2 succeeded \| Median TTFT: \d+ms \| Median Total: \d+ms/);

    // Assert the JSON results file was written with the captured metrics
    const outFiles = fs.readdirSync(outDir).filter((name) => name.endsWith('.json'));
    assert.equal(outFiles.length, 1, 'Expected exactly one output JSON file');
    const outputData = JSON.parse(fs.readFileSync(path.join(outDir, outFiles[0]), 'utf8'));

    assert.equal(outputData.totalQuestions, 2);
    assert.equal(outputData.successful, 2);
    assert.equal(outputData.failed, 0);
    assert.equal(typeof outputData.ttft.medianMs, 'number');
    assert.ok(outputData.ttft.medianMs >= 0, 'Median TTFT must be a non-negative number');
    assert.equal(typeof outputData.totalLatency.medianMs, 'number');
    assert.ok(outputData.totalLatency.medianMs > 0, 'Median total latency must be positive');

    assert.equal(outputData.results.length, 2);
    for (const item of outputData.results) {
      assert.equal(typeof item.firstTokenMs, 'number');
      assert.ok(item.firstTokenMs >= 0);
      assert.equal(typeof item.totalTimeMs, 'number');
      assert.ok(item.totalTimeMs > 0);
      assert.equal(typeof item.searchesRun, 'number');
      assert.equal(typeof item.extractsRun, 'number');
      assert.equal(typeof item.geminiCalls, 'number');
      assert.ok(item.geminiCalls >= 1);
      assert.equal(typeof item.sourcesCount, 'number');
      assert.equal(typeof item.cardsCount, 'number');
      assert.equal(item.error, null);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
