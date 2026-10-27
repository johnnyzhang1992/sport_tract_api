/**
 * 管理端道具目录：校验 + CRUD + 库存改写（spec §5.1/§7.2）。
 *
 * 口径：
 * - 字段所有权按写接口切开，谁负责谁必传：
 *   PUT /points/items/:id 只拥有内容字段（ITEM_CONTENT_FIELDS 那十三个，一个都不许缺，缺就 400 点名），
 *   永远不写 stock / unlimited；PATCH /points/items/:id/stock 是 stock 与 unlimited 的唯一出口。
 *   合在一条 PUT 里就等于「可选字段 + 默认值」——后台少传一个键，售罄的道具会被悄悄复活成 9999、
 *   道具图被清空（已上传对象成孤儿）、ad_free 的效果被换成补签，这些都是静默改写不是失败；
 * - key 创建后不可改：台账（PointRecord.refId / PointCard.itemKey / PointExchange.itemKey）
 *   全按它关联，改一下等于把历史兑换挂错道具——PUT 撞见改 key 直接 400 并点名原值/新值；
 * - 库存改写传目标值而不是增量：后台看到的是「现在剩多少」，语义含糊一次点两下就翻倍；
 *   返回 {before, after}（两个字段各自的改前改后）让操作方当场核对；
 * - schema 表达不了的校验（key 形状、名称长度、effect.kind 越界、ad_free 必带 days、notes 条数）集中在
 *   assertItemInput，更新入口再叠一层字段必传闸门 assertItemContent；错误文案一律「对象 + 实际值 + 限制」，
 *   不给通用失败；
 * - 唯一索引冲突（E11000）转 409 并点名 key，和仓内其它管理端写接口同码同形。
 */
import { AppError } from '../utils/app-error.js';
import { assertObjectIdLike } from '../utils/object-id.js';
import {
  ITEM_EFFECT_KINDS,
  ITEM_KINDS,
  PointCardModel,
  PointExchangeModel,
  PointItemModel,
  type ItemEffectKind,
  type ItemKind,
} from '../models/point.model.js';
import { getSignedUrl } from './oss.js';
import type { ItemDoc } from './points-catalog.js';

export const ITEM_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const DUPLICATE_KEY = 11000;

/** 实物详情图上限：schema 的 [String] 拦不住条数，条数与文案都归 assertItemInput */
export const DETAIL_IMAGE_MAX = 6;
/** 每人限购上限：0 = 不限，其余取 1–99（整数与范围都在 assertItemInput 校验，schema 只兜负数） */
export const PER_USER_LIMIT_MAX = 99;

/**
 * PUT /points/items/:id 拥有的内容字段：十三个全部必传，缺哪个就 400 点名哪个。
 * stock / unlimited 故意不在这张单子上——它们是 PATCH /points/items/:id/stock 的独占字段，
 * PUT 无论带不带都不写，免得「可选 + 默认值」把售罄的道具悄悄复活成 9999。
 * kind / detailImages / perUserLimit 是实物批次加进来的三项：管理端表单必须一起提交，
 * 实物默认限购 1 只属于「新建」，改档缺字段一律 400 而不是猜默认值。
 */
export const ITEM_CONTENT_FIELDS = [
  'name', 'subtitle', 'description', 'notes', 'price', 'validDays', 'effect', 'active', 'sortOrder', 'image',
  'kind', 'detailImages', 'perUserLimit',
] as const;
export type ItemContentField = typeof ITEM_CONTENT_FIELDS[number];

/** 新建入参：除 key/name/price/validDays/effect 外都可省略，落库取目录默认口径（这是新建，不是改写） */
export interface ItemInput {
  key: string;
  name: string;
  subtitle?: string;
  description?: string;
  notes?: string[];
  price: number;
  validDays: number;
  effect: { kind: ItemEffectKind; days: number };
  /** virtual（默认）/ physical；实物可省略 perUserLimit（新建落 1） */
  kind?: ItemKind;
  /** 实物详情图裸链，最多 DETAIL_IMAGE_MAX 张 */
  detailImages?: string[];
  /** 0 = 不限购 */
  perUserLimit?: number;
  stock?: number;
  unlimited?: boolean;
  active?: boolean;
  sortOrder?: number;
  image?: string;
}

/** PATCH /points/items/:id/stock 入参：stock 与 unlimited 至少要传一个（null 视同没传） */
export interface StockPatch {
  stock?: number | null;
  unlimited?: boolean | null;
}

