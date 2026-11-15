import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/memory/store.mjs';
import { normaliseEvidenceText, validatePageClaims, validateAnswerClaims, matchEntityHint, stripTrailingPlan } from '../src/evidence/claims.mjs';
import { checkAnswerFigures, hasMutableFactSignal } from '../src/evidence/figure-check.mjs';

function makePageStore(pageText) {
  const store = new Store(':memory:');
  const turn = store.createTurn({ userText: 'Compare Pipedrive pricing.', timezone: 'Asia/Kolkata' });
  const source = store.addSource({
    turnId: turn.id, url: 'https://pipedrive.com/pricing', domain: 'pipedrive.com',
    title: 'Pipedrive pricing', pageText, retrievalKind: 'page_text', pageTextOrigin: 'extract',
    retrievedAt: '2026-11-12T10:00:00.000Z',
  });
  return { store, turn, source };
}

function rawPrice(sourceId, overrides = {}) {
  return {
    source_id: sourceId, entity: 'Pipedrive', attribute: 'price', plan_name: 'Starter',
    value_text: '$15 per user per month', amount: 15, currency: 'USD', price_unit: 'flat',
    unit: 'users', period: 'year', commitment: 'none', qualifiers: ['promo','excl_tax','min_seats:5','market:US'],
    evidence_quote: 'Pipedrive Starter plan costs $15 per user per month with an annual commitment, promotional pricing, a minimum of 5 seats and excluding GST for the US market.',
    ...overrides,
  };
}

test('normalises Unicode, markdown and whitespace for quote matching', () => {
  assert.equal(normaliseEvidenceText('  **STARTER**  “A €15 price”  '), 'starter "a €15 price"');
});


test('extracts day-first page dates for stale-page protection', async () => {
  const { extractPageDate } = await import('../src/search/excerpts.mjs');
  assert.equal(extractPageDate('Last updated: 1 October 2026'), 'Last updated: 1 October 2026');
});

test('stores only a quote-backed claim from the exact current page', () => {
  const { store, turn, source } = makePageStore(rawPrice('id').evidence_quote);
  const result = validatePageClaims({ store, turnId: turn.id, sourceItems: [{ source, entity: 'Pipedrive' }], rawClaims: [rawPrice(source.id)] });
  assert.equal(result.stored, 1);
  assert.equal(result.rejected, 0);
  assert.equal(result.claims[0].source_id, source.id);
  assert.equal(result.claims[0].baseline_basis, 'page_text');
  store.close();
});


test('rejects a mismatched page before assigning its claims to a target entity', () => {
  const store = new Store(':memory:');
  const turn = store.createTurn({ userText: 'Check HubSpot pricing.', timezone: 'Asia/Kolkata' });
  const source = store.addSource({
    turnId: turn.id, url: 'https://hubspot.com/pricing', domain: 'hubspot.com',
    title: 'Pipedrive pricing',
    pageText: 'Pipedrive Starter costs $15 per user per month.',
    retrievalKind: 'page_text', pageTextOrigin: 'extract',
  });
  const quote = 'Pipedrive Starter costs $15 per user per month.';
  const result = validatePageClaims({
    store,
    turnId: turn.id,
    sourceItems: [{ source, entity: 'HubSpot' }],
    rawClaims: [{
      source_id: source.id, entity: 'HubSpot', attribute: 'price',
      plan_name: 'Starter', value_text: '$15 per user per month', amount: 15,
      evidence_quote: quote,
    }],
  });
  assert.equal(result.stored, 0);
  assert.deepEqual(result.wrongPageSourceIds, [source.id]);
  assert.equal(store.getSource(source.id).extraction_status, 'wrong_page');
  store.close();
});

test('accepts a target alias in the title or opening 1,000 characters', async () => {
  const { pageMatchesEntity } = await import('../src/evidence/claims.mjs');
  assert.equal(pageMatchesEntity({ title: 'Jira pricing', page_text: 'Pricing information.' }, 'Jira'), true);
  assert.equal(pageMatchesEntity({ title: 'Atlassian plans', page_text: 'Jira is included.' }, 'Jira'), true);
  assert.equal(pageMatchesEntity({ title: 'Pricing', page_text: `${'Unrelated content. '.repeat(80)}HubSpot pricing` }, 'HubSpot'), false);
  assert.equal(pageMatchesEntity({ title: 'HubSpotting guide', page_text: 'Unrelated CRM notes.' }, 'HubSpot'), false);
});

test('recognises usage billing as a comparable price basis', () => {
  const quote = 'Neon Launch costs $19 per month on usage billing.';
  const { store, turn, source } = makePageStore(quote);
  const result = validatePageClaims({
    store,
    turnId: turn.id,
    sourceItems: [{ source, entity: 'Neon' }],
    rawClaims: [rawPrice(source.id, {
      entity: 'Neon', plan_name: 'Launch', value_text: '$19 per month', amount: 19,
      price_unit: 'usage', period: 'month', evidence_quote: quote,
    })],
  });
  assert.equal(result.claims[0].price_unit, 'usage');
  store.close();
});

test('canonicalises per-user billing and accepts only quote-supported billing terms', () => {
  const { store, turn, source } = makePageStore(rawPrice('id').evidence_quote);
  const result = validatePageClaims({ store, turnId: turn.id, sourceItems: [{ source, entity: 'Pipedrive' }], rawClaims: [rawPrice(source.id)] });
  const claim = result.claims[0];
  assert.equal(claim.price_unit, 'per_seat');
  assert.equal(claim.currency, 'USD');
  assert.equal(claim.period, 'month');
  assert.equal(claim.commitment, 'annual');
  assert.deepEqual(JSON.parse(claim.qualifiers), ['excl_tax','market:US','min_seats:5','promo']);
  store.close();
});

test('rejects a fabricated quote that does not occur in page text', () => {
  const { store, turn, source } = makePageStore('Pipedrive Starter costs $15 per user per month.');
  const result = validatePageClaims({ store, turnId: turn.id, sourceItems: [{ source, entity: 'Pipedrive' }], rawClaims: [rawPrice(source.id, { evidence_quote: 'Pipedrive Pro costs $999 per seat per year.' })] });
  assert.equal(result.stored, 0);
  assert.equal(result.rejected, 1);
  store.close();
});

