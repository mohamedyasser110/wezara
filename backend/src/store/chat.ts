import { dbAll, dbGet, dbRun, dbTransaction, nowIso } from '../db/database.js';
import { newId } from './helpers.js';
import { getOrganizationById, type Organization } from './organizations.js';
import { ADMIN_ROLES } from '../middleware/requireRole.js';
import type { User } from './users.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// ============================================================================
// مركز المراسلات (contract-first 5c) — محادثات ثنائية بين أي جهتين.
// - الوزارة جهة مثل غيرها (يتحدث باسمها ministry_admin / initiative_manager).
// - المدقق: اطلاع فقط. المصانع/المستثمرون: ممنوعون.
// - الإدارة والمدقق يطّلعون (قراءة فقط) على المحادثات بين الجهات الأخرى.
// ============================================================================

export const CHAT_MINISTRY_ORG_ID = 'org-ministry';
const REVIEWER_ROLES = ['ida_reviewer', 'imc_reviewer', 'bank_reviewer', 'solar_provider'];
const OVERSIGHT_ROLES = [...ADMIN_ROLES, 'auditor'] as readonly string[];

export interface ChatAccess {
  /** The organization the user speaks for. */
  orgId: string;
  /** May send / mark read (auditors are read-only). */
  canSend: boolean;
  /** May read conversations between OTHER organizations. */
  canOversee: boolean;
}

export interface ChatAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderUserId: string;
  senderName: string;
  senderNameEn: string;
  senderRole: string;
  senderOrgId: string;
  senderOrgNameAr: string;
  body: string;
  attachments: ChatAttachment[];
  createdAt: string;
}

/** One row of the caller's directory: a peer organization + the pair conversation (if any). */
export interface ChatConversationSummary {
  orgId: string; // the PEER organization
  orgCode: string;
  orgNameAr: string;
  orgNameEn: string;
  orgType: string;
  contactEmail: string;
  conversationId: string | null;
  lastMessageAt: string;
  lastMessagePreview: string;
  lastMessageFromMe: boolean;
  myLastReadAt: string;
  peerLastReadAt: string;
  unread: number;
}

export interface ChatOversightItem {
  conversationId: string;
  orgA: { id: string; code: string; nameAr: string; nameEn: string; type: string };
  orgB: { id: string; code: string; nameAr: string; nameEn: string; type: string };
  lastMessageAt: string;
  lastMessagePreview: string;
  lastSenderOrgId: string;
  messageCount: number;
}

export interface ChatUnreadSummary {
  total: number;
  items: Array<Pick<ChatConversationSummary, 'orgId' | 'orgCode' | 'orgNameAr' | 'orgNameEn' | 'orgType' | 'unread' | 'lastMessagePreview' | 'lastMessageAt'>>;
}

/** Internal only — storedPath never leaves the backend. */
export interface ChatAttachmentInternal extends ChatAttachment {
  storedPath: string;
  orgA: string;
  orgB: string;
}

export interface NewChatAttachment {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storedPath: string;
}

const PREVIEW_MAX = 140;

/** Organization eligible for messaging: exists, active, not a factory. */
export async function getChatOrg(orgId: string): Promise<Organization | null> {
  const org = await getOrganizationById(orgId);
  if (!org || !org.active || org.type === 'factory') return null;
  return org;
}

export async function chatAccessFor(user: User | undefined | null): Promise<ChatAccess | null> {
  if (!user || user.role === 'factory_owner') return null;
  if (!await getChatOrg(user.organizationId)) return null;
  const isAdmin = (ADMIN_ROLES as readonly string[]).includes(user.role);
  if (!isAdmin && !REVIEWER_ROLES.includes(user.role) && user.role !== 'auditor') return null;
  return {
    orgId: user.organizationId,
    canSend: user.role !== 'auditor',
    canOversee: OVERSIGHT_ROLES.includes(user.role),
  };
}

