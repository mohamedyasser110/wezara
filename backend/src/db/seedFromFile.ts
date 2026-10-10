import fs from 'node:fs';
import { dbGet, dbRun, dbTransaction, nowIso } from './database.js';
import type { SqlParam } from '../store/helpers.js';
import { hashPassword } from '../auth/jwt.js';
import { seedIfEmpty, SEED_DEFAULT_PASSWORD } from './seed.js';
import { createApplication, applyDecision, getApplicationById } from '../store/applications.js';
import { alignWorkflowsAndAssignments, INTAKE_STAGE_ID, MINISTRY_ORG_ID } from '../store/workflow.js';

// ---------------------------------------------------------------------------
// seed-data.json loader — imports a portable demo dataset file (repo root
// seed-data.json) into any environment: local dev, staging, or first prod boot.
// - Base rows (orgs/users/factories/initiatives): INSERT OR IGNORE (idempotent).
// - Demo applications (+ decision timelines via the REAL decision engine):
//   guarded by meta seed_demo_v1 (skipped on re-run unless forceApps).
// - Passwords are NEVER read from the file: every inserted user gets the
//   standard default hash (SEED_DEFAULT_PASSWORD); change after first login.
// Async dual-driver: all SQL goes through ./database.js (same seed safety:
// never overwrites existing users/passwords/hashes, never deletes data).
// ---------------------------------------------------------------------------

export interface SeedFileDecision { action: string; comments?: string; by: string }
export interface SeedFileApplication {
  ref: string; initiativeId: string; factoryId: string;
  formData?: Record<string, unknown>; decisions?: SeedFileDecision[];
}
export interface SeedFileData {
  organizations: Array<{ id: string; code: string; nameAr: string; nameEn: string; type: string; active: number; contactEmail: string }>;
  users: Array<{ id: string; name: string; nameEn: string; email: string; role: string; organizationId: string; factoryId?: string; mustChangePassword?: number }>;
  factories: Array<{ id: string; data: Record<string, unknown> }>;
  initiatives: Array<Record<string, unknown>>;
  applications?: SeedFileApplication[];
}
export interface SeedFileResult {
  orgs: number; users: number; factories: number; initiatives: number; applications: number;
  appsCreated: number; skipped: boolean;
  apps: Array<{ ref: string; id: string; status: string }>;
}

const INIT_COLS = [
  'id', 'slug', 'titleAr', 'titleEn', 'taglineAr', 'taglineEn', 'descriptionAr', 'descriptionEn',
  'category', 'categoryEn', 'status', 'targetSectors', 'targetSectorsEn', 'targetGovernorates',
  'budgetTotalEGP', 'budgetAllocatedEGP', 'startDate', 'endDate', 'coverImage',
  'badgeTextAr', 'badgeTextEn', 'participatingOrgs', 'benefits', 'faqs', 'preEligibilityQuestions',
  'requiredDocsList', 'formSections', 'impactMetrics', 'customization', 'workflow',
  'objectives', 'eligibilityRequirements', 'selectionCriteria', 'financialTerms',
  'executionNotesAr', 'executionNotesEn', 'kpis',
];
const JSON_INIT_COLS = new Set([
  'targetSectors', 'targetSectorsEn', 'targetGovernorates', 'participatingOrgs', 'benefits',
  'faqs', 'preEligibilityQuestions', 'requiredDocsList', 'formSections', 'impactMetrics',
  'customization', 'workflow', 'objectives', 'eligibilityRequirements', 'selectionCriteria',
  'financialTerms', 'kpis',
]);

