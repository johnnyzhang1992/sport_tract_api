import { cleanUrl, deleteOssObjects, getSignedUrl } from './oss.js';
import { locateRegion } from './region.js';
import { AppError } from '../utils/app-error.js';
import { config } from '../config/index.js';
import { FootprintRecordModel } from '../models/footprint-record.model.js';
import type { CreateFootprintRecordInput, ListFootprintQueryInput } from '../utils/validators.js';

/** 足迹新增防刷：1 小时滑动窗口最多 30 条（低于 activities 强度：足迹是静态记录） */
const FP_CREATE_LIMIT = 30;
const FP_CREATE_WINDOW_MS = 3600000;

export async function assertCanCreateFootprint(userId: string) {
  const recent = await FootprintRecordModel.countDocuments({
    userId,
    createdAt: { $gte: new Date(Date.now() - FP_CREATE_WINDOW_MS) },
  });
  if (recent >= FP_CREATE_LIMIT) {
    throw new AppError(429, `创建过于频繁，1 小时内最多新增 ${FP_CREATE_LIMIT} 条足迹`);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toDto(doc: any, sign = true): any {
  return {
    id: String(doc._id),
    visitDate: doc.visitDate,
    title: doc.title,
    people: doc.people ?? [],
    description: doc.description ?? '',
    location: {
      name: doc.location?.name ?? '',
      address: doc.location?.address ?? '',
      province: doc.location?.province ?? '',
      city: doc.location?.city ?? '',
      adcode: doc.location?.adcode ?? 0,
      latitude: doc.location?.latitude,
      longitude: doc.location?.longitude,
    },
    photos: (doc.photos ?? []).map((p: string) => (sign ? getSignedUrl(p) : p)),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function findOwnedRecord(id: string, userId: string) {
  const doc = await FootprintRecordModel.findOne({ _id: id, userId }).lean();
  if (!doc) throw new AppError(404, '足迹不存在');
  return doc;
}

function buildLocation(input: CreateFootprintRecordInput) {
  const region = locateRegion(input.location.latitude, input.location.longitude);
  return { ...input.location, province: region?.province ?? '', city: region?.city ?? '' };
}

/** 编辑时清理被移除的旧图（入参已 cleanUrl；签名回传的 URL 归一后才能对上）。导出供差集口径单测 */
export function removedPhotos(oldList: string[], newList: string[]): string[] {
  return oldList.filter((p) => !newList.includes(p));
}

/**
 * 照片 URL 归属闸门（spec §5 第二道闸）
 *
 * 直传 policy 只约束"允许往哪个前缀上传"，约束不了"提交接口时回传哪个 URL"——
 * 入参可被伪造成他人对象，故落库前再校验一次归属。
 * 口径与 extractKeyFromUrl 一致：URL 以 config.oss.endpoint 开头即视为本 bucket 对象，
 * key 必须落在自己的 {baseDir}/users/{userId}/ 前缀下。
 * 非 bucket URL（外链、测试桩）与 endpoint 未配置时原样放行。
 * @param photos 已 cleanUrl 归一的照片列表
 */
function assertPhotosOwnedBy(userId: string, photos: string[]) {
  const base = config.oss.endpoint.replace(/\/$/, '');
  if (!base) return;
  const ownPrefix = `${config.oss.baseDir}/users/${userId}/`;
  for (const url of photos) {
    if (!url.startsWith(base)) continue; // 外链：不归本 bucket 管
    const key = url.slice(base.length).replace(/^\//, '');
    if (!key.startsWith(ownPrefix)) throw new AppError(400, '照片地址不属于当前用户');
  }
}

/** cleanUrl + 归属闸门：创建/更新共用的照片入口 */
function normalizePhotos(userId: string, photos: string[] | undefined): string[] {
  const cleaned = (photos ?? []).map(cleanUrl);
  assertPhotosOwnedBy(userId, cleaned);
  return cleaned;
}

export async function createFootprint(userId: string, input: CreateFootprintRecordInput) {
  const doc = await FootprintRecordModel.create({
    userId,
    visitDate: input.visitDate,
    title: input.title,
    people: input.people,
    description: input.description,
    location: buildLocation(input),
    photos: normalizePhotos(userId, input.photos),
  });
  return toDto(doc);
}

export async function listFootprints(userId: string, query: ListFootprintQueryInput) {
  const filter: Record<string, unknown> = { userId };
  if (query.keyword) {
    const rx = new RegExp(escapeRegex(query.keyword), 'i');
    filter.$or = [
      { title: rx }, { description: rx },
      { 'location.name': rx }, { 'location.address': rx },
    ];
  }
  const [total, docs] = await Promise.all([
    FootprintRecordModel.countDocuments(filter),
    FootprintRecordModel.find(filter)
      .sort({ visitDate: -1, createdAt: -1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .lean(),
  ]);
  return { items: docs.map((d) => toDto(d)), total, page: query.page, pageSize: query.pageSize };
}

export async function listFootprintGeo(userId: string) {
  const docs = await FootprintRecordModel.find({ userId })
    .sort({ visitDate: -1 })
    .select('title visitDate location.photos location.latitude location.longitude photos')
    .lean();
  return {
    items: docs.map((d) => ({
      id: String(d._id),
      title: d.title,
      visitDate: d.visitDate,
      latitude: d.location?.latitude,
      longitude: d.location?.longitude,
      coverPhoto: d.photos?.[0] ? getSignedUrl(d.photos[0]) : '',
    })),
  };
}

export async function getFootprint(id: string, userId: string) {
  return toDto(await findOwnedRecord(id, userId));
}

export async function updateFootprint(id: string, userId: string, input: CreateFootprintRecordInput) {
  const old = await findOwnedRecord(id, userId);
  const nextPhotos = normalizePhotos(userId, input.photos);
  const doc = await FootprintRecordModel.findOneAndUpdate(
    { _id: id, userId },
    {
      visitDate: input.visitDate,
      title: input.title,
      people: input.people,
      description: input.description,
      location: buildLocation(input),
      photos: nextPhotos,
    },
    { new: true },
  ).lean();
  // 并发删除兜底：findOwnedRecord 之后文档仍可能被删，findOneAndUpdate 会返回 null
  if (!doc) throw new AppError(404, '足迹不存在');
  // 被移除的旧图清理 OSS 文件；失败不阻塞更新（与 markers 一致）
  const stale = removedPhotos(old.photos ?? [], nextPhotos);
  if (stale.length > 0) await deleteOssObjects(stale).catch(() => {});
  return toDto(doc);
}

export async function deleteFootprint(id: string, userId: string) {
  const old = await findOwnedRecord(id, userId);
  await FootprintRecordModel.deleteOne({ _id: id, userId });
  await deleteOssObjects(old.photos ?? []).catch(() => {});
}
