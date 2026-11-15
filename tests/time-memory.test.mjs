import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/memory/store.mjs';
import { recallForTurn, topicWords } from '../src/agent/recall.mjs';
import { resolveDatePhrase, resolveDateRange, resolveSinceDate, localDateFromUtc, isValidTimezone } from '../src/time/resolve.mjs';

const NOW = new Date('2026-11-12T12:00:00.000Z');

test('validates IANA timezones and converts UTC using the requested zone', () => {
  assert.equal(isValidTimezone('Asia/Kolkata'), true);
  assert.equal(isValidTimezone('Not/A_Timezone'), false);
  assert.equal(localDateFromUtc('2026-11-12T20:00:00.000Z', 'Asia/Kolkata'), '2026-11-13');
  assert.equal(localDateFromUtc('2026-11-12T20:00:00.000Z', 'America/Los_Angeles'), '2026-11-12');
});

test('resolves last Tuesday and conversational Monday to the past', () => {
  assert.equal(resolveDatePhrase('What did I ask you last Tuesday?', 'Asia/Kolkata', NOW).date, '2026-11-10');
  assert.equal(resolveDatePhrase('On Monday we shortlisted five CRM tools.', 'Asia/Kolkata', NOW).date, '2026-11-09');
  assert.equal(resolveDatePhrase('What did we discuss on Monday?', 'Asia/Kolkata', NOW).date, '2026-11-09');
  assert.equal(resolveDatePhrase('Monday', 'Asia/Kolkata', NOW).date, '2026-11-09');
});

test('resolves upcoming dates for forecast-like requests', () => {
  assert.equal(resolveDatePhrase('What is the weather on Friday?', 'Asia/Kolkata', NOW).date, '2026-11-13');
  assert.equal(resolveDatePhrase('Show the schedule for Sunday.', 'Asia/Kolkata', NOW).date, '2026-11-15');
  assert.equal(resolveDatePhrase('What is the weather on Friday?', 'Asia/Kolkata', NOW).kind, 'weekday');
});

test('resolves relative dates and most recent calendar dates', () => {
  assert.equal(resolveDatePhrase('What did I ask yesterday?', 'Asia/Kolkata', NOW).date, '2026-11-11');
  assert.equal(resolveDatePhrase('What did I ask three days ago?', 'Asia/Kolkata', NOW).date, '2026-11-09');
  assert.equal(resolveDatePhrase('What did I ask on 3 November?', 'Asia/Kolkata', NOW).date, '2026-11-03');
  assert.equal(resolveDatePhrase('What did I ask on November 3?', 'Asia/Kolkata', NOW).date, '2026-11-03');
  assert.equal(resolveDatePhrase('What did I ask on November 3, 2025?', 'Asia/Kolkata', NOW).date, '2025-11-03');
});

test('does not treat ordinary month-like words as dates', () => {
  for (const text of ['May I ask a question?', 'the second option', 'the match sat at 5 pm', 'march on through the list']) {
    assert.equal(resolveDatePhrase(text, 'Asia/Kolkata', NOW).kind, 'none', text);
  }
});

test('keeps numeric day/month strings ambiguous', () => {
  const result = resolveDatePhrase('What did I ask on 3/11?', 'Asia/Kolkata', NOW);
  assert.equal(result.kind, 'ambiguous');
  assert.equal(result.matchedText, '3/11');
});

test('resolves the explicit calendar date before the trailing word today', () => {
  assert.equal(resolveDatePhrase('What did I ask you on 3 November? Is your answer still correct today?', 'Asia/Kolkata', NOW).date, '2026-11-03');
});

test('does not interpret vendor names and seat ranges as dates', () => {
  for (const text of [
    'Compare monday.com and Pipedrive pricing',
    'Is Monday CRM cheaper than HubSpot?',
    'Is it cheaper for 10-20 seats?',
    'We need 5-10 people on the plan',
    'What is one half of 1/2 of the total?',
  ]) assert.equal(resolveDatePhrase(text, 'Asia/Kolkata', NOW).kind, 'none', text);
});

test('prefers an ISO date over nearby version numbers and weekday words', () => {
  assert.equal(resolveDatePhrase('What changed in Postgres 17 on 2026-11-09?', 'Asia/Kolkata', NOW).date, '2026-11-09');
});