function pairOf(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

/** Column suffix for an org inside a conversation row. */
function sideOf(conv: Row, orgId: string): 'A' | 'B' {
  return conv.orgA === orgId ? 'A' : 'B';
}

export async function getConversationByPair(x: string, y: string): Promise<Row | undefined> {
  const [a, b] = pairOf(x, y);
  return dbGet<Row>('SELECT * FROM chat_conversations WHERE orgA = ? AND orgB = ?', [a, b]);
}

export async function getConversationById(id: string): Promise<Row | undefined> {
  return dbGet<Row>('SELECT * FROM chat_conversations WHERE id = ?', [id]);
}

async function getOrCreateConversation(x: string, y: string): Promise<Row> {
  const existing = await getConversationByPair(x, y);
  if (existing) return existing;
  const [a, b] = pairOf(x, y);
  await dbRun('INSERT INTO chat_conversations (id, orgA, orgB, createdAt) VALUES (?, ?, ?, ?)', [newId('chat'), a, b, nowIso()]);
  return await getConversationByPair(a, b) as Row;
}

// ----------------------------------------------------------------------------
// Directory / unread
// ----------------------------------------------------------------------------

/** Every eligible organization except mine, with the pair conversation summary. Unread first, then recent. */
export async function listChatDirectory(myOrgId: string): Promise<ChatConversationSummary[]> {
  const rows = await dbAll<Row>(
    `SELECT o.id AS orgId, o.code AS orgCode, o.nameAr AS orgNameAr, o.nameEn AS orgNameEn, o.type AS orgType,
            o.contactEmail AS contactEmail,
            c.id AS conversationId, c.lastMessageAt, c.lastMessagePreview, c.lastSenderOrgId,
            CASE WHEN c.orgA = :me THEN c.readA ELSE c.readB END AS myLastReadAt,
            CASE WHEN c.orgA = :me THEN c.readB ELSE c.readA END AS peerLastReadAt,
            (SELECT COUNT(*) FROM chat_messages m
              WHERE m.conversationId = c.id AND m.senderOrgId <> :me
                AND m.createdAt > (CASE WHEN c.orgA = :me THEN c.readA ELSE c.readB END)) AS unread
       FROM organizations o
       LEFT JOIN chat_conversations c
         ON (c.orgA = :me AND c.orgB = o.id) OR (c.orgB = :me AND c.orgA = o.id)
      WHERE o.active = 1 AND o.type <> 'factory' AND o.id <> :me
      ORDER BY (unread > 0) DESC, COALESCE(c.lastMessageAt, '') DESC, (o.id = :ministry) DESC, o.nameAr ASC`,
    { me: myOrgId, ministry: CHAT_MINISTRY_ORG_ID },
  );
  return rows.map((r) => ({
    orgId: r.orgId,
    orgCode: r.orgCode ?? '',
    orgNameAr: r.orgNameAr ?? '',
    orgNameEn: r.orgNameEn ?? '',
    orgType: r.orgType ?? '',
    contactEmail: r.contactEmail ?? '',
    conversationId: r.conversationId ?? null,
    lastMessageAt: r.lastMessageAt ?? '',
    lastMessagePreview: r.lastMessagePreview ?? '',
    lastMessageFromMe: !!r.lastSenderOrgId && r.lastSenderOrgId === myOrgId,
    myLastReadAt: r.myLastReadAt ?? '',
    peerLastReadAt: r.peerLastReadAt ?? '',
    unread: Number(r.unread ?? 0),
  }));
}

export async function getUnreadSummary(myOrgId: string): Promise<ChatUnreadSummary> {
  const withUnread = (await listChatDirectory(myOrgId)).filter((c) => c.unread > 0);
  return {
    total: withUnread.reduce((s, c) => s + c.unread, 0),
    items: withUnread
      .sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1))
      .slice(0, 10)
      .map((c) => ({
        orgId: c.orgId, orgCode: c.orgCode, orgNameAr: c.orgNameAr, orgNameEn: c.orgNameEn, orgType: c.orgType,
        unread: c.unread, lastMessagePreview: c.lastMessagePreview, lastMessageAt: c.lastMessageAt,
      })),
  };
}

