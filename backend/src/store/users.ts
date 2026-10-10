import { dbAll, dbGet, dbRun, dbTransaction, nowIso, parseJson, type SqlParam } from '../db/database.js';
import { likePattern, newId, normPage, normPageSize, paginate } from './helpers.js';

export interface User {
  id: string;
  name: string;
  nameEn: string;
  email: string;
  role: string;
  organizationId: string;
  factoryId?: string;
  mustChangePassword?: boolean;
  isVerified?: boolean;
}

/** Internal row WITH passwordHash — never return to clients. */
export interface UserInternal extends User {
  passwordHash: string;
}

export async function listUsers(opts: { organizationId?: string; role?: string; q?: string; page?: unknown; pageSize?: unknown }) {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (opts.organizationId) { where.push('organizationId = ?'); params.push(opts.organizationId); }
  if (opts.role && opts.role !== 'ALL') { where.push('role = ?'); params.push(opts.role); }
  if (opts.q) {
    where.push("(name LIKE ? ESCAPE '\\' OR nameEn LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')");
    const p = likePattern(opts.q);
    params.push(p, p, p);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = await dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM users ${clause}`, [...params]);
  const total = totalRow?.c ?? 0;
  const page = normPage(opts.page);
  const pageSize = normPageSize(opts.pageSize);
  const rows = await dbAll<User>(
    `SELECT id, name, nameEn, email, role, organizationId, factoryId FROM users ${clause} ORDER BY name ASC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return paginate(rows, total, page, pageSize);
}

export async function getUserById(id: string): Promise<User | null> {
  const row = await dbGet<User & { mustChangePassword?: number; isVerified?: number }>('SELECT id, name, nameEn, email, role, organizationId, factoryId, mustChangePassword, isVerified FROM users WHERE id = ?', [id]);
  if (!row) return null;
  return { ...row, mustChangePassword: Boolean(row.mustChangePassword), isVerified: row.isVerified !== 0 };
}

export async function getUserInternalById(id: string): Promise<UserInternal | null> {
  const row = await dbGet<UserInternal & { mustChangePassword?: number; isVerified?: number; emailVerificationToken?: string; emailVerificationExpires?: string }>('SELECT id, name, nameEn, email, role, organizationId, factoryId, passwordHash, mustChangePassword, isVerified, emailVerificationToken, emailVerificationExpires FROM users WHERE id = ?', [id]);
  if (!row) return null;
  return { ...row, mustChangePassword: Boolean(row.mustChangePassword), isVerified: row.isVerified !== 0 } as UserInternal;
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const row = await dbGet<User & { mustChangePassword?: number; isVerified?: number }>('SELECT id, name, nameEn, email, role, organizationId, factoryId, mustChangePassword, isVerified FROM users WHERE email = ? COLLATE NOCASE', [email]);
  if (!row) return null;
  return { ...row, mustChangePassword: Boolean(row.mustChangePassword), isVerified: row.isVerified !== 0 };
}

export async function getUserInternalByEmail(email: string): Promise<UserInternal | null> {
  const row = await dbGet<UserInternal & { mustChangePassword?: number; isVerified?: number; emailVerificationToken?: string; emailVerificationExpires?: string }>('SELECT id, name, nameEn, email, role, organizationId, factoryId, passwordHash, mustChangePassword, isVerified, emailVerificationToken, emailVerificationExpires FROM users WHERE email = ? COLLATE NOCASE', [email]);
  if (!row) return null;
  return { ...row, mustChangePassword: Boolean(row.mustChangePassword), isVerified: (row as { isVerified?: number }).isVerified !== 0 } as UserInternal;
}

export async function createUser(input: { name: string; nameEn: string; email: string; role: string; organizationId: string; factoryId?: string; passwordHash?: string; mustChangePassword?: boolean; isVerified?: boolean; emailVerificationToken?: string; emailVerificationExpires?: string }): Promise<User> {
  const now = nowIso();
  const id = newId('user');
  await dbRun(
    'INSERT INTO users (id, name, nameEn, email, role, organizationId, factoryId, passwordHash, mustChangePassword, isVerified, emailVerificationToken, emailVerificationExpires, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, input.name.trim(), input.nameEn.trim(), input.email.trim(), input.role, input.organizationId, input.factoryId ?? '', input.passwordHash ?? '', input.mustChangePassword ? 1 : 0, input.isVerified === false ? 0 : 1, input.emailVerificationToken ?? '', input.emailVerificationExpires ?? '', now, now],
  );
  return await getUserById(id) as User;
}

export async function verifyUserEmail(token: string): Promise<User | null> {
  const row = await dbGet<{ id: string; emailVerificationExpires: string }>('SELECT id, emailVerificationExpires FROM users WHERE emailVerificationToken = ?', [token]);
  if (!row) return null;
  if (row.emailVerificationExpires && new Date(row.emailVerificationExpires).getTime() < Date.now()) return null;
  await dbRun('UPDATE users SET isVerified = 1, emailVerificationToken = ?, emailVerificationExpires = ?, updatedAt = ? WHERE id = ?', ['', '', nowIso(), row.id]);
  return await getUserById(row.id);
}

export async function setUserPassword(id: string, passwordHash: string, mustChange: boolean): Promise<void> {
  await dbRun('UPDATE users SET passwordHash = ?, mustChangePassword = ?, updatedAt = ? WHERE id = ?', [passwordHash, mustChange ? 1 : 0, nowIso(), id]);
}

// PROD FIX: إكمال العقد — PUT/DELETE /users/:id كانا معلنين بدون تنفيذ.
export async function updateUser(id: string, patch: Partial<Pick<User, 'name' | 'nameEn' | 'email' | 'role' | 'organizationId' | 'factoryId'>>): Promise<User | null> {
  const sets: string[] = [];
  const params: SqlParam[] = [];
  if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name.trim()); }
  if (patch.nameEn !== undefined) { sets.push('nameEn = ?'); params.push(patch.nameEn.trim()); }
  if (patch.email !== undefined) { sets.push('email = ?'); params.push(patch.email.trim()); }
  if (patch.role !== undefined) { sets.push('role = ?'); params.push(patch.role); }
  if (patch.organizationId !== undefined) { sets.push('organizationId = ?'); params.push(patch.organizationId); }
  if (patch.factoryId !== undefined) { sets.push('factoryId = ?'); params.push(patch.factoryId); }
  if (sets.length) {
    sets.push('updatedAt = ?');
    params.push(nowIso(), id);
    await dbRun(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params]);
  }
  return await getUserById(id);
}

export async function deleteUser(id: string): Promise<boolean> {
  const info = await dbRun('DELETE FROM users WHERE id = ?', [id]);
  return Number(info.changes ?? 0) > 0;
}