test('resolves last week, this week and numbered-week ranges', () => {
  assert.deepEqual(resolveDateRange('any news since last week?', 'Asia/Kolkata', NOW), {
    from: '2026-11-02', to: '2026-11-08',
  });
  assert.deepEqual(resolveDateRange('what did we discuss this week?', 'Asia/Kolkata', NOW), {
    from: '2026-11-09', to: '2026-11-15',
  });
  assert.deepEqual(resolveDateRange('what did we discuss two weeks ago?', 'Asia/Kolkata', NOW), {
    from: '2026-10-26', to: '2026-11-01',
  });
});

test('resolves only explicit since/after/from dates for news filters', () => {
  assert.equal(resolveSinceDate('any news since last week?', 'Asia/Kolkata', NOW), '2026-11-05');
  assert.equal(resolveSinceDate('show changes since Monday', 'Asia/Kolkata', NOW), '2026-11-09');
  assert.equal(resolveSinceDate('show changes from 2026-11-09', 'Asia/Kolkata', NOW), '2026-11-09');
  assert.equal(resolveSinceDate('since then', 'Asia/Kolkata', NOW), null);
  assert.equal(resolveSinceDate('since?', 'Asia/Kolkata', NOW), null);
});

test('asks for clarification when same-priority calendar dates conflict', () => {
  const result = resolveDatePhrase('Compare what I asked on 3 November and 4 November.', 'Asia/Kolkata', NOW);
  assert.equal(result.kind, 'multiple');
  assert.equal(result.date, null);
});

test('topic extraction removes recall framing and keeps useful terms', () => {
  assert.deepEqual(topicWords('the one where you recommended Neon'), ['recommended', 'neon']);
  assert.deepEqual(topicWords('has any pricing changed since then about Neon hosting'), ['pricing', 'neon', 'hosting']);
});

test('date recall returns exact imported question and preserves original generation date', () => {
  const store = new Store(':memory:');
  const imported = store.importTurn({
    user_text: 'Compare Neon and Supabase for a Postgres project.',
    assistant_text: 'I recommended reviewing Neon and Supabase for branching and pooling.',
    created_at: '2026-11-09T10:00:00.000Z',
    source_created_at: '2026-10-20T10:00:00.000Z',
    timezone: 'Asia/Kolkata',
  });
  store.updateTurn(imported.id, { claims_status: 'done' });
  const recall = recallForTurn({ store, userText: 'What did I ask you on Monday?', timezone: 'Asia/Kolkata', now: NOW });
  assert.equal(recall.recalled.length, 1);
  assert.equal(recall.memory[0].question, 'Compare Neon and Supabase for a Postgres project.');
  assert.match(recall.memory[0].displayed_at, /9 Nov 2026/);
  assert.match(recall.memory[0].originally_generated_at, /20 Oct 2026/);
  store.close();
});

test('topic recall does not recall the currently streaming turn', () => {
  const store = new Store(':memory:');
  const old = store.importTurn({
    user_text: 'Which hosting platform did you recommend for Neon?',
    assistant_text: 'I recommended Neon for the database hosting comparison.',
    created_at: '2026-11-04T10:00:00.000Z', timezone: 'Asia/Kolkata',
  });
  store.updateTurn(old.id, { claims_status: 'done' });
  store.createTurn({ userText: 'the one where you recommended Neon', timezone: 'Asia/Kolkata', now: NOW });
  const recall = recallForTurn({ store, userText: 'the one where you recommended Neon', timezone: 'Asia/Kolkata', now: NOW });
  assert.equal(recall.recalled.length, 1);
  assert.equal(recall.recalled[0].id, old.id);
  store.close();
});

test('weather-on-Friday question shows no recall block', () => {
  const store = new Store(':memory:');
  const old = store.importTurn({ user_text: 'What was the earlier weather?', assistant_text: 'A previous question.', created_at: '2026-11-04T10:00:00.000Z' });
  store.updateTurn(old.id, { claims_status: 'done' });
  const recall = recallForTurn({ store, userText: 'What is the weather on Friday?', timezone: 'Asia/Kolkata', now: NOW });
  assert.equal(recall.recalled.length, 0);
  assert.equal(recall.memory.length, 0);
  assert.equal(recall.fact, '0 turns found for 2026-11-13');
  store.close();
});

