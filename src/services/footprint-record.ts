import { Types } from 'mongoose';
import { cleanUrl, deleteOssObjects, getSignedUrl, getThumbUrl } from './oss.js';
import { locateRegion } from './region.js';
import { AppError } from '../utils/app-error.js';
import { assertObjectIdLike } from '../utils/object-id.js';
import { config } from '../config/index.js';
import { FootprintRecordModel } from '../models/footprint-record.model.js';
import { UserModel } from '../models/user.model.js';
import type { CreateFootprintRecordInput, ListFootprintQueryInput, FootprintGeoQueryInput } from '../utils/validators.js';

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

/**
 * 关键词过滤条件（列表与地图 geo 共用一份口径，避免两处 $or 漂移）
 * 命中面：标题/描述/地点名/地址/省份/城市/同行人/到访日期。省市是地图页搜索框要求的「搜省份城市」。
 */
function keywordFilter(keyword: string): Record<string, unknown> {
  const rx = new RegExp(escapeRegex(keyword), 'i');
  return {
    $or: [
      { title: rx },
      { description: rx },
      { 'location.name': rx },
      { 'location.address': rx },
      { 'location.province': rx },
      { 'location.city': rx },
      { people: rx },
      { visitDate: rx },
    ],
  };
}

function toDto(doc: any, sign = true): any {
  return {
    id: String(doc._id),
    visitDate: doc.visitDate,
    title: doc.title,
    category: doc.category ?? '',
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
    // 与 photos 同序的缩略图档：端上渲染缩略图、点开 previewImage 用原图，一次页面少拉 100 倍流量。
    // 原图仍一并下发——已发布的老版本小程序读的是 photos，不能靠发版顺序赌客户端升级。
    photoThumbs: (doc.photos ?? []).map((p: string) => (sign ? getThumbUrl(p) : p)),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function findOwnedRecord(id: string, userId: string) {
  // 非 ObjectId 串会在 `_id` 上抛 CastError → 500 并泄露内部文案；GET/PUT/DELETE 三链都走这里，一处拦住
  assertObjectIdLike(id, '足迹不存在');
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
    category: input.category ?? '',
    people: input.people,
    description: input.description,
    location: buildLocation(input),
    photos: normalizePhotos(userId, input.photos),
  });
  return toDto(doc);
}

/**
 * 搜索命中得分（权重：标题 3 / 同行的人 2 / 描述、地点名、地址、省份、城市、日期 各 1）
 * 命中面与 keywordFilter 的 $or 逐字段对齐，只是「先排序后分页」需要显式分值。导出供单测
 */
export function searchScore(doc: any, keyword: string): number {
  const k = keyword.toLowerCase();
  const has = (s: unknown) => typeof s === 'string' && s.toLowerCase().includes(k);
  let score = 0;
  if (has(doc.title)) score += 3;
  if ((doc.people ?? []).some((p: string) => has(p))) score += 2;
  if (has(doc.description)) score += 1;
  if (has(doc.location?.name)) score += 1;
  if (has(doc.location?.address)) score += 1;
  if (has(doc.location?.province)) score += 1;
  if (has(doc.location?.city)) score += 1;
  if (has(doc.visitDate)) score += 1;
  return score;
}

/** 同分时按 visitDate 降序、createdAt 降序（与无关键词时的列表排序一致） */
function byRecency(a: any, b: any): number {
  if (a.visitDate !== b.visitDate) return a.visitDate < b.visitDate ? 1 : -1;
  return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
}

