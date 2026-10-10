import { dbAll, dbGet, dbRun, dbTransaction, nowIso, parseJson, type SqlParam } from '../db/database.js';
import { newId, normPage, normPageSize, paginate } from './helpers.js';

export interface DetailsFile {
  id: string;
  factoryId: string;
  fileName: string;
  fileSize: string;
  description: string;
  initiativeId?: string;
  applicationId?: string;
  uploadedAt: string;
  uploadedBy: string;
  status: 'pending' | 'verified' | 'rejected';
}

/** Internal row WITH storedPath — for filesystem deletion only, NEVER returned to clients. */
export interface DetailsFileInternal extends DetailsFile {
  storedPath: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function toApi(r: Row): DetailsFile {
  // PROD FIX: never expose storedPath (internal disk layout) to API clients.
  return {
    id: r.id, factoryId: r.factoryId, fileName: r.fileName,
    fileSize: r.fileSize ?? '', description: r.description ?? '',
    initiativeId: r.initiativeId ?? undefined, applicationId: r.applicationId ?? undefined,
    uploadedAt: r.uploadedAt,
    uploadedBy: r.uploadedBy ?? 'unknown',
    status: (r.status ?? 'pending') as DetailsFile['status'],
  };
}

function toInternal(r: Row): DetailsFileInternal {
  return { ...toApi(r), storedPath: r.storedPath ?? '' };
}

/** Unified factory profile: id + merged JSON `data` columns. */
export async function getFactoryById(id: string): Promise<(Record<string, unknown> & { id: string }) | null> {
  const row = await dbGet<{ id: string; data: string }>('SELECT id, data FROM factories WHERE id = ?', [id]);
  if (!row) return null;
  const data = parseJson<Record<string, unknown>>(row.data, {});
  return { ...data, id: row.id };
}

/** API-only frontend: public factory self-registration creates the factory row. */
export async function createFactory(data: Record<string, unknown>): Promise<{ id: string }> {
  const now = nowIso();
  const id = newId('factory');
  await dbRun('INSERT INTO factories (id, data, createdAt, updatedAt) VALUES (?, ?, ?, ?)', [
    id, JSON.stringify({ ...data, id }), now, now,
  ]);
  return { id };
}

export async function listFactories(opts: { q?: string; page?: unknown; pageSize?: unknown }) {
  const totalRow = await dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM factories');
  const total = totalRow?.c ?? 0;
  const page = normPage(opts.page);
  const pageSize = normPageSize(opts.pageSize);
  const rows = await dbAll<{ id: string; data: string }>('SELECT id, data FROM factories ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?', [
    pageSize, (page - 1) * pageSize,
  ]);
  let items = rows.map((r) => ({ ...parseJson<Record<string, unknown>>(r.data, {}), id: r.id }));
  if (opts.q) {
    const q = opts.q.toLowerCase();
    items = items.filter((f) =>
      String((f as Record<string, unknown>).nameAr ?? '').includes(opts.q as string) ||
      String((f as Record<string, unknown>).nameEn ?? '').toLowerCase().includes(q),
    );
  }
  return paginate(items, total, page, pageSize);
}

export async function updateFactory(id: string, patch: Record<string, unknown>): Promise<(Record<string, unknown> & { id: string }) | null> {
  const current = await getFactoryById(id);
  if (!current) return null;
  const { id: _omit, ...rest } = current;
  void _omit;
  const merged = { ...rest, ...patch, id };
  await dbRun('UPDATE factories SET data = ?, updatedAt = ? WHERE id = ?', [JSON.stringify(merged), nowIso(), id]);
  return await getFactoryById(id);
}

export async function listDetailsFiles(factoryId: string, initiativeId?: string): Promise<DetailsFile[]> {
  const rows = await dbAll<Row>('SELECT * FROM details_files WHERE factoryId = ? ORDER BY uploadedAt DESC, id DESC', [factoryId]);
  const all = rows.map(toApi);
  if (!initiativeId) return all;
  return all.filter((f) => !f.initiativeId || f.initiativeId === initiativeId);
}

export async function createDetailsFile(input: {
  factoryId: string; fileName: string; fileSize: string; description?: string;
  initiativeId?: string; applicationId?: string; storedPath?: string; uploadedBy: string;
}): Promise<DetailsFile> {
  const id = newId('fdet');
  const now = nowIso();
  await dbRun(
    `INSERT INTO details_files (id, factoryId, fileName, fileSize, description, initiativeId, applicationId, storedPath, uploadedAt, uploadedBy, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      id, input.factoryId, input.fileName, input.fileSize, input.description ?? '',
      input.initiativeId ?? null, input.applicationId ?? null, input.storedPath ?? '', now, input.uploadedBy,
    ],
  );
  const row = await dbGet<Row>('SELECT * FROM details_files WHERE id = ?', [id]) as Row;
  return toApi(row);
}

export async function deleteDetailsFile(factoryId: string, fileId: string): Promise<DetailsFileInternal | null> {
  const row = await dbGet<Row>('SELECT * FROM details_files WHERE id = ? AND factoryId = ?', [fileId, factoryId]);
  if (!row) return null;
  await dbRun('DELETE FROM details_files WHERE id = ?', [fileId]);
  return toInternal(row);
}

export async function countFilesByApplication(applicationId: string): Promise<number> {
  const row = await dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM details_files WHERE applicationId = ?', [applicationId]);
  return row?.c ?? 0;
}