test('a past date with no matching conversation is passed to the model as a zero-match fact', () => {
  const store = new Store(':memory:');
  const recall = recallForTurn({
    store, userText: 'What did I ask you on 3 November?', timezone: 'Asia/Kolkata', now: NOW,
  });
  assert.equal(recall.recalled.length, 0);
  assert.equal(recall.memory.length, 0);
  assert.equal(recall.fact, '0 turns found for 2026-11-03');
  store.close();
});

test('imports keep missing fields missing and mark an unknown generation date', () => {
  const store = new Store(':memory:');
  const imported = store.importTurn({ user_text: 'Question without source date.' }, 'Asia/Kolkata');
  assert.equal(imported.user_text, 'Question without source date.');
  assert.equal(imported.assistant_text, null);
  assert.equal(imported.source_created_at_utc, null);
  assert.equal(imported.origin, 'imported');
  store.close();
});

test('an imported turn can have a display timestamp distinct from its generation timestamp', () => {
  const store = new Store(':memory:');
  const imported = store.importTurn({
    user_text: 'A demo question.', assistant_text: 'A demo answer.',
    created_at: '2026-11-09T10:00:00Z', source_created_at: '2026-10-20T10:00:00Z',
  }, 'Asia/Kolkata');
  assert.equal(imported.local_date, '2026-11-09');
  assert.equal(imported.source_created_at_utc, '2026-10-20T10:00:00.000Z');
  store.close();
});

test('transactional imports roll back the whole batch if a date is invalid', () => {
  const store = new Store(':memory:');
  assert.throws(() => store.importTurns([
    { user_text: 'valid row', created_at: '2026-11-01T00:00:00Z' },
    { user_text: 'invalid row', created_at: 'not-a-date' },
  ]), /valid date/);
  assert.equal(store.listTurns(10).length, 0);
  store.close();
});

test('boot sweep marks unfinished live turns interrupted and claim extraction failed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-agent-test-'));
  const filename = path.join(directory, 'store.sqlite');
  let store = new Store(filename);
  const turn = store.createTurn({ userText: 'An unfinished turn', timezone: 'Asia/Kolkata', now: NOW });
  store.close();
  store = new Store(filename);
  const recovered = store.getTurn(turn.id);
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.claims_status, 'failed');
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('uses only compact recent-turn context and keeps each turn once', async () => {
  const { buildSystemContext, conversationContents } = await import('../src/agent/context.mjs');
  const store = new Store(':memory:');
  for (let index = 0; index < 8; index += 1) {
    const turn = store.importTurn({
      user_text: `Question ${index} ${'q'.repeat(900)}`,
      assistant_text: `Answer ${index} ${'a'.repeat(2000)}`,
      created_at: new Date(Date.UTC(2026, 10, index + 1)).toISOString(),
    });
    store.updateTurn(turn.id, { status: 'completed', claims_status: 'done' });
  }
  const context = buildSystemContext({ timezone: 'Asia/Kolkata', recall: { memory: [], fact: null }, store });
  assert.equal(context.contextTurns.length, 8);
  assert.ok(context.contextTurns.every((turn) => turn.question.length <= 600 && turn.answer.length <= 1500));
  assert.doesNotMatch(context.systemText, /Recent conversation context/);
  const contents = conversationContents(context.contextTurns, 'New question');
  assert.equal(contents.filter((item) => item.parts[0].text.includes('Question 0')).length, 1);
  assert.equal(contents.at(-1).parts[0].text, 'New question');
  store.close();
});

test('refreshes topic recall after a streaming turn transitions to stored status', () => {
  const store = new Store(':memory:');
  const turn = store.createTurn({ userText: 'What is index design?', timezone: 'Asia/Kolkata' });
  store.appendAssistantText(turn.id, 'We discussed partial PostgreSQL indexes and query planning.');
  assert.equal(store.searchByTopic(['postgresql'], 5).length, 0);
  store.updateTurn(turn.id, { status: 'completed', claims_status: 'done' });
  assert.equal(store.searchByTopic(['postgresql'], 5).length, 1);
  store.close();
});

test('does not put marked demo history into recent model context', () => {
  const store = new Store(':memory:');
  store.importTurn({ user_text: 'Demo conversation', assistant_text: 'Synthetic record', created_at: '2026-11-09T10:00:00Z', demo: true });
  store.importTurn({ user_text: 'Real conversation', assistant_text: 'Real record', created_at: '2026-11-10T10:00:00Z' });
  assert.deepEqual(store.lastTurns(8).map((turn) => turn.user_text), ['Real conversation']);
  assert.equal(store.searchByDate('2026-11-09').length, 1);
  store.close();
});