/** 库存与不限量的一对状态：改前改后都报，操作方看得见另一个字段没被顺手改掉 */
export interface StockState {
  stock: number;
  unlimited: boolean;
}

/** 管理端列表行：全字段 + id + 兑换数/发放数（含下架项，这是与 listActiveItems 的核心差异） */
export interface AdminItemRow {
  id: string;
  key: string;
  name: string;
  subtitle: string;
  description: string;
  notes: string[];
  price: number;
  validDays: number;
  effect: { kind: ItemEffectKind; days: number };
  kind: ItemKind;
  /** 入库裸链（回填写回它）；端上下发的是逐张签名后的缩略链 */
  detailImages: string[];
  /** 0 = 不限购 */
  perUserLimit: number;
  stock: number;
  unlimited: boolean;
  active: boolean;
  sortOrder: number;
  /** 入库裸链（回填写回它）；私有桶裸链进 <img> 会 403，展示一律取 previewUrl */
  image: string;
  previewUrl: string;
  exchangeCount: number;
  grantCount: number;
}

/** createItem/updateItem 返回：_id 给测试与内部调用方（updateItem(String(row._id))），其余同目录字段 */
export type SavedItemRow = Omit<AdminItemRow, 'id' | 'exchangeCount' | 'grantCount'> & { _id: string };

/** 错误文案里回显收到的值：空值统一写成「空」，对象给 JSON，别把 undefined 直接拼进句子 */
function shown(value: unknown): string {
  if (value === undefined || value === null || value === '') return '空';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * 目录行入参校验：schema 表达不了的几条（key 形状、名称长度、effect.kind 越界、ad_free 必带 days、notes 条数）都在这里。
 * effect.kind 必须在这道闸门拦下：enum 只写在 schema 里，放行到落库就是 Mongoose ValidationError
 * ——它既不是 AppError 也不是 11000，error-handler 只能回 500，非生产环境还把内部原文回显出去。
 */
export function assertItemInput(input: ItemInput): void {
  if (!ITEM_KEY_RE.test(String(input.key ?? ''))) {
    throw new AppError(400, `道具 key 只能是小写字母开头的 a-z0-9_，长度 2–40（收到「${input.key || '空'}」）`);
  }
  const name = String(input.name ?? '').trim();
  if (!name) throw new AppError(400, '道具名称不能为空');
  if (name.length > 20) throw new AppError(400, `道具名称最多 20 字（当前 ${name.length} 字）`);
  if (!(input.price >= 1)) throw new AppError(400, `兑换价至少 1 分（收到 ${input.price}）`);
  if (!(input.validDays >= 1)) throw new AppError(400, `卡有效期至少 1 天（收到 ${input.validDays}）`);
  // kind 与 effect.kind 同理：enum 只写在 schema 里，放行到落库就是 ValidationError → 500。
  // 省略/ null 走 schema 默认 virtual（只有新建会省略；PUT 由 assertItemContent 先拦住缺字段）。
  const rawKind = (input as { kind?: unknown }).kind;
  if (rawKind !== undefined && rawKind !== null && !ITEM_KINDS.includes(rawKind as ItemKind)) {
    throw new AppError(400, `道具类型只能是 ${ITEM_KINDS.join(' 或 ')}（收到「${shown(rawKind)}」）`);
  }
  const effect = input.effect as { kind?: unknown; days?: unknown } | null | undefined;
  if (!effect || typeof effect !== 'object') {
    throw new AppError(400, `道具效果必须提供 effect 对象，kind 只能是 ${ITEM_EFFECT_KINDS.join(' 或 ')}（收到「${shown(input.effect)}」）`);
  }
  if (!ITEM_EFFECT_KINDS.includes(effect.kind as ItemEffectKind)) {
    throw new AppError(400, `道具效果类型只能是 ${ITEM_EFFECT_KINDS.join(' 或 ')}（收到「${shown(effect.kind)}」）`);
  }
  // effect.days：schema 的 min:0 拦不住 'abc'（Number('abc')=NaN → Mongoose CastError → 500），
  // 所以在这道闸门统一要求「有限数字且 ≥0」。undefined/null 仍允许（makeup 可省略，落库默认 0）。
  const rawDays = effect.days;
  if (rawDays !== undefined && rawDays !== null) {
    const days = Number(rawDays);
    if (!Number.isFinite(days) || days < 0) {
      throw new AppError(400, `道具效果天数 effect.days 必须是 ≥0 的有限数字（收到「${shown(rawDays)}」）`);
    }
  }
  if (effect.kind === 'ad_free' && !(Number(effect.days) >= 1)) {
    throw new AppError(400, `免广告道具必须填天数 effect.days ≥ 1（收到「${shown(effect.days)}」）`);
  }
  // notes：schema 的 [String] 只在 Mongoose 写入时生效，非数组会先在 normalize 的 .map 上 TypeError（500）
  const rawNotes = (input as { notes?: unknown }).notes;
  if (rawNotes !== undefined && rawNotes !== null && !Array.isArray(rawNotes)) {
    throw new AppError(400, `兑换说明 notes 必须是字符串数组，最多 8 条（收到「${shown(rawNotes)}」）`);
  }
  const notes = Array.isArray(rawNotes) ? rawNotes : [];
  if (notes.length > 8) throw new AppError(400, `兑换说明最多 8 条（当前 ${notes.length} 条）`);
  // detailImages：同 notes，非数组会先在 normalize 的 .map 上 TypeError（500）；条数上限 schema 表达不了
  const rawImages = (input as { detailImages?: unknown }).detailImages;
  if (rawImages !== undefined && rawImages !== null && !Array.isArray(rawImages)) {
    throw new AppError(400, `商品详情图必须是字符串数组，最多 ${DETAIL_IMAGE_MAX} 张（收到「${shown(rawImages)}」）`);
  }
  if (Array.isArray(rawImages) && rawImages.length > DETAIL_IMAGE_MAX) {
    throw new AppError(400, `商品详情图最多 ${DETAIL_IMAGE_MAX} 张（当前 ${rawImages.length} 张）`);
  }
  // perUserLimit：0 = 不限；其余只收 1–99 的整数（'abc' → NaN、1.5、100 都要在这道闸门拦下，
  // 否则负数落库是 schema ValidationError → 500，小数/超上限则静默存成没有意义的值）。
  // '' 单独判掉：Number('')===0 会被当成「不限」，后台输入框清空就等于静默放开限购。
  const rawLimit = (input as { perUserLimit?: unknown }).perUserLimit;
  if (rawLimit !== undefined && rawLimit !== null) {
    const limit = rawLimit === '' ? Number.NaN : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 0 || limit > PER_USER_LIMIT_MAX) {
      throw new AppError(400,
        `每人限购只能是 0（不限）或 1–${PER_USER_LIMIT_MAX} 的整数（收到「${shown(rawLimit)}」）`);
    }
  }
}