test('rejects a claim whose numeric amount is absent from its evidence quote', () => {
  const { store, turn, source } = makePageStore('Pipedrive Starter costs $15 per user per month.');
  const result = validatePageClaims({ store, turnId: turn.id, sourceItems: [{ source, entity: 'Pipedrive' }], rawClaims: [rawPrice(source.id, { evidence_quote: 'Pipedrive Starter costs $15 per user per month.', amount: 16 })] });
  assert.equal(result.rejected, 1);
  store.close();
});

test('rejects unknown source IDs rather than assigning a one-page claim by fallback', () => {
  const { store, turn, source } = makePageStore('Pipedrive Starter costs $15 per user per month.');
  const result = validatePageClaims({ store, turnId: turn.id, sourceItems: [{ source, entity: 'Pipedrive' }], rawClaims: [rawPrice(source.id, { source_id: 'not-this-source', evidence_quote: 'Pipedrive Starter costs $15 per user per month.' })] });
  assert.equal(result.rejected, 1);
  store.close();
});

test('uses the code-assigned target entity even when the model entity differs', () => {
  const { store, turn, source } = makePageStore('Pipedrive Starter costs $15 per user per month.');
  const result = validatePageClaims({ store, turnId: turn.id, sourceItems: [{ source, entity: 'Pipedrive' }], rawClaims: [rawPrice(source.id, { evidence_quote: 'Pipedrive Starter costs $15 per user per month.', entity: 'HubSpot' })], entityFilter: 'pipedrive' });
  assert.equal(result.stored, 1);
  assert.equal(result.claims[0].entity_key, 'pipedrive');
  store.close();
});

test('maps a baseline extraction name variant to the hinted HubSpot entity before recheck', async () => {
  const store = new Store(':memory:');
  const turn = store.importTurn({
    user_text: 'Check HubSpot CRM Starter pricing.',
    assistant_text: 'HubSpot CRM Starter costs $15 per user per month.',
    created_at: '2026-10-20T10:00:00Z', source_created_at: '2026-10-20T10:00:00Z',
  });
  const baseline = validateAnswerClaims({ store, turn, rawClaims: [{
    entity: 'HubSpot CRM', attribute: 'price', plan_name: 'Starter',
    value_text: '$15 per user per month', amount: 15, currency: 'USD', price_unit: 'per_seat',
    period: 'month', commitment: 'unknown', evidence_quote: 'HubSpot CRM Starter costs $15 per user per month.',
  }] });
  assert.equal(baseline.stored, 1);
  assert.equal(baseline.claims[0].entity_key, 'hubspot');

  const currentTurn = store.createTurn({ userText: 'Check HubSpot again.', timezone: 'Asia/Kolkata' });
  const currentSource = store.addSource({
    turnId: currentTurn.id, url: 'https://hubspot.com/pricing', domain: 'hubspot.com',
    title: 'HubSpot pricing', pageText: 'HubSpot CRM Starter costs $20 per user per month.',
    retrievalKind: 'page_text', pageTextOrigin: 'extract', retrievedAt: '2026-11-12T10:00:00Z',
  });
  const current = validatePageClaims({ store, turnId: currentTurn.id,
    sourceItems: [{ source: currentSource, entity: 'HubSpot' }], entityFilter: 'hubspot',
    rawClaims: [{ source_id: currentSource.id, entity: 'HubSpot Sales Hub', attribute: 'price', plan_name: 'Starter',
      value_text: '$20 per user per month', amount: 20, currency: 'USD', price_unit: 'per_seat',
      period: 'month', commitment: 'unknown', evidence_quote: 'HubSpot CRM Starter costs $20 per user per month.' }],
  });
  const { buildComparisonCards } = await import('../src/evidence/compare.mjs');
  const cards = buildComparisonCards({ store, targets: [{ entity: 'HubSpot', entity_key: 'hubspot', checks: ['pricing'], page: { domain: 'hubspot.com' } }],
    currentClaims: current.claims, baselineClaims: baseline.claims });
  assert.match(cards[0].cards[0].status, /^Differs from my earlier answer/);
  store.close();
});

test('keeps an unrelated answer-extraction entity as an opaque key', () => {
  const store = new Store(':memory:');
  const turn = store.importTurn({
    user_text: 'Compare HubSpot CRM.',
    assistant_text: 'HubSpot costs $15 per user per month. Pipedrive costs $18 per user per month.',
    created_at: '2026-10-20T10:00:00Z', source_created_at: '2026-10-20T10:00:00Z',
  });
  const result = validateAnswerClaims({ store, turn, entityHints: ['HubSpot'], rawClaims: [{
    entity: 'Unrelated Acme Analytics', attribute: 'price', plan_name: 'Pro', value_text: '$18 per user per month',
    amount: 18, currency: 'USD', price_unit: 'per_seat', period: 'month', commitment: 'unknown',
    evidence_quote: 'Pipedrive costs $18 per user per month.',
  }] });
  assert.equal(result.stored, 1);
  assert.equal(result.claims[0].entity_key, 'unrelated acme analytics');
  assert.notEqual(result.claims[0].entity_key, 'hubspot');
  store.close();
});

test('does not infer currency, price unit, billing period or commitment when the quote omits them', () => {
  const quote = 'Pipedrive Starter is priced at 15 for the service.';
  const { store, turn, source } = makePageStore(quote);
  const result = validatePageClaims({ store, turnId: turn.id, sourceItems: [{ source, entity: 'Pipedrive' }], rawClaims: [rawPrice(source.id, { evidence_quote: quote, value_text: '15', amount: 15, currency: 'USD', price_unit: 'per_seat', period: 'month', commitment: 'annual', plan_name: 'Starter' })] });
  assert.equal(result.stored, 1);
  assert.equal(result.claims[0].currency, null);
  assert.equal(result.claims[0].price_unit, 'unknown');
  assert.equal(result.claims[0].period, 'unknown');
  assert.equal(result.claims[0].commitment, 'unknown');
  store.close();
});

