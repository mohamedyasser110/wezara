import { dbAll, dbGet, dbRun, dbTransaction, nowIso, parseJson, type SqlParam } from '../db/database.js';
import { likePattern, newId, normPage, normPageSize, paginate } from './helpers.js';

export interface Organization {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  type: string;
  active: boolean;
  contactEmail: string;
}

interface OrgRow {
  id: string; code: string; nameAr: string; nameEn: string;
  type: string; active: number; contactEmail: string;
}

function toApi(r: OrgRow): Organization {
  return {
    id: r.id, code: r.code, nameAr: r.nameAr, nameEn: r.nameEn,
    type: r.type, active: r.active === 1, contactEmail: r.contactEmail ?? '',
  };
}

export async function listOrganizations(opts: { type?: string; q?: string; page?: unknown; pageSize?: unknown }) {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (opts.type && opts.type !== 'ALL') {
    where.push('type = ?');
    params.push(opts.type);
  }
  if (opts.q) {
    where.push("(nameAr LIKE ? ESCAPE '\\' OR nameEn LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\')");
    const p = likePattern(opts.q);
    params.push(p, p, p);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = await dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM organizations ${clause}`, [...params]);
  const total = totalRow?.c ?? 0;
  const page = normPage(opts.page);
  const pageSize = normPageSize(opts.pageSize);
  const rows = await dbAll<OrgRow>(
    `SELECT * FROM organizations ${clause} ORDER BY nameAr ASC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return paginate(rows.map(toApi), total, page, pageSize);
}

export async function getOrganizationById(id: string): Promise<Organization | null> {
  const row = await dbGet<OrgRow>('SELECT * FROM organizations WHERE id = ?', [id]);
  return row ? toApi(row) : null;
}

export async function getOrganizationByCode(code: string): Promise<Organization | null> {
  const row = await dbGet<OrgRow>('SELECT * FROM organizations WHERE code = ? COLLATE NOCASE', [code]);
  return row ? toApi(row) : null;
}

export async function createOrganization(input: {
  code: string; nameAr: string; nameEn: string; type: string; contactEmail?: string;
}): Promise<Organization> {
  const now = nowIso();
  const id = newId('org');
  await dbRun(
    'INSERT INTO organizations (id, code, nameAr, nameEn, type, active, contactEmail, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
    [id, input.code.trim().toUpperCase(), input.nameAr.trim(), input.nameEn.trim(), input.type, (input.contactEmail ?? '').trim(), now, now],
  );
  return await getOrganizationById(id) as Organization;
}

export async function updateOrganization(id: string, patch: Partial<Pick<Organization, 'code' | 'nameAr' | 'nameEn' | 'type' | 'active' | 'contactEmail'>>): Promise<Organization | null> {
  const sets: string[] = [];
  const params: SqlParam[] = [];
  if (patch.code !== undefined) { sets.push('code = ?'); params.push(patch.code.trim().toUpperCase()); }
  if (patch.nameAr !== undefined) { sets.push('nameAr = ?'); params.push(patch.nameAr.trim()); }
  if (patch.nameEn !== undefined) { sets.push('nameEn = ?'); params.push(patch.nameEn.trim()); }
  if (patch.type !== undefined) { sets.push('type = ?'); params.push(patch.type); }
  if (patch.active !== undefined) { sets.push('active = ?'); params.push(patch.active ? 1 : 0); }
  if (patch.contactEmail !== undefined) { sets.push('contactEmail = ?'); params.push(patch.contactEmail.trim()); }
  if (sets.length) {
    sets.push('updatedAt = ?');
    params.push(nowIso(), id);
    await dbRun(`UPDATE organizations SET ${sets.join(', ')} WHERE id = ?`, [...params]);
  }
  return await getOrganizationById(id);
}

export { parseJson };
