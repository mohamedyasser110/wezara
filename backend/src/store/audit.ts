import { dbAll, dbGet, dbRun, nowIso } from '../db/database.js';
import { newId, normPage, normPageSize, paginate } from './helpers.js';

export interface AuditEntry {
  userId?: string;
  userName: string;
  ip?: string;
  actionType: string;
  entityType: string;
  entityId: string;
  summaryAr: string;
  beforeJson?: unknown;
  afterJson?: unknown;
}

export async function addAuditLog(entry: AuditEntry) {
  const id = newId('audit');
  const before = entry.beforeJson === undefined ? '' : JSON.stringify(entry.beforeJson);
  const after = entry.afterJson === undefined ? '' : JSON.stringify(entry.afterJson);
  await dbRun(
    'INSERT INTO audit_logs (id, timestamp, userId, userName, ip, actionType, entityType, entityId, summaryAr, beforeJson, afterJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, nowIso(), entry.userId ?? 'unknown', entry.userName ?? 'unknown', entry.ip ?? '', entry.actionType ?? '', entry.entityType ?? '', entry.entityId ?? '', entry.summaryAr ?? '', before, after],
  );
  return { ...entry, id };
}

export async function listAuditLogs(opts: { page?: unknown; pageSize?: unknown }) {
  const total = ((await dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM audit_logs')) as { c: number }).c;
  const page = normPage(opts.page);
  const pageSize = normPageSize(opts.pageSize);
  const rows = await dbAll('SELECT * FROM audit_logs ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?', [
    pageSize, (page - 1) * pageSize,
  ]);
  return paginate(rows, total, page, pageSize);
}