test('does not accept a plan name or limit unit absent from the quote', () => {
  const quote = 'Pipedrive includes 500 contacts in this tier.';
  const { store, turn, source } = makePageStore(quote);
  const result = validatePageClaims({ store, turnId: turn.id, sourceItems: [{ source, entity: 'Pipedrive' }], rawClaims: [{
    source_id: source.id, entity: 'Pipedrive', attribute: 'limit', plan_name: 'Advanced', value_text: '500 contacts', amount: 500,
    unit: 'contacts', period: 'month', commitment: 'unknown', evidence_quote: quote,
  }] });
  assert.equal(result.stored, 1);
  assert.equal(result.claims[0].plan_key, 'unspecified');
  assert.equal(result.claims[0].unit, 'contacts');
  assert.equal(result.claims[0].period, 'unknown');
  store.close();
});

test('accepts an evidence quote containing a comma-formatted amount', () => {
  const quote = 'The plan costs $1,200 per year.';
  const { store, turn, source } = makePageStore(quote);
  const result = validatePageClaims({ store, turnId: turn.id, sourceItems: [{ source, entity: 'Pipedrive' }], rawClaims: [{
    source_id: source.id, entity: 'Pipedrive', attribute: 'price', plan_name: 'plan', value_text: '$1,200', amount: 1200,
    evidence_quote: quote,
  }] });
  assert.equal(result.stored, 1);
  assert.equal(result.claims[0].amount, 1200);
  store.close();
});

test('keeps a user-provided claim as an unverified answer-text baseline', () => {
  const store = new Store(':memory:');
  const turn = store.importTurn({
    user_text: 'What was the earlier price?',
    assistant_text: 'Pipedrive Starter costs $15 per user per month.',
    created_at: '2026-10-20T10:00:00Z', timezone: 'Asia/Kolkata',
  });
  const result = validateAnswerClaims({ store, turn, rawClaims: [{
    entity: 'Pipedrive', attribute: 'price', plan_name: 'Starter', value_text: '$15 per user per month',
    amount: 15, currency: 'USD', price_unit: 'per_seat', period: 'month', commitment: 'unknown',
    evidence_quote: 'Pipedrive Starter costs $15 per user per month.',
  }] });
  assert.equal(result.stored, 1);
  assert.equal(result.claims[0].baseline_basis, 'answer_text');
  assert.equal(result.claims[0].source_id, null);
  assert.equal(store.getTurn(turn.id).claims_status, 'done');
  store.close();
});

test('allows an imported unknown-date answer as an explicitly unverified comparison baseline', async () => {
  const store = new Store(':memory:');
  const turn = store.importTurn({
    user_text: 'Compare HubSpot Starter pricing.',
    assistant_text: 'HubSpot Starter costs $15 per user per month.',
    created_at: '2026-11-09T10:00:00Z',
  });
  assert.equal(turn.source_created_at_utc, null);
  const baseline = validateAnswerClaims({ store, turn, rawClaims: [{
    entity: 'HubSpot', attribute: 'price', plan_name: 'Starter', value_text: '$15 per user per month',
    amount: 15, currency: 'USD', price_unit: 'per_seat', period: 'month', commitment: 'unknown',
    evidence_quote: 'HubSpot Starter costs $15 per user per month.',
  }] });
  assert.equal(baseline.stored, 1);
  assert.equal(baseline.claims[0].baseline_basis, 'answer_text');
  const { store: currentStore, turn: currentTurn, source } = makePageStore('HubSpot Starter costs $20 per user per month.');
  const current = validatePageClaims({ store: currentStore, turnId: currentTurn.id,
    sourceItems: [{ source, entity: 'HubSpot' }], rawClaims: [rawPrice(source.id, {
      evidence_quote: 'HubSpot Starter costs $20 per user per month.', value_text: '$20 per user per month', amount: 20,
    })],
  });
  const { buildComparisonCards } = await import('../src/evidence/compare.mjs');
  const card = buildComparisonCards({ store: currentStore,
    targets: [{ entity: 'HubSpot', entity_key: 'hubspot', checks: ['pricing'], page: { domain: 'hubspot.com' } }],
    currentClaims: current.claims, baselineClaims: baseline.claims,
  })[0].cards[0];
  assert.match(card.status, /^Differs from my earlier answer/);
  assert.equal(card.baseline.basis, 'answer_text');
  store.close();
  currentStore.close();
});

test('marks an unsupported figure in an answer', () => {
  const result = checkAnswerFigures('Pipedrive Starter costs $20 per user per month.', {
    userText: 'Compare Pipedrive pricing.', recalled: [], cards: [], claims: [],
    entities: [{ name: 'Pipedrive CRM', key: 'pipedrive crm', domain: 'pipedrive.com' }],
    sources: [{ title: 'Pipedrive pricing', registrable_domain: 'pipedrive.com', retrieval_kind: 'page_text', page_text: 'Pipedrive Starter costs $15 per user per month.' }],
  });
  assert.match(result.text, /figure not verified/);
});

test('does not borrow a HubSpot price for a Pipedrive sentence', () => {
  const result = checkAnswerFigures('Pipedrive costs $20 per user per month.', {
    userText: 'Compare HubSpot and Pipedrive pricing.', recalled: [], claims: [], cards: [],
    entities: [
      { name: 'HubSpot CRM', key: 'hubspot crm', domain: 'hubspot.com' },
      { name: 'Pipedrive CRM', key: 'pipedrive crm', domain: 'pipedrive.com' },
    ],
    sources: [
      { title: 'HubSpot pricing', registrable_domain: 'hubspot.com', retrieval_kind: 'page_text', page_text: 'HubSpot Starter costs $20 per user per month.' },
      { title: 'Pipedrive pricing', registrable_domain: 'pipedrive.com', retrieval_kind: 'page_text', page_text: 'Pipedrive Starter costs $15 per user per month.' },
    ],
  });
  assert.match(result.text, /figure not verified/);
});

