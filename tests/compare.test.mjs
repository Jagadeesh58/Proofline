import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/memory/store.mjs';
import { buildComparisonCards } from '../src/evidence/compare.mjs';
import { OFFICIAL_DOMAIN_SEEDS, trustLabel, registrableDomain, normaliseEntity } from '../src/seeds/domains.mjs';

function insertTurn(store, label, createdAt) {
  const turn = store.importTurn({ user_text: `${label} pricing check`, assistant_text: `${label} evidence`, created_at: createdAt, timezone: 'Asia/Kolkata' });
  store.updateTurn(turn.id, { claims_status: 'done' });
  return turn;
}

function addPrice(store, turn, { url, domain, amount, period = 'month', commitment = 'none', currency = 'USD', priceUnit = 'per_seat', observed = '2026-10-20T10:00:00.000Z', pageDate = null, entity = 'hubspot', plan = 'starter' }) {
  const source = store.addSource({
    turnId: turn.id, url, domain, title: `${entity} pricing`, pageText: `Plan costs $${amount} per user per ${period}.`,
    retrievalKind: 'page_text', pageTextOrigin: 'extract', pageDateText: pageDate,
    retrievedAt: observed,
  });
  const claim = store.addClaim({
    turn_id: turn.id, entity_key: entity, attribute: 'price', plan_key: plan,
    value_text: `$${amount} per user per ${period}`, amount, currency,
    price_unit: priceUnit, period, commitment, qualifiers: [],
    evidence_quote: `Plan costs $${amount} per user per ${period}.`, source_id: source.id,
    observed_at_utc: observed, baseline_basis: 'page_text',
  });
  return { source, claim };
}

function compareFixture({
  baseline = { url: 'https://hubspot.com/pricing', amount: 20 },
  current = { url: 'https://hubspot.com/pricing', amount: 20 },
  entity = 'HubSpot',
} = {}) {
  const store = new Store(':memory:');
  const before = insertTurn(store, 'baseline', '2026-10-20T10:00:00.000Z');
  addPrice(store, before, { ...baseline, entity: normaliseEntity(entity), observed: baseline.observed || '2026-10-20T10:00:00.000Z', pageDate: baseline.pageDate || null });
  const now = store.createTurn({ userText: 'Check current HubSpot pricing.', timezone: 'Asia/Kolkata', now: new Date('2026-11-12T10:00:00.000Z') });
  const currentData = addPrice(store, now, { ...current, entity: normaliseEntity(entity), observed: current.observed || '2026-11-12T10:00:00.000Z', pageDate: current.pageDate || null });
  store.updateTurn(before.id, { status: 'completed', claims_status: 'done' });
  store.updateTurn(now.id, { status: 'completed', claims_status: 'done' });
  const target = { entity, entity_key: normaliseEntity(entity), checks: ['pricing'], page: { domain: registrableDomain(current.url) } };
  const cards = buildComparisonCards({ store, targets: [target], currentClaims: [currentData.claim], baselineClaims: store.getClaimsForTurn(before.id) });
  return { store, cards: cards[0].cards };
}

test('assigns Same as before only when the same official source and terms match', () => {
  const { store, cards } = compareFixture();
  assert.equal(cards[0].status, 'Same as before');
  assert.equal(cards[0].trust_label, 'Official site (verified)');
  store.close();
});

test('assigns Changed when a verified price changes on the same source domain', () => {
  const { store, cards } = compareFixture({ current: { url: 'https://hubspot.com/pricing', amount: 24 } });
  assert.equal(cards[0].status, 'Changed');
  assert.equal(cards[0].delta_amount, 4);
  store.close();
});


test('a wrong-page extraction produces an explicit wrong_page comparison reason', () => {
  const store = new Store(':memory:');
  const now = store.createTurn({ userText: 'Check HubSpot pricing.', timezone: 'Asia/Kolkata' });
  const target = {
    entity: 'HubSpot', entity_key: 'hubspot', checks: ['pricing'],
    page: { domain: 'hubspot.com', extraction_reason: 'wrong_page' },
  };
  const cards = buildComparisonCards({
    store, targets: [target], currentClaims: [], baselineClaims: [],
  });
  assert.equal(cards[0].cards[0].reason, 'wrong_page');
  store.close();
});

