/**
 * 管理端道具目录：校验 + CRUD + 库存改写（spec §5.1/§7.2）。
 *
 * 口径：
 * - key 创建后不可改：台账（PointRecord.refId / PointCard.itemKey / PointExchange.itemKey）
 *   全按它关联，改一下等于把历史兑换挂错道具——PUT 撞见改 key 直接 400 并点名原值/新值；
 * - 库存改写传目标值而不是增量：后台看到的是「现在剩多少」，语义含糊一次点两下就翻倍；
 *   返回 {before, after} 让操作方当场核对；
 * - schema 表达不了的校验（key 形状、名称长度、ad_free 必带 days、notes 条数）集中在
 *   assertItemInput；错误文案一律「对象 + 实际值 + 限制」，不给通用失败；
 * - 唯一索引冲突（E11000）转 409 并点名 key，和仓内其它管理端写接口同码同形。
 */
import { AppError } from '../utils/app-error.js';
import { assertObjectIdLike } from '../utils/object-id.js';
import { PointCardModel, PointExchangeModel, PointItemModel } from '../models/point.model.js';
import { getSignedUrl } from './oss.js';
import type { ItemDoc } from './points-catalog.js';

export const ITEM_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const DUPLICATE_KEY = 11000;

/** 目录行入参：路由 request.body 直接 cast 过来，运行时字段一律以未知对待 */
export interface ItemInput {
  key: string;
  name: string;
  subtitle?: string;
  description?: string;
  notes?: string[];
  price: number;
  validDays: number;
  effect: { kind: 'makeup' | 'ad_free'; days: number };
  stock?: number;
  unlimited?: boolean;
  active?: boolean;
  sortOrder?: number;
  image?: string;
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
  effect: { kind: 'makeup' | 'ad_free'; days: number };
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

/** 目录行入参校验：schema 表达不了的几条（key 形状、名称长度、ad_free 必带 days、notes 条数）都在这里 */
export function assertItemInput(input: ItemInput): void {
  if (!ITEM_KEY_RE.test(String(input.key ?? ''))) {
    throw new AppError(400, `道具 key 只能是小写字母开头的 a-z0-9_，长度 2–40（收到「${input.key || '空'}」）`);
  }
  const name = String(input.name ?? '').trim();
  if (!name) throw new AppError(400, '道具名称不能为空');
  if (name.length > 20) throw new AppError(400, `道具名称最多 20 字（当前 ${name.length} 字）`);
  if (!(input.price >= 1)) throw new AppError(400, `兑换价至少 1 分（收到 ${input.price}）`);
  if (!(input.validDays >= 1)) throw new AppError(400, `卡有效期至少 1 天（收到 ${input.validDays}）`);
  if (input.effect?.kind === 'ad_free' && !(input.effect.days >= 1)) {
    throw new AppError(400, '免广告道具必须填天数（effect.days ≥ 1）');
  }
  if ((input.notes?.length ?? 0) > 8) throw new AppError(400, `兑换说明最多 8 条（当前 ${input.notes!.length} 条）`);
}

/** 入参 → 落库文档：trim/Number/Boolean 归一，可选字段取目录默认口径 */
function normalize(input: ItemInput): Omit<ItemDoc, '_id' | 'createdAt' | 'updatedAt'> {
  const effect = input.effect ?? { kind: 'makeup' as const, days: 0 };
  return {
    key: String(input.key).trim(),
    name: String(input.name).trim(),
    subtitle: String(input.subtitle ?? '').trim(),
    description: String(input.description ?? '').trim(),
    notes: (input.notes ?? []).map((n) => String(n)),
    price: Number(input.price),
    validDays: Number(input.validDays),
    effect: { kind: effect.kind, days: Number(effect.days ?? 0) },
    stock: input.stock == null ? 9999 : Number(input.stock),
    unlimited: Boolean(input.unlimited),
    active: input.active === undefined ? true : Boolean(input.active),
    sortOrder: Number(input.sortOrder ?? 0),
    image: String(input.image ?? '').trim(),
  };
}

function toSavedRow(r: ItemDoc): SavedItemRow {
  const { _id, createdAt: _c, updatedAt: _u, ...rest } = r as ItemDoc & Record<string, unknown>;
  const image = String(rest.image ?? '');
  return { ...rest, image, previewUrl: image ? getSignedUrl(image) : '', _id: String(_id) } as SavedItemRow;
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

/** 整行更新（PUT）：key 不可改；其余字段按入参覆盖 */
export async function updateItem(id: string, input: ItemInput): Promise<SavedItemRow> {
  assertObjectIdLike(id, '道具不存在');
  assertItemInput(input);
  const row = await PointItemModel.findOne({ _id: id }).lean() as ItemDoc | null;
  if (!row) throw new AppError(404, '道具不存在');
  const doc = normalize(input);
  // 同 key 回填是后台表单整行原样提交的正常路径，只有真改 key 才拦
  if (doc.key !== row.key) {
    throw new AppError(400, `道具 key 创建后不可修改（原「${row.key}」，收到「${doc.key}」）`);
  }
  const updated = await PointItemModel
    .findOneAndUpdate({ _id: id }, { $set: doc }, { returnDocument: 'after' })
    .lean() as ItemDoc | null;
  if (!updated) throw new AppError(404, '道具不存在');
  return toSavedRow(updated);
}

/**
 * 库存改写：传目标值（不是增量），返回 {before, after}；负数 400 并点名收到的值。
 * unlimited 道具的库存只是展示位——照改不拦，兑换链路本来就不读它扣减。
 */
export async function setItemStock(id: string, stock: number): Promise<{ before: number; after: number }> {
  assertObjectIdLike(id, '道具不存在');
  if (!Number.isInteger(Number(stock))) {
    throw new AppError(400, `库存必须是整数（收到 ${stock}）`);
  }
  if (stock < 0) throw new AppError(400, `库存不能为负（收到 ${stock}）`);
  const before = await PointItemModel.findOne({ _id: id }).lean() as ItemDoc | null;
  if (!before) throw new AppError(404, '道具不存在');
  const after = await PointItemModel
    .findOneAndUpdate({ _id: id }, { $set: { stock } }, { returnDocument: 'after' })
    .lean() as ItemDoc | null;
  if (!after) throw new AppError(404, '道具不存在');
  return { before: before.stock, after: after.stock };
}