test('labels snippet-only figures as unverified search leads', () => {
  const result = checkAnswerFigures('Pipedrive Starter costs $20 per month.', {
    userText: 'Compare Pipedrive pricing.', recalled: [], claims: [], cards: [],
    entities: [{ name: 'Pipedrive', key: 'pipedrive', domain: 'pipedrive.com' }],
    sources: [{ title: 'Pipedrive pricing', registrable_domain: 'pipedrive.com', retrieval_kind: 'snippet', snippet_text: 'Starter costs $20 per month.' }],
  });
  assert.match(result.text, /Search snippet, page not verified/);
});

test('allows a calculated team total based on a quote-validated per-seat price', () => {
  const result = checkAnswerFigures('For Pipedrive, a 20-person team would pay $300 per month.', {
    userText: 'Compare Pipedrive pricing for a 20-person sales team.', recalled: [], cards: [],
    claims: [{ entity_key: 'pipedrive', attribute: 'price', price_unit: 'per_seat', amount: 15, value_text: '$15 per user', evidence_quote: '$15 per user per month.' }],
    entities: [{ name: 'Pipedrive', key: 'pipedrive', domain: 'pipedrive.com' }],
    sources: [{ title: 'Pipedrive pricing', registrable_domain: 'pipedrive.com', retrieval_kind: 'page_text', page_text: 'Pipedrive costs $15 per user per month.' }],
  });
  assert.doesNotMatch(result.text, /figure not verified/);
});


test('does not use a figure elsewhere on the fetched page outside the excerpt sent to the model', () => {
  const result = checkAnswerFigures('HubSpot Starter costs $15 per user per month.', {
    userText: 'Check HubSpot Starter pricing.', recalled: [], claims: [], cards: [],
    entities: [{ name: 'HubSpot', key: 'hubspot', domain: 'hubspot.com' }],
    sources: [{
      title: 'HubSpot pricing', registrable_domain: 'hubspot.com', retrieval_kind: 'page_text',
      page_text: 'Starter costs $15 per user per month. Professional costs $20 per user per month.',
      excerpt_text: 'Professional costs $20 per user per month.',
    }],
  });
  assert.match(result.text, /figure not verified/);
});

test('accepts a genuinely supported amount from the excerpt window sent to the model', () => {
  const result = checkAnswerFigures('Pipedrive Starter costs $15 per user per month.', {
    userText: 'Compare Pipedrive pricing.', recalled: [], claims: [], cards: [],
    entities: [{ name: 'Pipedrive', key: 'pipedrive', domain: 'pipedrive.com' }],
    sources: [{ title: 'Pipedrive pricing', registrable_domain: 'pipedrive.com', retrieval_kind: 'page_text',
      page_text: 'The full page contains navigation and details.',
      excerpt_text: 'Pipedrive Starter costs $15 per user per month.' }],
  });
  assert.doesNotMatch(result.text, /figure not verified/);
});

test('allows the current date supplied by code', () => {
  const result = checkAnswerFigures('Today is 12 November 2026.', { userText: 'What is today’s date?', recalled: [], claims: [], sources: [], entities: [], cards: [], today: '2026-11-12', timezone: 'Asia/Kolkata' });
  assert.doesNotMatch(result.text, /figure not verified/);
});

test('forces search on a direct draft containing a mutable price or recency statement', () => {
  assert.equal(hasMutableFactSignal('The current price is $20 per seat.'), true);
  assert.equal(hasMutableFactSignal('This is still available today.'), true);
  assert.equal(hasMutableFactSignal('The service was released in 2025.'), true);
});

test('does not force search for stable concepts or neutral uses of now and still', () => {
  assert.equal(hasMutableFactSignal('A database index narrows the rows a query must inspect.'), false);
  assert.equal(hasMutableFactSignal('Now, the leaf node still points to its next sibling.'), false);
  assert.equal(hasMutableFactSignal('RFC 7540 (2015) defines HTTP/2.'), false);
  assert.equal(hasMutableFactSignal('A 64 KB page holds the following textbook example.'), false);
});

test('does not mistake a team-size number for support for a currency amount', () => {
  const context = {
    userText: 'Compare Pipedrive pricing for a 20-person sales team.', recalled: [], claims: [], cards: [],
    sources: [], entities: [{ name: 'Pipedrive', key: 'pipedrive', domain: 'pipedrive.com' }],
  };
  const checked = checkAnswerFigures('Pipedrive costs $20 per user per month.', context);
  assert.match(checked.text, /figure not verified/);
});

test('checks prices against the entity attached to each clause, not any entity in the sentence', () => {
  const context = {
    userText: 'Compare Pipedrive and HubSpot.', recalled: [], claims: [], cards: [],
    entities: [
      { name: 'Pipedrive', key: 'pipedrive', domain: 'pipedrive.com' },
      { name: 'HubSpot', key: 'hubspot', domain: 'hubspot.com' },
    ],
    sources: [
      { title: 'Pipedrive pricing', registrable_domain: 'pipedrive.com', retrieval_kind: 'page_text', page_text: 'Pipedrive Starter costs $15 per user per month.' },
      { title: 'HubSpot pricing', registrable_domain: 'hubspot.com', retrieval_kind: 'page_text', page_text: 'HubSpot Starter costs $20 per user per month.' },
    ],
  };
  const checked = checkAnswerFigures('Pipedrive costs $20 per user per month and HubSpot costs $15 per user per month.', context);
  assert.match(checked.text, /figure not verified/);
});

test('accepts a currency code only when the amount and currency are both present', () => {
  const context = {
    userText: 'What is the listed price?', recalled: [], claims: [], cards: [],
    entities: [{ name: 'Pipedrive', key: 'pipedrive', domain: 'pipedrive.com' }],
    sources: [{ title: 'Pipedrive pricing', registrable_domain: 'pipedrive.com', retrieval_kind: 'page_text', excerpt_text: 'Starter costs USD 15 per user per month.' }],
  };
  assert.doesNotMatch(checkAnswerFigures('Pipedrive costs $15 per user per month.', context).text, /figure not verified/);
  assert.match(checkAnswerFigures('Pipedrive costs $20 per user per month.', context).text, /figure not verified/);
});

