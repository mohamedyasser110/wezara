import { dbAll, dbGet, dbRun, dbTransaction, nowIso } from '../db/database.js';
import { newId } from './helpers.js';

export const BANNER_PLACEMENTS = ['before_about', 'before_steps', 'before_cta'] as const;
export const BANNER_LINK_TYPES = ['none', 'initiative', 'url'] as const;
export const MAX_BANNERS = 12;

export type BannerPlacement = (typeof BANNER_PLACEMENTS)[number];
export type BannerLinkType = (typeof BANNER_LINK_TYPES)[number];

export interface HomeBanner {
  id: string;
  /** صورة مرفوعة → مسار /api/v1/highlights/:id/image?v=… (لا تُرسل داخل JSON)؛ غير ذلك كما خُزنت. */
  imageUrl: string;
  titleAr: string;
  titleEn: string;
  subtitleAr: string;
  subtitleEn: string;
  ctaLabelAr: string;
  ctaLabelEn: string;
  linkType: BannerLinkType;
  linkTarget: string;
  placement: BannerPlacement;
  sortOrder: number;
  active: boolean;
  startsAt: string;
  endsAt: string;
  createdAt: string;
  updatedAt: string;
}

export type BannerPatch = Partial<Omit<HomeBanner, 'id' | 'sortOrder' | 'createdAt' | 'updatedAt'>>;

const WRITABLE = [
  'imageUrl', 'titleAr', 'titleEn', 'subtitleAr', 'subtitleEn', 'ctaLabelAr', 'ctaLabelEn',
  'linkType', 'linkTarget', 'placement', 'active', 'startsAt', 'endsAt',
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export function bannerImagePath(id: string, updatedAt: string): string {
  return `/api/v1/highlights/${encodeURIComponent(id)}/image?v=${encodeURIComponent(updatedAt)}`;
}

function toBanner(r: Row): HomeBanner {
  const raw = String(r.imageUrl ?? '');
  return {
    id: r.id,
    imageUrl: raw.startsWith('data:') ? bannerImagePath(r.id, r.updatedAt) : raw,
    titleAr: r.titleAr ?? '',
    titleEn: r.titleEn ?? '',
    subtitleAr: r.subtitleAr ?? '',
    subtitleEn: r.subtitleEn ?? '',
    ctaLabelAr: r.ctaLabelAr ?? '',
    ctaLabelEn: r.ctaLabelEn ?? '',
    linkType: r.linkType ?? 'none',
    linkTarget: r.linkTarget ?? '',
    placement: r.placement ?? 'before_about',
    sortOrder: Number(r.sortOrder ?? 0),
    active: Number(r.active) === 1,
    startsAt: r.startsAt ?? '',
    endsAt: r.endsAt ?? '',
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** كل البانرات (للإدارة) بترتيب العرض. */
export async function listBanners(): Promise<HomeBanner[]> {
  const rows = await dbAll<Row>('SELECT * FROM home_banners ORDER BY sortOrder ASC, createdAt ASC');
  return rows.map(toBanner);
}

/** معروض الآن = مفعل + داخل النافذة الزمنية (التواريخ ISO فتُقارن نصياً). */
export function isBannerLive(b: HomeBanner, now = nowIso()): boolean {
  return b.active && (!b.startsAt || b.startsAt <= now) && (!b.endsAt || now < b.endsAt);
}

export async function listLiveBanners(now = nowIso()): Promise<HomeBanner[]> {
  return (await listBanners()).filter((b) => isBannerLive(b, now));
}

export async function getBannerById(id: string): Promise<HomeBanner | undefined> {
  const r = await dbGet<Row>('SELECT * FROM home_banners WHERE id = ?', [id]);
  return r ? toBanner(r) : undefined;
}

/** القيمة الخام للصورة (data URL كاملة) — لراوت الصورة فقط. */
export async function getBannerRawImage(id: string): Promise<string | undefined> {
  const r = await dbGet<{ imageUrl: string }>('SELECT imageUrl FROM home_banners WHERE id = ?', [id]);
  return r?.imageUrl;
}

export async function countBanners(): Promise<number> {
  return ((await dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM home_banners')) as { c: number }).c;
}

function toColumn(field: (typeof WRITABLE)[number], v: unknown): string | number {
  if (field === 'active') return v ? 1 : 0;
  return String(v ?? '');
}

export async function createBanner(patch: BannerPatch & { imageUrl: string }): Promise<HomeBanner> {
  const id = newId('hl');
  const now = nowIso();
  const maxOrder = ((await dbGet<{ m: number }>('SELECT COALESCE(MAX(sortOrder), 0) AS m FROM home_banners')) as { m: number }).m;
  const values = { active: true, ...patch } as Record<string, unknown>;
  const cols = WRITABLE.filter((f) => values[f] !== undefined);
  await dbRun(
    `INSERT INTO home_banners (id, ${cols.join(', ')}, sortOrder, createdAt, updatedAt)
     VALUES (?, ${cols.map(() => '?').join(', ')}, ?, ?, ?)`,
    [id, ...cols.map((f) => toColumn(f, values[f])), maxOrder + 1, now, now],
  );
  return (await getBannerById(id))!;
}

export async function updateBanner(id: string, patch: BannerPatch): Promise<HomeBanner | undefined> {
  const values = patch as Record<string, unknown>;
  const cols = WRITABLE.filter((f) => values[f] !== undefined);
  await dbRun(
    `UPDATE home_banners SET ${[...cols.map((f) => `${f} = ?`), 'updatedAt = ?'].join(', ')} WHERE id = ?`,
    [...cols.map((f) => toColumn(f, values[f])), nowIso(), id],
  );
  return getBannerById(id);
}

export async function deleteBanner(id: string): Promise<boolean> {
  return Number((await dbRun('DELETE FROM home_banners WHERE id = ?', [id])).changes) > 0;
}

/** يعيد ترقيم كل البانرات حسب ترتيب ids (قائمة كاملة — يتحقق منها الراوت). */
export async function reorderBanners(ids: string[]): Promise<void> {
  await dbTransaction(async () => {
    for (let i = 0; i < ids.length; i++) {
      await dbRun('UPDATE home_banners SET sortOrder = ? WHERE id = ?', [i + 1, ids[i]]);
    }
  });
}
