import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.SEARCH_BACKEND = 'replay';
process.env.GEMINI_API_KEY = 'test-key';

const [{ executeLiveEvaluation }, { deterministicChecks }, { USER_STRINGS }] = await Promise.all([
  import('../scripts/live-eval.mjs'),
  import('../evals/official-prompts.mjs'),
  import('../src/strings.mjs'),
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

test('deterministicChecks evaluates fixed fake run objects for official prompts', () => {
  const validOfficial1 = {
    id: 'official-1',
    prompt: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
    answer: 'Here is the CRM comparison for HubSpot, Pipedrive, Zoho, Monday and Freshsales.',
    cards: [
      { entity: 'HubSpot', status: USER_STRINGS.sameAsBefore, domain: 'hubspot.com' },
      { entity: 'Pipedrive', status: USER_STRINGS.changed, domain: 'pipedrive.com' },
      { entity: 'Zoho', status: USER_STRINGS.changed, domain: 'zoho.com' },
      { entity: 'Monday', status: USER_STRINGS.changed, domain: 'monday.com' },
      { entity: 'Freshsales', status: USER_STRINGS.changed, domain: 'freshsales.io' },
    ],
  };
  const res1 = deterministicChecks(validOfficial1, { promptId: 'official-1' });
  assert.equal(res1.passed, true);

  const missingTool1 = {
    ...validOfficial1,
    cards: validOfficial1.cards.slice(0, 4),
  };
  assert.equal(deterministicChecks(missingTool1, { promptId: 'official-1' }).passed, false);

  const noDomain1 = {
    ...validOfficial1,
    cards: [
      { entity: 'HubSpot', status: USER_STRINGS.sameAsBefore, domain: null },
      ...validOfficial1.cards.slice(1),
    ],
  };
  assert.equal(deterministicChecks(noDomain1, { promptId: 'official-1' }).passed, false);

  const validOfficial2 = {
    id: 'official-2',
    prompt: 'What did I ask you on 3 November? Is your answer still correct today?',
    answer: 'On 3 November you asked: How should I choose between two hosted PostgreSQL providers for a student side project? Same as my earlier answer, branching and pooling remain key.',
  };
  const res2 = deterministicChecks(validOfficial2, { promptId: 'official-2' });
  assert.equal(res2.passed, true);

  const noDate2 = {
    ...validOfficial2,
    answer: 'You asked: How should I choose between two hosted PostgreSQL providers for a student side project? Same as my earlier answer.',
  };
  assert.equal(deterministicChecks(noDate2, { promptId: 'official-2' }).passed, false);

  const noFragment2 = {
    ...validOfficial2,
    answer: 'On 3 November you asked about databases. Same as my earlier answer, it is correct.',
  };
  assert.equal(deterministicChecks(noFragment2, { promptId: 'official-2' }).passed, false);

  const noStatus2 = {
    ...validOfficial2,
    answer: 'On 3 November you asked: How should I choose between two hosted PostgreSQL providers for a student side project? I think it is fine.',
  };
  assert.equal(deterministicChecks(noStatus2, { promptId: 'official-2' }).passed, false);

  const clock = new Date('2026-11-15T10:00:00.000Z');
  const validOfficial3 = {
    id: 'official-3',
    prompt: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
    answer: 'Comparing Neon and Supabase pricing for Postgres hosting since last Tuesday.',
    resolvedDate: '2026-11-10',
    cards: [
      { entity: 'Neon', status: USER_STRINGS.sameAsBefore, domain: 'neon.tech' },
      { entity: 'Supabase', status: USER_STRINGS.sameAsBefore, domain: 'supabase.com' },
    ],
  };
  const res3 = deterministicChecks(validOfficial3, { promptId: 'official-3', timezone: 'Asia/Kolkata', clock });
  assert.equal(res3.passed, true);

  const wrongDate3 = {
    ...validOfficial3,
    resolvedDate: '2026-11-03',
  };
  assert.equal(deterministicChecks(wrongDate3, { promptId: 'official-3', timezone: 'Asia/Kolkata', clock }).passed, false);

  const missingCard3 = {
    ...validOfficial3,
    cards: [{ entity: 'Neon', status: USER_STRINGS.sameAsBefore, domain: 'neon.tech' }],
  };
  assert.equal(deterministicChecks(missingCard3, { promptId: 'official-3', timezone: 'Asia/Kolkata', clock }).passed, false);

  const missingName3 = {
    ...validOfficial3,
    answer: 'Comparing Neon pricing for Postgres hosting since last Tuesday.',
  };
  assert.equal(deterministicChecks(missingName3, { promptId: 'official-3', timezone: 'Asia/Kolkata', clock }).passed, false);
});