export async function listFootprints(userId: string, query: ListFootprintQueryInput) {
  const filter: Record<string, unknown> = { userId };
  const keyword = query.keyword?.trim();
  if (keyword) Object.assign(filter, keywordFilter(keyword));
  if (query.from || query.to) {
    filter.visitDate = {
      ...(query.from ? { $gte: query.from } : {}),
      ...(query.to ? { $lt: query.to } : {}),
    };
  }
  // 带关键词：先按相关度排序（标题/同行的人权重高），再内存切片分页——个人级数据量可控
  if (keyword) {
    const docs = await FootprintRecordModel.find(filter).lean();
    const ranked = docs
      .map((d) => ({ d, score: searchScore(d, keyword) }))
      .sort((a, b) => b.score - a.score || byRecency(a.d, b.d))
      .map((x) => x.d);
    const items = ranked.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
    return { items: items.map((d) => toDto(d)), total: ranked.length, page: query.page, pageSize: query.pageSize };
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

/**
 * 地图页打点数据：全量（或按 省/年/分类/关键词 过滤后）返回，不分页
 * 不带 query 时行为与历史一致，老版本小程序不受影响。
 * 下发 province/city/category 是给筛选弹窗本地算选项用的：省份与年份候选直接从首次全量快照去重，
 * 省一个聚合接口，代价是一次字符串拷贝。
 */
export async function listFootprintGeo(userId: string, query: FootprintGeoQueryInput = {}) {
  const filter: Record<string, unknown> = { userId };
  const keyword = query.keyword?.trim();
  if (keyword) Object.assign(filter, keywordFilter(keyword));
  if (query.province) filter['location.province'] = query.province;
  if (query.category) filter.category = query.category;
  if (query.year) {
    // visitDate 是 YYYY-MM-DD 字符串，字典序即日期序，左含右不含
    filter.visitDate = { $gte: `${query.year}-01-01`, $lt: `${Number(query.year) + 1}-01-01` };
  }
  const docs = await FootprintRecordModel.find(filter)
    .sort({ visitDate: -1 })
    .select('title visitDate category location.photos location.province location.city location.latitude location.longitude photos')
    .lean();
  return {
    items: docs.map((d) => ({
      id: String(d._id),
      title: d.title,
      visitDate: d.visitDate,
      category: d.category ?? '',
      province: d.location?.province ?? '',
      city: d.location?.city ?? '',
      latitude: d.location?.latitude,
      longitude: d.location?.longitude,
      coverPhoto: d.photos?.[0] ? getSignedUrl(d.photos[0]) : '',
      // 地图气泡照片卡只有 108×64，canvas 画原图是白拉流量
      coverPhotoThumb: d.photos?.[0] ? getThumbUrl(d.photos[0]) : '',
    })),
  };
}

export interface FootprintStats {
  total: number;
  provinceCount: number;
  cityCount: number;
  /** 分省计数（次数倒序、同数按名称），每省带城市明细；省为空或城市为空的脏数据不进 cities */
  provinces: Array<{ name: string; count: number; cities: Array<{ name: string; count: number }> }>;
}

/**
 * 统计页聚合：total / 省份数 / 城市数 / 分省计数（点亮地图上色用）
 * 一次按 province+city 分组后在 Node 侧汇总——单用户私有数据，分组行数 ≤ 省市组合数，
 * 不值得上 $facet 两次查询。userId 必须先转 ObjectId：aggregate 的 $match 不像 find 那样按 schema 自动转型。
 * @param range from 含 / to 不含（YYYY-MM-DD，与 visitDate 字符串同构，字典序即日期序）；不传 = 全部
 */
export async function footprintStats(
  userId: string,
  range: { from?: string; to?: string } = {},
): Promise<FootprintStats> {
  const match: Record<string, unknown> = { userId: new Types.ObjectId(userId) };
  if (range.from || range.to) {
    const visitDate: Record<string, string> = {};
    if (range.from) visitDate.$gte = range.from;
    if (range.to) visitDate.$lt = range.to;
    match.visitDate = visitDate;
  }
  const rows = await FootprintRecordModel.aggregate<{ _id: { province?: string; city?: string }; count: number }>([
    { $match: match },
    { $group: { _id: { province: '$location.province', city: '$location.city' }, count: { $sum: 1 } } },
  ]);

  let total = 0;
  const provMap = new Map<string, { count: number; cities: Map<string, number> }>();
  const citySet = new Set<string>();
  for (const row of rows) {
    total += row.count;
    const province = (row._id?.province ?? '').trim();
    const city = (row._id?.city ?? '').trim();
    if (province) {
      const entry = provMap.get(province) ?? { count: 0, cities: new Map<string, number>() };
      entry.count += row.count;
      // 城市挂在省下：早期直连库灌的数据只有省没有市，这类行计省不计市，不能凭空造一个空城市项
      if (city) entry.cities.set(city, (entry.cities.get(city) ?? 0) + row.count);
      provMap.set(province, entry);
    }
    if (city) citySet.add(`${province}|${city}`);
  }
  const provinces = [...provMap.entries()]
    .map(([name, v]) => ({
      name,
      count: v.count,
      cities: [...v.cities.entries()]
        .map(([cityName, count]) => ({ name: cityName, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { total, provinceCount: provinces.length, cityCount: citySet.size, provinces };
}

export interface FootprintCalendarDay {
  date: string;
  count: number;
}

export interface FootprintCalendar {
  total: number;
  placeCount: number;
  photoCount: number;
  days: FootprintCalendarDay[];
}

/**
 * 日历形态聚合：按天打点（days）+「N 条记录 · N 个地方 · N 张照片」总览
 * 全量返回、不按月份过滤，与 /geo 同一先例（私有数据量级可控）——前端 ‹ › 换月只在本地筛 days。
 * placeCount 是 distinct location.name（"个地方"按地点名口径，城市数在 /stats），空地点名不计。
 */
export async function footprintCalendar(userId: string): Promise<FootprintCalendar> {
  const rows = await FootprintRecordModel.aggregate<{
    _id: string;
    count: number;
    photos: number;
    names: (string | undefined)[];
  }>([
    { $match: { userId: new Types.ObjectId(userId) } },
    {
      $group: {
        _id: '$visitDate',
        count: { $sum: 1 },
        photos: { $sum: { $size: { $ifNull: ['$photos', []] } } },
        names: { $addToSet: '$location.name' },
      },
    },
  ]);

  let total = 0;
  let photoCount = 0;
  const places = new Set<string>();
  const days: FootprintCalendarDay[] = [];
  for (const row of rows) {
    total += row.count;
    photoCount += row.photos ?? 0;
    for (const raw of row.names ?? []) {
      const name = (raw ?? '').trim();
      if (name) places.add(name);
    }
    days.push({ date: row._id, count: row.count });
  }
  days.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { total, placeCount: places.size, photoCount, days };
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
      category: input.category ?? '',
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

/**
 * 按 id 硬删 + 清理 OSS 照片（不校验归属）。
 * 导出给管理后台用；用户端 deleteFootprint 必须先过归属再委托到这里，OSS 清理口径只留这一份。
 */
export async function deleteFootprintById(id: string) {
  assertObjectIdLike(id, '足迹不存在');
  const doc = await FootprintRecordModel.findById(id).lean();
  if (!doc) throw new AppError(404, '足迹不存在');
  await FootprintRecordModel.deleteOne({ _id: id });
  await deleteOssObjects(doc.photos ?? []).catch(() => {});
}

export async function deleteFootprint(id: string, userId: string) {
  // 归属校验在委托前：越权请求不能进到删除/OSS 清理那一步
  await findOwnedRecord(id, userId);
  await deleteFootprintById(id);
}

export interface AdminFootprintListQuery {
  page: number;
  pageSize: number;
  userId?: string;
  keyword?: string;
  province?: string;
  minPhotos?: number;
  visitFrom?: string;
  visitTo?: string;
}

/**
 * 管理后台足迹详情：正文 + 照片（签名 URL）+ 归属人昵称/UID
 * 不走 findOwnedRecord（那是用户端的归属闸门），后台按 id 直查。
 */
export async function adminGetFootprintById(id: string) {
  assertObjectIdLike(id, '足迹不存在');
  const doc = await FootprintRecordModel.findById(id).lean();
  if (!doc) throw new AppError(404, '足迹不存在');
  const user = await UserModel.findById(doc.userId).select('nickname uid').lean();
  return {
    ...toDto(doc),
    userId: String(doc.userId),
    userNickname: user?.nickname || '微信用户',
    userUid: user?.uid != null ? String(user.uid) : '',
  };
}

/**
 * 管理后台全站足迹列表（只读视角：带记录归属人信息，不下发照片数组）
 *
 * 与用户端 listFootprints 的两处口径差异：
 * - 排序固定 createdAt 倒序（后台按「什么时候进来的」排查，用户端按到访时间浏览）
 * - keyword 除文本命中外，还整体纳入昵称命中的用户的全部足迹（后台常按人找记录）
 * 照片只在详情弹窗按需取，列表不下发：一次 100 条 × 3 图 = 300 个签名 URL，白烧 CPU。
 */
export async function adminListFootprintRecords(query: AdminFootprintListQuery) {
  const filter: Record<string, unknown> = {};
  if (query.userId) filter.userId = assertObjectIdLike(query.userId, '用户不存在');
  if (query.province) filter['location.province'] = query.province;
  if (query.visitFrom || query.visitTo) {
    const visitDate: Record<string, string> = {};
    if (query.visitFrom) visitDate.$gte = query.visitFrom;
    if (query.visitTo) visitDate.$lt = query.visitTo;
    filter.visitDate = visitDate;
  }
  if (query.minPhotos && query.minPhotos > 0) {
    // 数组字段不能用 photos: { $gte: n }（那是「元素值 ≥ n」）；照片数只能进表达式比较
    filter.$expr = { $gte: [{ $size: { $ifNull: ['$photos', []] } }, query.minPhotos] };
  }
  const keyword = query.keyword?.trim();
  if (keyword) {
    const rx = new RegExp(escapeRegex(keyword), 'i');
    const or: Record<string, unknown>[] = [
      { title: rx },
      { description: rx },
      { 'location.name': rx },
      { 'location.address': rx },
      { people: rx },
    ];
    const byNickname = await UserModel.find({ nickname: rx }).select('_id').lean();
    if (byNickname.length > 0) or.push({ userId: { $in: byNickname.map((u) => u._id) } });
    filter.$or = or;
  }

  const [total, docs] = await Promise.all([
    FootprintRecordModel.countDocuments(filter),
    FootprintRecordModel.find(filter)
      .select('userId title visitDate category location people photos createdAt updatedAt')
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .lean(),
  ]);

  // 昵称/UID 只回填本页涉及的用户，不整表捞
  const ids = [...new Set(docs.map((d) => String(d.userId)))];
  const users = await UserModel.find({ _id: { $in: ids } }).select('_id nickname uid').lean();
  const nickMap = new Map(users.map((u) => [String(u._id), u.nickname || '微信用户']));
  const uidMap = new Map(users.map((u) => [String(u._id), u.uid != null ? String(u.uid) : '']));

  return {
    total,
    page: query.page,
    pageSize: query.pageSize,
    items: docs.map((d) => ({
      id: String(d._id),
      userId: String(d.userId),
      userNickname: nickMap.get(String(d.userId)) ?? '微信用户',
      userUid: uidMap.get(String(d.userId)) ?? '',
      title: d.title,
      visitDate: d.visitDate,
      category: d.category ?? '',
      placeName: d.location?.name ?? '',
      address: d.location?.address ?? '',
      province: d.location?.province ?? '',
      city: d.location?.city ?? '',
      people: d.people ?? [],
      peopleCount: (d.people ?? []).length,
      photoCount: d.photos?.length ?? 0,
      // 列表缩略图只给首图的缩略档；整组原图仍留给详情按需签（一页 100 行 × 3 图 = 300 个签名）
      coverPhoto: d.photos?.[0] ? getThumbUrl(d.photos[0]) : '',
      createdAt: d.createdAt,
    })),
  };
}