test('resolves product names to seeded parent-brand domains without plan hints', () => {
  for (const entity of ['Jira', 'Confluence', 'Trello', 'Bitbucket']) {
    assert.equal(
      trustLabel(entity, 'https://atlassian.com/pricing').label,
      'Official site (verified)',
      entity,
    );
  }
  assert.equal(trustLabel('Dynamics 365', 'https://microsoft.com').label, 'Official site (verified)');
  assert.equal(trustLabel('Sales Cloud', 'https://salesforce.com').label, 'Official site (verified)');
});


test('recognises unseen vendor names through generic category stripping', () => {
  assert.equal(
    trustLabel('Northstar CRM', 'https://northstar.com/pricing').label,
    'Vendor site (not verified)',
  );
  assert.equal(
    trustLabel('BlueOak Cloud Hosting', 'https://blueoak.io').label,
    'Vendor site (not verified)',
  );
  assert.equal(
    trustLabel('Northstar CRM', 'https://northstar-pricing.com').label,
    'Third party',
  );
});

test('does not compare values across registrable domains', () => {
  const { store, cards } = compareFixture({
    baseline: { url: 'https://hubspot.com/pricing', amount: 20 },
    current: { url: 'https://hubspot.io/pricing', amount: 25 },
  });
  assert.equal(cards[0].status, 'Couldn’t confirm');
  assert.equal(cards[0].reason, 'different_source_sites');
  store.close();
});

test('does not use a third-party source to assign Changed or Same', () => {
  const { store, cards } = compareFixture({ current: { url: 'https://hubspot-pricing-review.com/page', amount: 25 } });
  assert.equal(cards[0].status, 'Couldn’t confirm');
  assert.equal(cards[0].reason, 'third_party_source');
  store.close();
});

test('rejects an older page date as a current changed value', () => {
  const { store, cards } = compareFixture({ current: { url: 'https://hubspot.com/pricing', amount: 25, pageDate: 'Last updated: 1 October 2026' } });
  assert.equal(cards[0].status, 'Couldn’t confirm');
  assert.equal(cards[0].reason, 'stale_page');
  store.close();
});

test('rejects an older page date as confirming an unchanged value', () => {
  const { store, cards } = compareFixture({ current: { url: 'https://hubspot.com/pricing', amount: 20, pageDate: 'Last updated: 1 October 2026' } });
  assert.equal(cards[0].status, 'Couldn’t confirm');
  assert.equal(cards[0].reason, 'stale_page');
  store.close();
});

test('plan matching strictly distinguishes Pro from Professional and Starter from Starter Plus', () => {
  const { store, cards } = compareFixture({ current: { url: 'https://hubspot.com/pricing', amount: 20, plan: 'starter plus' } });
  assert.equal(cards[0].status, 'No earlier record to compare');
  store.close();
});

test('does not compare prices in different currencies as equivalent', () => {
  const { store, cards } = compareFixture({ current: { url: 'https://hubspot.com/pricing', amount: 20, currency: 'CAD' } });
  assert.equal(cards[0].status, 'Can’t compare: terms differ');
  assert.equal(cards[0].reason, 'terms_differ');
  store.close();
});

test('does not compare a known commitment with an unknown commitment', () => {
  const { store, cards } = compareFixture({ current: { url: 'https://hubspot.com/pricing', amount: 25, commitment: 'unknown' } });
  assert.equal(cards[0].status, 'Can’t compare: terms differ');
  assert.equal(cards[0].reason, 'terms_unknown');
  store.close();
});

test('reports changed billing conditions as Can’t compare rather than Changed', () => {
  const { store, cards } = compareFixture({ current: { url: 'https://hubspot.com/pricing', amount: 25, period: 'year' } });
  assert.equal(cards[0].status, 'Can’t compare: terms differ');
  assert.equal(cards[0].reason, 'terms_differ');
  store.close();
});

