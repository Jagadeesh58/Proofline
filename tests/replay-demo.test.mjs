process.env.DEMO_MODE = '1';
process.env.SEARCH_BACKEND = 'replay';

import './test-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [{ Store }, { runTurn }, { resolveDatePhrase }] = await Promise.all([
  import('../src/memory/store.mjs'),
  import('../src/agent/run-turn.mjs'),
  import('../src/time/resolve.mjs'),
]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../');
const demoPath = path.join(root, 'src/seeds/demo-history.json');
const demoTurns = JSON.parse(fs.readFileSync(demoPath, 'utf8'));

function getSeededTurns(timezone = 'Asia/Kolkata') {
  const now = new Date();
  const mondayResolved = resolveDatePhrase(
    'On Monday we shortlisted 5 CRM tools for a 20-person sales team.',
    timezone,
    now,
  );
  const tuesdayResolved = resolveDatePhrase(
    'Last Tuesday I asked you about Postgres hosting.',
    timezone,
    now,
  );
  const mondayDate = mondayResolved.date || '2026-11-09';
  const tuesdayDate = tuesdayResolved.date || '2026-11-10';

  return demoTurns.map((item, idx) => {
    let createdAt = item.created_at;
    if (idx === 0) {
      createdAt = `${mondayDate}T08:30:00.000Z`;
    } else if (idx === 2) {
      createdAt = `${tuesdayDate}T08:30:00.000Z`;
    } else if (idx === 1) {
      createdAt = '2026-11-03T08:30:00.000Z';
    }
    return { ...item, created_at: createdAt, timezone, demo: true };
  });
}

test('official prompt 1 runs in replay mode with memory recall, cards, and citations', async () => {
  const store = new Store(':memory:');
  store.importTurns(getSeededTurns('Asia/Kolkata'), 'Asia/Kolkata');

  const events = [];
  let answerText = '';

  await runTurn({
    userText: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
    timezone: 'Asia/Kolkata',
    store,
    send: (type, data) => {
      events.push({ type, data });
      if (type === 'token' && data?.text) answerText += data.text;
    },
  });

  const memoryEvent = events.find((e) => e.type === 'memory');
  assert.ok(memoryEvent, 'Memory event must be emitted');
  assert.ok(memoryEvent.data.turns.length > 0, 'Must recall Monday CRM shortlist turn');

  const cardsEvent = events.find((e) => e.type === 'cards');
  assert.ok(cardsEvent, 'Cards event must be emitted');
  assert.ok(cardsEvent.data.cards.length >= 3, 'Must produce comparison cards for CRM entities');

  const sourcesEvent = events.find((e) => e.type === 'sources');
  assert.ok(sourcesEvent, 'Sources event must be emitted');
  assert.ok(sourcesEvent.data.sources.length > 0, 'Sources must be present');

  assert.match(answerText, /\[S\d+\]/, 'Answer commentary must contain numbered citations');
  assert.match(answerText, /HubSpot|Pipedrive/i, 'Answer must address shortlisted tools');
  store.close();
});

test('official prompt 2 runs in replay mode with date recall and verification', async () => {
  const store = new Store(':memory:');
  store.importTurns(getSeededTurns('Asia/Kolkata'), 'Asia/Kolkata');

  const events = [];
  let answerText = '';

  await runTurn({
    userText: 'What did I ask you on 3 November? Is your answer still correct today?',
    timezone: 'Asia/Kolkata',
    store,
    send: (type, data) => {
      events.push({ type, data });
      if (type === 'token' && data?.text) answerText += data.text;
    },
  });

  const memoryEvent = events.find((e) => e.type === 'memory');
  assert.ok(memoryEvent, 'Memory event must be emitted for 3 November query');
  const recalledQuestion = memoryEvent.data.turns[0].question || memoryEvent.data.turns[0].user_text;
  assert.ok(recalledQuestion.includes('PostgreSQL'), 'Recalled turn must match 3 November question');

  const cardsEvent = events.find((e) => e.type === 'cards');
  assert.ok(cardsEvent, 'Cards event must be emitted');

  assert.match(answerText, /3 November/i, 'Answer must cite 3 November');
  assert.match(answerText, /\[S\d+\]/, 'Answer must contain citations');
  store.close();
});

test('official prompt 3 runs in replay mode with relative date recall and host checks', async () => {
  const store = new Store(':memory:');
  store.importTurns(getSeededTurns('Asia/Kolkata'), 'Asia/Kolkata');

  const events = [];
  let answerText = '';

  await runTurn({
    userText: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
    timezone: 'Asia/Kolkata',
    store,
    send: (type, data) => {
      events.push({ type, data });
      if (type === 'token' && data?.text) answerText += data.text;
    },
  });

  const memoryEvent = events.find((e) => e.type === 'memory');
  assert.ok(memoryEvent, 'Memory event must be emitted for Last Tuesday query');

  const cardsEvent = events.find((e) => e.type === 'cards');
  assert.ok(cardsEvent, 'Cards event must be emitted');
  const neonCard = cardsEvent.data.cards.find((c) => c.entity.toLowerCase().includes('neon'));
  assert.ok(neonCard, 'Neon card must be present');

  assert.match(answerText, /Neon|Supabase/i, 'Answer must discuss Postgres hosts');
  assert.match(answerText, /\[S\d+\]/, 'Answer must contain citations');
  store.close();
});
