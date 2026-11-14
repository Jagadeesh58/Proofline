import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve('.');
const ignored = new Set(['node_modules', 'data', '.git']);
const extensions = new Set(['.mjs', '.js']);
const files = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (extensions.has(path.extname(entry.name))) files.push(absolute);
  }
}

for (const folder of ['src', 'scripts', 'tests', 'evals', 'public']) {
  if (fs.existsSync(path.join(root, folder))) walk(path.join(root, folder));
}
const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failures.push({ file: path.relative(root, file), message: `${result.stdout}${result.stderr}`.trim() });
  }
}
if (failures.length) {
  for (const failure of failures) process.stderr.write(`\n${failure.file}\n${failure.message}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Syntax check passed for ${files.length} JavaScript files.\n`);
}