test('compares equal prices when commitment is unknown on both sides with an honest suffix', () => {
  const { store, cards } = compareFixture({
    baseline: { url: 'https://hubspot.com/pricing', amount: 20, commitment: 'unknown' },
    current: { url: 'https://hubspot.com/pricing', amount: 20, commitment: 'unknown' },
  });
  assert.equal(cards[0].status, 'Same as before (billing terms not stated)');
  assert.equal(cards[0].reason, 'terms_partly_unknown');
  store.close();
});

test('compares changed prices when commitment is unknown on both sides with an honest suffix', () => {
  const { store, cards } = compareFixture({
    baseline: { url: 'https://hubspot.com/pricing', amount: 20, commitment: 'unknown' },
    current: { url: 'https://hubspot.com/pricing', amount: 24, commitment: 'unknown' },
  });
  assert.equal(cards[0].status, 'Changed (billing terms not stated)');
  assert.equal(cards[0].reason, 'terms_partly_unknown');
  store.close();
});

test('does not compare a different plan alias or an absent baseline plan', () => {
  const { store, cards } = compareFixture({ current: { url: 'https://hubspot.com/pricing', amount: 25, plan: 'professional' } });
  assert.equal(cards[0].status, 'No earlier record to compare');
  store.close();
});

test('earlier-answer baselines use only the unverified answer labels', () => {
  const store = new Store(':memory:');
  const before = insertTurn(store, 'answer baseline', '2026-10-20T10:00:00Z');
  const answerClaim = store.addClaim({
    turn_id: before.id, entity_key: 'hubspot', attribute: 'price', plan_key: 'starter',
    value_text: '$20 per user per month', amount: 20, currency: 'USD', price_unit: 'per_seat',
    period: 'month', commitment: 'none', qualifiers: [], evidence_quote: 'HubSpot Starter costs $20 per user per month with no contract.',
    source_id: null, observed_at_utc: '2026-10-20T10:00:00Z', baseline_basis: 'answer_text',
  });
  const now = store.createTurn({ userText: 'Check HubSpot pricing.', timezone: 'Asia/Kolkata' });
  const { claim: currentClaim } = addPrice(store, now, { url: 'https://hubspot.com/pricing', amount: 20, entity: 'hubspot' });
  store.updateTurn(before.id, { status: 'completed', claims_status: 'done' });
  store.updateTurn(now.id, { status: 'completed', claims_status: 'done' });
  const cards = buildComparisonCards({
    store, targets: [{ entity: 'HubSpot', entity_key: 'hubspot', checks: ['pricing'], page: { domain: 'hubspot.com' } }],
    currentClaims: [currentClaim], baselineClaims: [answerClaim],
  });
  assert.equal(cards[0].cards[0].status, 'Same as my earlier answer');
  store.close();
});

test('lists reported release notes by provider publication date without treating it as event date', () => {
  const store = new Store(':memory:');
  const turn = insertTurn(store, 'release', '2026-11-12T00:00:00Z');
  const source = store.addSource({
    turnId: turn.id, url: 'https://hubspot.com/changelog', domain: 'hubspot.com', title: 'New HubSpot feature',
    providerDate: '2026-11-05', pageText: 'HubSpot announced a new feature.', retrievalKind: 'page_text', pageTextOrigin: 'search_raw',
  });
  const claim = store.addClaim({
    turn_id: turn.id, entity_key: 'hubspot', attribute: 'release', plan_key: 'unspecified', value_text: 'new feature',
    evidence_quote: 'HubSpot announced a new feature.', source_id: source.id, observed_at_utc: source.retrieved_at_utc, baseline_basis: 'page_text',
  });
  const output = buildComparisonCards({
    store, targets: [{ entity: 'HubSpot', entity_key: 'hubspot', checks: ['news'], since: '2026-11-01', page: null }],
    currentClaims: [claim], baselineClaims: [],
  });
  assert.equal(output[0].reported.length, 1);
  assert.equal(output[0].reported[0].date, '2026-11-05');
  store.close();
});

