import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ReplayCorpus, buildAblationInputs } from '../src/search/replay.mjs';

test('reworded replay searches reach the same fixture page', () => {
  const corpus = new ReplayCorpus();
  const first = corpus.search({ q: 'HubSpot CRM Starter monthly pricing per user' });
  const reworded = corpus.search({ q: 'HubSpot Starter cost per seat monthly plan' });
  assert.ok(first.length > 0);
  assert.equal(first[0].url, reworded[0].url);
  assert.ok(first.every((item) => item.raw_content.toLowerCase().includes('fixture')));
  corpus.close();
});

test('news replay applies each query own since date and provider date', () => {
  const corpus = new ReplayCorpus();
  const neon = corpus.search({ q: 'Neon Postgres feature announcement', topic: 'news', since: '2026-11-06' });
  const hubspot = corpus.search({ q: 'HubSpot CRM feature announcement', topic: 'news', since: '2026-11-06' });
  assert.equal(neon.length, 1);
  assert.equal(neon[0].published_date, '2026-11-08');
  assert.equal(hubspot.some((item) => item.url === 'https://hubspot.com/changelog/fixture-2026-11-05'), false);
  corpus.close();
});

test('replay extracts only an exact corpus URL', () => {
  const corpus = new ReplayCorpus();
  const found = corpus.extract('https://hubspot.com/pricing');
  assert.match(found.raw_content, /\$20 per user per month/);
  assert.equal(corpus.extract('https://hubspot.com/other'), null);
  corpus.close();
});

test('ablation arms receive identical evidence while removing architecture features by arm', () => {
  const history = [{ user_text: 'Earlier question', assistant_text: 'Earlier answer', created_at_utc: '2026-10-20T10:00:00Z' }];
  const evidence = [{ url: 'https://example.test/pricing', excerpt: 'Fixture $10 monthly' }];
  const cards = [{ status: 'Changed' }];
  const arms = buildAblationInputs({ userText: 'Is this the same?', history, evidence, cards });
  assert.deepEqual(arms.A.evidence, arms.B.evidence);
  assert.deepEqual(arms.B.evidence, arms.C.evidence);
  assert.equal(arms.A.history.length, 0);
  assert.equal(arms.B.history.length, 1);
  assert.equal(arms.C.controls.assignedCards[0].status, 'Changed');
  assert.equal(arms.C.controls.figureGate, true);
});


test('ablation replay cases have stable retrieval and natural-query evidence coverage', () => {
  const matrix = JSON.parse(fs.readFileSync(new URL('../evals/cases/ablation.json', import.meta.url), 'utf8'));
  const corpus = new ReplayCorpus();
  for (const item of matrix.cases) {
    const results = corpus.search({ q: item.query, limit: 5 });
    assert.ok(results.some((page) => page.url === item.expected_url), `${item.id}: expected evidence is reachable`);
    if (item.kind === 'retrieval-stability') {
      const reworded = corpus.search({ q: item.reworded_query, limit: 5 });
      assert.ok(reworded.length > 0, `${item.id}: reworded query has results`);
      assert.equal(reworded[0].url, results[0].url, `${item.id}: top result is stable`);
      assert.equal(results[0].url, item.expected_url, `${item.id}: recorded top result is expected page`);
    }
  }
  corpus.close();
});
