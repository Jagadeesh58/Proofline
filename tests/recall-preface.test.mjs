import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecallPreface } from '../src/agent/recall-preface.mjs';

test('returns empty string when there is no resolved date or no recalled turns', () => {
  assert.equal(buildRecallPreface({ recall: { resolved: null, recalled: [] } }), '');
  assert.equal(buildRecallPreface({ recall: { resolved: { date: '2026-11-03' }, recalled: [] } }), '');
  assert.equal(buildRecallPreface({ recall: { resolved: null, recalled: [{ user_text: 'hello' }] } }), '');
  assert.equal(buildRecallPreface(), '');
});

test('formats the date correctly and outputs expected preface', () => {
  const recall = {
    resolved: { date: '2026-11-03' },
    recalled: [
      {
        local_date: '2026-11-03',
        user_text: 'How should I choose between two hosted PostgreSQL providers for a student side project?',
      },
    ],
  };
  const result = buildRecallPreface({ recall, timezone: 'UTC', willSearch: false });
  assert.ok(result.startsWith('On Tue, 3 Nov 2026 you asked: '));
  assert.ok(result.includes('How should I choose between two hosted PostgreSQL providers'));
  assert.ok(result.endsWith('.\n\n'));
  assert.ok(!result.includes('Checking what has changed since'));
});

test('cuts on a word boundary with ellipsis when exceeding 160 characters', () => {
  const longQuestion = 'This is a very long user question that definitely exceeds one hundred and sixty characters in total length and should be cleanly truncated at a natural word boundary without cutting any word in half.';
  const recall = {
    resolved: { date: '2026-11-09' },
    recalled: [
      {
        local_date: '2026-11-09',
        user_text: longQuestion,
      },
    ],
  };
  const result = buildRecallPreface({ recall, timezone: 'UTC', willSearch: false });
  assert.ok(result.includes('…".\n\n'));
  assert.ok(!result.includes('half'));
});

test('appends the search follow-up when willSearch is true', () => {
  const recall = {
    resolved: { date: '2026-11-03' },
    recalled: [
      {
        local_date: '2026-11-03',
        user_text: 'Which Postgres provider is better?',
      },
    ],
  };
  const result = buildRecallPreface({ recall, timezone: 'UTC', willSearch: true });
  assert.equal(
    result,
    'On Tue, 3 Nov 2026 you asked: "Which Postgres provider is better?". Checking what has changed since.\n\n',
  );
});

test('omits the search follow-up when willSearch is false', () => {
  const recall = {
    resolved: { date: '2026-11-03' },
    recalled: [
      {
        local_date: '2026-11-03',
        user_text: 'Which Postgres provider is better?',
      },
    ],
  };
  const result = buildRecallPreface({ recall, timezone: 'UTC', willSearch: false });
  assert.equal(
    result,
    'On Tue, 3 Nov 2026 you asked: "Which Postgres provider is better?".\n\n',
  );
});

test('counts additional turns on the same date', () => {
  const recall = {
    resolved: { date: '2026-11-03' },
    recalled: [
      { local_date: '2026-11-03', user_text: 'Question one' },
      { local_date: '2026-11-03', user_text: 'Question two' },
      { local_date: '2026-11-03', user_text: 'Question three' },
    ],
  };
  const result = buildRecallPreface({ recall, timezone: 'UTC', willSearch: true });
  assert.equal(
    result,
    'On Tue, 3 Nov 2026 you asked: "Question one" (2 more that day). Checking what has changed since.\n\n',
  );
});
