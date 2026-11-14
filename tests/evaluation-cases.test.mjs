import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { trustLabel } from '../src/seeds/domains.mjs';
import PLANS from '../src/seeds/plans.json' with { type: 'json' };
import { hasMutableFactSignal } from '../src/evidence/figure-check.mjs';

const read = (name) => JSON.parse(fs.readFileSync(new URL(`../evals/cases/${name}`, import.meta.url), 'utf8'));

test('evaluation case matrices have the planned offline definition sizes', () => {
  const expected = {
    'dates-recall.json': 41,
    'evidence.json': 22,
    'comparison.json': 25,
    'domain-labels.json': 97,
    'search-policy.json': 40,
    'official-prompts.json': 12,
    'general-research.json': 15,
    'failure-resilience.json': 8,
    'reviewer.json': 9,
  };
  for (const [name, count] of Object.entries(expected)) {
    const data = read(name);
    const actual = name === 'domain-labels.json'
      ? data.seeded.length + data.non_seeded.length + data.lookalikes.length
      : name === 'official-prompts.json'
        ? data.prompts.length * data.history_modes.length
        : name === 'general-research.json'
          ? data.prompts.length
          : data.cases.length;
    assert.equal(actual, count, name);
  }
  const policy = read('search-policy.json').cases;
  assert.equal(policy.filter((item) => item.expected_search).length, 15);
  assert.equal(policy.filter((item) => !item.expected_search).length, 25);
});

test('seeded and non-seeded vendor domain fixtures are measured separately with zero lookalike matches', () => {
  const data = read('domain-labels.json');
  const falseSeeded = data.seeded.filter((item) => trustLabel(item.entity, item.url, PLANS).label === 'Third party');
  const falseNonSeeded = data.non_seeded.filter((item) => trustLabel(item.entity, item.url, PLANS).label === 'Third party');
  const falseNameMatches = data.lookalikes.filter((item) => trustLabel(item.entity, item.url, PLANS).label === 'Vendor site (not verified)');
  assert.equal(data.seeded.length, 40);
  assert.equal(data.non_seeded.length, 30);
  assert.equal(data.lookalikes.length, 27);
  assert.deepEqual(falseSeeded, []);
  assert.ok(falseNonSeeded.length / data.non_seeded.length <= 0.10, JSON.stringify(falseNonSeeded));
  assert.deepEqual(falseNameMatches, []);
  for (const item of data.seeded) assert.equal(trustLabel(item.entity, item.url, PLANS).label, item.expected, item.url);
  for (const item of data.non_seeded) assert.equal(trustLabel(item.entity, item.url, PLANS).label, item.expected, item.url);
  for (const item of data.lookalikes) assert.equal(trustLabel(item.entity, item.url, PLANS).label, 'Third party', item.url);
});

test('the offline scanner regression cases reject mutable drafts and accept stable concepts', () => {
  const data = read('search-policy-drafts.json');
  assert.equal(data.stable_regression_cases.length, 40);
  assert.equal(data.mutable_trap_regression_cases.length, 25);
  for (const answer of data.stable_regression_cases) assert.equal(hasMutableFactSignal(answer), false, answer);
  for (const answer of data.mutable_trap_regression_cases) assert.equal(hasMutableFactSignal(answer), true, answer);
});
