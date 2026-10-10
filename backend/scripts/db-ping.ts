// db-ping.ts — فحص سريع لقاعدة البيانات: السائق + SELECT 1 (+ users/version لـ MySQL).
// Usage: npm run db:ping   (with DB_DRIVER=sqlite|mysql in env)
// Exit non-zero on failure. No top-level await: everything runs inside main().

async function main(): Promise<void> {
  const { config } = await import('../src/config.js');
  const db = await import('../src/db/database.js');
  try {
    if (config.dbDriver === 'mysql') {
      console.log(`[db:ping] السائق — driver: mysql (${config.mysql.user}@${config.mysql.host}:${config.mysql.port}/${config.mysql.database})`);
    } else {
      console.log(`[db:ping] السائق — driver: sqlite (path: ${config.dbPath})`);
    }
    const one = await db.dbGet<{ one: number }>('SELECT 1 AS one');
    console.log(`[db:ping] SELECT 1 → ${Number(one?.one)}`);
    if (config.dbDriver === 'mysql') {
      const users = await db.dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM users');
      console.log(`[db:ping] users: ${Number(users?.c ?? 0)}`);
      const ver = await db.dbGet<{ v: string }>('SELECT VERSION() AS v');
      console.log(`[db:ping] server version: ${String(ver?.v ?? '?')}`);
    }
    console.log('[db:ping] OK');
  } finally {
    try { await db.closeDb(); } catch { /* noop */ }
  }
}

main().catch((e) => {
  console.error('[db:ping] فشل — FAILED:', (e as Error).message);
  process.exit(1);
});
