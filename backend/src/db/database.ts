/**
 * Unified async database layer — SQLite (default, embedded) + MySQL (mysql2/promise).
 *
 * Why this file exists:
 * The codebase historically used `node:sqlite` (DatabaseSync — SYNCHRONOUS API).
 * MySQL has no synchronous driver, so every data-access call site is migrated to
 * this small async API. Driver is chosen once from env (see config.dbDriver):
 *
 *   DB_DRIVER=sqlite  → node:sqlite file at DB_PATH (default, zero-config dev/test)
 *   DB_DRIVER=mysql   → mysql2 pool from MYSQL_* (production / shared staging)
 *
 * SQL compatibility notes (keep call sites portable — write SQLite-flavoured SQL):
 * - `?` positional and `:name` named placeholders both work on either driver
 *   (mysql pool is created with `namedPlaceholders: true`). Always use
 *   PREPARED placeholders — never interpolate values (SQL injection).
 * - `INSERT OR IGNORE` / `INSERT OR REPLACE` are rewritten for MySQL automatically.
 * - `COLLATE NOCASE` is stripped for MySQL (utf8mb4_unicode_ci is already
 *   case-insensitive). SQLite keeps it.
 * - `` `key` `` backtick quoting works on BOTH drivers — the `meta` table uses a
 *   reserved word (`key`) in MySQL, so ALWAYS write `` `key` `` (and `value`).
 * - NEVER use `rowid` (no equivalent in MySQL) — order by createdAt/id instead.
 * - NEVER use `PRAGMA`, `json_each`, `BEGIN IMMEDIATE` in call sites — use the
 *   helpers here (`dbTransaction`, driver branches via `isMysql()`).
 * - `LIMIT ? OFFSET ?` placeholders are fine (mysql uses pool.query, which
 *   client-side escapes values — server-side prepare limits don't apply).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { getDb as getSqliteDb, closeDb as closeSqliteDb } from './sqlite.js';

// Re-exported so stores keep a single import source.
export { nowIso, parseJson } from './sqlite.js';

/** Params accepted by both drivers. Buffer covers mysql2; Uint8Array for node:sqlite. */
export type SqlParam = string | number | bigint | null | Buffer | Uint8Array;
export type SqlParams = SqlParam[] | Record<string, SqlParam>;

export type DbDriver = 'sqlite' | 'mysql';

export function getDriver(): DbDriver {
  return config.dbDriver === 'mysql' ? 'mysql' : 'sqlite';
}

export function isMysql(): boolean {
  return getDriver() === 'mysql';
}

// ---------------------------------------------------------------------------
// MySQL pool (lazy singleton)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MysqlPool = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MysqlConn = any;

let pool: MysqlPool | null = null;
let poolFailed = false;

async function getPool(): Promise<MysqlPool> {
  if (pool) return pool;
  if (poolFailed) throw new Error('[db] MySQL pool previously failed to init — refusing to retry in-process.');
  let mysql: typeof import('mysql2/promise');
  try {
    // mysql2 is an optional prod dependency: requiring it only on the mysql path
    // keeps `DB_DRIVER=sqlite` working with zero extra installs.
    mysql = await import('mysql2/promise');
  } catch {
    poolFailed = true;
    throw new Error('[db] DB_DRIVER=mysql but the `mysql2` package is not installed. Run `npm install mysql2` in backend/.');
  }
  const c = config.mysql;
  try {
    pool = mysql.createPool({
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.password,
      database: c.database,
      charset: 'utf8mb4',
      timezone: 'Z',
      dateStrings: true, // DATETIME/DATE come back as strings, never shifted Date objects
      namedPlaceholders: true, // `:name` params work like node:sqlite
      waitForConnections: true,
      connectionLimit: c.connectionLimit,
      queueLimit: 0,
      connectTimeout: 10_000,
      // NOTE: intentionally NOT multipleStatements — schema files are split and
      // executed statement-by-statement (safer + keeps triggers intact).
    });
    // Fail fast with a clear message when MySQL is unreachable/misconfigured.
    const conn = await pool.getConnection();
    try {
      await conn.query('SELECT 1');
      await conn.query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
    } finally {
      conn.release();
    }
    return pool;
  } catch (e) {
    poolFailed = true;
    pool = null;
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[db] cannot connect to MySQL ${c.user}@${c.host}:${c.port}/${c.database}: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Transactions — implicit connection propagation via AsyncLocalStorage
// ---------------------------------------------------------------------------

interface TxStore {
  driver: DbDriver;
  /** mysql: dedicated connection; sqlite: null (single shared handle + mutex). */
  conn: MysqlConn | null;
}

const txStorage = new AsyncLocalStorage<TxStore>();

/** Simple promise mutex — serializes SQLite write-transactions (see below). */
let sqliteTxTail: Promise<void> = Promise.resolve();
function sqliteMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = sqliteTxTail.then(fn, fn);
  // Keep the chain alive even if this transaction rejects.
  sqliteTxTail = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Run `fn` inside a transaction (COMMIT on success, ROLLBACK on error).
 * Nested calls reuse the outer transaction (same connection / same sqlite lock).
 *
 * Correctness note: node:sqlite is a single synchronous connection. Awaiting
 * real async work between BEGIN and COMMIT would let another request interleave
 * its own BEGIN on the same handle — hence sqlite transactions are serialized
 * with a mutex. Our wrappers resolve without real I/O on sqlite, so hold time
 * is microseconds. MySQL uses a dedicated pooled connection per transaction.
 */
export async function dbTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const existing = txStorage.getStore();
  if (existing) return fn(); // nested → join outer transaction
  if (isMysql()) {
    const p = await getPool();
    const conn = await p.getConnection();
    try {
      await conn.beginTransaction();
      try {
        const out = await txStorage.run({ driver: 'mysql', conn }, fn);
        await conn.commit();
        return out;
      } catch (e) {
        try { await conn.rollback(); } catch { /* noop */ }
        throw e;
      }
    } finally {
      conn.release();
    }
  }
  // sqlite
  return sqliteMutex(async () => {
    const db = getSqliteDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = await txStorage.run({ driver: 'sqlite', conn: null }, fn);
      db.exec('COMMIT');
      return out;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* noop */ }
      throw e;
    }
  });
}

