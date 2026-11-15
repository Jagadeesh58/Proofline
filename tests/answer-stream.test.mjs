import test from 'node:test';
import assert from 'node:assert/strict';
import { createSentenceGate } from '../src/evidence/answer-stream.mjs';

test('sentence gate checks against claims after in-flight extraction resolves', async () => {
  let claims = [];
  let resolveExtraction;
  const extractionPromise = new Promise((resolve) => { resolveExtraction = resolve; });
  const sent = [];
  let saved = '';
  const gate = createSentenceGate({
    send: (event, payload) => sent.push({ event, payload }),
    store: { appendAssistantText: (_turnId, value) => { saved += value; } },
    turnId: 'turn-1',
    getContext: () => ({
      userText: 'Compare Pipedrive pricing for a 20-person sales team.',
      recalled: [], cards: [], sources: [],
      entities: [{ name: 'Pipedrive', key: 'pipedrive', domain: 'pipedrive.com' }],
      claims,
    }),
    extractionPromise,
  });

  gate.push('Pipedrive costs $300 per month for the 20-person team.');
  const flushed = gate.flush();
  claims = [{ entity_key: 'pipedrive', attribute: 'price', amount: 15, price_unit: 'per_seat', value_text: '$15 per user per month', evidence_quote: 'Pipedrive costs $15 per user per month.' }];
  resolveExtraction(claims);
  const result = await flushed;

  assert.equal(result, 'Pipedrive costs $300 per month for the 20-person team.');
  assert.equal(saved, result);
  assert.deepEqual(sent.filter((item) => item.event === 'figure_marker'), []);
});

test('does not split abbreviations, initials, decimals or bare list markers', async () => {
  const { sentenceEndIndex } = await import('../src/evidence/answer-stream.mjs');
  assert.equal(sentenceEndIndex('Pipedrive costs approx. $14 per user. Next'), 'Pipedrive costs approx. $14 per user.'.length);
  assert.equal(sentenceEndIndex('e.g. $14 per user. Next'), 'e.g. $14 per user.'.length);
  assert.equal(sentenceEndIndex('The value is 3.14. Next'), 'The value is 3.14.'.length);
  assert.equal(sentenceEndIndex('1. First item\n2. Second item'), -1);
  assert.equal(sentenceEndIndex('Dr. A. Smith arrived. Next'), 'Dr. A. Smith arrived.'.length);
  assert.equal(sentenceEndIndex('This is complete. Next'), 'This is complete.'.length);
});

test('streams narrative text before claims extraction, but gates later figures in order', async () => {
  let resolveExtraction;
  const extractionPromise = new Promise((resolve) => { resolveExtraction = resolve; });
  const sent = [];
  let saved = '';
  const gate = createSentenceGate({
    send: (event, payload) => sent.push({ event, payload }),
    store: { appendAssistantText: (_id, value) => { saved += value; } },
    turnId: 'turn-fast',
    getContext: () => ({ userText: 'Check Acme pricing', recalled: [], cards: [], sources: [], entities: [], claims: [] }),
    extractionPromise,
  });
  gate.push('Here is the summary. Acme costs $20 per month.');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(saved.startsWith('Here is the summary.'));
  assert.ok(!saved.includes('Acme costs'));
  resolveExtraction([]);
  await gate.flush();
  assert.ok(saved.indexOf('Here is the summary.') < saved.indexOf('Acme costs'));
  assert.ok(sent.filter((item) => item.event === 'token').length >= 1);
});