test('does not invent an imported generation date from its display timestamp', () => {
  const store = new Store(':memory:');
  const imported = store.importTurn({ user_text: 'Question', assistant_text: 'Answer', created_at: '2026-11-09T10:00:00Z' });
  assert.equal(imported.source_created_at_utc, null);
  const recall = recallForTurn({ store, userText: 'What did I ask on 9 November?', timezone: 'Asia/Kolkata', now: NOW });
  assert.equal(recall.memory[0].generation_date_unknown, true);
  assert.equal(recall.memory[0].originally_generated_at, null);
  assert.match(recall.memory[0].displayed_at, /9 Nov/);
  store.close();
});

test('ordinary related topic questions do not emit a recall memory event', () => {
  const store = new Store(':memory:');
  store.importTurn({ user_text: 'What is HubSpot Starter pricing?', assistant_text: 'HubSpot offers a Starter plan.', created_at: '2026-11-01T10:00:00Z' });
  const ordinary = recallForTurn({ store, userText: 'How does HubSpot Starter compare with Pipedrive?', timezone: 'Asia/Kolkata', now: NOW });
  assert.ok(ordinary.recalled.length);
  assert.equal(ordinary.memory.length, 0);
  const framed = recallForTurn({ store, userText: 'The one where you recommended HubSpot Starter', timezone: 'Asia/Kolkata', now: NOW });
  assert.equal(framed.memory.length, 1);
  store.close();
});

test('recall framing recognises ten natural references and ignores ordinary overlap', () => {
  const store = new Store(':memory:');
  store.importTurn({ user_text: 'We discussed Neon hosting pricing and backups.', assistant_text: 'Neon was a useful option.', created_at: '2026-11-01T10:00:00Z' });
  const phrases = [
    'What did I ask about Neon?', 'What was the Neon option from earlier?', 'Tell me what we discussed about Neon.',
    'You previously recommended Neon.', 'The one where you recommended Neon.', 'Remind me about Neon.',
    'What did I ask you last time about Neon?', 'We talked about Neon before.', 'You told me about Neon earlier.',
    'Has any Neon pricing changed since then?',
  ];
  for (const phrase of phrases) {
    const recall = recallForTurn({ store, userText: phrase, timezone: 'Asia/Kolkata', now: NOW });
    assert.equal(recall.memory.length, 1, phrase);
  }
  const plain = recallForTurn({ store, userText: 'Does Neon support branching?', timezone: 'Asia/Kolkata', now: NOW });
  assert.equal(plain.memory.length, 0);
  store.close();
});

test('does not silently substitute demo history from another date for weekday recall', () => {
  const store = new Store(':memory:');
  store.importTurn({ user_text: 'Demo Tuesday question.', assistant_text: 'Demo response.', created_at: '2026-11-03T10:00:00Z', demo: true });
  const recall = recallForTurn({ store, userText: 'What did I ask on Tuesday?', timezone: 'Asia/Kolkata', now: NOW });
  assert.equal(recall.recalled.length, 0);
  store.close();
});

test('same-day recall finds turns created earlier today', () => {
  const store = new Store(':memory:');
  store.importTurn({ user_text: 'What are the main CRM options?', assistant_text: 'HubSpot and Salesforce.', created_at: '2026-11-12T06:00:00Z' });
  const recall = recallForTurn({ store, userText: 'What did I ask today?', timezone: 'Asia/Kolkata', now: NOW });
  assert.equal(recall.recalled.length, 1);
  assert.match(recall.memory[0].question, /CRM options/);
  store.close();
});

test('current-week recall finds turns created during the current week', () => {
  const store = new Store(':memory:');
  // 2026-11-09 is Monday of the current week (NOW is Thursday 2026-11-12)
  store.importTurn({ user_text: 'Shortlisted CRM tools.', assistant_text: '5 CRM tools.', created_at: '2026-11-09T08:00:00Z' });
  const recall = recallForTurn({ store, userText: 'What did I ask this week?', timezone: 'Asia/Kolkata', now: NOW });
  assert.equal(recall.recalled.length, 1);
  assert.match(recall.memory[0].question, /Shortlisted CRM/);
  store.close();
});

