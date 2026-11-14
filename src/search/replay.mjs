import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const DEFAULT_CORPUS = path.join(ROOT, 'evals/fixtures/corpus.json');

function termsFor(query) {
  const ignored = ['the', 'for', 'and', 'with', 'what', 'from', 'how', 'does', 'about', 'current'];
  const matches = String(query || '').toLowerCase().match(/[a-z0-9]{2,}/g) || [];
  return [...new Set(matches.filter((term) => !ignored.includes(term)))];
}

/** Shared retrieval corpus for all ablation arms. Search and extract return identical evidence to every arm. */
export class ReplayCorpus {
  constructor(filename = DEFAULT_CORPUS) {
    this.fixture = JSON.parse(fs.readFileSync(filename, 'utf8'));
    this.db = new DatabaseSync(':memory:');
    this.db.exec(`
      CREATE TABLE pages (
        id TEXT PRIMARY KEY, entity TEXT, topic TEXT, url TEXT UNIQUE,
        title TEXT, published_date TEXT, page_date_text TEXT, content TEXT, page_text TEXT
      );
      CREATE VIRTUAL TABLE pages_fts USING fts5(id UNINDEXED, entity, title, content, page_text);
    `);
    const insert = this.db.prepare('INSERT INTO pages VALUES (?,?,?,?,?,?,?,?,?)');
    const insertFts = this.db.prepare('INSERT INTO pages_fts VALUES (?,?,?,?,?)');
    for (const page of this.fixture.pages) {
      insert.run(
        page.id, page.entity, page.topic, page.url, page.title,
        page.published_date || null, page.page_date_text || null,
        page.content || '', page.page_text || ''
      );
      insertFts.run(page.id, page.entity, page.title, page.content || '', page.page_text || '');
    }
  }

  search({ q, topic = 'general', since, limit = 5 }) {
    const terms = termsFor(q);
    if (!terms.length) return [];
    const match = terms.map((term) => `"${term.replaceAll('"', '')}"*`).join(' OR ');
    let rows;
    try {
      rows = this.db.prepare(`
        SELECT p.*, bm25(pages_fts) AS rank FROM pages_fts f JOIN pages p ON p.id=f.id
        WHERE pages_fts MATCH ? AND (? <> 'news' OR (p.published_date IS NOT NULL AND p.published_date >= ?))
        ORDER BY rank ASC LIMIT ?
      `).all(match, topic, since || '0000-00-00', limit * 3);
    } catch { rows = []; }
    const filtered = rows.filter((page) => topic !== 'news' || page.topic === 'news');
    return filtered.slice(0, limit).map((page) => ({
      url: page.url,
      title: page.title,
      content: page.content,
      published_date: page.published_date,
      raw_content: page.page_text,
      score: Math.max(0, 1 / (1 + Math.abs(page.rank))),
      fixture_id: page.id,
    }));
  }

  extract(url) {
    const page = this.db.prepare('SELECT * FROM pages WHERE url=?').get(url);
    if (!page) return null;
    return {
      url: page.url,
      title: page.title,
      raw_content: page.page_text,
      published_date: page.published_date,
      page_date_text: page.page_date_text,
      fixture_id: page.id,
    };
  }

  close() { this.db.close(); }
}

/** A single corpus payload keeps the A/B/C evidence inputs byte-for-byte consistent. */
export function buildAblationInputs({ userText, history = [], evidence = [], cards = [] }) {
  const historyCopy = history.map((turn) => ({
    user_text: turn.user_text ?? null,
    assistant_text: turn.assistant_text ?? null,
    created_at_utc: turn.created_at_utc ?? null,
  }));
  const evidenceCopy = evidence.map((item) => ({ ...item }));
  return {
    A: { arm: 'naive', history: [], evidence: evidenceCopy, controls: null },
    B: { arm: 'prompt_stuffed', history: historyCopy, evidence: evidenceCopy, controls: null },
    C: {
      arm: 'full_architecture',
      history: historyCopy,
      evidence: evidenceCopy,
      controls: { validatedClaims: [], assignedCards: cards, figureGate: true },
    },
  };
}

let defaultInstance = null;
export function getReplayCorpus(filename = DEFAULT_CORPUS) {
  if (!defaultInstance) defaultInstance = new ReplayCorpus(filename);
  return defaultInstance;
}