// ---------------------------------------------------------------------------
// SQL dialect translation (SQLite flavour in → driver flavour out)
// ---------------------------------------------------------------------------

/** Translate portable SQLite-flavoured SQL to the active driver. Idempotent. */
export function translateSql(sql: string): string {
  if (!isMysql()) return sql;
  let out = sql;
  out = out.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT IGNORE INTO');
  out = out.replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, 'REPLACE INTO');
  // MySQL has no IF NOT EXISTS for indexes/triggers — init is error-tolerant instead.
  out = out.replace(/CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/gi, 'CREATE $1INDEX');
  out = out.replace(/CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS/gi, 'CREATE TRIGGER');
  // utf8mb4_unicode_ci columns are already case-insensitive.
  out = out.replace(/\s+COLLATE\s+NOCASE/gi, '');
  return out;
}

function toArrayParams(params: SqlParams | undefined): { arr: SqlParam[]; obj: Record<string, SqlParam> | null } {
  if (params === undefined) return { arr: [], obj: null };
  if (Array.isArray(params)) return { arr: params, obj: null };
  return { arr: [], obj: params };
}

// mysql2 returns [rows, fields]; rows for SELECT is an array, for writes an OkPacket.
function normalizeMysqlRows(rows: unknown): Record<string, unknown>[] {
  if (Array.isArray(rows)) {
    return (rows as unknown[]).map((r) =>
      r !== null && typeof r === 'object' && !Buffer.isBuffer(r) ? { ...(r as Record<string, unknown>) } : r,
    ) as Record<string, unknown>[];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Core query API
// ---------------------------------------------------------------------------

export async function dbAll<T = Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T[]> {
  const q = translateSql(sql);
  const store = txStorage.getStore();
  if (store?.driver === 'mysql' && store.conn) {
    const [rows] = await store.conn.query(q, params ?? []);
    return normalizeMysqlRows(rows) as T[];
  }
  if (isMysql()) {
    const p = await getPool();
    const [rows] = await p.query(q, params ?? []);
    return normalizeMysqlRows(rows) as T[];
  }
  const db = getSqliteDb();
  const { arr, obj } = toArrayParams(params);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (obj ? db.prepare(q).all(obj as any) : db.prepare(q).all(...(arr as any[]))) as T[];
  return rows;
}

export async function dbGet<T = Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T | undefined> {
  const rows = await dbAll<T>(sql, params);
  return rows[0];
}

export async function dbRun(sql: string, params?: SqlParams): Promise<{ changes: number }> {
  const q = translateSql(sql);
  const store = txStorage.getStore();
  if (store?.driver === 'mysql' && store.conn) {
    const [res] = await store.conn.query(q, params ?? []);
    return { changes: Number((res as { affectedRows?: number }).affectedRows ?? 0) };
  }
  if (isMysql()) {
    const p = await getPool();
    const [res] = await p.query(q, params ?? []);
    return { changes: Number((res as { affectedRows?: number }).affectedRows ?? 0) };
  }
  const db = getSqliteDb();
  const { arr, obj } = toArrayParams(params);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const info = (obj ? db.prepare(q).run(obj as any) : db.prepare(q).run(...(arr as any[]))) as unknown as { changes?: number | bigint };
  return { changes: Number(info.changes ?? 0) };
}

/**
 * Execute DDL / multi-purpose SQL (schema files, CREATE INDEX, one-off fixes).
 * - sqlite: runs as-is (PRAGMA lines included).
 * - mysql: PRAGMA lines are skipped; the rest is split on `;` and executed
 *   statement-by-statement. Callers should prefer initDatabase() for full files.
 */
export async function dbExec(sql: string): Promise<void> {
  const store = txStorage.getStore();
  if (store?.driver === 'mysql' && store.conn) {
    for (const stmt of splitMysqlStatements(translateSql(sql))) {
      await store.conn.query(stmt);
    }
    return;
  }
  if (isMysql()) {
    const p = await getPool();
    const conn = await p.getConnection();
    try {
      for (const stmt of splitMysqlStatements(translateSql(sql))) {
        await conn.query(stmt);
      }
    } finally {
      conn.release();
    }
    return;
  }
  getSqliteDb().exec(sql);
}

/** Split SQL text into single statements; drops full-line comments + PRAGMA lines (SQLite-only). */
export function splitMysqlStatements(sql: string): string[] {
  const lines = sql.split('\n').filter((l) => {
    const t = l.trim();
    // NOTE: schema files must not start a statement-continuation line with `--`.
    return t.length > 0 && !t.startsWith('--') && !/^\s*PRAGMA\b/i.test(l) && !/^\s*--\s*PRAGMA/i.test(l);
  });
  const joined = lines.join('\n');
  return joined
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^--/.test(s));
}

// ---------------------------------------------------------------------------
// Schema init + column-introspection (replaces PRAGMA table_info)
// ---------------------------------------------------------------------------

function findSchemaFile(name: 'schema.sql' | 'schema.mysql.sql'): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, name),
    path.join(process.cwd(), 'dist', 'db', name),
    path.join(process.cwd(), 'src', 'db', name),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`[db] ${name} not found (tried ${candidates.join(' | ')})`);
  return found;
}