/**
 * 更新入口的字段闸门（PUT）：十三个内容字段逐个查在不在，null 视同没传，然后叠上通用校验。
 * 为什么逐字段必传而不是「缺了就补默认值/取库里的值」：后台表单是整行提交，缺字段说明这次提交
 * 本身就不完整——猜一个下去就是静默改写（售罄复活成 9999、道具图清空、ad_free 换成补签、
 * 实物限购被默认成 1），而且这些改写还会绕过 PATCH /stock 的目标值语义。缺字段就该 400 点名缺哪个。
 */
export function assertItemContent(input: ItemInput): void {
  const received = input as unknown as Record<string, unknown>;
  for (const field of ITEM_CONTENT_FIELDS) {
    const value = received[field];
    if (value === undefined || value === null) {
      throw new AppError(400, `道具更新缺少字段「${field}」（PUT 覆盖整行内容，十三个字段必传，缺字段不猜默认值；收到「${shown(value)}」）`);
    }
  }
  assertItemInput(input);
}

/** 入参 → 落库文档：trim/Number/Boolean 归一，可选字段取目录默认口径（只有新建走这里，更新用 normalizeContent） */
function normalize(input: ItemInput): Omit<ItemDoc, '_id' | 'createdAt' | 'updatedAt'> {
  const effect = input.effect;
  const kind = (input.kind ?? 'virtual') as ItemKind;
  return {
    key: String(input.key).trim(),
    name: String(input.name).trim(),
    subtitle: String(input.subtitle ?? '').trim(),
    description: String(input.description ?? '').trim(),
    notes: (input.notes ?? []).map((n) => String(n)),
    price: Number(input.price),
    validDays: Number(input.validDays),
    kind,
    effect: { kind: effect.kind, days: Number(effect.days ?? 0) },
    stock: input.stock == null ? 9999 : Number(input.stock),
    unlimited: Boolean(input.unlimited),
    active: input.active === undefined ? true : Boolean(input.active),
    sortOrder: Number(input.sortOrder ?? 0),
    image: String(input.image ?? '').trim(),
    detailImages: (input.detailImages ?? []).map((u) => String(u)),
    // 实物「没表态」→ 每人限购 1；虚拟默认 0（不限）。显式 0 是后台明确选的「不限」，不许被覆盖
    perUserLimit: input.perUserLimit == null
      ? (kind === 'physical' ? 1 : 0)
      : Number(input.perUserLimit),
  };
}

