// mysql-init.ts — تجهيز MySQL لمشروع جديد: إنشاء القاعدة + السكيما.
// Usage: DB_DRIVER=mysql MYSQL_USER=.. MYSQL_DATABASE=.. tsx scripts/mysql-init.ts
// (or: npm run db:mysql:init with the env set — see docs/MYSQL_MIGRATION.md).
// Steps: (1) admin connection WITHOUT database → CREATE DATABASE IF NOT EXISTS
// utf8mb4; (2) dynamic-import database.js AFTER env is set → initDatabase().
// No top-level await: everything runs inside main().
import mysql from 'mysql2/promise';

async function main(): Promise<void> {
  const user = (process.env.MYSQL_USER ?? '').trim();
  const database = (process.env.MYSQL_DATABASE ?? '').trim();
  if (!user || !database) {
    console.error('[mysql:init] خطأ: MYSQL_USER و MYSQL_DATABASE مطلوبان — MYSQL_USER + MYSQL_DATABASE are required (see docs/MYSQL_MIGRATION.md)');
    process.exit(2);
  }
  const host = (process.env.MYSQL_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  const port = Number(process.env.MYSQL_PORT ?? 3306) || 3306;
  const password = process.env.MYSQL_PASSWORD ?? '';

  // (1) إنشاء القاعدة إن غابت — needs CREATE privilege (موثّق في docs/MYSQL_MIGRATION.md).
  const admin = await mysql.createConnection({ host, port, user, password, charset: 'utf8mb4' });
  try {
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`[mysql:init] القاعدة جاهزة — database OK: \`${database}\` (utf8mb4/utf8mb4_unicode_ci) @ ${user}@${host}:${port}`);
  } finally {
    try { await admin.end(); } catch { /* noop */ }
  }

  // (2) السكيما عبر الطبقة الموحدة — dynamic import AFTER env (ESM hoists static imports).
  process.env.DB_DRIVER = 'mysql';
  const { initDatabase, closeDb } = await import('../src/db/database.js');
  try {
    await initDatabase();
    console.log('[mysql:init] السكيما جاهزة — schema OK (tables + idempotent columns)');
  } finally {
    try { await closeDb(); } catch { /* noop */ }
  }

  console.log('[mysql:init] الخطوات التالية — next steps:');
  console.log('  1) مشروع جديد:  DB_DRIVER=mysql npm run db:seed      (بذرة نظيفة — fresh seed)');
  console.log('  2) مشروع قائم:   DB_DRIVER=sqlite npm run db:mysql:migrate  (نقل من SQLite ثم تحقق)');
  console.log('  3) فحص الاتصال:  npm run db:ping');
}

main().catch((e) => {
  console.error('[mysql:init] فشل — FAILED:', (e as Error).message);
  process.exit(1);
});
