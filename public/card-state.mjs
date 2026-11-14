function entityKey(group) {
  return String(group?.entity_key || group?.entity || '').trim().toLocaleLowerCase('en-GB');
}

/** Merge full progressive card snapshots without moving an entity after first render. */
export function mergeCardsByEntity(existing = [], incoming = []) {
  const merged = existing.slice();
  const positions = new Map();
  merged.forEach((group, index) => positions.set(entityKey(group), index));
  for (const group of incoming || []) {
    const key = entityKey(group);
    if (!key) continue;
    if (!positions.has(key)) {
      positions.set(key, merged.length);
      merged.push(group);
      continue;
    }
    const index = positions.get(key);
    if (JSON.stringify(merged[index]) !== JSON.stringify(group)) merged[index] = group;
  }
  return merged;
}
