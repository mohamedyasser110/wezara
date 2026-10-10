// migrate-sqlite-to-mysql.ts — one-way bulk transfer: SQLite file → MySQL server.
// Run: DB_DRIVER=sqlite npm run db:mysql:migrate -- [--skip-backup] [--tables=a,b,c] [--batch-size=N] [--dry-run]
// Standalone tool: uses node:sqlite DIRECTLY for the source + mysql2/promise DIRECTLY
// for the target (NOT src/db/database.ts — it needs both drivers at once).
// - NEVER modifies the source (opened read-only; backup is a plain file copy).
// - Idempotent re-runs: REPLACE INTO by primary key.
// - No top-level await: everything runs inside main().
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';

// ترتيب آمن للمفاتيح الأجنبية: الآباء أولاً ثم الأبناء (FK-safe order).
const TABLES_IN_ORDER = [
  'organizations', 'users', 'initiatives', 'factories', 'details_files',
  'applications', 'messages', 'chat_conversations', 'chat_messages', 'chat_attachments',
  'email_outbox', 'home_banners', 'audit_logs', 'refresh_tokens', 'meta',
];

// أخطاء MySQL التي تعني «مطبَّق مسبقاً» — تُتجاهل أثناء تجهيز السكيما (idempotent).
const IDEMPOTENT_ERRNOS = new Set([1050, 1060, 1061, 1068, 1359, 1826]);

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function parseArgs(argv: string[]) {
  const opts = { skipBackup: false, tables: null as string[] | null, batchSize: 500, dryRun: false };
  for (const a of argv) {
    if (a === '--skip-backup') opts.skipBackup = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a.startsWith('--tables=')) opts.tables = a.slice('--tables='.length).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--batch-size=')) {
      const n = Number(a.slice('--batch-size='.length));
      if (!Number.isFinite(n) || n < 1) throw new Error(`[migrate] --batch-size must be a positive number (got ${a})`);
      opts.batchSize = Math.floor(n);
    } else {
      throw new Error(`[migrate] unknown flag ${a} — known: --skip-backup --tables=a,b,c --batch-size=N --dry-run`);
    }
  }
  return opts;
}

function findMysqlSchema(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', 'src', 'db', 'schema.mysql.sql'), // tsx from backend/
    path.join(process.cwd(), 'src', 'db', 'schema.mysql.sql'), // cwd = backend/
    path.join(process.cwd(), 'dist', 'db', 'schema.mysql.sql'), // built backend
    path.join(process.cwd(), 'backend', 'src', 'db', 'schema.mysql.sql'), // cwd = repo root
    path.join(process.cwd(), 'backend', 'dist', 'db', 'schema.mysql.sql'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`[migrate] schema.mysql.sql not found (tried ${candidates.join(' | ')})`);
  return found;
}