test('recognises a supplied current date in US month-first format', () => {
  const checked = checkAnswerFigures('Today is November 12, 2026.', {
    userText: '', recalled: [], claims: [], cards: [], sources: [], entities: [], today: '2026-11-12',
  });
  assert.doesNotMatch(checked.text, /figure not verified/);
});

test('forces a search for current executive and plan-limit statements in a direct draft', () => {
  assert.equal(hasMutableFactSignal('Yamini Rangan is the CEO of HubSpot.'), true);
  assert.equal(hasMutableFactSignal('The current API limits are listed on the product plan.'), true);
  assert.equal(hasMutableFactSignal('Pipedrive shipped a new feature since Monday.'), true);
});

test('rejects a claim value that contradicts its otherwise valid page quote', () => {
  const quote = 'Pipedrive Starter costs $15 per user per month.';
  const { store, turn, source } = makePageStore(quote);
  const result = validatePageClaims({
    store, turnId: turn.id, sourceItems: [{ source, entity: 'Pipedrive' }],
    rawClaims: [rawPrice(source.id, {
      evidence_quote: quote,
      value_text: '$20 per user per month',
      amount: 15,
    })],
  });
  assert.equal(result.stored, 0);
  assert.equal(result.rejected, 1);
  store.close();
});

test('rejects an earlier-answer claim value that is not present in its quote', () => {
  const store = new Store(':memory:');
  const turn = store.importTurn({
    user_text: 'What was the earlier price?',
    assistant_text: 'Pipedrive Starter costs $15 per user per month.',
    created_at: '2026-10-20T10:00:00Z', timezone: 'Asia/Kolkata',
  });
  const result = validateAnswerClaims({ store, turn, rawClaims: [{
    entity: 'Pipedrive', attribute: 'price', plan_name: 'Starter',
    value_text: '$20 per user per month', amount: 15,
    evidence_quote: 'Pipedrive Starter costs $15 per user per month.',
  }] });
  assert.equal(result.stored, 0);
  assert.equal(result.rejected, 1);
  store.close();
});

test('a calculated currency total cannot validate a percentage or a unit quantity', () => {
  const context = {
    userText: 'Compare Pipedrive pricing for a 20-person sales team.', recalled: [], cards: [],
    claims: [{ entity_key: 'pipedrive', attribute: 'price', price_unit: 'per_seat', amount: 15, value_text: '$15 per user', evidence_quote: '$15 per user per month.' }],
    entities: [{ name: 'Pipedrive', key: 'pipedrive', domain: 'pipedrive.com' }], sources: [],
  };
  assert.match(checkAnswerFigures('Pipedrive would save 300%.', context).text, /figure not verified/);
  assert.match(checkAnswerFigures('Pipedrive has 300 users.', context).text, /figure not verified/);
});

test('recognises annual and monthly billing phrases in realistic pricing quotes', () => {
  const variants = [
    { quote: '$20 per user per month, billed annually', amount: 20, period: 'month', commitment: 'annual' },
    { quote: '$25 per user/month billed monthly', amount: 25, period: 'month', commitment: 'monthly' },
    { quote: 'Starter $15/seat/mo billed annually', amount: 15, period: 'month', commitment: 'annual' },
    { quote: '€14.90 per user per month (billed annually)', amount: 14.9, period: 'month', commitment: 'annual' },
    { quote: '$25 per user per month, month-to-month', amount: 25, period: 'month', commitment: 'monthly' },
  ];
  for (const variant of variants) {
    const { store, turn, source } = makePageStore(variant.quote);
    const value = variant.quote.match(/(?:\$|€)[\d.]+[^,]*/)?.[0] || variant.quote;
    const result = validatePageClaims({ store, turnId: turn.id, sourceItems: [{ source, entity: 'Pipedrive' }], rawClaims: [{
      source_id: source.id, entity: 'Pipedrive', attribute: 'price', plan_name: 'Starter',
      value_text: value, amount: variant.amount, evidence_quote: variant.quote,
    }] });
    assert.equal(result.stored, 1, variant.quote);
    assert.equal(result.claims[0].period, variant.period, variant.quote);
    assert.equal(result.claims[0].commitment, variant.commitment, variant.quote);
    store.close();
  }
});


test('reads billing terms within 200 characters around the validated quote', () => {
  const quote = 'Pipedrive Starter costs $15 per user per month.';
  const variants = [
    `Pipedrive Starter billing: billed annually. ${quote}`,
    `${quote} This listed price is billed monthly.`,
  ];
  const expected = ['annual', 'monthly'];
  for (const [index, pageText] of variants.entries()) {
    const { store, turn, source } = makePageStore(pageText);
    const result = validatePageClaims({
      store,
      turnId: turn.id,
      sourceItems: [{ source, entity: 'Pipedrive' }],
      rawClaims: [{
        source_id: source.id, entity: 'Pipedrive', attribute: 'price',
        plan_name: 'Starter', value_text: '$15 per user per month',
        amount: 15, evidence_quote: quote,
      }],
    });
    assert.equal(result.stored, 1);
    assert.equal(result.claims[0].commitment, expected[index]);
    store.close();
  }
});

test('extracts pricing evidence that appears after long page navigation text', async () => {
  const { excerptWindow } = await import('../src/search/excerpts.mjs');
  const page = `${'Navigation and cookie notices. '.repeat(900)}\nStarter plan costs $20 per user per month, billed annually.`;
  const excerpt = excerptWindow(page, 'Starter');
  assert.ok(excerpt.includes('$20 per user per month'));
  assert.ok(excerpt.length <= 12_000);
});

test('strict plan identity matching prevents prefix collisions like Pro vs Professional', async () => {
  const { plansMatch } = await import('../src/evidence/compare.mjs');
  assert.equal(plansMatch('pro', 'professional'), false);
  assert.equal(plansMatch('starter', 'starter plus'), false);
  assert.equal(plansMatch('business', 'business premium'), false);
  assert.equal(plansMatch('starter', 'starter customer platform'), true);
  assert.equal(plansMatch('starter', 'enterprise'), false);
});

