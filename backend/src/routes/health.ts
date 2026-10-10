import { Router } from 'express';
import fs from 'node:fs';
import { dbGet, pingDatabase } from '../db/database.js';
import { config } from '../config.js';
import { ah } from '../middleware/asyncHandler.js';

export const healthRouter = Router();
// PROD FIX: health حقيقي يفحص DB + قرص الرفع (readiness/liveness).
healthRouter.get('/health', ah(async (_req, res) => {
  const checks: Record<string, string> = {};
  let ok = true;
  try {
    const live = await pingDatabase();
    checks.db = live ? 'ok' : 'fail';
    if (checks.db !== 'ok') ok = false;
  } catch {
    checks.db = 'fail';
    ok = false;
  }
  try {
    fs.mkdirSync(config.uploadDir, { recursive: true });
    fs.accessSync(config.uploadDir, fs.constants.W_OK);
    checks.uploads = 'ok';
    // File lifecycle: count orphans (non-fatal, just report)
    try {
      const dbFiles = await dbGet<{ c: number }>('SELECT COUNT(*) c FROM details_files');
      const diskFiles = fs.existsSync(config.uploadDir) ? fs.readdirSync(config.uploadDir).length : 0;
      checks.files = `db:${dbFiles?.c ?? 0} disk:${diskFiles}`;
    } catch { checks.files = 'unknown'; }
  } catch {
    checks.uploads = 'fail';
    ok = false;
  }
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    version: '1.0.0',
    time: new Date().toISOString(),
    env: config.env,
    checks,
  });
}));