/** Idempotent schema creation for the active driver (CREATE TABLE/INDEX IF NOT EXISTS). */
export async function initDatabase(): Promise<void> {
  if (isMysql()) {
    const p = await getPool();
    const conn = await p.getConnection();
    try {
      const schema = fs.readFileSync(findSchemaFile('schema.mysql.sql'), 'utf8');
      for (const stmt of splitMysqlStatements(translateSql(schema))) {
        try {
          await conn.query(stmt);
        } catch (e) {
          if (!isIdempotentMysqlError(e)) throw e; // table/index/trigger already there
        }
      }
      await ensureMysqlColumns(conn);
    } finally {
      conn.release();
    }
    return;
  }
  // sqlite path keeps its battle-tested sync init (schema + ensureMigrated).
  getSqliteDb();
}

/** MySQL error codes that mean "already applied" — safe to skip for idempotent init. */
function isIdempotentMysqlError(e: unknown): boolean {
  const code = (e as { errno?: number; code?: string } | null)?.errno;
  // 1050 table exists · 1060 duplicate column · 1061 duplicate index ·
  // 1068 multiple primary key · 1359 trigger exists · 1826 duplicate FK name
  return code === 1050 || code === 1060 || code === 1061 || code === 1068 || code === 1359 || code === 1826;
}

/** Column names of a table on the active driver (portable PRAGMA table_info). */
export async function tableColumns(table: string): Promise<Set<string>> {
  if (isMysql()) {
    const rows = await dbAll<{ COLUMN_NAME?: string; column_name?: string; Field?: string; field?: string }>(
      'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [table],
    );
    return new Set(rows.map((r) => String(r.COLUMN_NAME ?? r.column_name ?? r.Field ?? r.field ?? '')));
  }
  const rows = await dbAll<{ name: string }>(`PRAGMA table_info(${table})`);
  return new Set(rows.map((r) => r.name));
}

/**
 * MySQL counterpart of sqlite.ts ensureMigrated(): ADD COLUMN only when missing.
 * Fresh installs already have everything from schema.mysql.sql; this covers DBs
 * created by older schema versions. Fully idempotent and online-safe.
 */
