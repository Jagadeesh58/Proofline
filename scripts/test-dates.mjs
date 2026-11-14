import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve('.');
const dates = ['2026-11-13', '2026-12-31', '2027-03-01'];
const testFiles = fs.readdirSync(path.join(root, 'tests'))
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => path.join('tests', f));

for (const date of dates) {
  process.stdout.write(`\n--- Running test suite with FAKE_NOW=${date} ---\n`);
  const result = spawnSync(
    process.execPath,
    ['--import', './tests/fake-clock.mjs', '--test', ...testFiles],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, FAKE_NOW: date },
    },
  );
  if (result.status !== 0) {
    process.stderr.write(`Test suite failed under FAKE_NOW=${date}\n`);
    process.exit(result.status ?? 1);
  }
}
process.stdout.write('\nDate independence check passed for all dates.\n');
