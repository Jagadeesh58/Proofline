import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.mjs';

const filename = path.resolve(config.dbPath);
const candidates = [filename, `${filename}-wal`, `${filename}-shm`];
for (const candidate of candidates) {
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
process.stdout.write(`Removed the local SQLite database and sidecar files at ${filename}.\n`);
