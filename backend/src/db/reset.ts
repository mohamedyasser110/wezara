import { closeDb, initDatabase } from './database.js';
import { resetAndSeed } from './seed.js';

async function main(): Promise<void> {
  await initDatabase(); // idempotent — reset wipes tables, so they must exist first
  await resetAndSeed();
  console.log('[db:reset] wiped + reseeded');
  await closeDb();
}

main().catch((e) => {
  console.error('[db:reset] FAILED:', (e as Error).message);
  process.exit(1);
});
