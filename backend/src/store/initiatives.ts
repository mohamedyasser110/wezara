import { dbAll, dbGet, dbRun, dbTransaction, nowIso, parseJson, type SqlParam } from '../db/database.js';
import { normalizeWorkflowStages } from './workflow.js';
import { likePattern, newId, normPage, normPageSize, paginate } from './helpers.js';

export interface Initiative {
  id: string;
  slug: string;
  titleAr: string;
  titleEn: string;
  taglineAr: string;
  taglineEn: string;
  descriptionAr: string;
  descriptionEn: string;
  category: string;
  categoryEn: string;
  status: string;
  targetSectors: string[];
  targetSectorsEn: string[];
  targetGovernorates: string[];
  budgetTotalEGP: number;
  budgetAllocatedEGP: number;
  startDate: string;
  endDate: string;
  coverImage: string;
  badgeTextAr: string;
  badgeTextEn: string;
  participatingOrgs: string[];
  benefits: unknown[];
  faqs: unknown[];
  preEligibilityQuestions: unknown[];
  requiredDocsList: unknown[];
  formSections: unknown[];
  impactMetrics: Record<string, unknown>;
  customization: Record<string, unknown>;
  workflow: { version: number; stages: unknown[] } & Record<string, unknown>;
  objectives: unknown[];
  eligibilityRequirements: unknown[];
  selectionCriteria: unknown[];
  financialTerms: Record<string, unknown>;
  executionNotesAr: string;
  executionNotesEn: string;
  createdAt: string;
  updatedAt: string;
  // kpis عمداً غير موجود هنا: ADMIN ONLY عبر getInitiativeKpis — لا يتسرب في القراءة العامة.
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export function toInitiativeApi(r: Row): Initiative {
  return {
    id: r.id,
    slug: r.slug,
    titleAr: r.titleAr,
    titleEn: r.titleEn,
    taglineAr: r.taglineAr ?? '',
    taglineEn: r.taglineEn ?? '',
    descriptionAr: r.descriptionAr ?? '',
    descriptionEn: r.descriptionEn ?? '',
    category: r.category ?? '',
    categoryEn: r.categoryEn ?? '',
    status: r.status,
    targetSectors: parseJson<string[]>(r.targetSectors, []),
    targetSectorsEn: parseJson<string[]>(r.targetSectorsEn, []),
    targetGovernorates: parseJson<string[]>(r.targetGovernorates, []),
    budgetTotalEGP: Number(r.budgetTotalEGP ?? 0),
    budgetAllocatedEGP: Number(r.budgetAllocatedEGP ?? 0),
    startDate: r.startDate ?? '',
    endDate: r.endDate ?? '',
    coverImage: r.coverImage ?? '',
    badgeTextAr: r.badgeTextAr ?? '',
    badgeTextEn: r.badgeTextEn ?? '',
    participatingOrgs: parseJson<string[]>(r.participatingOrgs, []),
    benefits: parseJson<unknown[]>(r.benefits, []),
    faqs: parseJson<unknown[]>(r.faqs, []),
    preEligibilityQuestions: parseJson<unknown[]>(r.preEligibilityQuestions, []),
    requiredDocsList: parseJson<unknown[]>(r.requiredDocsList, []),
    formSections: parseJson<unknown[]>(r.formSections, []),
    impactMetrics: parseJson<Record<string, unknown>>(r.impactMetrics, {}),
    customization: parseJson<Record<string, unknown>>(r.customization, {}),
    workflow: parseJson<Initiative['workflow']>(r.workflow, { version: 1, stages: [] }),
    objectives: parseJson<unknown[]>(r.objectives, []),
    eligibilityRequirements: parseJson<unknown[]>(r.eligibilityRequirements, []),
    selectionCriteria: parseJson<unknown[]>(r.selectionCriteria, []),
    financialTerms: parseJson<Record<string, unknown>>(r.financialTerms, {}),
    executionNotesAr: r.executionNotesAr ?? '',
    executionNotesEn: r.executionNotesEn ?? '',
    createdAt: r.createdAt ?? '',
    updatedAt: r.updatedAt ?? '',
  };
}

function toListItem(r: Row) {
  return {
    id: r.id as string,
    titleAr: r.titleAr as string,
    titleEn: r.titleEn as string,
    status: r.status as string,
    budgetTotalEGP: Number(r.budgetTotalEGP ?? 0),
    coverImage: (r.coverImage as string) ?? '',
  };
}

export async function listInitiatives(opts: { status?: string; q?: string; page?: unknown; pageSize?: unknown; full?: boolean; hideStatuses?: string[] }) {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (opts.status && opts.status !== 'ALL') { where.push('status = ?'); params.push(opts.status); }
  if (opts.hideStatuses?.length) {
    where.push(`status NOT IN (${opts.hideStatuses.map(() => '?').join(', ')})`);
    params.push(...opts.hideStatuses);
  }
  if (opts.q) {
    where.push("(titleAr LIKE ? ESCAPE '\\' OR titleEn LIKE ? ESCAPE '\\')");
    const p = likePattern(opts.q);
    params.push(p, p);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = await dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM initiatives ${clause}`, [...params]);
  const total = totalRow?.c ?? 0;
  const page = normPage(opts.page);
  const pageSize = normPageSize(opts.pageSize);
  if (opts.full) {
    // API-only frontend: public showcase + wizard need complete objects (not list cards).
    const rows = await dbAll<Row>(
      `SELECT * FROM initiatives ${clause} ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    return paginate(rows.map(toInitiativeApi), total, page, pageSize);
  }
  const rows = await dbAll<Row>(
    `SELECT id, titleAr, titleEn, status, budgetTotalEGP, coverImage FROM initiatives ${clause} ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return paginate(rows.map(toListItem), total, page, pageSize);
}

export async function getInitiativeById(id: string): Promise<Initiative | null> {
  const row = await dbGet<Row>('SELECT * FROM initiatives WHERE id = ?', [id]);
  return row ? toInitiativeApi(row) : null;
}

export async function slugExists(slug: string, selfId?: string): Promise<boolean> {
  const row = await dbGet<{ one?: number }>(
    'SELECT 1 AS one FROM initiatives WHERE slug = ? COLLATE NOCASE AND id != ?',
    [slug, selfId ?? ''],
  );
  return Boolean(row);
}

export interface InitiativeCreateInput extends Record<string, unknown> {
  titleAr: string;
  titleEn: string;
}

export async function createInitiative(patch: InitiativeCreateInput & { slug: string }): Promise<Initiative> {
  const now = nowIso();
  const id = newId('init');
  const day = now.slice(0, 10);
  await dbRun(
    `INSERT INTO initiatives
     (id, slug, titleAr, titleEn, taglineAr, taglineEn, descriptionAr, descriptionEn, category, categoryEn, status,
      targetSectors, targetSectorsEn, targetGovernorates, budgetTotalEGP, budgetAllocatedEGP, startDate, endDate,
      coverImage, badgeTextAr, badgeTextEn, participatingOrgs, benefits, faqs, preEligibilityQuestions,
      requiredDocsList, formSections, impactMetrics, customization, workflow,
      objectives, eligibilityRequirements, selectionCriteria, financialTerms, executionNotesAr, executionNotesEn,
      createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, patch.slug,
      String(patch.titleAr ?? ''), String(patch.titleEn ?? 'New Initiative'),
      String(patch.taglineAr ?? ''), String(patch.taglineEn ?? ''),
      String(patch.descriptionAr ?? ''), String(patch.descriptionEn ?? ''),
      String(patch.category ?? ''), String(patch.categoryEn ?? ''),
      String(patch.status ?? 'draft'),
      JSON.stringify(patch.targetSectors ?? []), JSON.stringify(patch.targetSectorsEn ?? []), JSON.stringify(patch.targetGovernorates ?? []),
      Number(patch.budgetTotalEGP ?? 0), Number(patch.budgetAllocatedEGP ?? 0),
      String(patch.startDate ?? day), String(patch.endDate ?? day),
      String(patch.coverImage ?? '/covers/solar-2026.svg'),
      String(patch.badgeTextAr ?? ''), String(patch.badgeTextEn ?? ''),
      JSON.stringify(patch.participatingOrgs ?? []), JSON.stringify(patch.benefits ?? []),
      JSON.stringify(patch.faqs ?? []), JSON.stringify(patch.preEligibilityQuestions ?? []),
      JSON.stringify(patch.requiredDocsList ?? []), JSON.stringify(patch.formSections ?? []),
      JSON.stringify(patch.impactMetrics ?? {}),
      JSON.stringify({ requireDetailsFile: false, maxFileSizeMB: 15, allowedFileTypes: '.pdf' }),
      JSON.stringify({ version: 1, stages: normalizeWorkflowStages([]).stages }),
      JSON.stringify(patch.objectives ?? []), JSON.stringify(patch.eligibilityRequirements ?? []),
      JSON.stringify(patch.selectionCriteria ?? []), JSON.stringify(patch.financialTerms ?? {}),
      String(patch.executionNotesAr ?? ''), String(patch.executionNotesEn ?? ''),
      now, now,
    ],
  );
  return await getInitiativeById(id) as Initiative;
}

const JSON_FIELDS = new Set([
  'targetSectors', 'targetSectorsEn', 'targetGovernorates', 'participatingOrgs',
  'benefits', 'faqs', 'preEligibilityQuestions', 'requiredDocsList', 'formSections', 'impactMetrics',
  'objectives', 'eligibilityRequirements', 'selectionCriteria', 'financialTerms',
]);

const TEXT_FIELDS = new Set(['executionNotesAr', 'executionNotesEn']);

// kpis خارج هذه القائمة عمداً — له راوت أدمن مخصص (GET/PUT /initiatives/:id/kpis).
export const INITIATIVE_COLUMNS = new Set([
  'titleAr', 'titleEn', 'slug', 'taglineAr', 'taglineEn', 'descriptionAr', 'descriptionEn',
  'category', 'categoryEn', 'status', 'targetSectors', 'targetSectorsEn', 'targetGovernorates',
  'budgetTotalEGP', 'budgetAllocatedEGP', 'startDate', 'endDate', 'coverImage',
  'badgeTextAr', 'badgeTextEn', 'participatingOrgs', 'benefits', 'faqs',
  'preEligibilityQuestions', 'requiredDocsList', 'formSections', 'impactMetrics',
  'objectives', 'eligibilityRequirements', 'selectionCriteria', 'financialTerms',
  'executionNotesAr', 'executionNotesEn',
]);

export async function updateInitiative(id: string, patch: Record<string, unknown>): Promise<Initiative | null> {
  const sets: string[] = [];
  const params: SqlParam[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!INITIATIVE_COLUMNS.has(k)) continue;
    if (JSON_FIELDS.has(k)) { sets.push(`${k} = ?`); params.push(JSON.stringify(v)); }
    else if (k === 'budgetTotalEGP' || k === 'budgetAllocatedEGP') { sets.push(`${k} = ?`); params.push(Number(v)); }
    else if (k === 'slug') { sets.push('slug = ?'); params.push(String(v).trim()); }
    else if (TEXT_FIELDS.has(k)) { sets.push(`${k} = ?`); params.push(String(v ?? '')); }
    else { sets.push(`${k} = ?`); params.push(v as SqlParam); }
  }
  if (sets.length) {
    sets.push('updatedAt = ?');
    params.push(nowIso(), id);
    await dbRun(`UPDATE initiatives SET ${sets.join(', ')} WHERE id = ?`, [...params]);
  }
  return await getInitiativeById(id);
}