test('does not merge distinct plans like Pro and Professional as duplicates', () => {
  const store = new Store(':memory:');
  const turn = store.importTurn({
    user_text: 'Compare historic plans',
    assistant_text: 'Acme Pro costs $10 monthly. Acme Professional costs $12 monthly.',
    created_at: '2026-10-20T10:00:00Z', timezone: 'Asia/Kolkata',
  });
  const result = validateAnswerClaims({ store, turn, rawClaims: [
    { entity: 'Acme', attribute: 'price', plan_name: 'Pro', value_text: '$10 monthly', amount: 10, evidence_quote: 'Acme Pro costs $10 monthly.' },
    { entity: 'Acme', attribute: 'price', plan_name: 'Professional', value_text: '$12 monthly', amount: 12, evidence_quote: 'Acme Professional costs $12 monthly.' },
  ] });
  assert.equal(result.stored, 2);
  assert.equal(result.rejected, 0);
  store.close();
});

test('does not treat a model-supplied card delta as a code-calculated figure', () => {
  const context = {
    userText: 'Has HubSpot pricing changed since Tuesday?', recalled: [],
    claims: [{ entity_key: 'hubspot', attribute: 'price', price_unit: 'per_seat', amount: 24, value_text: '$24 per user', evidence_quote: '$24 per user per month.' }],
    cards: [{ entity: 'HubSpot', entity_key: 'hubspot', cards: [{ entity: 'HubSpot', attribute: 'price', status: 'Changed', delta_amount: 4 }] }],
    entities: [{ name: 'HubSpot', key: 'hubspot', domain: 'hubspot.com' }],
    sources: [{ title: 'HubSpot pricing', registrable_domain: 'hubspot.com', retrieval_kind: 'page_text', page_text: 'HubSpot Starter costs $24 per user per month.' }],
  };
  assert.match(checkAnswerFigures('HubSpot Starter rose by $4 per user per month.', context).text, /figure not verified/);
});


test('uses the code-assigned target entity rather than a free-text extracted entity', () => {
  const quote = 'HubSpot Sales Hub Starter costs $15 per user per month.';
  const { store, turn, source } = makePageStore(quote);
  const result = validatePageClaims({ store, turnId: turn.id, sourceItems: [{ source, entity: 'HubSpot' }], rawClaims: [{
    ...rawPrice(source.id, { evidence_quote: quote, value_text: '$15 per user per month', amount: 15 }),
    entity: 'HubSpot Sales Hub',
  }] });
  assert.equal(result.stored, 1);
  assert.equal(result.claims[0].entity_key, 'hubspot');
  store.close();
});

test('a stable decimal, a non-market percentage and big-O do not force a search', () => {
  const examples = [
    'Pi is approximately 3.14159.', 'At least 50% full is a queue occupancy threshold.',
    'Binary search runs in O(log n) time.', 'A hash lookup is expected to run in O(1) time.',
    'The Euclidean algorithm computes the greatest common divisor.',
  ];
  for (const example of examples) assert.equal(hasMutableFactSignal(example), false, example);
});

test('version-style decimals still force a search', () => {
  assert.equal(hasMutableFactSignal('Node 22.16 includes the latest runtime fixes.'), true);
  assert.equal(hasMutableFactSignal('The product version 3.2 is the current release.'), true);
});

test('marks an amount copied from a different plan in the same page', () => {
  const result = checkAnswerFigures('HubSpot Starter is $20 per user per month.', {
    userText: 'Check HubSpot pricing.', recalled: [], cards: [],
    entities: [{ name: 'HubSpot', key: 'hubspot', domain: 'hubspot.com' }],
    claims: [{ entity_key: 'hubspot', attribute: 'price', plan_key: 'starter', amount: 15, value_text: '$15 per user per month', evidence_quote: 'Starter is $15 per user per month.' }],
    sources: [{ title: 'HubSpot pricing', registrable_domain: 'hubspot.com', retrieval_kind: 'page_text', excerpt_text: 'Starter is $15 per user per month. Professional is $20 per user per month.' }],
  });
  assert.match(result.text, /figure not verified/);
});

test('requires a matching vendor source for free-form figures', () => {
  const result = checkAnswerFigures('Acme Cloud costs $20 per month.', {
    userText: 'Search Acme Cloud pricing.', recalled: [], claims: [], cards: [], entities: [],
    sources: [{ title: 'Other Vendor pricing', registrable_domain: 'other-vendor.com', retrieval_kind: 'page_text', excerpt_text: 'The price is $20 per month.' }],
  });
  assert.match(result.text, /figure not verified/);
});

test('marks an unsupported calendar date and accepts the full date in an excerpt', () => {
  const context = { userText: 'What changed recently?', recalled: [], claims: [], cards: [], entities: [], sources: [], sinceDates: [], today: '2026-11-13' };
  assert.match(checkAnswerFigures('The release shipped on 5 November.', context).text, /figure not verified/);
  context.sources.push({ title: 'Release notes', registrable_domain: 'example.com', retrieval_kind: 'page_text', excerpt_text: 'Published 5 November 2026.' });
  assert.doesNotMatch(checkAnswerFigures('The release shipped on 5 November 2026.', context).text, /figure not verified/);
});

test('keeps an unsubstantiated release date marked while preserving today wording', () => {
  const context = { userText: '', recalled: [], claims: [], cards: [], entities: [], sources: [], today: '2026-11-13' };
  assert.match(checkAnswerFigures('The product launched on 2026-11-05.', context).text, /figure not verified/);
  assert.doesNotMatch(checkAnswerFigures('As of today, the current date is 13 November 2026.', context).text, /figure not verified/);
});

test('separates figure notice from subsequent sentence with whitespace', () => {
  const context = { userText: '', recalled: [], claims: [], cards: [], entities: [], sources: [], today: '2026-11-13' };
  const checked = checkAnswerFigures(
    'On 3 November 2026, you asked about Postgres. Yes, that advice remains correct.',
    context,
  );
  assert.match(checked.text, /\(figure not verified\) Yes,/);
  assert.doesNotMatch(checked.text, /\(figure not verified\)Yes/);
});

