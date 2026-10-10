// backup-sqlite.ts — نسخة احتياطية لملف SQLite (+wal/-shm إن وُجدا).
// Usage: npm run db:backup   (DB_PATH or ./data/app.db → data/backups/app-YYYYMMDD-HHmmss.db)
// Sync fs is fine here — no top-level await, no async needed.
import fs from 'node:fs';
import path from 'node:path';

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main(): void {
  const dbPath = path.resolve(process.env.DB_PATH ?? './data/app.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`[db:backup] خطأ: الملف غير موجود — DB file not found: ${dbPath}`);
    process.exit(1);
  }
  const backupDir = process.env.BACKUP_DIR
    ? path.resolve(process.env.BACKUP_DIR)
    : path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, `app-${stamp()}.db`);
  let bytes = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    const src = dbPath + suffix;
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest + suffix);
      bytes += fs.statSync(dest + suffix).size;
    }
  }
  const kb = (bytes / 1024).toFixed(1);
  console.log(`[db:backup] تم — backup OK: ${dest} (${bytes} bytes ≈ ${kb} KB)`);
}

main();
