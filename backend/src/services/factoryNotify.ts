import { config } from '../config.js';
import { dbAll } from '../db/database.js';
import { getFactoryById } from '../store/factories.js';
import { getOrganizationById } from '../store/organizations.js';
import { enqueueEmail } from '../store/emailOutbox.js';
import type { ApplicationWithTrack } from '../store/applications.js';
import { factoryUpdateEmail, type FactoryEmailEvent, type FactoryEventKind } from '../mail/factoryNotifications.js';
import { isMailConfigured } from '../mail/mailer.js';
import { kickMailQueue } from '../jobs/mailQueue.js';

// إخطار المنشأة ببريد رسمي مع كل تحديث في مراحل طلبها.
// يُسجَّل في email_outbox ويُرسل من العامل — أي خطأ هنا لا يؤثر على القرار نفسه.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Factory contact email + verified owner accounts of that factory (de-duplicated). */
export async function factoryRecipients(factoryId: string): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (e: unknown) => {
    const v = String(e ?? '').trim();
    if (!EMAIL_RE.test(v) || seen.has(v.toLowerCase())) return;
    seen.add(v.toLowerCase());
    out.push(v);
  };
  add((await getFactoryById(factoryId))?.contactEmail);
  const owners = await dbAll<{ email: string }>(
    "SELECT email FROM users WHERE factoryId = ? AND role = 'factory_owner' AND isVerified = 1",
    [factoryId],
  );
  for (const o of owners) add(o.email);
  return out;
}

async function orgEn(orgId: string): Promise<string> {
  try { return (await getOrganizationById(orgId))?.nameEn ?? ''; } catch { return ''; }
}

async function queue(app: ApplicationWithTrack, event: FactoryEmailEvent): Promise<void> {
  const recipients = await factoryRecipients(app.factoryId);
  const mail = factoryUpdateEmail(event);
  const noRecipients = recipients.length === 0;
  const disabled = !isMailConfigured();
  await enqueueEmail({
    kind: `factory_${event.kind}`,
    refType: 'application',
    refId: app.id,
    recipients,
    ...mail,
    // Audit trail without a backlog: never replay old notifications once mail gets configured later.
    status: noRecipients || disabled ? 'skipped' : 'pending',
    reason: noRecipients ? 'no factory email on file' : disabled ? 'mail not configured (GMAIL_USER / GMAIL_APP_PASSWORD)' : '',
  });
  kickMailQueue();
}

async function base(app: ApplicationWithTrack): Promise<Pick<FactoryEmailEvent, 'factoryNameAr' | 'applicationNumber' | 'initiativeTitleAr' | 'totalStages' | 'appUrl'>> {
  const f = await getFactoryById(app.factoryId);
  return {
    factoryNameAr: app.factoryNameAr || String(f?.nameAr ?? ''),
    applicationNumber: app.applicationNumber,
    initiativeTitleAr: app.initiativeTitleAr,
    totalStages: app.totalStages,
    appUrl: config.appUrl,
  };
}

/** «تم استلام طلبكم» — right after submission. */
export async function notifyFactorySubmitted(app: ApplicationWithTrack): Promise<void> {
  try {
    const cur = app.stageTrack.find((s) => s.stageId === app.currentStageId);
    await queue(app, {
      ...await base(app),
      kind: 'submitted',
      stageNameAr: cur?.nameAr ?? app.currentStageNameAr,
      orgNameAr: cur?.orgNameAr || app.currentAssignedOrgNameAr,
      stageOrder: app.currentStageOrder || 1,
      approvedStages: 0,
      at: app.submittedAt,
    });
  } catch (e) {
    console.error('[factory-notify] submission email failed to queue:', e);
  }
}

/** Every factory-relevant decision (escalation is internal — no email). */
export async function notifyFactoryDecision(before: ApplicationWithTrack, after: ApplicationWithTrack, action: string, comments?: string): Promise<void> {
  try {
    let kind: FactoryEventKind | null = null;
    if (action === 'approve') {
      if (after.status === 'completed') kind = 'completed';
      else if (after.currentStageId !== before.currentStageId) kind = 'stage_approved';
    } else if (action === 'request_rework') kind = 'rework';
    else if (action === 'reject') kind = 'rejected';
    if (!kind) return;

    const decided = after.stageTrack.find((s) => s.stageId === before.currentStageId);
    const next = after.stageTrack.find((s) => s.stageId === after.currentStageId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev: any = after.timeline[after.timeline.length - 1] ?? {};
    const decidedOrgId = String(ev.byOrgId || decided?.orgId || before.currentAssignedOrgId);
    await queue(after, {
      ...await base(after),
      kind,
      stageNameAr: decided?.nameAr ?? before.currentStageNameAr,
      orgNameAr: String(ev.byOrgNameAr || decided?.orgNameAr || before.currentAssignedOrgNameAr),
      orgNameEn: String(ev.byOrgNameEn || await orgEn(decidedOrgId)),
      nextStageNameAr: kind === 'stage_approved' ? next?.nameAr : undefined,
      nextOrgNameAr: kind === 'stage_approved' ? (next?.orgNameAr || after.currentAssignedOrgNameAr) : undefined,
      stageOrder: after.currentStageOrder || 1,
      approvedStages: after.stageTrack.filter((s) => s.status === 'approved').length,
      comments: comments?.trim() || undefined,
      at: String(ev.at || new Date().toISOString()),
    });
  } catch (e) {
    console.error('[factory-notify] decision email failed to queue:', e);
  }
}