test('recognises verified seed domains and unverified vendor-name matches', () => {
  assert.equal(trustLabel('HubSpot', 'https://hubspot.com/pricing').label, 'Official site (verified)');
  assert.equal(trustLabel('Zoho CRM', 'https://zoho.com/crm/pricing').label, 'Official site (verified)');
  assert.equal(trustLabel('Monday CRM', 'https://monday.com/pricing').label, 'Official site (verified)');
  assert.equal(trustLabel('Less Annoying CRM', 'https://lessannoyingcrm.com/pricing').label, 'Official site (verified)');
});

test('recognises Fly.io and Aiven parent labels without a bare first-word match', () => {
  assert.equal(trustLabel('Fly.io', 'https://fly.io/docs').label, 'Vendor site (not verified)');
  assert.equal(trustLabel('Aiven for PostgreSQL', 'https://aiven.com/pricing').label, 'Vendor site (not verified)');
  assert.equal(trustLabel('Less Annoying CRM', 'https://less.com/').label, 'Third party');
  assert.equal(trustLabel('AWS RDS', 'https://amazon.com/').label, 'Third party');
});

test('rejects lookalike, SEO and unapproved-TLD domains', () => {
  assert.equal(trustLabel('Pipedrive', 'https://pipedrive-pricing-explained.com/').label, 'Third party');
  assert.equal(trustLabel('Pipedrive CRM', 'https://pipedrive-crm.com/').label, 'Third party');
  assert.equal(trustLabel('HubSpot', 'https://hubspot.info/').label, 'Third party');
});

test('registrable-domain extraction accounts for common two-part public suffixes', () => {
  assert.equal(registrableDomain('https://pricing.example.co.uk/page'), 'example.co.uk');
  assert.equal(registrableDomain('https://docs.example.com.au/'), 'example.com.au');
  assert.equal(registrableDomain('https://www.hubspot.com/'), 'hubspot.com');
});

test('domain-match candidate normalisation keeps hyphens and removes category suffixes only', () => {
  assert.equal(normaliseEntity('Less Annoying CRM'), 'less annoying crm');
  assert.equal(trustLabel('FreshSales', 'https://freshworks.com/products/freshsales').label, 'Official site (verified)');
});

