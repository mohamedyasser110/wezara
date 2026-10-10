import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Copies src/db/*.sql -> dist/db/*.sql after tsc (tsc doesn't copy .sql).
const here = path.dirname(fileURLToPath(import.meta.url));
const files = ['schema.sql', 'schema.mysql.sql'];
const destDir = path.join(process.cwd(), 'dist', 'db');
fs.mkdirSync(destDir, { recursive: true });
for (const name of files) {
  const candidates = [
    path.join(here, '..', 'src', 'db', name),
    path.join(process.cwd(), 'src', 'db', name),
  ];
  const from = candidates.find((p) => fs.existsSync(p));
  if (!from) {
    console.error(`[copy-schema] NOT FOUND: ${name} (tried ${candidates.join(' | ')})`);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(destDir, name));
  console.log(`[copy-schema] ${from} -> ${path.join(destDir, name)}`);
}