test('resolves relative dates forward and backward with strict week bounds', () => {
  // NOW is Thursday 2026-11-12
  assert.equal(resolveDatePhrase('next Monday', 'Asia/Kolkata', NOW).date, '2026-11-16');
  assert.equal(resolveDatePhrase('next Friday', 'Asia/Kolkata', NOW).date, '2026-11-13');
  assert.equal(resolveDatePhrase('this Monday', 'Asia/Kolkata', NOW).date, '2026-11-09');
  assert.equal(resolveDatePhrase('last Monday', 'Asia/Kolkata', NOW).date, '2026-11-09');
  assert.equal(resolveDatePhrase('3 Nov', 'Asia/Kolkata', NOW).date, '2026-11-03');
  assert.equal(resolveDatePhrase('Nov 3', 'Asia/Kolkata', NOW).date, '2026-11-03');
  assert.equal(resolveSinceDate('Since 5 November 2024', 'Asia/Kolkata', NOW), '2024-11-05');
  assert.equal(resolveDatePhrase('a week ago', 'Asia/Kolkata', NOW).date, '2026-11-05');
  assert.equal(resolveDatePhrase('last month', 'Asia/Kolkata', NOW).range.from, '2026-10-01');
  assert.equal(resolveDatePhrase('last month', 'Asia/Kolkata', NOW).range.to, '2026-10-31');
  assert.equal(resolveDatePhrase('two Mondays ago', 'Asia/Kolkata', NOW).date, '2026-11-02');
  assert.equal(resolveDatePhrase('on the 3rd', 'Asia/Kolkata', NOW).date, '2026-11-03');
  assert.equal(resolveDatePhrase('the 3rd', 'Asia/Kolkata', NOW).date, '2026-11-03');
  assert.equal(resolveSinceDate('since last month', 'Asia/Kolkata', NOW), '2026-10-01');
  assert.equal(resolveSinceDate('since a week ago', 'Asia/Kolkata', NOW), '2026-11-05');
});

test('store integrity check validates schema and foreign keys', () => {
  const store = new Store(':memory:');
  const result = store.integrityCheck();
  assert.equal(result.ok, true);
  assert.equal(result.integrity, 'ok');
  assert.deepEqual(result.foreignKeys, []);
  store.close();
});

test('table-driven tests: month-only phrases', () => {
  const monthPhrases = [
    { phrase: 'What did I ask you in October?', expected: { from: '2026-10-01', to: '2026-10-31' } },
    { phrase: 'in October', expected: { from: '2026-10-01', to: '2026-10-31' } },
    { phrase: 'last October', expected: { from: '2026-10-01', to: '2026-10-31' } },
    { phrase: 'What did we discuss last October?', expected: { from: '2026-10-01', to: '2026-10-31' } },
    { phrase: 'What did I ask earlier this month?', expected: { from: '2026-11-01', to: '2026-11-12' } },
    { phrase: 'earlier this month', expected: { from: '2026-11-01', to: '2026-11-12' } },
    { phrase: 'in November', expected: { from: '2026-11-01', to: '2026-11-30' } },
    { phrase: 'What was discussed in November?', expected: { from: '2026-11-01', to: '2026-11-30' } },
    { phrase: 'last month', expected: { from: '2026-10-01', to: '2026-10-31' } },
    { phrase: 'What did I ask last month?', expected: { from: '2026-10-01', to: '2026-10-31' } },
    { phrase: 'this month', expected: { from: '2026-11-01', to: '2026-11-30' } },
    { phrase: 'in September', expected: { from: '2026-09-01', to: '2026-09-30' } },
    { phrase: 'in August', expected: { from: '2026-08-01', to: '2026-08-31' } },
    { phrase: 'during October', expected: { from: '2026-10-01', to: '2026-10-31' } },
    { phrase: 'in October 2025', expected: { from: '2025-10-01', to: '2025-10-31' } },
    { phrase: 'October 2024', expected: { from: '2024-10-01', to: '2024-10-31' } },
    { phrase: 'in December', expected: { from: '2025-12-01', to: '2025-12-31' } },
  ];
  for (const item of monthPhrases) {
    const res = resolveDatePhrase(item.phrase, 'Asia/Kolkata', NOW);
    assert.deepEqual(res.range, item.expected, `Failed for phrase: "${item.phrase}"`);
    assert.deepEqual(resolveDateRange(item.phrase, 'Asia/Kolkata', NOW), item.expected);
  }
});