/** PUT 落库的那一份：就是 ITEM_CONTENT_FIELDS 那十三个字段（key/stock/unlimited 一个都不在里面） */
type ItemContentPatch = Pick<ItemDoc, ItemContentField>;

/** 入参 → PUT 的 $set 文档：只做归一，不补默认值（字段齐不齐由 assertItemContent 决定） */
function normalizeContent(input: ItemInput): ItemContentPatch {
  const effect = input.effect;
  return {
    name: String(input.name).trim(),
    subtitle: String(input.subtitle).trim(),
    description: String(input.description).trim(),
    notes: input.notes!.map((n) => String(n)),
    price: Number(input.price),
    validDays: Number(input.validDays),
    effect: { kind: effect.kind, days: Number(effect.days ?? 0) },
    active: Boolean(input.active),
    sortOrder: Number(input.sortOrder),
    image: String(input.image).trim(),
    kind: input.kind!,
    detailImages: input.detailImages!.map((u) => String(u)),
    perUserLimit: Number(input.perUserLimit),
  };
}

function toSavedRow(r: ItemDoc): SavedItemRow {
  const { _id, createdAt: _c, updatedAt: _u, ...rest } = r as ItemDoc & Record<string, unknown>;
  const image = String(rest.image ?? '');
  return {
    ...rest,
    // 老行物理上没有这三个字段：回执按默认口径补齐，调用方不必再判 undefined
    kind: (rest.kind ?? 'virtual') as ItemKind,
    detailImages: (rest.detailImages ?? []) as string[],
    perUserLimit: Number(rest.perUserLimit ?? 0),
    image,
    previewUrl: image ? getSignedUrl(image) : '',
    _id: String(_id),
  } as SavedItemRow;
}

/**
 * 管理端列表：含下架项，按 sortOrder 升序；exchangeCount/grantCount 两次分组计数再拼回。
 * 不用 $lookup：目录行是个位数，两条 group 各自走 itemKey 索引，比 join 好读也好排错。
 */
export async function listItemsForAdmin(): Promise<AdminItemRow[]> {
  const rows = await PointItemModel.find({}).sort({ sortOrder: 1, _id: 1 }).lean();
  const keys = rows.map((r) => r.key);
  const [exchangeAgg, grantAgg] = await Promise.all([
    PointExchangeModel.aggregate<{ _id: string; count: number }>([
      { $match: { itemKey: { $in: keys } } },
      { $group: { _id: '$itemKey', count: { $sum: 1 } } },
    ]),
    // 发放数只算后台/系统来源（兑换走 exchangeCount，两头不重不漏）
    PointCardModel.aggregate<{ _id: string; count: number }>([
      { $match: { itemKey: { $in: keys }, source: { $in: ['admin', 'system'] } } },
      { $group: { _id: '$itemKey', count: { $sum: 1 } } },
    ]),
  ]);
  const exchangeBy = new Map(exchangeAgg.map((g) => [g._id, Number(g.count)]));
  const grantBy = new Map(grantAgg.map((g) => [g._id, Number(g.count)]));
  return rows.map((r) => ({
    id: String(r._id),
    key: r.key,
    name: r.name,
    subtitle: r.subtitle ?? '',
    description: r.description ?? '',
    notes: r.notes ?? [],
    price: r.price,
    validDays: r.validDays,
    effect: { kind: r.effect?.kind ?? 'makeup', days: r.effect?.days ?? 0 },
    // 本批次前入库的老行没有这三个字段：按虚拟/无图/不限的默认口径回给表单，别让编辑表单拿到 undefined
    kind: (r.kind ?? 'virtual') as ItemKind,
    detailImages: r.detailImages ?? [],
    perUserLimit: Number(r.perUserLimit ?? 0),
    stock: r.stock,
    unlimited: r.unlimited,
    active: r.active,
    sortOrder: r.sortOrder,
    image: r.image ?? '',
    // 同上传接口口径：url 入库、previewUrl 只给后台展示
    previewUrl: r.image ? getSignedUrl(r.image) : '',
    exchangeCount: exchangeBy.get(r.key) ?? 0,
    grantCount: grantBy.get(r.key) ?? 0,
  }));
}

