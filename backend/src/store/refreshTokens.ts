import { dbGet, dbRun, nowIso } from '../db/database.js';
import { newId } from './helpers.js';
import { sha256 } from '../auth/jwt.js';
import { config } from '../config.js';

export async function storeRefreshToken(userId: string, jti: string, token: string): Promise<void> {
  const exp = new Date(Date.now() + config.jwtRefreshTtlSec * 1000).toISOString();
  await dbRun(
    'INSERT INTO refresh_tokens (id, userId, tokenHash, expiresAt, revoked, createdAt) VALUES (?, ?, ?, ?, 0, ?)',
    [newId('rt'), userId, sha256(token), exp, nowIso()],
  );
  void jti;
}

export async function isRefreshValid(token: string): Promise<{ userId: string; jti: string } | null> {
  const h = sha256(token);
  const row = await dbGet<{ userId: string; expiresAt: string; revoked: number }>(
    'SELECT userId, expiresAt, revoked FROM refresh_tokens WHERE tokenHash = ?', [h],
  );
  if (!row || row.revoked) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) return null;
  // jti not stored separately — sub from JWT verified by caller
  return { userId: row.userId, jti: '' };
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await dbRun('UPDATE refresh_tokens SET revoked = 1 WHERE tokenHash = ?', [sha256(token)]);
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await dbRun('UPDATE refresh_tokens SET revoked = 1 WHERE userId = ?', [userId]);
}