test('table-driven tests: relative expressions', () => {
  const relativeExpressions = [
    { phrase: 'What did I ask this morning?', expectedDate: '2026-11-12' },
    { phrase: 'this morning', expectedDate: '2026-11-12' },
    { phrase: 'I asked this morning about CRM', expectedDate: '2026-11-12' },
    { phrase: 'the day before yesterday', expectedDate: '2026-11-10' },
    { phrase: 'What did we talk about the day before yesterday?', expectedDate: '2026-11-10' },
    { phrase: 'day before yesterday', expectedDate: '2026-11-10' },
    { phrase: 'yesterday', expectedDate: '2026-11-11' },
    { phrase: 'What did I ask yesterday?', expectedDate: '2026-11-11' },
    { phrase: '3 days ago', expectedDate: '2026-11-09' },
    { phrase: 'three days ago', expectedDate: '2026-11-09' },
    { phrase: '1 day ago', expectedDate: '2026-11-11' },
    { phrase: 'a day ago', expectedDate: '2026-11-11' },
    { phrase: 'one day ago', expectedDate: '2026-11-11' },
    { phrase: '5 days ago', expectedDate: '2026-11-07' },
    { phrase: 'a couple of days ago', expectedDate: '2026-11-10' },
    { phrase: 'couple of days ago', expectedDate: '2026-11-10' },
    { phrase: 'What did I ask a couple of days ago?', expectedDate: '2026-11-10' },
    { phrase: 'two weeks ago', expectedRange: { from: '2026-10-26', to: '2026-11-01' } },
    { phrase: '2 weeks ago', expectedRange: { from: '2026-10-26', to: '2026-11-01' } },
    { phrase: '3 weeks ago', expectedRange: { from: '2026-10-19', to: '2026-10-25' } },
    { phrase: 'a week ago', expectedDate: '2026-11-05' },
    { phrase: 'one week ago', expectedDate: '2026-11-05' },
    { phrase: 'last weekend', expectedRange: { from: '2026-11-07', to: '2026-11-08' } },
    { phrase: 'What did we discuss last weekend?', expectedRange: { from: '2026-11-07', to: '2026-11-08' } },
    { phrase: '1 month ago', expectedRange: { from: '2026-10-01', to: '2026-10-31' } },
    { phrase: 'one month ago', expectedRange: { from: '2026-10-01', to: '2026-10-31' } },
    { phrase: '2 months ago', expectedRange: { from: '2026-09-01', to: '2026-09-30' } },
    { phrase: 'two months ago', expectedRange: { from: '2026-09-01', to: '2026-09-30' } },
    { phrase: '3 months ago', expectedRange: { from: '2026-08-01', to: '2026-08-31' } },
    { phrase: 'three months ago', expectedRange: { from: '2026-08-01', to: '2026-08-31' } },
  ];
  for (const item of relativeExpressions) {
    const res = resolveDatePhrase(item.phrase, 'Asia/Kolkata', NOW);
    if (item.expectedDate) {
      assert.equal(res.date, item.expectedDate, `Failed date for: "${item.phrase}"`);
    }
    if (item.expectedRange) {
      assert.deepEqual(res.range, item.expectedRange, `Failed range for: "${item.phrase}"`);
      assert.deepEqual(resolveDateRange(item.phrase, 'Asia/Kolkata', NOW), item.expectedRange);
    }
  }
});

