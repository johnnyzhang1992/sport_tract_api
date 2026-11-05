/**
 * 照片管理（2026-11-05）：把「你的照片存在哪、占了多少额度、怎么删」做成一个可操作的入口。
 *
 * 为什么需要它：照片额度告满时服务端只会说「删除部分照片后继续上传」，但照片散落在
 * 轨迹打点（activities.markers[].photos）与足迹（footprintrecords.photos）两处，
 * 用户没有一处能总览+删除——尤其「会员到期 300→100 超额」时，用户根本不知道该删哪些。
 *
 * 纪律：
 * - 只读/只删自己的（每个查询都带 userId，越权按 404，与仓内既有口径一致）；
 * - 删除按「owner 文档 + 需保留的照片集合」**全量替换**，而不是按 URL 单点删——
 *   URL 可能重复出现（同一张图挂两个打点），全量替换才能保证口径与 settlePhotoQuota 对齐；
 * - 额度结算走 settlePhotoQuota(before, after)，与轨迹/足迹的编辑路径同一套；
 * - OSS 文件删除失败不阻塞（与既有删除路径同口径）。
 */
import { Types } from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import { FootprintRecordModel } from '../models/footprint-record.model.js';
import { UserModel } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { isObjectIdLike } from '../utils/object-id.js';
import { countPhotos, getPhotoQuota, settlePhotoQuota } from './photo-quota.js';
import { cleanUrl, deleteOssObjects, getSignedUrl, getThumbUrl } from './oss.js';
import { bjDateStr } from '../utils/bj-time.js';

export type PhotoOwnerKind = 'activity' | 'footprint';

export interface PhotoRef {
  kind: PhotoOwnerKind;
  id: string;
  /** 本次要删的照片（原始库内 URL，也接受签名 URL——统一 cleanUrl 后比对） */
  urls: string[];
}

export interface PhotoItem {
  url: string;
  thumb: string;
}

export interface PhotoGroup {
  kind: PhotoOwnerKind;
  /** activity/footprint 的文档 id：删除时回传 */
  id: string;
  /** 轨迹（类型+日期）或足迹（标题+日期） */
  title: string;
  dateText: string;
  photos: PhotoItem[];
}

export interface MyPhotosResult {
  used: number;
  limit: number;
  remaining: number;
  over: number;
  isMember: boolean;
  groups: PhotoGroup[];
}

/** 打点里的照片：photos 非空以它为准，否则回退兼容字段 photoUrl */
function markerPhotos(marker: { photos?: string[]; photoUrl?: string }): string[] {
  const list = (marker.photos ?? []).filter(Boolean);
  if (list.length) return list;
  return marker.photoUrl ? [marker.photoUrl] : [];
}

/** 我的照片总览：按「轨迹 / 足迹」分组，含额度读数（used/limit/over） */
export async function listMyPhotos(userId: string): Promise<MyPhotosResult> {
  if (!isObjectIdLike(userId)) throw new AppError(401, '请先登录');
  const uid = new Types.ObjectId(userId);
  const [quota, activities, footprints] = await Promise.all([
    getPhotoQuota(userId),
    ActivityModel.find({ userId: uid })
      .select({ type: 1, startTime: 1, name: 1, markers: 1 })
      .sort({ startTime: -1 })
      .limit(500)
      .lean(),
    FootprintRecordModel.find({ userId: uid })
      .select({ title: 1, visitDate: 1, photos: 1 })
      .sort({ visitDate: -1 })
      .limit(500)
      .lean(),
  ]);

  const groups: PhotoGroup[] = [];
  for (const a of activities) {
    const urls: string[] = [];
    for (const m of (a.markers ?? []) as Array<{ photos?: string[]; photoUrl?: string }>) {
      urls.push(...markerPhotos(m));
    }
    if (!urls.length) continue;
    groups.push({
      kind: 'activity',
      id: String(a._id),
      title: `${String(a.name || '运动轨迹')}`,
      dateText: a.startTime ? bjDateStr(Number(a.startTime)) : '',
      photos: urls.map((u) => ({ url: getSignedUrl(u), thumb: getThumbUrl(u) })),
    });
  }
  for (const f of footprints) {
    const urls = ((f.photos ?? []) as string[]).filter(Boolean);
    if (!urls.length) continue;
    groups.push({
      kind: 'footprint',
      id: String(f._id),
      title: String(f.title || '足迹'),
      dateText: String(f.visitDate || ''),
      photos: urls.map((u) => ({ url: getSignedUrl(u), thumb: getThumbUrl(u) })),
    });
  }

  // 计数权威性（2026-11-05）：photoQuotaUsed 是「该用户库里存着的照片颗数」的缓存，
  // 历史数据（额度功能上线前的老轨迹/足迹）没走过结算，counter 会偏低——这里以**文档实际张数**
  // 为准，并把 counter 顺手校准（只在这一处做修复，写路径仍然走 settlePhotoQuota）。
  const actual = groups.reduce((n, g) => n + g.photos.length, 0);
  let used = quota.used;
  if (actual !== used) {
    await UserModel.updateOne({ _id: uid }, { $set: { photoQuotaUsed: actual } });
    console.warn(`[photos] 额度计数校准：${used} → ${actual}（user=${userId}）`);
    used = actual;
  }

  return {
    used,
    limit: quota.limit,
    remaining: Math.max(0, quota.limit - used),
    over: Math.max(0, used - quota.limit),
    isMember: quota.isMember,
    groups,
  };
}

