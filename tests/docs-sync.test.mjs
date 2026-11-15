import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { syncDesignDocs } from '../scripts/docs-sync.mjs';

test('syncDesignDocs reads date and tier from new and old result schemas', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofline-docs-sync-'));
  try {
    const evalsDir = path.join(tmpDir, 'evals/results');
    fs.mkdirSync(evalsDir, { recursive: true });

    const designTemplate = [
      '# Proofline: design',
      '',
      '## Measured',
      '',
      '<!-- measured:start -->',
      'Not yet measured.',
      '<!-- measured:end -->',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, 'DESIGN.md'), designTemplate, 'utf8');

    // Test new schema (timestamp, account_tier, firstModelToken)
    const newSchema = {
      timestamp: '2026-11-15T12:00:00.000Z',
      build_id: 'build-new',
      totalQuestions: 3,
      environment: { account_tier: 'free' },
      ttft: { medianMs: 1500, maxMs: 2000 },
      firstModelToken: { medianMs: 2500, maxMs: 3500 },
      totalLatency: { medianMs: 3000, maxMs: 4000 },
      successful: 3,
    };
    fs.writeFileSync(path.join(evalsDir, 'live-latest.json'), JSON.stringify(newSchema), 'utf8');

    syncDesignDocs(tmpDir);
    const updatedNew = fs.readFileSync(path.join(tmpDir, 'DESIGN.md'), 'utf8');
    assert.match(updatedNew, /On 2026-11-15/);
    assert.match(updatedNew, /evaluated on the free tier/);
    assert.match(updatedNew, /First model-written token: median 2\.5 s, max 3\.5 s\./);

    // Test old schema (date, accountTier)
    const oldSchema = {
      date: '2026-11-14T08:00:00.000Z',
      build_id: 'build-old',
      totalQuestions: 3,
      environment: { accountTier: 'standard' },
      ttft: { medianMs: 1200, maxMs: 1800 },
      totalLatency: { medianMs: 2500, maxMs: 3500 },
      successful: 3,
    };
    fs.writeFileSync(path.join(evalsDir, 'live-latest.json'), JSON.stringify(oldSchema), 'utf8');

    syncDesignDocs(tmpDir);
    const updatedOld = fs.readFileSync(path.join(tmpDir, 'DESIGN.md'), 'utf8');
    assert.match(updatedOld, /On 2026-11-14/);
    assert.match(updatedOld, /evaluated on the standard tier/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
