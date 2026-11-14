import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('browser card rendering merges by entity key and updates a single stable group', () => {
  assert.match(app, /mergeCardsByEntity\(renderedCardGroups, cards \|\| \[\]\)/);
  assert.match(app, /cardGroupNodes\.get\(key\)/);
  assert.match(app, /groupNode\.replaceChildren\(\)/);
  assert.match(app, /cardGroupNodes\.set\(key, groupNode\)/);
});

test('browser displays unknown generation dates and has a details list for figure markers', () => {
  assert.match(app, /turn\.generation_date_unknown_label/);
  assert.match(app, /function renderFigureMarkerDetails\(/);
  assert.match(app, /figure-marker-details/);
  assert.match(app, /turnFigureMarkers\.push\(markerText\)/);
  assert.match(app, /if \(event === 'memory'\) renderMemory\(data\.turns\)/);
  assert.match(app, /extraction_skipped_budget/);
  assert.match(app, /non-target extraction skipped: budget/);
});

test('browser source details expose extraction failure status for wrong pages', () => {
  assert.match(app, /source\.extraction_status/);
  assert.match(app, /extraction: \$\{source\.extraction_status\}/);
});

test('browser demo-history action sends a JSON Content-Type header', () => {
  const appSource = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /fetch\('\/api\/demo-history',\s*\{[^}]*'content-type':\s*'application\/json'/);
});
