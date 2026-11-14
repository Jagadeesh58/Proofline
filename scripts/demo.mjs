import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.DEMO_MODE = '1';
process.env.SEARCH_BACKEND = 'replay';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../');
const demoPath = path.join(root, 'src/seeds/demo-history.json');

// Pre-seed demo turns into SQLite store so official prompts work immediately on launch
const { config } = await import('../src/config.mjs');
const { Store } = await import('../src/memory/store.mjs');

try {
  const store = new Store(config.dbPath);
  const existing = store.listTurns(100).filter((t) => t.is_demo);
  if (!existing.length && fs.existsSync(demoPath)) {
    const turns = JSON.parse(fs.readFileSync(demoPath, 'utf8'));
    store.importTurns(turns.map((item) => ({ ...item, timezone: config.timezone, demo: true })), config.timezone);
  }
  store.close();
} catch {
  // Ignore pre-seed error if already populated or db in use
}

// Start application
await import('../src/main.mjs');
