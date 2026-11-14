import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isValidTimezone, localDateFromUtc } from '../time/resolve.mjs';

export class Store {
  constructor(filename) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.sweepInterrupted();
  }

  migrate() {
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version < 1) {
      this.db.exec(`
        CREATE TABLE turns (
          id TEXT PRIMARY KEY,
          origin TEXT NOT NULL CHECK(origin IN ('live','imported')),
          user_text TEXT,
          assistant_text TEXT,
          source_titles_text TEXT NOT NULL DEFAULT '',
          created_at_utc TEXT NOT NULL,
          source_created_at_utc TEXT,
          imported_at_utc TEXT,
          iana_timezone TEXT NOT NULL,
          local_date TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('streaming','completed','interrupted','failed')),
          claims_status TEXT NOT NULL CHECK(claims_status IN ('not_applicable','pending','done','failed')),
          timings_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE sources (
          id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
          url TEXT NOT NULL,
          registrable_domain TEXT NOT NULL,
          title TEXT NOT NULL,
          provider_date TEXT,
          snippet_text TEXT NOT NULL DEFAULT '',
          page_text TEXT,
          retrieval_kind TEXT NOT NULL CHECK(retrieval_kind IN ('snippet','page_text')),
          page_text_origin TEXT CHECK(page_text_origin IN ('extract','search_raw') OR page_text_origin IS NULL),
          page_date_text TEXT,
          retrieved_at_utc TEXT NOT NULL,
          extraction_status TEXT NOT NULL DEFAULT 'ok'
        );
        CREATE INDEX sources_turn_idx ON sources(turn_id);
        CREATE TABLE claims (
          id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
          entity_key TEXT NOT NULL,
          attribute TEXT NOT NULL CHECK(attribute IN ('price','limit','version','release')),
          plan_key TEXT NOT NULL,
          value_text TEXT NOT NULL,
          amount REAL,
          currency TEXT,
          price_unit TEXT NOT NULL DEFAULT 'unknown',
          unit TEXT,
          period TEXT,
          commitment TEXT NOT NULL DEFAULT 'unknown',
          qualifiers TEXT NOT NULL DEFAULT '[]',
          evidence_quote TEXT NOT NULL,
          source_id TEXT REFERENCES sources(id),
          observed_at_utc TEXT NOT NULL,
          baseline_basis TEXT NOT NULL CHECK(baseline_basis IN ('page_text','answer_text'))
        );
        CREATE INDEX claims_entity_idx ON claims(entity_key, attribute, plan_key, observed_at_utc);
        CREATE VIRTUAL TABLE turns_fts USING fts5(turn_id UNINDEXED, user_text, assistant_text, source_titles_text);
        PRAGMA user_version = 1;
      `);
    }
    const currentVersion = this.db.prepare('PRAGMA user_version').get().user_version;
    if (currentVersion < 2) {
      this.db.exec('ALTER TABLE turns ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0; PRAGMA user_version = 2;');
    }
    const versionAfter2 = this.db.prepare('PRAGMA user_version').get().user_version;
    if (versionAfter2 < 3) {
      this.db.exec(
        'ALTER TABLE turns ADD COLUMN session_id TEXT; '
        + 'CREATE INDEX IF NOT EXISTS turns_session_idx ON turns(session_id); '
        + 'PRAGMA user_version = 3;'
      );
    }
  }

  sweepInterrupted() {
    this.db.prepare("UPDATE turns SET status='interrupted' WHERE status='streaming'").run();
    this.db.prepare(
      "UPDATE turns SET claims_status='failed' WHERE claims_status='pending' AND status IN ('interrupted','failed')"
    ).run();
  }

  createTurn({ userText, timezone, sessionId = null, now = new Date(), id = randomUUID() }) {
    const utc = now.toISOString();
    const localDate = localDateFromUtc(utc, timezone);
    const sql = 'INSERT INTO turns ('
      + 'id,origin,user_text,assistant_text,source_titles_text,created_at_utc,'
      + 'source_created_at_utc,imported_at_utc,iana_timezone,local_date,status,'
      + 'claims_status,timings_json,session_id'
      + ') VALUES (?, \'live\', ?, \'\', \'\', ?, NULL, NULL, ?, ?, \'streaming\', \'pending\', \'{}\', ?)';
    this.db.prepare(sql).run(id, userText, utc, timezone, localDate, sessionId);
    this.refreshFts(id);
    return this.getTurn(id);
  }

  importTurn(item, timezoneDefault = 'Asia/Kolkata') {
    const id = randomUUID();
    const importedAt = new Date().toISOString();
    const displayRaw = item.created_at || item.createdAt || null;
    const parsedDisplayDate = displayRaw ? new Date(displayRaw) : null;
    if (displayRaw && Number.isNaN(parsedDisplayDate.getTime())) {
      throw new Error('An imported created_at value must be a valid date.');
    }
    const sourceCreatedRaw = item.source_created_at || item.source_created_at_utc || null;
    const parsedSourceDate = sourceCreatedRaw ? new Date(sourceCreatedRaw) : null;
    if (sourceCreatedRaw && Number.isNaN(parsedSourceDate.getTime())) {
      throw new Error('An imported source_created_at value must be a valid date.');
    }
    const sourceCreated = parsedSourceDate ? parsedSourceDate.toISOString() : null;
    const displayCreated = parsedDisplayDate ? parsedDisplayDate.toISOString() : importedAt;
    const timezone = item.timezone || timezoneDefault;
    if (!isValidTimezone(timezone)) {
      throw new Error('An imported timezone must be a valid IANA timezone.');
    }
    const localDate = localDateFromUtc(displayCreated, timezone);
    const sql = 'INSERT INTO turns ('
      + 'id,origin,user_text,assistant_text,source_titles_text,created_at_utc,'
      + 'source_created_at_utc,imported_at_utc,iana_timezone,local_date,status,'
      + 'claims_status,timings_json,is_demo'
      + ') VALUES (?, \'imported\', ?, ?, \'\', ?, ?, ?, ?, ?, \'completed\', \'pending\', \'{}\', ?)';
    const userVal = item.user_text == null && item.user == null ? null : String(item.user_text ?? item.user);
    const assistVal = item.assistant_text == null && item.assistant == null
      ? null : String(item.assistant_text ?? item.assistant);
    this.db.prepare(sql).run(
      id, userVal, assistVal, displayCreated, sourceCreated,
      importedAt, timezone, localDate, item.demo ? 1 : 0
    );
    this.refreshFts(id);
    return this.getTurn(id);
  }

  importTurns(items, timezoneDefault = 'Asia/Kolkata') {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const imported = items.map((item) => this.importTurn(item, timezoneDefault));
      this.db.exec('COMMIT');
      return imported;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getTurn(id) { return this.db.prepare('SELECT * FROM turns WHERE id=?').get(id) || null; }
  updateTurn(id, fields) {
    if (!this.db?.open) return;
    const allowed = ['assistant_text', 'status', 'claims_status', 'timings_json', 'source_titles_text'];
    const keys = Object.keys(fields).filter((key) => allowed.includes(key));
    if (!keys.length) return;
    const values = keys.map((key) => (
      key === 'timings_json' && typeof fields[key] !== 'string' ? JSON.stringify(fields[key]) : fields[key]
    ));
    this.db.prepare(`UPDATE turns SET ${keys.map((key) => `${key}=?`).join(',')} WHERE id=?`).run(...values, id);
    this.refreshFts(id);
  }

  appendAssistantText(id, text) {
    if (!this.db?.open) return;
    this.db.prepare('UPDATE turns SET assistant_text=assistant_text || ? WHERE id=?').run(text, id);
  }

  refreshFts(id) {
    if (!this.db?.open) return;
    const turn = this.getTurn(id);
    if (!turn) return;
    this.db.prepare('DELETE FROM turns_fts WHERE turn_id=?').run(id);
    this.db.prepare('INSERT INTO turns_fts(turn_id,user_text,assistant_text,source_titles_text) VALUES (?,?,?,?)')
      .run(id, turn.user_text || '', turn.assistant_text || '', turn.source_titles_text || '');
  }

  addSource(source) {
    const id = source.id || randomUUID();
    const sql = 'INSERT INTO sources ('
      + 'id,turn_id,url,registrable_domain,title,provider_date,snippet_text,page_text,'
      + 'retrieval_kind,page_text_origin,page_date_text,retrieved_at_utc,extraction_status'
      + ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)';
    this.db.prepare(sql).run(
      id, source.turnId, source.url, source.domain || 'unknown', source.title || source.url,
      source.providerDate || null, source.snippetText || '', source.pageText || null,
      source.retrievalKind || 'snippet', source.pageTextOrigin || null, source.pageDateText || null,
      source.retrievedAt || new Date().toISOString(), source.extractionStatus || 'ok'
    );
    const titles = this.db.prepare(
      'SELECT title FROM sources WHERE turn_id=? ORDER BY retrieved_at_utc'
    ).all(source.turnId).map((row) => row.title);
    this.db.prepare('UPDATE turns SET source_titles_text=? WHERE id=?').run(titles.join(' | '), source.turnId);
    this.refreshFts(source.turnId);
    return this.db.prepare('SELECT * FROM sources WHERE id=?').get(id);
  }

  updateSourceExtractionStatus(id, status) {
    this.db.prepare('UPDATE sources SET extraction_status=? WHERE id=?').run(status, id);
  }

  getSources(turnId) {
    return this.db.prepare('SELECT * FROM sources WHERE turn_id=? ORDER BY retrieved_at_utc, rowid').all(turnId);
  }

  getSource(id) {
    return this.db.prepare('SELECT * FROM sources WHERE id=?').get(id) || null;
  }

  addClaim(claim) {
    const id = claim.id || randomUUID();
    const sql = 'INSERT INTO claims ('
      + 'id,turn_id,entity_key,attribute,plan_key,value_text,amount,currency,price_unit,'
      + 'unit,period,commitment,qualifiers,evidence_quote,source_id,observed_at_utc,baseline_basis'
      + ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
    this.db.prepare(sql).run(
      id, claim.turn_id, claim.entity_key, claim.attribute, claim.plan_key || 'unspecified',
      claim.value_text, claim.amount ?? null, claim.currency ?? null, claim.price_unit || 'unknown',
      claim.unit ?? null, claim.period ?? null, claim.commitment || 'unknown',
      JSON.stringify(claim.qualifiers || []), claim.evidence_quote, claim.source_id ?? null,
      claim.observed_at_utc || new Date().toISOString(), claim.baseline_basis || 'page_text'
    );
    return this.db.prepare('SELECT * FROM claims WHERE id=?').get(id);
  }

  getClaimsForTurn(turnId) {
    return this.db.prepare('SELECT * FROM claims WHERE turn_id=? ORDER BY observed_at_utc').all(turnId);
  }

  getClaimsForEntities(entities, excludeTurnId = null) {
    const results = [];
    for (const entity of entities) {
      const params = excludeTurnId ? [entity, excludeTurnId] : [entity];
      const sql = `SELECT c.*, t.origin, t.status AS turn_status, t.source_created_at_utc, t.created_at_utc
        FROM claims c JOIN turns t ON t.id=c.turn_id
        WHERE c.entity_key=? ${excludeTurnId ? 'AND c.turn_id<>?' : ''}
          AND t.status='completed' AND t.claims_status='done'
        ORDER BY c.observed_at_utc DESC LIMIT 30`;
      results.push(...this.db.prepare(sql).all(...params));
    }
    return results;
  }

  getBaselineUrl(claims) {
    for (const claim of claims) {
      if (!claim.source_id) continue;
      const row = this.getSource(claim.source_id);
      if (row?.url) return row.url;
    }
    return null;
  }

  searchByDate(date, sessionId = null) {
    if (sessionId) {
      const sql = "SELECT * FROM turns WHERE local_date=? AND status IN ('completed','interrupted') "
        + "AND (session_id=? OR origin='imported' OR COALESCE(is_demo,0)=1) ORDER BY created_at_utc";
      return this.db.prepare(sql).all(date, sessionId);
    }
    const sql = "SELECT * FROM turns WHERE local_date=? AND status IN ('completed','interrupted') "
      + 'ORDER BY created_at_utc';
    return this.db.prepare(sql).all(date);
  }

  searchDemoByWeekday(date) {
    const [y, m, d] = String(date || '').split('-').map(Number);
    if (!y || !m || !d) return [];
    const targetDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const demoSql = "SELECT * FROM turns WHERE COALESCE(is_demo,0)=1 AND status IN ('completed','interrupted') "
      + 'ORDER BY created_at_utc';
    const demoRows = this.db.prepare(demoSql).all();
    return demoRows.filter((row) => {
      const [ry, rm, rd] = String(row.local_date || '').split('-').map(Number);
      return ry && rm && rd && new Date(Date.UTC(ry, rm - 1, rd)).getUTCDay() === targetDay;
    });
  }

  searchByDateRange(from, to, sessionId = null) {
    if (sessionId) {
      const sql = "SELECT * FROM turns WHERE local_date BETWEEN ? AND ? AND status IN ('completed','interrupted') "
        + "AND (session_id=? OR origin='imported' OR COALESCE(is_demo,0)=1) ORDER BY local_date, created_at_utc";
      return this.db.prepare(sql).all(from, to, sessionId);
    }
    const sql = "SELECT * FROM turns WHERE local_date BETWEEN ? AND ? AND status IN ('completed','interrupted') "
      + 'ORDER BY local_date, created_at_utc';
    return this.db.prepare(sql).all(from, to);
  }

  searchByTopic(words, limit = 12, sessionId = null) {
    if (!words.length) return [];
    const query = words.map((word) => `"${word.replaceAll('"', '')}"*`).join(' OR ');
    try {
      const sql = sessionId
        ? `SELECT t.*, bm25(turns_fts) AS rank FROM turns_fts f
           JOIN turns t ON t.id=f.turn_id
           WHERE turns_fts MATCH ? AND t.status='completed'
             AND (t.session_id=? OR t.origin='imported' OR COALESCE(t.is_demo,0)=1)
           ORDER BY rank LIMIT ?`
        : `SELECT t.*, bm25(turns_fts) AS rank FROM turns_fts f
           JOIN turns t ON t.id=f.turn_id WHERE turns_fts MATCH ? AND t.status='completed'
           ORDER BY rank LIMIT ?`;
      const params = sessionId ? [query, sessionId, limit] : [query, limit];
      return this.db.prepare(sql).all(...params);
    } catch {
      const clauses = words.map(() => (
        '(lower(user_text) LIKE ? OR lower(assistant_text) LIKE ? OR lower(source_titles_text) LIKE ?)'
      )).join(' OR ');
      const params = words.flatMap((word) => [`%${word}%`, `%${word}%`, `%${word}%`]);
      if (sessionId) {
        const sql = `SELECT * FROM turns WHERE status='completed' `
          + `AND (session_id=? OR origin='imported' OR COALESCE(is_demo,0)=1) `
          + `AND (${clauses}) ORDER BY created_at_utc DESC LIMIT ?`;
        return this.db.prepare(sql).all(sessionId, ...params, limit);
      }
      const sql = `SELECT * FROM turns WHERE status='completed' AND ${clauses} ORDER BY created_at_utc DESC LIMIT ?`;
      return this.db.prepare(sql).all(...params, limit);
    }
  }

  searchRecent(limit = 12, sessionId = null) {
    if (sessionId) {
      const sql = "SELECT * FROM turns WHERE status IN ('completed','interrupted') "
        + "AND (session_id=? OR origin='imported' OR COALESCE(is_demo,0)=1) "
        + "ORDER BY created_at_utc DESC LIMIT ?";
      return this.db.prepare(sql).all(sessionId, limit);
    }
    const sql = "SELECT * FROM turns WHERE status IN ('completed','interrupted') "
      + "ORDER BY created_at_utc DESC LIMIT ?";
    return this.db.prepare(sql).all(limit);
  }

  lastTurns(limit = 8, sessionId = null) {
    if (sessionId) {
      const sql = "SELECT * FROM turns WHERE status='completed' AND COALESCE(is_demo,0)=0 "
        + "AND (session_id=? OR origin='imported') ORDER BY created_at_utc DESC LIMIT ?";
      return this.db.prepare(sql).all(sessionId, limit).reverse();
    }
    const sql = "SELECT * FROM turns WHERE status='completed' AND COALESCE(is_demo,0)=0 "
      + 'ORDER BY created_at_utc DESC LIMIT ?';
    return this.db.prepare(sql).all(limit).reverse();
  }

  listTurns(limit = 100, sessionId = null) {
    if (sessionId) {
      const sql = 'SELECT id,origin,user_text,assistant_text,created_at_utc,source_created_at_utc,'
        + 'iana_timezone,local_date,status,claims_status,is_demo,session_id FROM turns '
        + "WHERE (session_id=? OR origin='imported' OR COALESCE(is_demo,0)=1) "
        + 'ORDER BY created_at_utc DESC LIMIT ?';
      return this.db.prepare(sql).all(sessionId, limit);
    }
    const sql = 'SELECT id,origin,user_text,assistant_text,created_at_utc,source_created_at_utc,'
      + 'iana_timezone,local_date,status,claims_status,is_demo,session_id FROM turns '
      + 'ORDER BY created_at_utc DESC LIMIT ?';
    return this.db.prepare(sql).all(limit);
  }

  integrityCheck() {
    const integrity = this.db.prepare('PRAGMA integrity_check').get();
    const foreignKeys = this.db.prepare('PRAGMA foreign_key_check').all();
    return {
      ok: integrity?.integrity_check === 'ok' && foreignKeys.length === 0,
      integrity: integrity?.integrity_check || 'unknown',
      foreignKeys,
    };
  }

  close() { this.db.close(); }
}