// يقسّم ملف السكيما لعبارات منفذة واحدة-واحدة (يتجاهل PRAGMA والتعليقات والفارغ).
function splitStatements(sql: string): string[] {
  const lines = sql.split('\n').filter((l) => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith('--') && !/^\s*PRAGMA\b/i.test(l);
  });
  return lines.join('\n').split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // (1) المصدر والهدف من المتغيرات — SQLITE_PATH ثم DB_PATH ثم الافتراضي.
  const sqlitePath = path.resolve(process.env.SQLITE_PATH ?? process.env.DB_PATH ?? './data/app.db');
  const mysqlCfg = {
    host: (process.env.MYSQL_HOST ?? '127.0.0.1').trim() || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306) || 3306,
    user: (process.env.MYSQL_USER ?? '').trim(),
    password: process.env.MYSQL_PASSWORD ?? '',
    database: (process.env.MYSQL_DATABASE ?? '').trim(),
  };
  const missing = ['MYSQL_USER', 'MYSQL_DATABASE'].filter((k) => !(process.env[k] ?? '').trim());
  if (missing.length) {
    console.error(`[migrate] خطأ: متغيرات ناقصة ${missing.join(' + ')} — Missing env: ${missing.join(' + ')} (see docs/MYSQL_MIGRATION.md)`);
    process.exit(2);
  }
  if (!fs.existsSync(sqlitePath)) {
    console.error(`[migrate] خطأ: ملف SQLite غير موجود — SQLite file not found: ${sqlitePath}`);
    process.exit(2);
  }
  const tables = opts.tables ?? TABLES_IN_ORDER;
  for (const t of tables) {
    if (!TABLES_IN_ORDER.includes(t)) {
      console.error(`[migrate] خطأ: جدول غير معروف — unknown table: ${t} (known: ${TABLES_IN_ORDER.join(', ')})`);
      process.exit(2);
    }
  }

  // (2) نسخة احتياطية من المصدر قبل أي شيء (نُسخ ملفات فقط — المصدر لا يُمس).
  if (!opts.skipBackup && !opts.dryRun) {
    const backupDir = path.join(path.dirname(sqlitePath), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const base = path.join(backupDir, `app-${stamp()}.db`);
    for (const suffix of ['', '-wal', '-shm']) {
      const src = sqlitePath + suffix;
      if (fs.existsSync(src)) fs.copyFileSync(src, base + suffix);
    }
    console.log(`[migrate] نسخة احتياطية — backup: ${base}`);
  } else {
    console.log('[migrate] بدون نسخة احتياطية (تخطي / dry-run) — backup skipped');
  }

  // المصدر read-only دائماً — NEVER modify source.
  const src = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const conn = await mysql.createConnection({
      host: mysqlCfg.host, port: mysqlCfg.port, user: mysqlCfg.user,
      password: mysqlCfg.password, database: mysqlCfg.database,
      charset: 'utf8mb4',
    });
    try {
      await conn.query('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');
      await conn.query('SET FOREIGN_KEY_CHECKS=0');

      // (3) تجهيز السكيما على الهدف (idempotent — يعيد التشغيل بأمان).
      if (!opts.dryRun) {
        const schemaPath = findMysqlSchema();
        const schema = fs.readFileSync(schemaPath, 'utf8');
        let created = 0;
        let skipped = 0;
        for (const stmt of splitStatements(schema)) {
          try {
            await conn.query(stmt);
            created++;
          } catch (e) {
            const errno = (e as { errno?: number } | null)?.errno;
            if (errno !== undefined && IDEMPOTENT_ERRNOS.has(errno)) skipped++;
            else throw e;
          }
        }
        console.log(`[migrate] السكيما جاهزة — schema OK (${created} applied, ${skipped} already-there) from ${schemaPath}`);
      }

      // (4) النقل جدولاً-جدولاً مع الحفاظ على الـ IDs.
      let grandTotal = 0;
      const verify: Array<{ table: string; source: number; target: number }> = [];
      for (const t of tables) {
        const cols = (src.prepare(`PRAGMA table_info("${t}")`).all() as Array<{ name: string }>).map((r) => r.name);
        if (!cols.length) {
          console.log(`[migrate] ${t}: لا يوجد في المصدر — not in source, skipped`);
          continue;
        }
        const total = (src.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get() as { c: number }).c;
        if (opts.dryRun) {
          const [tRows] = await conn.query(`SELECT COUNT(*) AS c FROM \`${t}\``);
          const target = Number((tRows as Array<{ c: number }>)[0]?.c ?? 0);
          console.log(`[migrate] ${t}: المصدر=${total} الهدف=${target} (dry-run — counts only)`);
          verify.push({ table: t, source: total, target });
          continue;
        }
        const colList = cols.map((c) => `\`${c}\``).join(', ');
        await conn.beginTransaction();
        try {
          let copied = 0;
          for (let offset = 0; offset < total; offset += opts.batchSize) {
            const rows = src.prepare(`SELECT * FROM "${t}" LIMIT ? OFFSET ?`).all(opts.batchSize, offset) as Array<Record<string, unknown>>;
            if (!rows.length) break;
            const placeholders = rows.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ');
            const values: unknown[] = [];
            for (const r of rows) {
              for (const c of cols) {
                const v = r[c];
                if (v === undefined) values.push(null);
                else if (typeof v === 'bigint') values.push(Number(v));
                else values.push(v); // Buffer يُمرَّر كما هو، nulls محفوظة، JSON/TEXT/العربية untouched (utf8mb4)
              }
            }
            await conn.query(`REPLACE INTO \`${t}\` (${colList}) VALUES ${placeholders}`, values);
            copied += rows.length;
          }
          await conn.commit();
          grandTotal += copied;
          console.log(`[migrate] ${t}: نُقل ${copied}/${total} — copied`);
        } catch (e) {
          try { await conn.rollback(); } catch { /* noop */ }
          throw e;
        }
      }
      if (!opts.dryRun) console.log(`[migrate] الإجمالي — total rows copied: ${grandTotal}`);

      // (5) إعادة تفعيل الفحوص ثم التحقق: العدّ + سلامة المفاتيح.
      await conn.query('SET FOREIGN_KEY_CHECKS=1');
      let failed = false;
      for (const t of tables) {
        const cols = (src.prepare(`PRAGMA table_info("${t}")`).all() as Array<{ name: string }>).map((r) => r.name);
        if (!cols.length) continue;
        const sTotal = (src.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get() as { c: number }).c;
        let dTotal = 0;
        try {
          const [tRows] = await conn.query(`SELECT COUNT(*) AS c FROM \`${t}\``);
          dTotal = Number((tRows as Array<{ c: number }>)[0]?.c ?? 0);
        } catch { /* table missing on target */ }
        const ok = sTotal === dTotal;
        if (!ok) failed = true;
        if (!opts.dryRun) verify.push({ table: t, source: sTotal, target: dTotal });
        console.log(`[migrate] تحقق ${t}: المصدر=${sTotal} الهدف=${dTotal} ${ok ? 'OK' : 'MISMATCH — عدم تطابق'}`);
      }
      // فحص أيتام المفاتيح الأجنبية (spot-checks).
      const fkChecks: Array<[string, string]> = [
        ['applications.initiativeId', 'SELECT id FROM `applications` WHERE `initiativeId` NOT IN (SELECT `id` FROM `initiatives`) LIMIT 20'],
        ['applications.factoryId', 'SELECT id FROM `applications` WHERE `factoryId` NOT IN (SELECT `id` FROM `factories`) LIMIT 20'],
        ['messages.applicationId', 'SELECT id FROM `messages` WHERE `applicationId` NOT IN (SELECT `id` FROM `applications`) LIMIT 20'],
        ['chat_messages.conversationId', 'SELECT id FROM `chat_messages` WHERE `conversationId` NOT IN (SELECT `id` FROM `chat_conversations`) LIMIT 20'],
      ];
      for (const [label, sql] of fkChecks) {
        const [tName] = label.split('.');
        if (!tables.includes(tName)) continue;
        try {
          const [rows] = await conn.query(`SELECT COUNT(*) AS c FROM (${sql.replace(/ LIMIT 20$/, '')}) AS v`);
          const n = Number((rows as Array<{ c: number }>)[0]?.c ?? 0);
          if (n > 0) {
            failed = true;
            const [sample] = await conn.query(sql);
            console.error(`[migrate] انتهاك FK — FK violation ${label}: ${n} (sample: ${JSON.stringify(sample)})`);
          } else {
            console.log(`[migrate] سلامة ${label}: OK`);
          }
        } catch (e) {
          console.log(`[migrate] فحص ${label}: تعذّر (الجدول غير منقول؟) — skipped: ${(e as Error).message}`);
        }
      }
      if (failed) {
        console.error('[migrate] فشل التحقق — VERIFICATION FAILED (counts mismatch or FK violations)');
        process.exit(1);
      }
      console.log('[migrate] تم بنجاح — migration verified OK');
    } finally {
      try { await conn.end(); } catch { /* noop */ }
    }
  } finally {
    try { src.close(); } catch { /* noop */ }
  }
}

main().catch((e) => {
  console.error('[migrate] فشل — FAILED:', (e as Error).message);
  process.exit(1);
});