export interface DeletePhotosResult {
  deleted: number;
  used: number;
  limit: number;
  remaining: number;
  over: number;
}

/**
 * 删除我自己的照片。按 owner 文档聚合：同一文档只更新一次、只结算一次额度。
 * 返回删完后的最新额度读数（端上直接刷新，不必再拉一次总览）。
 */
export async function deleteMyPhotos(userId: string, refs: PhotoRef[]): Promise<DeletePhotosResult> {
  if (!isObjectIdLike(userId)) throw new AppError(401, '请先登录');
  if (!Array.isArray(refs) || refs.length === 0) throw new AppError(400, '请选择要删除的照片');
  if (refs.length > 100) throw new AppError(400, '一次最多处理 100 组');

  // 按 (kind,id) 聚合成一个文档一次处理；urls 取并集（同一张图重复传不影响）
  const byOwner = new Map<string, { kind: PhotoOwnerKind; id: string; urls: Set<string> }>();
  for (const ref of refs) {
    const kind = ref.kind;
    if (kind !== 'activity' && kind !== 'footprint') throw new AppError(400, '照片来源类型不合法');
    const id = String(ref.id ?? '');
    if (!Types.ObjectId.isValid(id)) throw new AppError(400, '照片来源 ID 无效');
    const key = `${kind}:${id}`;
    const entry = byOwner.get(key) ?? { kind, id, urls: new Set<string>() };
    for (const u of ref.urls ?? []) {
      const cleaned = cleanUrl(String(u));
      if (cleaned) entry.urls.add(cleaned);
    }
    byOwner.set(key, entry);
  }

  const uid = new Types.ObjectId(userId);
  let deleted = 0;
  const staleOss: string[] = [];

  for (const owner of byOwner.values()) {
    if (owner.urls.size === 0) continue;
    if (owner.kind === 'activity') {
      const doc = await ActivityModel.findOne({ _id: owner.id, userId: uid })
        .select({ markers: 1 })
        .lean();
      if (!doc) throw new AppError(404, '轨迹不存在');
      const markers = (doc.markers ?? []) as Array<{ id: string; photos?: string[]; photoUrl?: string }>;
      const before = markers.reduce((n, m) => n + markerPhotos(m).length, 0);
      let changed = false;
      const nextMarkers = markers.map((m) => {
        const own = markerPhotos(m);
        const keep = own.filter((u) => !owner.urls.has(cleanUrl(u)));
        if (keep.length === own.length) return m;
        changed = true;
        deleted += own.length - keep.length;
        staleOss.push(...own.filter((u) => owner.urls.has(cleanUrl(u))));
        return { ...m, photos: keep, photoUrl: keep[0] || '' };
      });
      if (!changed) continue;
      const after = nextMarkers.reduce((n, m) => n + markerPhotos(m).length, 0);
      await ActivityModel.updateOne({ _id: owner.id, userId: uid }, { $set: { markers: nextMarkers } });
      await settlePhotoQuota(userId, before, after);
      continue;
    }

    const doc = await FootprintRecordModel.findOne({ _id: owner.id, userId: uid })
      .select({ photos: 1 })
      .lean();
    if (!doc) throw new AppError(404, '足迹不存在');
    const own = ((doc.photos ?? []) as string[]).filter(Boolean);
    const keep = own.filter((u) => !owner.urls.has(cleanUrl(u)));
    if (keep.length === own.length) continue;
    deleted += own.length - keep.length;
    staleOss.push(...own.filter((u) => owner.urls.has(cleanUrl(u))));
    await FootprintRecordModel.updateOne({ _id: owner.id, userId: uid }, { $set: { photos: keep } });
    await settlePhotoQuota(userId, own.length, keep.length);
  }

  // OSS 文件清理失败不阻塞：库里已不再引用，重传同名文件也不会命中旧对象
  if (staleOss.length) await deleteOssObjects(staleOss).catch(() => {});

  const quota = await getPhotoQuota(userId);
  // 兜平：删除路径已把 used 回补，这里只读不写（避免二次扣减）
  const guard = await UserModel.findById(uid).select({ photoQuotaUsed: 1 }).lean();
  const used = guard?.photoQuotaUsed ?? quota.used;
  return {
    deleted,
    used,
    limit: quota.limit,
    remaining: Math.max(0, quota.limit - used),
    over: Math.max(0, used - quota.limit),
  };
}

/** 额度读数（端上刷新用；与 entitlements 的 photoQuota 同源） */
export async function myPhotoQuota(userId: string) {
  const q = await getPhotoQuota(userId);
  return { ...q, over: Math.max(0, q.used - q.limit) };
}

/** 单条删除前的归属校验用（路由层不需要，保留给将来的分享场景） */
export function countPhotosOfHolder(holder: { photos?: string[]; photoUrl?: string }): number {
  return countPhotos(holder);
}