export async function deleteInitiative(id: string): Promise<boolean> {
  const info = await dbRun('DELETE FROM initiatives WHERE id = ?', [id]);
  return Number(info.changes ?? 0) > 0;
}

export async function updateCustomization(id: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const current = await getInitiativeById(id);
  if (!current) return null;
  const merged = { ...current.customization, ...patch };
  await dbRun('UPDATE initiatives SET customization = ?, updatedAt = ? WHERE id = ?', [JSON.stringify(merged), nowIso(), id]);
  return merged;
}

/**
 * نسخ مبادرة كاملة كمسودة: كل الأعمدة (البيانات + التخصيص + المراحل + المؤشرات) بصف جديد.
 * معرفات المراحل تبقى كما هي — آمن لأن النسخة بلا طلبات. null = الأصل غير موجود.
 */
export async function duplicateInitiative(id: string): Promise<Initiative | null> {
  const src = await dbGet<Row>('SELECT * FROM initiatives WHERE id = ?', [id]);
  if (!src) return null;
  let slug = `${src.slug}-copy`;
  for (let n = 2; await slugExists(slug); n++) slug = `${src.slug}-copy-${n}`;
  const now = nowIso();
  const row: Row = {
    ...src,
    id: newId('init'),
    slug,
    status: 'draft',
    titleAr: `نسخة من ${src.titleAr}`,
    titleEn: `Copy of ${src.titleEn}`,
    createdAt: now,
    updatedAt: now,
  };
  const cols = Object.keys(row);
  await dbRun(`INSERT INTO initiatives (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    [...cols.map(c => row[c] as SqlParam)]);
  return await getInitiativeById(row.id as string);
}

/** مؤشرات قياس الأداء — ADMIN ONLY (لا تمر عبر toInitiativeApi). null = مبادرة غير موجودة. */
export async function getInitiativeKpis(id: string): Promise<unknown[] | null> {
  const row = await dbGet<{ kpis?: string }>('SELECT kpis FROM initiatives WHERE id = ?', [id]);
  return row ? parseJson<unknown[]>(row.kpis, []) : null;
}

export async function updateInitiativeKpis(id: string, kpis: unknown[]): Promise<boolean> {
  const info = await dbRun('UPDATE initiatives SET kpis = ?, updatedAt = ? WHERE id = ?', [JSON.stringify(kpis), nowIso(), id]);
  return Number(info.changes ?? 0) > 0;
}

/** Caller must pass stages already normalized (normalizeWorkflowStages) — intake first, orders 1..n. */
export async function updateWorkflow(id: string, stages: unknown[]): Promise<{ version: number } | null> {
  const current = await getInitiativeById(id);
  if (!current) return null;
  const version = Number(current.workflow?.version ?? 1) + 1;
  await dbRun('UPDATE initiatives SET workflow = ?, updatedAt = ? WHERE id = ?', [
    JSON.stringify({ version, stages }), nowIso(), id,
  ]);
  return { version };
}