test('table-driven tests: explicit date ranges', () => {
  const dateRanges = [
    { phrase: 'between Oct 1 and Oct 15', expected: { from: '2026-10-01', to: '2026-10-15' } },
    { phrase: 'What did I ask between Oct 1 and Oct 15?', expected: { from: '2026-10-01', to: '2026-10-15' } },
    { phrase: 'between October 1 and October 15', expected: { from: '2026-10-01', to: '2026-10-15' } },
    { phrase: 'between October 1st and October 15th', expected: { from: '2026-10-01', to: '2026-10-15' } },
    { phrase: 'between Oct 1 and 15', expected: { from: '2026-10-01', to: '2026-10-15' } },
    { phrase: 'between 1 Oct and 15 Oct', expected: { from: '2026-10-01', to: '2026-10-15' } },
    { phrase: 'between 2026-10-01 and 2026-10-15', expected: { from: '2026-10-01', to: '2026-10-15' } },
    { phrase: 'between 2026-11-01 and 2026-11-10', expected: { from: '2026-11-01', to: '2026-11-10' } },
    { phrase: 'from last Monday to Wednesday', expected: { from: '2026-11-09', to: '2026-11-11' } },
    {
      phrase: 'What did we talk about from last Monday to Wednesday?',
      expected: { from: '2026-11-09', to: '2026-11-11' },
    },
    { phrase: 'from Monday to Wednesday', expected: { from: '2026-11-09', to: '2026-11-11' } },
    { phrase: 'from Monday to Friday', expected: { from: '2026-11-09', to: '2026-11-13' } },
    { phrase: 'from Oct 1 to Oct 15', expected: { from: '2026-10-01', to: '2026-10-15' } },
    { phrase: 'from October 1st to 15th', expected: { from: '2026-10-01', to: '2026-10-15' } },
    { phrase: 'from October 1 to October 15', expected: { from: '2026-10-01', to: '2026-10-15' } },
    { phrase: 'from 2026-10-01 to 2026-10-15', expected: { from: '2026-10-01', to: '2026-10-15' } },
    { phrase: 'from Oct 1 through Oct 15', expected: { from: '2026-10-01', to: '2026-10-15' } },
    { phrase: 'from Oct 1 until Oct 15', expected: { from: '2026-10-01', to: '2026-10-15' } },
  ];
  for (const item of dateRanges) {
    const res = resolveDatePhrase(item.phrase, 'Asia/Kolkata', NOW);
    assert.deepEqual(res.range, item.expected, `Failed range for: "${item.phrase}"`);
    assert.deepEqual(resolveDateRange(item.phrase, 'Asia/Kolkata', NOW), item.expected);
  }
});

test('table-driven tests: negative guards and product names', () => {
  const negativeGuards = [
    'Compare monday.com and Pipedrive pricing',
    'Is Monday CRM cheaper than HubSpot?',
    'What is on the Monday board?',
    'Monday work management features',
    'Tell me about Office 365 plans',
    'What changed in Office 365?',
    'Postgres 17 query performance',
    'What is new in Python 3.12?',
    'Is Node 22 LTS ready?',
    'Is it cheaper for 10-20 seats?',
    'We need 5-10 people on the plan',
    'Can we get 100-200 users?',
    'What is one half of 1/2 of the total?',
    'May I ask a question?',
    'the second option on the list',
    'the match sat at 5 pm',
    'march on through the list',
    'Version 2.0 release date',
  ];
  for (const text of negativeGuards) {
    const res = resolveDatePhrase(text, 'Asia/Kolkata', NOW);
    assert.equal(res.kind, 'none', `Expected 'none' for: "${text}"`);
    assert.equal(res.date, null);
    assert.equal(res.range, null);
  }
});

test('table-driven tests: timezone boundaries near midnight', () => {
  const boundaryCases = [
    {
      tz: 'Asia/Kolkata',
      time: new Date('2026-11-12T18:29:00.000Z'),
      expectedToday: '2026-11-12',
      expectedYesterday: '2026-11-11',
      expectedDayBeforeYesterday: '2026-11-10',
    },
    {
      tz: 'Asia/Kolkata',
      time: new Date('2026-11-12T18:31:00.000Z'),
      expectedToday: '2026-11-13',
      expectedYesterday: '2026-11-12',
      expectedDayBeforeYesterday: '2026-11-11',
    },
    {
      tz: 'America/Los_Angeles',
      time: new Date('2026-11-12T07:59:00.000Z'),
      expectedToday: '2026-11-11',
      expectedYesterday: '2026-11-10',
      expectedDayBeforeYesterday: '2026-11-09',
    },
    {
      tz: 'America/Los_Angeles',
      time: new Date('2026-11-12T08:01:00.000Z'),
      expectedToday: '2026-11-12',
      expectedYesterday: '2026-11-11',
      expectedDayBeforeYesterday: '2026-11-10',
    },
    {
      tz: 'Pacific/Auckland',
      time: new Date('2026-11-12T10:59:00.000Z'),
      expectedToday: '2026-11-12',
      expectedYesterday: '2026-11-11',
      expectedDayBeforeYesterday: '2026-11-10',
    },
    {
      tz: 'Pacific/Auckland',
      time: new Date('2026-11-12T11:01:00.000Z'),
      expectedToday: '2026-11-13',
      expectedYesterday: '2026-11-12',
      expectedDayBeforeYesterday: '2026-11-11',
    },
  ];
  for (const c of boundaryCases) {
    const todayRes = resolveDatePhrase('today', c.tz, c.time);
    assert.equal(todayRes.date, c.expectedToday, `today failed for ${c.tz}`);
    const morningRes = resolveDatePhrase('this morning', c.tz, c.time);
    assert.equal(morningRes.date, c.expectedToday, `this morning failed for ${c.tz}`);
    const yesterdayRes = resolveDatePhrase('yesterday', c.tz, c.time);
    assert.equal(yesterdayRes.date, c.expectedYesterday, `yesterday failed for ${c.tz}`);
    const dayBeforeRes = resolveDatePhrase('the day before yesterday', c.tz, c.time);
    assert.equal(dayBeforeRes.date, c.expectedDayBeforeYesterday, `day before yesterday failed for ${c.tz}`);
  }
});

