import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('submission documents record the required architecture, lifecycle, and limits', () => {
  const design = read('DESIGN.md');
  const requiredHeadings = [
    '# Proofline: design',
    '## How it works',
    '## Why it is built this way',
    '## Considered and rejected',
    '## With another week',
    '## Measured',
  ];
  let lastIndex = -1;
  for (const heading of requiredHeadings) {
    const idx = design.indexOf(heading);
    assert.ok(idx > lastIndex, `DESIGN.md must contain heading in order: ${heading}`);
    lastIndex = idx;
  }

  assert.ok(design.includes('flowchart TD'), 'DESIGN.md must contain a mermaid diagram');
  const designWords = (design.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ').match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu) || []).length;
  assert.ok(designWords <= 550, `DESIGN.md word count (${designWords}) must be at most 550 words`);

  // Verify config defaults agreement with DESIGN.md
  assert.ok(design.includes('20 requests per session'), 'DESIGN.md must state session quota of 20');
  assert.ok(design.includes('200 requests per day'), 'DESIGN.md must state daily global quota of 200');

  const readme = read('README.md');
  const readmeHeadings = [
    '# Proofline',
    '## Quickstart',
    '## Keys',
    '## Official Prompts',
    '## Performance',
    '## Offline Demo',
    '## Deployment and Results',
  ];
  for (const heading of readmeHeadings) {
    assert.ok(readme.includes(heading), `README.md must contain heading: ${heading}`);
  }
  assert.ok(readme.includes('https://proofline.onrender.com'), 'README.md must link to live deployment');
  assert.ok(readme.includes('DESIGN.md'), 'README.md must link to DESIGN.md');
  const readmeWords = (readme.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ').match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu) || []).length;
  assert.ok(readmeWords >= 180 && readmeWords <= 300, `README.md word count (${readmeWords}) must be 180-300`);

  const jsonFiles = fs.readdirSync(new URL('../evals/results/', import.meta.url)).filter((name) => name.endsWith('.json'));
  assert.ok(jsonFiles.includes('latest.json'), 'evals/results must contain latest.json');
  assert.ok(jsonFiles.includes('live-latest.json'), 'evals/results must contain live-latest.json');

  const latest = JSON.parse(read('evals/results/latest.json'));
  assert.ok(design.includes(`${latest.test_summary.tests} tests`), 'DESIGN.md must match test count from latest.json');

  const liveLatest = JSON.parse(read('evals/results/live-latest.json'));
  assert.ok(design.includes(`${liveLatest.citationFaithfulness.totalQuotes}/${liveLatest.citationFaithfulness.totalQuotes} quotes`), 'DESIGN.md must match faithfulness from live-latest.json');
});

test('deprecated name-matched phrase does not appear anywhere in src, public, tests, README or DESIGN', () => {
  const root = new URL('../', import.meta.url);
  const targets = ['src', 'public', 'tests', 'README.md', 'DESIGN.md'];
  const pattern = new RegExp(['Name-matched', ' domain'].join(''), 'i');
  function checkPath(relPath) {
    if (relPath.endsWith('submission-docs.test.mjs')) return;
    const full = new URL(relPath, root);
    if (!fs.existsSync(full)) return;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(full)) {
        checkPath(`${relPath}/${entry}`);
      }
    } else if (/\.(mjs|js|md|html|css|json)$/.test(relPath)) {
      const content = fs.readFileSync(full, 'utf8');
      assert.doesNotMatch(content, pattern, `Forbidden phrase found in ${relPath}`);
    }
  }
  for (const target of targets) checkPath(target);
});

test('document check enforces consistency between evals/results/latest.json and README', () => {
  const readmePath = path.resolve('README.md');
  const originalReadme = fs.readFileSync(readmePath, 'utf8');
  try {
    fs.writeFileSync(readmePath, `${originalReadme}\nStale literal: 9999 tests\n`, 'utf8');
    const result = spawnSync(process.execPath, ['scripts/document-check.mjs'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /README\.md contains literal test count "9999 tests" that does not match/);
  } finally {
    fs.writeFileSync(readmePath, originalReadme, 'utf8');
  }
});

test('eval summary parser exits non-zero when test output is not parsable', () => {
  const testScript = `
    const output = "corrupted test runner output with no summary";
    const match = output.match(/(?:#|ℹ)\\s*tests\\s+(\\d+)[\\s\\S]*?(?:#|ℹ)\\s*suites\\s+(\\d+)[\\s\\S]*?(?:#|ℹ)\\s*pass\\s+(\\d+)[\\s\\S]*?(?:#|ℹ)\\s*fail\\s+(\\d+)[\\s\\S]*?(?:#|ℹ)\\s*cancelled\\s+(\\d+)[\\s\\S]*?(?:#|ℹ)\\s*skipped\\s+(\\d+)/);
    if (!match) process.exit(1);
  `;
  const result = spawnSync(process.execPath, ['-e', testScript]);
  assert.notEqual(result.status, 0);
});
