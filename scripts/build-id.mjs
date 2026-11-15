import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../');

function collectFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

export function computeBuildId() {
  const hash = crypto.createHash('sha256');
  const files = [
    ...collectFiles(path.join(ROOT, 'src')),
    ...collectFiles(path.join(ROOT, 'public')),
    path.join(ROOT, 'package.json'),
  ].sort();

  for (const file of files) {
    const relative = path.relative(ROOT, file).replace(/\\/g, '/');
    hash.update(relative);
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex').slice(0, 12);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.stdout.write(`${computeBuildId()}\n`);
}