async function ensureMysqlColumns(conn: MysqlConn): Promise<void> {
  const cols = async (table: string): Promise<Set<string>> => {
    try {
      const [rows] = await conn.query(
        'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [table],
      );
      return new Set((rows as Array<{ COLUMN_NAME: string }>).map((r) => r.COLUMN_NAME));
    } catch {
      return new Set();
    }
  };
  const addCol = async (table: string, ddl: string) => {
    try {
      await conn.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    } catch { /* exists (race) */ }
  };
  const ensureIndex = async (name: string, table: string, colsSql: string, unique = false) => {
    try {
      const [rows] = await conn.query(
        'SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
        [table, name],
      );
      if ((rows as unknown[]).length === 0) {
        await conn.query(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${table} (${colsSql})`);
      }
    } catch { /* concurrent create */ }
  };

  const u = await cols('users');
  if (!u.has('passwordHash')) await addCol('users', "passwordHash LONGTEXT NOT NULL");
  if (!u.has('mustChangePassword')) await addCol('users', 'mustChangePassword TINYINT(1) NOT NULL DEFAULT 0');
  if (!u.has('factoryId')) await addCol('users', "factoryId VARCHAR(64) NOT NULL DEFAULT ''");
  if (!u.has('isVerified')) await addCol('users', 'isVerified TINYINT(1) NOT NULL DEFAULT 1');
  if (!u.has('emailVerificationToken')) await addCol('users', "emailVerificationToken VARCHAR(255) NOT NULL DEFAULT ''");
  if (!u.has('emailVerificationExpires')) await addCol('users', "emailVerificationExpires VARCHAR(32) NOT NULL DEFAULT ''");
  await ensureIndex('idx_users_factory', 'users', 'factoryId');

  const ini = await cols('initiatives');
  if (!ini.has('objectives')) await addCol('initiatives', "objectives LONGTEXT NOT NULL");
  if (!ini.has('eligibilityRequirements')) await addCol('initiatives', "eligibilityRequirements LONGTEXT NOT NULL");
  if (!ini.has('selectionCriteria')) await addCol('initiatives', "selectionCriteria LONGTEXT NOT NULL");
  if (!ini.has('financialTerms')) await addCol('initiatives', "financialTerms LONGTEXT NOT NULL");
  if (!ini.has('executionNotesAr')) await addCol('initiatives', "executionNotesAr LONGTEXT NOT NULL");
  if (!ini.has('executionNotesEn')) await addCol('initiatives', "executionNotesEn LONGTEXT NOT NULL");
  if (!ini.has('kpis')) await addCol('initiatives', "kpis LONGTEXT NOT NULL");

  const a = await cols('audit_logs');
  if (!a.has('userId')) await addCol('audit_logs', "userId VARCHAR(64) NOT NULL DEFAULT 'unknown'");
  if (!a.has('ip')) await addCol('audit_logs', "ip VARCHAR(64) NOT NULL DEFAULT ''");
  if (!a.has('beforeJson')) await addCol('audit_logs', "beforeJson LONGTEXT NOT NULL");
  if (!a.has('afterJson')) await addCol('audit_logs', "afterJson LONGTEXT NOT NULL");

  // Legacy banner ids blocked by ad-blockers («banner-» → «hl-»).
  try {
    await conn.query("UPDATE home_banners SET id = CONCAT('hl-', SUBSTRING(id, 8)) WHERE id LIKE 'banner-%'");
  } catch { /* older schema */ }

  // «وزارة الصناعة والتجارة» → «وزارة الصناعة» (idempotent data fix).
  const pairs: Array<[string, string]> = [
    ['وزارة الصناعة والتجارة', 'وزارة الصناعة'],
    ['Ministry of Industry and Trade', 'Ministry of Industry'],
  ];
  const targets: Array<[string, string]> = [
    ['organizations', 'nameAr'], ['organizations', 'nameEn'],
    ['initiatives', 'workflow'], ['initiatives', 'participatingOrgs'],
    ['applications', 'timeline'],
  ];
  for (const [table, col] of targets) {
    for (const [from, to] of pairs) {
      try {
        await conn.query(`UPDATE ${table} SET ${col} = REPLACE(${col}, ?, ?) WHERE ${col} LIKE ?`, [from, to, `%${from}%`]);
      } catch { /* column missing on older DBs */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Health + shutdown
// ---------------------------------------------------------------------------

/** SELECT 1 reachability check for the active driver (used by /health + boot). */
export async function pingDatabase(): Promise<boolean> {
  try {
    const row = await dbGet<{ one: number }>('SELECT 1 AS one');
    return Number(row?.one) === 1;
  } catch {
    return false;
  }
}

export async function closeDb(): Promise<void> {
  try { closeSqliteDb(); } catch { /* noop */ }
  if (pool) {
    try { await pool.end(); } catch { /* noop */ }
    pool = null;
  }
}