test('official seed dates are present for every seeded vendor', () => {
  assert.ok(Object.keys(OFFICIAL_DOMAIN_SEEDS).length >= 10);
  for (const seed of Object.values(OFFICIAL_DOMAIN_SEEDS)) assert.match(seed.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
});


test('accepts current Notion, Neon and Zoho domains without upgrading unseeded domains to Official', () => {
  assert.equal(trustLabel('Notion', 'https://notion.com').label, 'Official site (verified)');
  assert.equal(trustLabel('Neon', 'https://neon.com').label, 'Official site (verified)');
  assert.equal(trustLabel('Zoho CRM', 'https://zoho.in', { 'zoho crm': { allowed_tlds: ['in', 'eu'], domain_labels: ['zoho'] } }).label, 'Vendor site (not verified)');
  assert.equal(trustLabel('Zoho CRM', 'https://zoho.eu', { 'zoho crm': { allowed_tlds: ['in', 'eu'], domain_labels: ['zoho'] } }).label, 'Vendor site (not verified)');
});

test('maps Atlassian, Microsoft and Salesforce product names to seeded parent domains', () => {
  for (const entity of ['Jira', 'Confluence', 'Trello', 'Bitbucket']) {
    assert.equal(trustLabel(entity, 'https://atlassian.com', { [entity.toLowerCase()]: { domain_labels: ['atlassian'] } }).label, 'Official site (verified)', entity);
  }
  assert.equal(trustLabel('Dynamics 365', 'https://microsoft.com', { 'dynamics 365': { domain_labels: ['microsoft'] } }).label, 'Official site (verified)');
  assert.equal(trustLabel('Sales Cloud', 'https://salesforce.com', { 'sales cloud': { domain_labels: ['salesforce'] } }).label, 'Official site (verified)');
});

test('keeps the specifically identified HubSpot and Pipedrive lookalikes third party', () => {
  for (const url of ['https://hubspot.in', 'https://hubspot.co', 'https://hubspot.org', 'https://hubspot.tech', 'https://hubspot.info']) {
    assert.equal(trustLabel('HubSpot', url).label, 'Third party', url);
  }
  for (const url of ['https://pipedrive-crm.com', 'https://pipedrive-pricing-explained.com']) {
    assert.equal(trustLabel('Pipedrive', url).label, 'Third party', url);
  }
});

test('a name-matched baseline can be compared only on the same domain and never claims verified Changed', () => {
  const { store, cards } = compareFixture({
    entity: 'Close',
    baseline: { url: 'https://close.com/pricing', domain: 'close.com', amount: 20 },
    current: { url: 'https://close.com/pricing', domain: 'close.com', amount: 24 },
  });
  assert.equal(cards[0].status, 'Changed (site not verified)');
  assert.equal(cards[0].trust_label, 'Vendor site (not verified)');
  assert.equal(cards[0].domain, 'close.com');
  store.close();
});


test('vendor site domain keeps partly unknown changed prices visibly unverified', () => {
  const { store, cards } = compareFixture({
    entity: 'Close',
    baseline: { url: 'https://close.com/pricing', amount: 20, commitment: 'unknown' },
    current: { url: 'https://close.com/pricing', amount: 24, commitment: 'unknown' },
  });
  assert.equal(cards[0].status, 'Changed (billing terms not stated) (site not verified)');
  assert.equal(cards[0].trust_label, 'Vendor site (not verified)');
  store.close();
});


test('does not compare a name-matched baseline across two different vendor-name domains', () => {
  const { store, cards } = compareFixture({
    entity: 'Close',
    baseline: { url: 'https://close.com/pricing', amount: 20 },
    current: { url: 'https://close.io/pricing', amount: 24 },
  });
  assert.equal(cards[0].status, 'Couldn’t confirm');
  assert.equal(cards[0].reason, 'different_source_sites');
  assert.equal(cards[0].trust_label, 'Vendor site (not verified)');
  store.close();
});

test('CRM check turn with 5 recalled tools generates 5 comparison cards', () => {
  const store = new Store(':memory:');
  const before = insertTurn(store, 'baseline', '2026-11-09T08:30:00.000Z');
  const now = store.createTurn({ userText: 'Check CRM shortlist.', timezone: 'Asia/Kolkata' });
  const crmEntities = [
    { entity: 'HubSpot', key: 'hubspot', plan: 'Starter', price: 20 },
    { entity: 'Pipedrive', key: 'pipedrive', plan: 'Essential', price: 15 },
    { entity: 'Zoho', key: 'zoho', plan: 'Standard', price: 14 },
    { entity: 'Monday', key: 'monday', plan: 'Basic', price: 12 },
    { entity: 'Freshsales', key: 'freshsales', plan: 'Growth', price: 9 },
  ];
  const targets = crmEntities.map((item) => ({
    entity: item.entity,
    entity_key: item.key,
    checks: ['pricing'],
    page: { domain: `${item.key}.com` },
  }));
  const baselineClaims = crmEntities.map((item) => {
    const { claim } = addPrice(store, before, {
      url: `https://${item.key}.com/pricing`,
      domain: `${item.key}.com`,
      amount: item.price,
      entity: item.key,
      plan: item.plan.toLowerCase(),
      period: 'month',
      commitment: 'annual',
      observed: '2026-11-09T08:30:00.000Z',
    });
    return claim;
  });
  const currentData = addPrice(store, now, {
    url: 'https://hubspot.com/pricing',
    domain: 'hubspot.com',
    amount: 20,
    entity: 'hubspot',
    plan: 'starter',
    period: 'month',
    commitment: 'annual',
    observed: '2026-11-14T10:00:00.000Z',
  });

  const cards = buildComparisonCards({
    store,
    targets,
    currentClaims: [currentData.claim],
    baselineClaims,
  });

  assert.equal(cards.length, 5);
  assert.equal(cards[0].entity, 'HubSpot');
  assert.equal(cards[0].cards[0].status, 'Same as before');
  assert.equal(cards[0].cards[0].plan, 'starter');
  assert.equal(cards[0].cards[0].current.amount, 20);

  for (let i = 1; i < 5; i += 1) {
    assert.equal(cards[i].cards[0].status, 'Couldn’t confirm');
    assert.equal(cards[i].entity, crmEntities[i].entity);
  }
  store.close();
});

test('Postgres check turn with 2 recalled hosts generates 2 comparison cards', () => {
  const store = new Store(':memory:');
  const targets = [
    { entity: 'Neon', entity_key: 'neon', checks: ['pricing'], page: { domain: 'neon.tech' } },
    { entity: 'Supabase', entity_key: 'supabase', checks: ['pricing'], page: { domain: 'supabase.com' } },
  ];
  const baselineClaims = [
    {
      entity_key: 'neon',
      attribute: 'price',
      plan_key: 'launch',
      amount: 19,
      currency: 'USD',
      period: 'month',
      commitment: 'none',
      value_text: '$19 per month',
      evidence_quote: 'Neon Launch is $19 per month.',
      observed_at_utc: '2026-11-10T08:30:00.000Z',
      baseline_basis: 'page_text',
    },
    {
      entity_key: 'supabase',
      attribute: 'price',
      plan_key: 'pro',
      amount: 25,
      currency: 'USD',
      period: 'month',
      commitment: 'none',
      value_text: '$25 per month',
      evidence_quote: 'Supabase Pro is $25 per month.',
      observed_at_utc: '2026-11-10T08:30:00.000Z',
      baseline_basis: 'page_text',
    },
  ];
  const cards = buildComparisonCards({
    store,
    targets,
    currentClaims: [],
    baselineClaims,
  });
  assert.equal(cards.length, 2);
  assert.equal(cards[0].entity, 'Neon');
  assert.equal(cards[0].cards[0].status, 'Couldn’t confirm');
  assert.equal(cards[1].entity, 'Supabase');
  assert.equal(cards[1].cards[0].status, 'Couldn’t confirm');
  store.close();
});

test('two providers where one is confirmed same and one is unconfirmed reports unconfirmed for the second', () => {
  const store = new Store(':memory:');
  const before = insertTurn(store, 'baseline', '2026-11-10T08:30:00.000Z');
  const now = store.createTurn({ userText: 'Check Postgres pricing.', timezone: 'Asia/Kolkata' });
  const targets = [
    { entity: 'Neon', entity_key: 'neon', checks: ['pricing'], page: { domain: 'neon.tech' } },
    { entity: 'Supabase', entity_key: 'supabase', checks: ['pricing'], page: { domain: 'supabase.com' } },
  ];
  const neonBase = addPrice(store, before, {
    url: 'https://neon.tech/pricing',
    domain: 'neon.tech',
    amount: 19,
    entity: 'neon',
    plan: 'launch',
    period: 'month',
    commitment: 'none',
    observed: '2026-11-10T08:30:00.000Z',
  });
  const supaBase = addPrice(store, before, {
    url: 'https://supabase.com/pricing',
    domain: 'supabase.com',
    amount: 25,
    entity: 'supabase',
    plan: 'pro',
    period: 'month',
    commitment: 'none',
    observed: '2026-11-10T08:30:00.000Z',
  });
  const neonCurrent = addPrice(store, now, {
    url: 'https://neon.tech/pricing',
    domain: 'neon.tech',
    amount: 19,
    entity: 'neon',
    plan: 'launch',
    period: 'month',
    commitment: 'none',
    observed: '2026-11-14T10:00:00.000Z',
  });

  const cards = buildComparisonCards({
    store,
    targets,
    currentClaims: [neonCurrent.claim],
    baselineClaims: [neonBase.claim, supaBase.claim],
  });
  assert.equal(cards.length, 2);
  assert.equal(cards[0].cards[0].status, 'Same as before');
  assert.equal(cards[1].cards[0].status, 'Couldn’t confirm');
  store.close();
});