test('decimal-aware splitSentences keeps decimal prices, percentages and version numbers intact', async () => {
  const { splitSentences } = await import('../src/evidence/answer-stream.mjs');

  const decimalPrice = 'Acme Pro costs $19.99 per user per month.';
  assert.deepEqual(splitSentences(decimalPrice), ['Acme Pro costs $19.99 per user per month.']);

  const multipleDecimals = 'Acme Pro costs $19.99 per user per month. Enterprise is $199.99 billed annually.';
  assert.deepEqual(splitSentences(multipleDecimals), [
    'Acme Pro costs $19.99 per user per month.',
    'Enterprise is $199.99 billed annually.',
  ]);

  const variousFormats = 'Conversion grew by 18.5%. Pi is approximately 3.14. Released v2.5.1 on 2026.11.13. Limit is 2.5 GB. Visit https://example.com/pricing for details. Dr. A. Smith confirmed this.';
  const sentences = splitSentences(variousFormats);
  assert.ok(sentences.length >= 6);
  assert.ok(sentences.some((s) => s.includes('18.5%')));
  assert.ok(sentences.some((s) => s.includes('3.14')));
  assert.ok(sentences.some((s) => s.includes('v2.5.1')));
  assert.ok(sentences.some((s) => s.includes('2.5 GB')));
  assert.ok(sentences.some((s) => s.includes('https://example.com/pricing')));
  assert.ok(!sentences.some((s) => s.startsWith('99 per user')));
});

test('sentence gate preserves inter-sentence whitespace and spaces after unverified figure markers', async () => {
  let saved = '';
  const tokens = [];
  const gate = createSentenceGate({
    send: (event, payload) => { if (event === 'token') tokens.push(payload.text); },
    store: { appendAssistantText: (_id, value) => { saved += value; } },
    turnId: 'turn-ws',
    getContext: () => ({
      userText: 'Check pricing',
      recalled: [], cards: [], sources: [], entities: [{ name: 'HubSpot', key: 'hubspot', domain: 'hubspot.com' }],
      claims: [],
    }),
  });

  // Push sentence 1 containing unverified figure and sentence 2 progressively
  gate.push('HubSpot Starter costs $99 per user per month. ');
  gate.push('HubSpot also introduced new reporting features.');
  const result = await gate.flush();

  assert.ok(result.includes('(figure not verified) HubSpot also introduced'));
  assert.doesNotMatch(result, /\(figure not verified\)HubSpot/);
  assert.equal(saved, result);

  // Push two sentences where the second has no leading space
  let saved2 = '';
  const gate2 = createSentenceGate({
    send: () => {},
    store: { appendAssistantText: (_id, value) => { saved2 += value; } },
    turnId: 'turn-ws-2',
    getContext: () => ({ userText: 'Check', recalled: [], cards: [], sources: [], entities: [], claims: [] }),
  });
  gate2.push('No pricing changes have been reported since last Tuesday.');
  gate2.push('Official provider pages confirm this.');
  const result2 = await gate2.flush();
  assert.equal(result2, 'No pricing changes have been reported since last Tuesday. Official provider pages confirm this.');
  assert.equal(saved2, result2);
});

test('sentenceEndIndex retains trailing citation markers attached to the sentence', async () => {
  const { sentenceEndIndex } = await import('../src/evidence/answer-stream.mjs');

  const textWithCitation = 'No changes since last Tuesday. [S1] Official provider pages were checked.';
  const end1 = sentenceEndIndex(textWithCitation);
  assert.equal(textWithCitation.slice(0, end1), 'No changes since last Tuesday. [S1]');

  const textWithDirectCitation = 'No changes since last Tuesday.[S1] Official provider pages were checked.';
  const end2 = sentenceEndIndex(textWithDirectCitation);
  assert.equal(textWithDirectCitation.slice(0, end2), 'No changes since last Tuesday.[S1]');

  const textWithMultipleCitations = 'Pricing confirmed. [S1, S2] Next paragraph starts here.';
  const end3 = sentenceEndIndex(textWithMultipleCitations);
  assert.equal(textWithMultipleCitations.slice(0, end3), 'Pricing confirmed. [S1, S2]');
});

test('checkAnswerFigures preserves multiline markdown lists and paragraph newlines', async () => {
  const { checkAnswerFigures } = await import('../src/evidence/figure-check.mjs');
  const input = 'Here is the summary:\n\n- HubSpot: unchanged.\n- Pipedrive: unchanged.\n- Zoho: unchanged.';
  const result = checkAnswerFigures(input, {
    userText: 'Check CRM tools',
    recalled: [],
    claims: [],
    sources: [],
    entities: [],
    cards: [],
  });
  assert.equal(result.text, input);
});
