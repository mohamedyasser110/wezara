import { initDatabase, closeDb } from './database.js';

// Ensures schema exists (idempotent). Seed is separate and auto-runs on boot.
async function main(): Promise<void> {
  await initDatabase();
  console.log('[db:migrate] schema OK');
  await closeDb();
}

void main();