test('does not infer billing commitment from a yearly price unit but accepts an explicit monthly billing quote', () => {
  for (const variant of [
    { quote: 'Starter costs $15 per user per year.', period: 'year', commitment: 'unknown' },
    { quote: 'Starter costs $15 per user/month, billed monthly.', period: 'month', commitment: 'monthly' },
  ]) {
    const { store, turn, source } = makePageStore(variant.quote);
    const result = validatePageClaims({ store, turnId: turn.id, sourceItems: [{ source, entity: 'Pipedrive' }], rawClaims: [{
      source_id: source.id, entity: 'Pipedrive', attribute: 'price', plan_name: 'Starter', value_text: variant.quote,
      amount: 15, period: 'annual', commitment: 'annual', evidence_quote: variant.quote,
    }] });
    assert.equal(result.stored, 1);
    assert.equal(result.claims[0].period, variant.period);
    assert.equal(result.claims[0].commitment, variant.commitment);
    store.close();
  }
});

test('free-form page claims preserve distinct model entity strings as opaque keys', () => {
  const pageText = 'PostgreSQL 17.2 is the current stable release. Postgres 16.4 remains available for maintenance.';
  const { store, turn, source } = makePageStore(pageText);
  const result = validatePageClaims({
    store,
    turnId: turn.id,
    sourceItems: [{ source, entity: '' }],
    rawClaims: [
      {
        source_id: source.id, entity: 'PostgreSQL', attribute: 'version',
        value_text: '17.2', amount: null, evidence_quote: 'PostgreSQL 17.2 is the current stable release.',
      },
      {
        source_id: source.id, entity: 'Postgres', attribute: 'version',
        value_text: '16.4', amount: null, evidence_quote: 'Postgres 16.4 remains available for maintenance.',
      },
    ],
  });
  assert.equal(result.stored, 2);
  assert.deepEqual(result.claims.map((claim) => claim.entity_key), ['postgresql', 'postgres']);
  store.close();
});

test('normalises demo baseline entity strings with trailing plan names to canonical vendor keys', () => {
  const store = new Store(':memory:');
  const turn = store.importTurn({
    user_text: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Which should we compare first?',
    assistant_text: 'The five tools shortlisted were HubSpot Starter at $20 per user per month, billed annually, Pipedrive Essential at $15 per user per month, billed annually, Zoho CRM Standard at $14 per user per month, billed annually, Monday CRM Basic at $12 per user per month, billed annually, and Freshsales Growth at $9 per user per month, billed annually.',
    created_at: '2026-11-09T08:30:00.000Z',
    source_created_at: '2026-10-20T08:30:00.000Z',
  });
  const result = validateAnswerClaims({
    store,
    turn,
    rawClaims: [
      { entity: 'HubSpot Starter', attribute: 'price', plan_name: 'Starter', value_text: '$20 per user per month', amount: 20, evidence_quote: 'HubSpot Starter at $20 per user per month, billed annually' },
      { entity: 'Pipedrive Essential', attribute: 'price', plan_name: 'Essential', value_text: '$15 per user per month', amount: 15, evidence_quote: 'Pipedrive Essential at $15 per user per month, billed annually' },
      { entity: 'Zoho CRM Standard', attribute: 'price', plan_name: 'Standard', value_text: '$14 per user per month', amount: 14, evidence_quote: 'Zoho CRM Standard at $14 per user per month, billed annually' },
      { entity: 'Monday CRM Basic', attribute: 'price', plan_name: 'Basic', value_text: '$12 per user per month', amount: 12, evidence_quote: 'Monday CRM Basic at $12 per user per month, billed annually' },
      { entity: 'Freshsales Growth', attribute: 'price', plan_name: 'Growth', value_text: '$9 per user per month', amount: 9, evidence_quote: 'Freshsales Growth at $9 per user per month, billed annually' },
    ],
  });
  assert.deepEqual(result.claims.map((claim) => claim.entity_key), ['hubspot', 'pipedrive', 'zoho crm', 'monday crm', 'freshsales']);
  store.close();
});

test('strict entity matching keeps different products from the same vendor separate', () => {
  assert.equal(matchEntityHint('Microsoft Teams', ['Microsoft Dynamics']), 'microsoft teams');
  assert.equal(matchEntityHint('Zoho Books', ['Zoho CRM']), 'zoho books');
  assert.equal(matchEntityHint('Salesforce Service Cloud', ['Salesforce Sales Cloud']), 'salesforce service cloud');

  assert.equal(matchEntityHint('HubSpot Starter', ['HubSpot'], 'Starter'), 'hubspot');
  assert.equal(matchEntityHint('Pipedrive Essential', ['Pipedrive'], 'Essential'), 'pipedrive');

  assert.equal(matchEntityHint('Zoho', ['Zoho CRM']), 'zoho crm');
  assert.equal(matchEntityHint('Zoho', ['Zoho CRM', 'Zoho Books']), 'zoho');
});

