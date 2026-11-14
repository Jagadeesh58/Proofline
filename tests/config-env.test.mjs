import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const configSource = fs.readFileSync(new URL('../src/config.mjs', import.meta.url), 'utf8');
const envExample = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

test('every environment setting read by config is documented in the blank environment example', () => {
  const settings = new Set([
    ...[...configSource.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]),
    ...[...configSource.matchAll(/number\('([A-Z][A-Z0-9_]*)'/g)].map((match) => match[1]),
  ]);
  const lines = envExample.split(/\r?\n/);
  const entries = new Map();
  lines.forEach((line, index) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) return;
    entries.set(match[1], { value: match[2], index });
    assert.ok(index > 0 && lines[index - 1].startsWith('# '), `${match[1]} needs a one-line comment`);
  });
  for (const setting of settings) assert.ok(entries.has(setting), `${setting} is read by config but absent from .env.example`);
  for (const [key, entry] of entries) {
    assert.ok(settings.has(key), `${key} is documented but not read by config`);
    assert.equal(key === 'EXTRACTION_MODE' ? entry.value : entry.value, key === 'EXTRACTION_MODE' ? 'per_entity' : '', `${key} must not contain a secret or value`);
  }
  assert.match(envExample, /# .*batched.*fallback.*low per-minute Gemini limits/i);
});
