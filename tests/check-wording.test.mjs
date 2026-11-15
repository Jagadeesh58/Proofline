import test from 'node:test';
import assert from 'node:assert/strict';
import { scanText } from '../scripts/check-wording.mjs';

test('flags numbered and word stages', () => {
  const badSamples = [
    'Now executing Part 1 of the task.',
    'Step #2 is now underway.',
    'Moving on to phase 3.',
    'Here is task 4 details.',
    'Phase one has started.',
  ];
  for (const sample of badSamples) {
    const hits = scanText(sample, 'dummy.txt');
    assert.ok(hits.length > 0, `Expected hit for "${sample}"`);
  }
});

test('flags process and review phrases', () => {
  const badSamples = [
    'Made the changes as requested.',
    'Updated per your plan.',
    'Proceeding as planned.',
    'Fixed to address feedback.',
    'Now incorporating review comments.',
    'Here are the final changes.',
    'Temporary fixme in code.',
  ];
  for (const sample of badSamples) {
    const hits = scanText(sample, 'dummy.txt');
    assert.ok(hits.length > 0, `Expected hit for "${sample}"`);
  }
});

test('flags promotional words', () => {
  const badSamples = [
    'Our system provides a robust architecture.',
    'It offers seamless integrations.',
    'We guarantee zero errors.',
    'This delivers 100% precision.',
    'No model can make mistakes here.',
    'Language models frequently slip dates.',
  ];
  for (const sample of badSamples) {
    const hits = scanText(sample, 'dummy.txt');
    assert.ok(hits.length > 0, `Expected hit for "${sample}"`);
  }
});

test('passes clean code and documentation text', () => {
  const cleanSamples = [
    'Resolves relative dates to strict calendar boundaries.',
    'SQLite with BM25 retrieves past turns before model invocation.',
    'Web search is the only external tool exposed to the language model.',
    'When no baseline exists, claims are marked unconfirmed.',
  ];
  for (const sample of cleanSamples) {
    const hits = scanText(sample, 'dummy.txt');
    assert.equal(hits.length, 0, `Unexpected hit for "${sample}"`);
  }
});
