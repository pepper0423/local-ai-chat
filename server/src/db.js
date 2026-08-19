import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// LOCAL_AI_CHAT_DATA_DIR lets test runs point at a scratch directory instead of the live
// server/data/ — never touch the real one while testing (see README / CLAUDE notes).
const DATA_DIR = process.env.LOCAL_AI_CHAT_DATA_DIR
  ? path.resolve(process.env.LOCAL_AI_CHAT_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'chat.db');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

// journal_mode/foreign_keys are per-connection pragmas — set then read back to confirm.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const journalMode = db.prepare('PRAGMA journal_mode').get().journal_mode;
const foreignKeys = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
if (journalMode !== 'wal') {
  console.warn(`[db] expected journal_mode=wal, got ${journalMode}`);
}
if (foreignKeys !== 1) {
  console.warn('[db] foreign_keys pragma did not take effect — CASCADE deletes will not work');
}

function runMigrations() {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const getApplied = db.prepare('SELECT value FROM meta WHERE key = ?');
  const markApplied = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');

  for (const file of files) {
    const metaKey = `migration:${file}`;
    const already = getApplied.get(metaKey);
    if (already) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      markApplied.run(metaKey, new Date().toISOString());
      db.exec('COMMIT');
      console.log(`[db] applied migration ${file}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

runMigrations();

/** Run `fn` inside a BEGIN/COMMIT transaction, ROLLBACK on throw. node:sqlite has no
 * db.transaction() helper (that's a better-sqlite3-ism), so we do it explicitly. */
function withTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** node:sqlite may return lastInsertRowid as a BigInt; normalize to Number for JSON. */
function lastInsertId(result) {
  return Number(result.lastInsertRowid);
}

export { db, DB_PATH, DATA_DIR, withTransaction, lastInsertId };
