import { dbAll, dbGet, dbRun, nowIso, parseJson } from '../db/database.js';
import { newId, normPage, normPageSize, paginate, type SqlParam } from './helpers.js';
import { getUserById } from './users.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export interface MessageFile {
  id: string;
  fileName: string;
  fileSize: string;
  description: string;
  initiativeId?: string;
  applicationId?: string;
  uploadedAt: string;
  status: string;
}

export interface Message {
  id: string;
  applicationId: string;
  fromUserId: string;
  fromUserName: string;
  fromOrgId: string;
  toOrgId: string;
  subject: string;
  body: string;
  customFields: Record<string, string>;
  detailsFileId?: string;
  detailsFile?: MessageFile;
  createdAt: string;
}

function toMessageApi(r: Row): Message {
  const cf = parseJson<Record<string, string>>(r.customFields, {});
  const msg: Message = {
    id: r.id,
    applicationId: r.applicationId,
    fromUserId: r.fromUserId ?? '',
    fromUserName: r.fromUserName ?? '',
    fromOrgId: r.fromOrgId ?? '',
    toOrgId: r.toOrgId ?? '',
    subject: r.subject ?? '',
    body: r.body ?? '',
    customFields: cf && typeof cf === 'object' ? cf : {},
    createdAt: r.createdAt,
  };
  if (r.detailsFileId) msg.detailsFileId = r.detailsFileId;
  if (r._detailsFile) msg.detailsFile = r._detailsFile as MessageFile;
  return msg;
}

/** Resolves the sender display name (snapshot at read time — same pattern as applications performerSnapshot). */
async function senderName(userId: string): Promise<string> {
  try {
    const u = await getUserById(userId);
    return u?.name ?? userId;
  } catch {
    return userId;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function attachDetailsFile(msg: any): Promise<void> {
  if (!msg.detailsFileId) return;
  try {
    const f = await dbGet<Row>(
      'SELECT id, fileName, fileSize, description, initiativeId, applicationId, uploadedAt, status FROM details_files WHERE id = ?',
      [msg.detailsFileId],
    );
    // PROD FIX: never leak storedPath — explicit safe columns only.
    if (f) {
      msg._detailsFile = {
        id: f.id, fileName: f.fileName, fileSize: f.fileSize, description: f.description,
        initiativeId: f.initiativeId, applicationId: f.applicationId,
        uploadedAt: f.uploadedAt, status: f.status,
      };
    }
  } catch { /* ignore — message stays without file data */ }
}

export async function listMessages(
  applicationId: string,
  opts: { page?: unknown; pageSize?: unknown; orgId?: string },
) {
  const page = normPage(opts.page);
  const pageSize = normPageSize(opts.pageSize, 20);
  const where = opts.orgId
    ? 'WHERE applicationId = ? AND (fromOrgId = ? OR toOrgId = ?)'
    : 'WHERE applicationId = ?';
  const params: SqlParam[] = opts.orgId ? [applicationId, opts.orgId, opts.orgId] : [applicationId];
  const total = ((await dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM messages ${where}`, params)) as { c: number }).c;
  const rows = await dbAll<Row>(
    `SELECT * FROM messages ${where} ORDER BY createdAt ASC, id ASC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  const data: Message[] = [];
  for (const r of rows) {
    const withName = { ...r, fromUserName: await senderName(String(r.fromUserId ?? '')) };
    await attachDetailsFile(withName);
    data.push(toMessageApi(withName));
  }
  return paginate(data, total, page, pageSize);
}

export async function createMessage(input: {
  applicationId: string; fromUserId: string; fromOrgId: string; toOrgId: string;
  subject: string; body: string; customFields: Record<string, string>; detailsFileId?: string;
}): Promise<Message> {
  const id = newId('msg');
  // Same-ms messages would tie on createdAt (random-UUID ids break ties
  // arbitrarily, unlike the old SQLite rowid). Keep per-application monotonic
  // timestamps so ORDER BY createdAt reproduces insertion order.
  const prev = await dbGet<{ m: string | null }>('SELECT MAX(createdAt) AS m FROM messages WHERE applicationId = ?', [input.applicationId]);
  const stamp = nowIso();
  const now = prev?.m && stamp <= prev.m ? new Date(new Date(prev.m).getTime() + 1).toISOString() : stamp;
  await dbRun(
    `INSERT INTO messages
     (id, applicationId, fromUserId, fromOrgId, toOrgId, subject, body, customFields, detailsFileId, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, input.applicationId, input.fromUserId, input.fromOrgId, input.toOrgId,
      input.subject, input.body, JSON.stringify(input.customFields),
      (input.detailsFileId ?? null) as SqlParam, now,
    ],
  );
  const row = await dbGet<Row>('SELECT * FROM messages WHERE id = ?', [id]) as Row;
  const withName = { ...row, fromUserName: await senderName(input.fromUserId) };
  await attachDetailsFile(withName);
  return toMessageApi(withName);
}
