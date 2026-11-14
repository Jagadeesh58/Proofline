import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.SEARCH_BACKEND = 'replay';
process.env.GEMINI_API_KEY = 'test-key';

const [{ executeLiveEvaluation }] = await Promise.all([
  import('../scripts/live-eval.mjs'),
]);

test('live-eval writes timestamped file and preserves success in live-latest.json', async () => {
  const tmpDir = path.resolve('data/test-live-eval');
  fs.mkdirSync(tmpDir, { recursive: true });

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const payload = 'data: ' + JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Calculated annual spend is $3,600.' }] } }],
    }) + '\n\ndata: [DONE]\n\n';
    return new Response(payload, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  try {
    const testQuestions = [
      {
        id: 'stable-1',
        category: 'stable_concept',
        prompt: 'If a sales team has 20 seats and each seat costs $15 per month billed annually, what is the annual spend?',
        expectedType: 'arithmetic',
      },
    ];

    const result = await executeLiveEvaluation({
      questionsList: testQuestions,
      outDir: tmpDir,
      runsPerQuestion: 1,
      writeLatest: true,
    });

    assert.ok(fs.existsSync(result.timestampedPath), 'Timestamped result file must exist');
    assert.ok(fs.existsSync(result.latestPath), 'live-latest.json must exist');
    const latestData = JSON.parse(fs.readFileSync(result.latestPath, 'utf8'));
    assert.equal(latestData.totalQuestions, 1);
    assert.equal(latestData.results.length, 1);
    const q0 = latestData.results[0];
    assert.equal(q0.id, 'stable-1');
    assert.ok('firstTokenMs' in q0);
    assert.ok('totalTimeMs' in q0);
    assert.ok('geminiCalls' in q0);
    assert.ok('searchesRun' in q0);
    assert.ok('extractsRun' in q0);
    assert.ok('sourcesCount' in q0);
    assert.ok('answerProduced' in q0);

    const sentinel = { ...latestData, successful: 1, sentinel: true };
    fs.writeFileSync(result.latestPath, JSON.stringify(sentinel), 'utf8');

    const failedSummary = {
      date: new Date().toISOString(),
      successful: 0,
      totalQuestions: 1,
      results: [{ id: 'fail-case', error: 'Simulated failure' }],
    };
    const mockTimestamp = path.join(tmpDir, 'live-failed-test.json');
    fs.writeFileSync(mockTimestamp, JSON.stringify(failedSummary), 'utf8');
    if (failedSummary.successful > 0) {
      fs.writeFileSync(result.latestPath, JSON.stringify(failedSummary), 'utf8');
    }

    const preservedLatest = JSON.parse(fs.readFileSync(result.latestPath, 'utf8'));
    assert.equal(preservedLatest.sentinel, true, 'Successful live-latest.json was not overwritten by failed run');
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