/** Conversations between OTHER organizations (read-only oversight for the ministry / auditor). */
export async function listOversight(excludeOrgId: string): Promise<ChatOversightItem[]> {
  const rows = await dbAll<Row>(
    `SELECT c.id AS conversationId, c.lastMessageAt, c.lastMessagePreview, c.lastSenderOrgId,
            a.id AS aId, a.code AS aCode, a.nameAr AS aNameAr, a.nameEn AS aNameEn, a.type AS aType,
            b.id AS bId, b.code AS bCode, b.nameAr AS bNameAr, b.nameEn AS bNameEn, b.type AS bType,
            (SELECT COUNT(*) FROM chat_messages m WHERE m.conversationId = c.id) AS messageCount
       FROM chat_conversations c
       JOIN organizations a ON a.id = c.orgA
       JOIN organizations b ON b.id = c.orgB
      WHERE c.lastMessageAt <> '' AND c.orgA <> ? AND c.orgB <> ?
      ORDER BY c.lastMessageAt DESC`,
    [excludeOrgId, excludeOrgId],
  );
  return rows.map((r) => ({
    conversationId: r.conversationId,
    orgA: { id: r.aId, code: r.aCode, nameAr: r.aNameAr, nameEn: r.aNameEn, type: r.aType },
    orgB: { id: r.bId, code: r.bCode, nameAr: r.bNameAr, nameEn: r.bNameEn, type: r.bType },
    lastMessageAt: r.lastMessageAt ?? '',
    lastMessagePreview: r.lastMessagePreview ?? '',
    lastSenderOrgId: r.lastSenderOrgId ?? '',
    messageCount: Number(r.messageCount ?? 0),
  }));
}

// ----------------------------------------------------------------------------
// Messages
// ----------------------------------------------------------------------------

function isImageMime(mime: string): boolean {
  return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp';
}

async function attachmentsFor(messageIds: string[]): Promise<Map<string, ChatAttachment[]>> {
  const out = new Map<string, ChatAttachment[]>();
  if (!messageIds.length) return out;
  const marks = messageIds.map(() => '?').join(',');
  const rows = await dbAll<Row>(
    `SELECT id, messageId, fileName, mimeType, sizeBytes, createdAt FROM chat_attachments
      WHERE messageId IN (${marks}) ORDER BY createdAt ASC, id ASC`,
    [...messageIds],
  );
  for (const r of rows) {
    const list = out.get(r.messageId) ?? [];
    list.push({
      id: r.id, fileName: r.fileName, mimeType: r.mimeType, sizeBytes: Number(r.sizeBytes ?? 0),
      isImage: isImageMime(r.mimeType), createdAt: r.createdAt,
    });
    out.set(r.messageId, list);
  }
  return out;
}

async function toMessages(rows: Row[]): Promise<ChatMessage[]> {
  const files = await attachmentsFor(rows.map((r) => r.id as string));
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversationId,
    senderUserId: r.senderUserId ?? '',
    senderName: r.senderName ?? '',
    senderNameEn: r.senderNameEn ?? '',
    senderRole: r.senderRole ?? '',
    senderOrgId: r.senderOrgId ?? '',
    senderOrgNameAr: r.senderOrgNameAr ?? '',
    body: r.body ?? '',
    attachments: files.get(r.id) ?? [],
    createdAt: r.createdAt,
  }));
}

const MESSAGE_SELECT = `SELECT m.createdAt AS mild, m.id AS mid, m.id, m.conversationId, m.senderUserId, m.senderOrgId, m.body, m.createdAt,
       u.name AS senderName, u.nameEn AS senderNameEn, u.role AS senderRole, so.nameAr AS senderOrgNameAr
  FROM chat_messages m
  LEFT JOIN users u ON u.id = m.senderUserId
  LEFT JOIN organizations so ON so.id = m.senderOrgId`;

export interface MessagePage {
  data: ChatMessage[];
  hasMore: boolean;
  readA: string;
  readB: string;
  orgA: string;
  orgB: string;
}

/**
 * Cursor pagination by message id (createdAt+id — strictly monotonic via monotonicNow):
 * default = newest `limit`; before=<id> = older page; after=<id> = everything newer (polling, ≤100).
 */