export async function seedFromFile(jsonPath: string, opts: { forceApps?: boolean } = {}): Promise<SeedFileResult> {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as SeedFileData;
  if (!Array.isArray(data.organizations) || !Array.isArray(data.users) ||
      !Array.isArray(data.factories) || !Array.isArray(data.initiatives)) {
    throw new Error('[seed-from-file] invalid file: organizations/users/factories/initiatives arrays required');
  }
  // Base platform rows first (also backfills password hashes on old DBs).
  await seedIfEmpty();
  const now = nowIso();

  await dbTransaction(async () => {
    for (const o of data.organizations) {
      await dbRun(
        'INSERT OR IGNORE INTO organizations (id, code, nameAr, nameEn, type, active, contactEmail, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [o.id, o.code, o.nameAr, o.nameEn, o.type, o.active ? 1 : 0, o.contactEmail ?? '', now, now],
      );
    }
    const defaultHash = hashPassword(SEED_DEFAULT_PASSWORD);
    for (const u of data.users) {
      await dbRun(
        'INSERT OR IGNORE INTO users (id, name, nameEn, email, role, organizationId, factoryId, passwordHash, mustChangePassword, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [u.id, u.name, u.nameEn ?? '', u.email, u.role, u.organizationId, u.factoryId ?? '', defaultHash, u.mustChangePassword ? 1 : 0, now, now],
      );
    }
    for (const f of data.factories) {
      await dbRun(
        'INSERT OR IGNORE INTO factories (id, data, createdAt, updatedAt) VALUES (?, ?, ?, ?)',
        [f.id, JSON.stringify(f.data), now, now],
      );
    }
    const placeholders = INIT_COLS.map(() => '?').join(', ');
    for (const i of data.initiatives) {
      const vals: SqlParam[] = INIT_COLS.map((c) => {
        const v: unknown = i[c];
        if (JSON_INIT_COLS.has(c)) return JSON.stringify(v ?? (c === 'workflow' ? { stages: [] } : c === 'financialTerms' ? {} : []));
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' || v === null) return v;
        return '';
      });
      await dbRun(
        `INSERT OR IGNORE INTO initiatives (${INIT_COLS.join(', ')}, createdAt, updatedAt) VALUES (${placeholders}, ?, ?)`,
        [...vals, now, now],
      );
    }
  });

  // Demo applications through the real store path (numbering + decision engine).
  // NOTE: `key` is reserved in MySQL — backtick-quote it (valid in SQLite too).
  const flag = await dbGet<{ value?: string }>("SELECT value FROM meta WHERE `key` = 'seed_demo_v1'");
  const apps: SeedFileResult['apps'] = [];
  let appsCreated = 0;
  let skipped = false;
  if (flag?.value === '1' && !opts.forceApps) {
    skipped = true;
  } else {
    for (const a of data.applications ?? []) {
      const init = await dbGet<{ id: string; titleAr: string; workflow: string }>(
        'SELECT id, titleAr, workflow FROM initiatives WHERE id = ?', [a.initiativeId],
      );
      const fac = await dbGet<{ id: string; data: string }>(
        'SELECT id, data FROM factories WHERE id = ?', [a.factoryId],
      );
      if (!init || !fac) throw new Error(`[seed-from-file] unknown initiative/factory for app ref=${a.ref}`);
      let stages: Array<{ id?: string; nameAr?: string; assignedOrgId?: string; assignedOrgNameAr?: string; slaDays?: number; order?: number }> = [];
      try {
        const wf = JSON.parse(init.workflow ?? '{}') as { stages?: typeof stages };
        if (Array.isArray(wf.stages)) stages = [...wf.stages].sort((x, y) => Number(x.order ?? 0) - Number(y.order ?? 0));
      } catch { stages = []; }
      // Demo decisions in the file are scripted from the first ENTITY stage (they pre-date the ministry intake).
      const s0 = stages.find((s) => s.id !== INTAKE_STAGE_ID) ?? stages[0] ?? {};
      const fdata = JSON.parse(fac.data ?? '{}') as Record<string, unknown>;
      const owner = await dbGet<{ id: string }>('SELECT id FROM users WHERE factoryId = ? LIMIT 1', [fac.id]);
      const created = await createApplication({
        initiativeId: init.id, initiativeTitleAr: init.titleAr,
        factoryId: fac.id, factoryNameAr: String(fdata.nameAr ?? fac.id),
        factorySectorAr: String(fdata.sector ?? ''), factoryGovernorateAr: String(fdata.governorate ?? ''),
        currentStageId: String(s0.id ?? 'stage-1'), currentStageNameAr: String(s0.nameAr ?? ''),
        currentAssignedOrgId: String(s0.assignedOrgId ?? MINISTRY_ORG_ID),
        currentAssignedOrgNameAr: String(s0.assignedOrgNameAr ?? ''),
        slaDays: Number(s0.slaDays ?? 7), formData: a.formData ?? {}, detailsFileIds: [],
        by: owner?.id ?? '',
      });
      for (const d of a.decisions ?? []) await applyDecision(created.id, d.action, d.comments, d.by);
      const fin = await getApplicationById(created.id);
      apps.push({ ref: a.ref, id: created.id, status: fin?.status ?? 'unknown' });
      appsCreated++;
    }
    await dbRun("INSERT OR REPLACE INTO meta (`key`, value) VALUES ('seed_demo_v1', '1')");
  }
  // Mandatory ministry intake stage + consistent assignments (idempotent).
  await alignWorkflowsAndAssignments();

  const count = async (t: string) => Number((await dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t}`))?.c ?? 0);
  return {
    orgs: await count('organizations'), users: await count('users'), factories: await count('factories'),
    initiatives: await count('initiatives'), applications: await count('applications'),
    appsCreated, skipped, apps,
  };
}