test('topic recall returns up to 3 relevant past turns ranked by BM25 scoring plus recency within budget', () => {
  const store = new Store(':memory:');
  const turn1 = store.importTurn({
    user_text: 'Tell me about PostgreSQL connection pooling with PgBouncer.',
    assistant_text: 'PgBouncer is a lightweight connection pooler for PostgreSQL.',
    created_at: '2026-11-01T10:00:00.000Z',
  });
  store.updateTurn(turn1.id, { claims_status: 'done' });
  const turn2 = store.importTurn({
    user_text: 'How does PostgreSQL streaming replication work?',
    assistant_text: 'Streaming replication sends WAL records from primary to standby.',
    created_at: '2026-11-05T10:00:00.000Z',
  });
  store.updateTurn(turn2.id, { claims_status: 'done' });
  const turn3 = store.importTurn({
    user_text: 'What are PostgreSQL table partition strategies?',
    assistant_text: 'PostgreSQL supports range, list and hash partitioning.',
    created_at: '2026-11-09T10:00:00.000Z',
  });
  store.updateTurn(turn3.id, { claims_status: 'done' });
  const turn4 = store.importTurn({
    user_text: 'How to monitor PostgreSQL active locks and queries?',
    assistant_text: 'Query pg_stat_activity to inspect running queries and lock wait states.',
    created_at: '2026-11-10T10:00:00.000Z',
  });
  store.updateTurn(turn4.id, { claims_status: 'done' });

  const recall = recallForTurn({
    store,
    userText: 'The one where we discussed PostgreSQL replication and pooling',
    timezone: 'Asia/Kolkata',
    now: NOW,
  });

  assert.equal(recall.recalled.length, 3);
  assert.equal(recall.memory.length, 3);
  assert.ok(recall.topicMatches.length >= 3);
  assert.ok(recall.topicMatches[0].score >= recall.topicMatches[1].score);
  assert.ok(recall.topicMatches[1].score >= recall.topicMatches[2].score);

  store.close();
});

test('topic recall respects character budget config.maxContextChars', () => {
  const store = new Store(':memory:');
  for (let i = 1; i <= 3; i += 1) {
    const t = store.importTurn({
      user_text: `PostgreSQL query optimization question ${i} ${'q'.repeat(200)}`,
      assistant_text: `PostgreSQL answer ${i} ${'a'.repeat(400)}`,
      created_at: `2026-11-0${i}T10:00:00.000Z`,
    });
    store.updateTurn(t.id, { claims_status: 'done' });
  }

  const recall = recallForTurn({
    store,
    userText: 'The one where you answered PostgreSQL query optimization',
    timezone: 'Asia/Kolkata',
    now: NOW,
  });

  assert.equal(recall.recalled.length, 2);
  assert.equal(recall.memory.length, 2);
  store.close();
});

test('when 0 turns match a queried past date, explicitly return fact and never invent history', () => {
  const store = new Store(':memory:');
  const dates = ['2026-10-15', '2026-11-01', '2026-11-08'];
  for (const d of dates) {
    const recall = recallForTurn({
      store,
      userText: `What did I ask on ${d}?`,
      timezone: 'Asia/Kolkata',
      now: NOW,
    });
    assert.equal(recall.recalled.length, 0);
    assert.equal(recall.memory.length, 0);
    assert.equal(recall.fact, `0 turns found for ${d}`);
  }
  store.close();
});