test('cross-product baseline from different products never produces Changed or Same', async () => {
  const { buildComparisonCards } = await import('../src/evidence/compare.mjs');
  const store = new Store(':memory:');
  const turn = store.createTurn({ userText: 'Check Microsoft Dynamics pricing.', timezone: 'Asia/Kolkata' });
  const currentSource = store.addSource({
    turnId: turn.id, url: 'https://microsoft.com/dynamics', domain: 'microsoft.com',
    title: 'Microsoft Dynamics pricing', pageText: 'Dynamics costs $70 per user per month.',
    retrievalKind: 'page_text', pageTextOrigin: 'extract', retrievedAt: '2026-11-12T10:00:00Z',
  });
  const currentClaims = [{
    id: 'c1', turn_id: turn.id, entity_key: 'microsoft dynamics',
    attribute: 'price', plan_key: 'standard', value_text: '$70 per user per month',
    amount: 70, currency: 'USD', price_unit: 'per_seat', period: 'month',
    commitment: 'annual', qualifiers: '[]', evidence_quote: 'Dynamics costs $70 per user per month.',
    source_id: currentSource.id, observed_at_utc: '2026-11-12T10:00:00Z', baseline_basis: 'page_text',
  }];
  const baselineClaims = [{
    id: 'b1', turn_id: 't0', entity_key: 'microsoft teams',
    attribute: 'price', plan_key: 'standard', value_text: '$5 per user per month',
    amount: 5, currency: 'USD', price_unit: 'per_seat', period: 'month',
    commitment: 'annual', qualifiers: '[]', evidence_quote: 'Teams costs $5 per user per month.',
    source_id: null, observed_at_utc: '2026-10-20T10:00:00Z', baseline_basis: 'answer_text',
  }];
  const cards = buildComparisonCards({
    store,
    targets: [{ entity: 'Microsoft Dynamics', entity_key: 'microsoft dynamics', checks: ['pricing'], page: { domain: 'microsoft.com' } }],
    currentClaims,
    baselineClaims,
  });
  assert.equal(cards.length, 1);
  assert.notEqual(cards[0].cards[0].status, 'Changed');
  assert.notEqual(cards[0].cards[0].status, 'Same as before');
  assert.match(cards[0].cards[0].status, /No earlier record to compare/);
  store.close();
});

test('currencyFromQuote distinguishes prefixes and codes before bare dollars and records ambiguity', async () => {
  const { currencyFromQuote } = await import('../src/evidence/claims.mjs');
  assert.equal(currencyFromQuote('', 'CA$49 per month'), 'CAD');
  assert.equal(currencyFromQuote('', 'A$49 per month'), 'AUD');
  assert.equal(currencyFromQuote('', 'S$49 per month'), 'SGD');
  assert.equal(currencyFromQuote('', 'US$49 per month'), 'USD');
  assert.equal(currencyFromQuote('', '€49 per month'), 'EUR');
  assert.equal(currencyFromQuote('', '£49 per month'), 'GBP');
  assert.equal(currencyFromQuote('', '₹49 per month'), 'INR');
  assert.equal(currencyFromQuote('', 'Rs. 49 per month'), 'INR');
  assert.equal(currencyFromQuote('', '49 CAD billed monthly'), 'CAD');
  assert.equal(currencyFromQuote('', '49 AUD billed monthly'), 'AUD');
  assert.equal(currencyFromQuote('', '49 SGD billed monthly'), 'SGD');
  assert.equal(currencyFromQuote('', '49 USD billed monthly'), 'USD');
  assert.equal(currencyFromQuote('', '49 EUR billed monthly'), 'EUR');
  assert.equal(currencyFromQuote('', '$49 per month', 'All prices in Canadian dollars'), 'CAD');
  assert.equal(currencyFromQuote('', '$49 per month'), 'ambiguous_dollar');
});

test('billing terms on adjacent plans are not transferred across plans', async () => {
  const { commitmentFromQuote } = await import('../src/evidence/claims.mjs');
  const pageText = 'Starter costs $49 per user per month. Professional is billed annually.';

  const starterCommitment = commitmentFromQuote('', 'Starter costs $49 per user per month.', pageText, 'Starter');
  assert.notEqual(starterCommitment, 'annual');
  assert.equal(starterCommitment, 'unknown');

  const proCommitment = commitmentFromQuote('', 'Professional is billed annually.', pageText, 'Professional');
  assert.equal(proCommitment, 'annual');

  const monthlyEquivalent = commitmentFromQuote('', '$49/mo (monthly equivalent, billed annually)');
  assert.equal(monthlyEquivalent, 'annual');
});

test('quote surrounded by "billed annually" within 200 chars resolves to annual; without billing words gives unknown', async () => {
  const { commitmentFromQuote } = await import('../src/evidence/claims.mjs');
  const quote = 'Starter $20 per user per month';
  const pageWithBilling = 'Starter pricing details: Starter $20 per user per month when billed annually.';
  assert.equal(commitmentFromQuote('', quote, pageWithBilling, 'Starter'), 'annual');

  const pageWithoutBilling = 'Starter pricing details: Starter $20 per user per month with unlimited contacts.';
  assert.equal(commitmentFromQuote('', quote, pageWithoutBilling, 'Starter'), 'unknown');
});

test('findVerbatimSlice extracts exact verbatim substring from page text despite formatting differences', async () => {
  const { findVerbatimSlice } = await import('../src/evidence/claims.mjs');
  const page = 'HubSpot CRM Starter costs $20 per user per month with monthly billing.';

  // Exact match
  assert.equal(
    findVerbatimSlice(page, 'costs $20 per user per month'),
    'costs $20 per user per month'
  );

  // Case variation: model used uppercase "Costs"
  assert.equal(
    findVerbatimSlice(page, 'Costs $20 per user per month'),
    'costs $20 per user per month'
  );

  // Whitespace variation in multiline page text
  const multilinePage = 'Neon Launch costs $19\nper month on usage billing.';
  const matched = findVerbatimSlice(multilinePage, 'Neon Launch costs $19 per month');
  assert.ok(matched);
  assert.ok(multilinePage.includes(matched));

  // Completely ungrounded quote returns null
  assert.equal(findVerbatimSlice(page, 'costs $999 per month for unlimited users'), null);
});

test('claims pipeline extracts verbatim quote directly matching stored page text faithfully', () => {
  const pageText = 'Pipedrive Essential costs $15 per user per month with no commitment.';
  const { store, turn, source } = makePageStore(pageText);

  // Model produced quote with slight casing difference
  const modelClaim = rawPrice(source.id, {
    evidence_quote: 'Pipedrive Essential Costs $15 Per User Per Month with no commitment.',
    value_text: '$15 per user per month',
    amount: 15,
  });

  const result = validatePageClaims({
    store,
    turnId: turn.id,
    sourceItems: [{ source, entity: 'Pipedrive' }],
    rawClaims: [modelClaim],
  });

  assert.equal(result.stored, 1);
  assert.equal(result.rejected, 0);
  const savedClaim = result.claims[0];
  assert.ok(source.page_text.includes(savedClaim.evidence_quote));
  store.close();
});

