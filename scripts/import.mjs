import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/memory/store.mjs';
import { config } from '../src/config.mjs';

const inputPath = process.argv[2];
if (!inputPath) {
  process.stderr.write('Usage: npm run import -- path/to/history.json\n');
  process.exit(2);
}
const resolved = path.resolve(inputPath);
if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
  process.stderr.write(`File not found: ${resolved}\n`);
  process.exit(2);
}
let data;
try { data = JSON.parse(fs.readFileSync(resolved, 'utf8')); }
catch { process.stderr.write('Import file must contain valid JSON.\n'); process.exit(2); }
const turns = Array.isArray(data) ? data : data.turns;
if (!Array.isArray(turns) || turns.length < 1 || turns.length > 1000) {
  process.stderr.write('Import expects an array of 1 to 1,000 turns, or an object with a turns array.\n');
  process.exit(2);
}
const store = new Store(config.dbPath);
try {
  const imported = store.importTurns(turns, data.timezone || config.timezone);
  process.stdout.write(`Imported ${imported.length} turn(s) into ${path.resolve(config.dbPath)}.\n`);
} catch (error) {
  process.stderr.write(`Import failed: ${error.message}\n`);
  process.exitCode = 1;
} finally { store.close(); }