export async function listConversationMessages(conv: Row | undefined, opts: { before?: string; after?: string; limit?: unknown }): Promise<MessagePage> {
  const empty = (): MessagePage => ({ data: [], hasMore: false, readA: conv?.readA ?? '', readB: conv?.readB ?? '', orgA: conv?.orgA ?? '', orgB: conv?.orgB ?? '' });
  if (!conv) return empty();
  const n = Number(opts.limit);
  const limit = Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 50) : 30;
  const cursorOf = (id: string) =>
    dbGet<{ createdAt: string; id: string }>('SELECT createdAt, id FROM chat_messages WHERE id = ? AND conversationId = ?', [id, conv.id]);

  if (opts.after) {
    const cursor = await cursorOf(opts.after);
    if (!cursor) return empty();
    const rows = await dbAll<Row>(`${MESSAGE_SELECT} WHERE m.conversationId = ? AND (m.createdAt > ? OR (m.createdAt = ? AND m.id > ?)) ORDER BY m.createdAt ASC, m.id ASC LIMIT 100`,
      [conv.id, cursor.createdAt, cursor.createdAt, cursor.id]);
    return { ...empty(), data: await toMessages(rows) };
  }
  let rows: Row[];
  if (opts.before) {
    const cursor = await cursorOf(opts.before);
    if (!cursor) return empty();
    rows = await dbAll<Row>(`${MESSAGE_SELECT} WHERE m.conversationId = ? AND (m.createdAt < ? OR (m.createdAt = ? AND m.id < ?)) ORDER BY m.createdAt DESC, m.id DESC LIMIT ?`,
      [conv.id, cursor.createdAt, cursor.createdAt, cursor.id, limit]);
  } else {
    rows = await dbAll<Row>(`${MESSAGE_SELECT} WHERE m.conversationId = ? ORDER BY m.createdAt DESC, m.id DESC LIMIT ?`,
      [conv.id, limit]);
  }
  rows.reverse();
  const oldest = rows[0] as Row | undefined;
  const hasMore = oldest !== undefined
    && Boolean(await dbGet<{ x: number }>('SELECT 1 AS x FROM chat_messages WHERE conversationId = ? AND (createdAt < ? OR (createdAt = ? AND id < ?)) LIMIT 1', [conv.id, oldest.createdAt, oldest.createdAt, oldest.id]));
  return { ...empty(), data: await toMessages(rows), hasMore };
}

/** Strictly increasing per conversation so "createdAt > lastReadAt" never loses a same-ms message. */
function monotonicNow(after: string): string {
  const now = nowIso();
  if (!after || now > after) return now;
  return new Date(new Date(after).getTime() + 1).toISOString();
}

export async function createChatMessage(input: {
  fromOrgId: string; toOrgId: string; senderUserId: string; body: string; attachments: NewChatAttachment[];
}): Promise<ChatMessage> {
  const id = newId('cmsg');
  await dbTransaction(async () => {
    const conv = await getOrCreateConversation(input.fromOrgId, input.toOrgId);
    const createdAt = monotonicNow(conv.lastMessageAt as string);
    await dbRun('INSERT INTO chat_messages (id, conversationId, senderUserId, senderOrgId, body, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
      [id, conv.id, input.senderUserId, input.fromOrgId, input.body, createdAt]);
    for (const [i, a] of input.attachments.entries()) {
      // Same-ms attachments would tie on createdAt (random-UUID ids break ties
      // arbitrarily, unlike the old SQLite rowid). Stagger +1ms per file so
      // ORDER BY createdAt reproduces insertion order deterministically.
      const aAt = i === 0 ? createdAt : new Date(new Date(createdAt).getTime() + i).toISOString();
      await dbRun(
        'INSERT INTO chat_attachments (id, messageId, fileName, mimeType, sizeBytes, storedPath, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [newId('catt'), id, a.fileName, a.mimeType, a.sizeBytes, a.storedPath, aAt],
      );
    }
    const preview = input.body
      ? input.body.replace(/\s+/g, ' ').slice(0, PREVIEW_MAX)
      : `📎 ${input.attachments[0]?.fileName ?? ''}${input.attachments.length > 1 ? ` (+${input.attachments.length - 1})` : ''}`;
    // Sending implies the sender's org has seen everything up to its own message.
    const s = sideOf(conv, input.fromOrgId);
    await dbRun(`UPDATE chat_conversations SET lastMessageAt = ?, lastMessagePreview = ?, lastSenderOrgId = ?, read${s} = ? WHERE id = ?`,
      [createdAt, preview, input.fromOrgId, createdAt, conv.id]);
  });
  const row = await dbGet<Row>(`${MESSAGE_SELECT} WHERE m.id = ?`, [id]) as Row;
  return (await toMessages([row]))[0];
}

/** Marks the pair conversation read for `orgId` and re-arms its email reminder. */
export async function markChatRead(myOrgId: string, peerOrgId: string): Promise<{ myLastReadAt: string; peerLastReadAt: string }> {
  const conv = await getConversationByPair(myOrgId, peerOrgId);
  if (!conv) return { myLastReadAt: '', peerLastReadAt: '' };
  const me = sideOf(conv, myOrgId);
  const peer = me === 'A' ? 'B' : 'A';
  const upTo = (conv.lastMessageAt as string) || '';
  await dbRun(
    `UPDATE chat_conversations SET read${me} = ?, reminderSent${me} = '', reminderAttempt${me} = '' WHERE id = ? AND read${me} < ?`,
    [upTo, conv.id, upTo],
  );
  const after = await getConversationById(conv.id) as Row;
  return { myLastReadAt: after[`read${me}`] ?? '', peerLastReadAt: after[`read${peer}`] ?? '' };
}

