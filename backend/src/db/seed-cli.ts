import { closeDb, initDatabase } from './database.js';
import { seedIfEmpty } from './seed.js';

async function main(): Promise<void> {
  await initDatabase(); // idempotent — creates schema on an empty DB (both drivers)
  const { seeded } = await seedIfEmpty();
  console.log(`[db:seed] ${seeded ? 'seeded initial data' : 'already seeded — skipped'}`);
  await closeDb();
}

main().catch((e) => {
  console.error('[db:seed] FAILED:', (e as Error).message);
  process.exit(1);
});