/** 新增道具：key 形状/字段校验先跑，唯一索引冲突转 409 并点名 key */
export async function createItem(input: ItemInput): Promise<SavedItemRow> {
  assertItemInput(input);
  const doc = normalize(input);
  try {
    const created = await PointItemModel.create(doc);
    return toSavedRow(created.toObject() as unknown as ItemDoc);
  } catch (e) {
    if ((e as { code?: number } | null)?.code === DUPLICATE_KEY) {
      throw new AppError(409, `道具 key 已存在：${doc.key}`);
    }
    throw e;
  }
}

/**
 * 内容整行更新（PUT）：key 不可改，十个内容字段按入参覆盖，stock / unlimited 一律不写。
 * 库存与不限量是 PATCH /points/items/:id/stock 的独占字段（目标值语义 + 改前改后回执）；
 * 这里带上 stock/unlimited 也只是忽略，绝不落库——否则后台表单一次整行提交就能把售罄道具复活。
 */
export async function updateItem(id: string, input: ItemInput): Promise<SavedItemRow> {
  assertObjectIdLike(id, '道具不存在');
  assertItemContent(input);
  const row = await PointItemModel.findOne({ _id: id }).lean() as ItemDoc | null;
  if (!row) throw new AppError(404, '道具不存在');
  const key = String(input.key).trim();
  // 同 key 回填是后台表单整行原样提交的正常路径，只有真改 key 才拦
  if (key !== row.key) {
    throw new AppError(400, `道具 key 创建后不可修改（原「${row.key}」，收到「${key}」）`);
  }
  const updated = await PointItemModel
    .findOneAndUpdate({ _id: id }, { $set: normalizeContent(input) }, { returnDocument: 'after' })
    .lean() as ItemDoc | null;
  if (!updated) throw new AppError(404, '道具不存在');
  return toSavedRow(updated);
}

/**
 * 库存/不限量改写（PATCH 的唯一出口）：传目标值（不是增量），stock 与 unlimited 至少给一个，
 * 返回两个字段的 {before, after}；负数 400 并点名收到的值。
 * unlimited 道具的库存只是展示位——照改不拦，兑换链路本来就不读它扣减。
 */
export async function setItemStock(id: string, patch: StockPatch): Promise<{ before: StockState; after: StockState }> {
  assertObjectIdLike(id, '道具不存在');
  const received = patch as { stock?: unknown; unlimited?: unknown };
  // null 视同没传：PUT 那侧的「可选即默认值」教训不能在这侧重演
  const hasStock = received.stock !== undefined && received.stock !== null;
  const hasUnlimited = received.unlimited !== undefined && received.unlimited !== null;
  if (!hasStock && !hasUnlimited) {
    throw new AppError(400, '库存改写至少要传 stock 或 unlimited 之一（收到 空）');
  }
  const set: { stock?: number; unlimited?: boolean } = {};
  if (hasStock) {
    const stock = Number(received.stock);
    if (!Number.isInteger(stock)) throw new AppError(400, `库存必须是整数（收到「${shown(received.stock)}」）`);
    if (stock < 0) throw new AppError(400, `库存不能为负（收到 ${stock}）`);
    set.stock = stock;
  }
  if (hasUnlimited) {
    if (typeof received.unlimited !== 'boolean') {
      throw new AppError(400, `unlimited 只能是 true 或 false（收到「${shown(received.unlimited)}」）`);
    }
    set.unlimited = received.unlimited;
  }
  const before = await PointItemModel.findOne({ _id: id }).lean() as ItemDoc | null;
  if (!before) throw new AppError(404, '道具不存在');
  const after = await PointItemModel
    .findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' })
    .lean() as ItemDoc | null;
  if (!after) throw new AppError(404, '道具不存在');
  const state = (doc: ItemDoc): StockState => ({ stock: doc.stock, unlimited: doc.unlimited });
  return { before: state(before), after: state(after) };
}