export async function getChatAttachment(id: string): Promise<ChatAttachmentInternal | null> {
  const r = await dbGet<Row>(
    `SELECT a.id, a.fileName, a.mimeType, a.sizeBytes, a.storedPath, a.createdAt, c.orgA, c.orgB
       FROM chat_attachments a
       JOIN chat_messages m ON m.id = a.messageId
       JOIN chat_conversations c ON c.id = m.conversationId
      WHERE a.id = ?`,
    [id],
  );
  if (!r) return null;
  return {
    id: r.id, fileName: r.fileName, mimeType: r.mimeType, sizeBytes: Number(r.sizeBytes ?? 0),
    isImage: isImageMime(r.mimeType), createdAt: r.createdAt, storedPath: r.storedPath, orgA: r.orgA, orgB: r.orgB,
  };
}

// ----------------------------------------------------------------------------
// Reminder support (jobs/chatReminders.ts) — per recipient side
// ----------------------------------------------------------------------------

export interface ReminderCandidate {
  conversationId: string;
  side: 'A' | 'B';
  /** Recipient organization (has unread messages). */
  orgId: string;
  peerOrgId: string;
  unread: number;
  oldestUnreadAt: string;
}

/** Sides whose incoming messages stayed unread past `cutoff` and were not reminded yet. */
export async function listReminderCandidates(cutoffIso: string, retryBeforeIso: string): Promise<ReminderCandidate[]> {
  const q = (me: 'A' | 'B') => {
    const peer = me === 'A' ? 'B' : 'A';
    return `SELECT c.id AS conversationId, '${me}' AS side, c.org${me} AS orgId, c.org${peer} AS peerOrgId,
                   COUNT(m.id) AS unread, MIN(m.createdAt) AS oldestUnreadAt
              FROM chat_conversations c
              JOIN chat_messages m ON m.conversationId = c.id
              JOIN organizations o ON o.id = c.org${me}
             WHERE m.senderOrgId = c.org${peer}
               AND m.createdAt > c.read${me}
               AND c.reminderSent${me} = ''
               AND (c.reminderAttempt${me} = '' OR c.reminderAttempt${me} <= ?)
               AND o.active = 1 AND o.type <> 'factory'
             GROUP BY c.id
            HAVING MIN(m.createdAt) <= ?`;
  };
  const rows = await dbAll<Row>(`${q('A')} UNION ALL ${q('B')}`,
    [retryBeforeIso, cutoffIso, retryBeforeIso, cutoffIso]);
  return rows.map((r) => ({
    conversationId: r.conversationId, side: r.side, orgId: r.orgId, peerOrgId: r.peerOrgId,
    unread: Number(r.unread ?? 0), oldestUnreadAt: r.oldestUnreadAt,
  }));
}

/** Org contact email + verified members who can chat for it (no factory owners / auditors), de-duplicated. */
export async function reminderRecipients(orgId: string): Promise<string[]> {
  const org = await getOrganizationById(orgId);
  const users = await dbAll<{ email: string }>(
    "SELECT email FROM users WHERE organizationId = ? AND isVerified = 1 AND role NOT IN ('factory_owner', 'auditor')",
    [orgId],
  );
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (e: string | undefined) => {
    const v = (e ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return;
    const k = v.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(v);
  };
  add(org?.contactEmail);
  for (const u of users) add(u.email);
  return out;
}

export async function markReminderAttempt(conversationId: string, side: 'A' | 'B', atIso: string): Promise<void> {
  await dbRun(`UPDATE chat_conversations SET reminderAttempt${side} = ? WHERE id = ?`, [atIso, conversationId]);
}

export async function markReminderSent(conversationId: string, side: 'A' | 'B', atIso: string): Promise<void> {
  await dbRun(`UPDATE chat_conversations SET reminderSent${side} = ?, reminderAttempt${side} = ? WHERE id = ?`,
    [atIso, atIso, conversationId]);
}
