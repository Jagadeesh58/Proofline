import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWebSearchInput, ToolInputError, resolveTargetNewsSince } from '../src/search/tool.mjs';
import { trustLabel } from '../src/seeds/domains.mjs';

test('accepts the documented one-tool input with independent query and target arrays', () => {
  const result = validateWebSearchInput({
    queries: [{ q: 'How does PostgreSQL MVCC work?' }, { q: 'new product release', topic: 'news', since: '2026-11-01' }],
    targets: [{ entity: 'Neon', checks: ['pricing','limit','news'], since: '2026-11-01' }],
  }, '2026-11-12');
  assert.equal(result.queries.length, 2);
  assert.equal(result.targets.length, 1);
  assert.equal(result.queries[0].topic, 'general');
});

test('rejects an empty tool request', () => {
  assert.throws(() => validateWebSearchInput({ queries: [], targets: [] }), ToolInputError);
  assert.throws(() => validateWebSearchInput({}), ToolInputError);
});

test('rejects a date filter on a general query', () => {
  assert.throws(() => validateWebSearchInput({ queries: [{ q: 'pricing', since: '2026-11-01' }] }), /only on news queries/);
});

test('rejects malformed or future query dates', () => {
  assert.throws(() => validateWebSearchInput({ queries: [{ q: 'news', topic: 'news', since: '2026-02-30' }] }), /valid date/);
  assert.throws(() => validateWebSearchInput({ queries: [{ q: 'news', topic: 'news', since: '2026-12-01' }] }, '2026-11-12'), /no later than today/);
});

test('rejects a since value on a non-news target', () => {
  assert.throws(() => validateWebSearchInput({ targets: [{ entity: 'Neon', checks: ['pricing'], since: '2026-11-01' }] }), /only on news targets/);
});

test('validates any supplied news target date but permits recall to supply it', () => {
  assert.doesNotThrow(() => validateWebSearchInput({ targets: [{ entity: 'Neon', checks: ['news'] }] }, '2026-11-12'));
  assert.throws(() => validateWebSearchInput({ targets: [{ entity: 'Neon', checks: ['news'], since: 'not-a-date' }] }), /valid since date/);
});

test('rejects unknown fields rather than silently accepting a non-strict tool shape', () => {
  assert.throws(() => validateWebSearchInput({ query: 'wrong field', queries: [{ q: 'valid' }] }), /unsupported field/);
  assert.throws(() => validateWebSearchInput({ queries: [{ q: 'valid', domain: 'example.com' }] }), /unsupported field/);
  assert.throws(() => validateWebSearchInput({ targets: [{ entity: 'Neon', checks: ['pricing'], url: 'https://neon.tech' }] }), /unsupported field/);
});

test('enforces six queries and six targets as separate limits', () => {
  assert.throws(() => validateWebSearchInput({ queries: Array.from({ length: 7 }, (_, index) => ({ q: `q${index}` })) }), /limit is six/);
  assert.throws(() => validateWebSearchInput({ targets: Array.from({ length: 7 }, (_, index) => ({ entity: `entity ${index}`, checks: ['pricing'] })) }), /limit is six/);
  assert.doesNotThrow(() => validateWebSearchInput({ queries: Array.from({ length: 6 }, (_, index) => ({ q: `q${index}` })), targets: Array.from({ length: 6 }, (_, index) => ({ entity: `entity ${index}`, checks: ['pricing'] })) }));
});

test('overwrites a model-supplied display date with an imported turn real generation date', () => {
  const result = resolveTargetNewsSince({ entity: 'Neon', checks: ['news'], since: '2026-11-09' }, [{
    origin: 'imported', user_text: 'Neon pricing shortlist', assistant_text: 'We checked Neon hosting.', created_at_utc: '2026-11-09T10:00:00Z', source_created_at_utc: '2026-10-20T10:00:00Z',
  }], 'Asia/Kolkata');
  assert.equal(result.since, '2026-10-20');
  assert.equal(result.unavailableReason, null);
});

test('uses the local generation date for a live recalled turn', () => {
  const result = resolveTargetNewsSince({ checks: ['news'], since: '2026-11-15' }, [{
    origin: 'live', created_at_utc: '2026-11-11T20:00:00Z', source_created_at_utc: null,
  }], 'Asia/Kolkata');
  assert.equal(result.since, '2026-11-12');
});

test('does not fabricate a news baseline for an imported turn with unknown generation date', () => {
  const result = resolveTargetNewsSince({ checks: ['news'], since: '2026-11-01' }, [{
    origin: 'imported', created_at_utc: '2026-11-11T20:00:00Z', source_created_at_utc: null,
  }], 'Asia/Kolkata');
  assert.deepEqual(result, { since: null, baselineSince: null, explicitSince: null, unavailableReason: 'generation_date_unknown' });
});

test('uses a validated model-supplied since only when there is no recalled turn', () => {
  assert.deepEqual(resolveTargetNewsSince({ since: '2026-11-01' }, [], 'Asia/Kolkata', '2026-11-12'), { since: '2026-11-01', baselineSince: null, explicitSince: null, unavailableReason: null });
  assert.deepEqual(resolveTargetNewsSince({ since: '2026-12-01' }, [], 'Asia/Kolkata', '2026-11-12'), { since: null, baselineSince: null, explicitSince: null, unavailableReason: 'invalid_since' });
});

test('domain labels do not accept unrelated hosts just because the entity word appears in a subdomain', () => {
  assert.equal(trustLabel('Pipedrive', 'https://pipedrive.scam-example.com/').label, 'Third party');
  assert.equal(trustLabel('HubSpot', 'https://hubspot.info/').label, 'Third party');
});

test('replay backend is available without a Tavily API key', async () => {
  const { isSearchReady } = await import('../src/config.mjs');
  assert.equal(isSearchReady({ searchBackend: 'replay', tavilyKey: '' }), true);
  assert.equal(isSearchReady({ searchBackend: 'tavily', tavilyKey: '' }), false);
  assert.equal(isSearchReady({ searchBackend: 'tavily', tavilyKey: 'configured' }), true);
});
