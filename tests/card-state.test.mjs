import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCardsByEntity } from '../public/card-state.mjs';

const group = (key, status) => ({
  entity: key,
  entity_key: key.toLowerCase(),
  cards: [{ entity: key, attribute: 'price', status }],
});

test('repeated identical card snapshots add no duplicate and preserve existing groups', () => {
  const first = group('Neon', 'Same as before');
  const second = group('HubSpot', 'Changed');
  const initial = mergeCardsByEntity([], [first, second]);
  const repeated = mergeCardsByEntity(initial, [first, second]);
  assert.equal(repeated.length, 2);
  assert.strictEqual(repeated[0], first);
  assert.strictEqual(repeated[1], second);
});

test('a late entity resolver updates only its own card without reordering earlier cards', () => {
  const neon = group('Neon', 'Same as before');
  const hubspotPending = group('HubSpot', 'No earlier record to compare');
  const pipedrive = group('Pipedrive', 'Changed');
  const initial = mergeCardsByEntity([], [neon, hubspotPending, pipedrive]);
  const hubspotResolved = group('HubSpot', 'Same as before');
  const updated = mergeCardsByEntity(initial, [neon, hubspotResolved, pipedrive]);
  assert.deepEqual(updated.map((item) => item.entity_key), ['neon', 'hubspot', 'pipedrive']);
  assert.strictEqual(updated[0], neon);
  assert.strictEqual(updated[1], hubspotResolved);
  assert.strictEqual(updated[2], pipedrive);
});
