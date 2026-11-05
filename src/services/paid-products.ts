/**
 * 现金商品目录的读写与校验（spec §5.1）。
 * 校验全在这里做、路由只解包——沿用 points-catalog-admin 的分工，别让 400 落到 error-handler 的 500 分支。
 */
import { Types } from 'mongoose';
import { PaidProductModel, PAID_PRODUCT_PERK_KEYS, type PaidProduct, type PaidProductPerks } from '../models/paid-product.model.js';
import { AppError } from '../utils/app-error.js';
import { assertObjectIdLike } from '../utils/object-id.js';

const KEY_RE = /^[a-z0-9_]{3,32}$/;

export interface PaidProductDto {
  id: string;
  key: string;
  name: string;
  subtitle: string;
  priceFen: number;
  /** 分→元的展示串（给后台表单提示「MP 道具价要填这个数」），不是第二真相 */
  priceYuanText: string;
  durationDays: number;
  perks: PaidProductPerks;
  active: boolean;
  sortOrder: number;
  notes: string[];
  createdAt: number;
  updatedAt: number;
}

/** 空目录行/缺 perks 的统一兜底：缺字段＝不给这项权益，绝不给个默认额度 */
export function paidProductPerksOf(p: { perks?: Partial<PaidProductPerks> } | undefined | null): PaidProductPerks {
  return {
    adFree: p?.perks?.adFree === true,
    exportBundle: p?.perks?.exportBundle === true,
    photoQuota: Number(p?.perks?.photoQuota ?? 0) || 0,
    subscribeNotice: p?.perks?.subscribeNotice === true,
  };
}

/**
 * 入参校验。partial=true（PUT）时**只接受内容字段**：active/sortOrder 有独立入口，
 * 沿用积分道具那轮的裁定——PUT 顺手改上下架会让「下架」这个动作有两个语义不同的入口。
 */
export function assertPaidProductInput(
  input: Record<string, unknown>,
  { partial }: { partial: boolean },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.key !== undefined || !partial) {
    const key = String(input.key ?? '').trim();
    if (!KEY_RE.test(key)) {
      throw new AppError(400, `道具 ID 不合法（需 3–32 位小写字母/数字/下划线，且与 MP 后台道具 productId 完全一致；收到："${key}"）`);
    }
    out.key = key;
  }
  if (input.name !== undefined || !partial) {
    const name = String(input.name ?? '').trim();
    if (!name) throw new AppError(400, '名称不能为空');
    if (name.length > 20) throw new AppError(400, `名称不能超过 20 字（当前 ${name.length} 字）`);
    out.name = name;
  }
  if (input.subtitle !== undefined) {
    const subtitle = String(input.subtitle ?? '').trim();
    if (subtitle.length > 30) throw new AppError(400, `副标题不能超过 30 字（当前 ${subtitle.length} 字）`);
    out.subtitle = subtitle;
  }
  if (input.priceFen !== undefined || !partial) {
    const n = input.priceFen;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      throw new AppError(400, `价格必须是正整数分（收到 ${JSON.stringify(n)}；1.99 元应填 199）`);
    }
    if (n > 1000000) throw new AppError(400, `价格超过单笔上限（当前 ${n} 分＝${(n / 100).toFixed(2)} 元，上限 10000 元）`);
    out.priceFen = n;
  }
  if (input.durationDays !== undefined || !partial) {
    const n = input.durationDays;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      throw new AppError(400, `会员天数必须是正整数（收到 ${JSON.stringify(n)}）`);
    }
    if (n > 3660) throw new AppError(400, `会员天数超过上限（当前 ${n} 天，上限 3660 天＝10 年）`);
    out.durationDays = n;
  }
  if (input.perks !== undefined) {
    const raw = input.perks as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(400, '权益必须是一个对象');
    for (const k of Object.keys(raw)) {
      if (!(PAID_PRODUCT_PERK_KEYS as readonly string[]).includes(k)) {
        throw new AppError(400, `未知权益键 "${k}"（可用：${PAID_PRODUCT_PERK_KEYS.join('、')}）`);
      }
    }
    const quota = raw.photoQuota;
    if (quota !== undefined && (typeof quota !== 'number' || !Number.isInteger(quota) || quota < 0 || quota > 10000)) {
      throw new AppError(400, `照片额度必须是 0–10000 的整数（收到 ${JSON.stringify(quota)}；0＝不给加成）`);
    }
    out.perks = {
      adFree: raw.adFree === true,
      exportBundle: raw.exportBundle === true,
      photoQuota: typeof quota === 'number' ? quota : 0,
      subscribeNotice: raw.subscribeNotice === true,
    };
  }
  if (partial) {
    if (input.active !== undefined) throw new AppError(400, '上架/下架请用 PATCH /active 入口（PUT 只改内容）');
    if (input.sortOrder !== undefined) throw new AppError(400, '排序请用 PATCH /sort-order 入口（PUT 只改内容）');
    if (input.key !== undefined) throw new AppError(400, '道具 ID 创建后不可改（它就是 MP 后台的 productId，改了历史单会指向不存在的道具）');
  } else {
    if (input.active !== undefined) out.active = Boolean(input.active);
    if (input.sortOrder !== undefined) out.sortOrder = Number.isInteger(input.sortOrder) ? Number(input.sortOrder) : (() => { throw new AppError(400, '排序必须是整数'); })();
  }
  if (input.notes !== undefined) {
    const notes = Array.isArray(input.notes) ? input.notes.map((s) => String(s)) : [];
    if (notes.length > 10) throw new AppError(400, `备注条数超过上限（当前 ${notes.length} 条，上限 10 条）`);
    out.notes = notes;
  }
  return out;
}

function toDto(r: Record<string, unknown> & { _id: Types.ObjectId }): PaidProductDto {
  return {
    id: String(r._id),
    key: String(r.key ?? ''),
    name: String(r.name ?? ''),
    subtitle: String(r.subtitle ?? ''),
    priceFen: Number(r.priceFen ?? 0),
    priceYuanText: (Number(r.priceFen ?? 0) / 100).toFixed(2),
    durationDays: Number(r.durationDays ?? 0),
    perks: paidProductPerksOf(r as { perks?: Partial<PaidProductPerks> }),
    active: r.active !== false,
    sortOrder: Number(r.sortOrder ?? 0),
    notes: Array.isArray(r.notes) ? (r.notes as string[]) : [],
    createdAt: r.createdAt ? new Date(r.createdAt as never).getTime() : 0,
    updatedAt: r.updatedAt ? new Date(r.updatedAt as never).getTime() : 0,
  };
}

export async function listPaidProductsForAdmin(): Promise<PaidProductDto[]> {
  const rows = await PaidProductModel.find({}).sort({ sortOrder: 1, createdAt: -1 }).lean();
  return rows.map((r) => toDto(r as never));
}

/** 用户侧只看在售档位（Task 7 会员页） */
export async function activePaidProducts(): Promise<PaidProductDto[]> {
  const rows = await PaidProductModel.find({ active: true }).sort({ sortOrder: 1, priceFen: 1 }).lean();
  return rows.map((r) => toDto(r as never));
}

/** 按 MP 后台道具 id 取目录行（下单/发货/退款都要回看档位）；行不存在＝null，调用方自己决定文案 */
export async function paidProductOf(key: string): Promise<PaidProduct | null> {
  const row = await PaidProductModel.findOne({ key }).lean();
  return (row ?? null) as PaidProduct | null;
}

export async function createPaidProduct(input: Record<string, unknown>): Promise<PaidProductDto> {
  const data = assertPaidProductInput(input, { partial: false });
  const key = String(data.key);
  if (await PaidProductModel.exists({ key })) throw new AppError(409, `道具 ID "${key}" 已存在（一个 MP 道具只能有一条目录）`);
  const doc = await PaidProductModel.create(data);
  return toDto(doc.toObject() as never);
}

/** PUT：只改内容（key/active/sortOrder 被 assertPaidProductInput 的 partial 分支拒掉） */
export async function updatePaidProduct(id: string, input: Record<string, unknown>): Promise<PaidProductDto> {
  assertObjectIdLike(id, '商品不存在');
  const data = assertPaidProductInput(input, { partial: true });
  if (Object.keys(data).length === 0) throw new AppError(400, '没有需要更新的内容');
  const doc = await PaidProductModel.findOneAndUpdate({ _id: id }, { $set: data }, { returnDocument: 'after' }).lean();
  if (!doc) throw new AppError(404, '商品不存在');
  return toDto(doc as never);
}

export async function setPaidProductActive(id: string, active: boolean): Promise<PaidProductDto> {
  assertObjectIdLike(id, '商品不存在');
  const doc = await PaidProductModel.findOneAndUpdate({ _id: id }, { $set: { active: Boolean(active) } }, { returnDocument: 'after' }).lean();
  if (!doc) throw new AppError(404, '商品不存在');
  return toDto(doc as never);
}

/**
 * 排序的独立入口（2026-11-03 修复轮裁定）。
 * 为什么要真做而不是只留一句提示：assertPaidProductInput 的 partial 分支会拿「请用 PATCH /sort-order」
 * 拒掉携带 sortOrder 的 PUT——入口不存在时，这句提示就是把运营指向一个 404，而 Task 13 的后台目录页
 * 确实要能改排序。与 active 同一条纪律：只碰 sortOrder 这一列，内容改动一律走 PUT。
 */
export async function setPaidProductSortOrder(id: string, sortOrder: unknown): Promise<PaidProductDto> {
  assertObjectIdLike(id, '商品不存在');
  if (typeof sortOrder !== 'number' || !Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 9999) {
    throw new AppError(400, `排序必须是不大于 9999 的非负整数（收到 ${JSON.stringify(sortOrder)}）`);
  }
  const doc = await PaidProductModel.findOneAndUpdate({ _id: id }, { $set: { sortOrder } }, { returnDocument: 'after' }).lean();
  if (!doc) throw new AppError(404, '商品不存在');
  return toDto(doc as never);
}

/**
 * 种子档位（spec §4，MP 后台 2026-11-03 已发布）。
 * $setOnInsert：后台改过的价/文案不会被重跑冲掉——这条与 seedPointItems 同一教训。
 * 三条都高于 iOS 1 元地板价；photoQuota 200 是 D1 默认值（2026-11-05 从 300 下调），用户改目录即改额度，不改代码。
 */
const SEED = [
  {
    key: 'month_card', name: '会员月卡', subtitle: '30 天', priceFen: 199, durationDays: 30, sortOrder: 1,
    perks: { adFree: true, exportBundle: true, photoQuota: 200, subscribeNotice: true },
    notes: ['MP 后台道具价 1.99 元', '改价要同步 MP 后台（spec §2.4）'],
  },
  {
    key: 'season_card', name: '会员季卡', subtitle: '90 天', priceFen: 499, durationDays: 90, sortOrder: 2,
    perks: { adFree: true, exportBundle: true, photoQuota: 200, subscribeNotice: true },
    notes: ['MP 后台道具价 4.99 元', '改价要同步 MP 后台（spec §2.4）'],
  },
  {
    key: 'year_card', name: '会员年卡', subtitle: '365 天', priceFen: 1699, durationDays: 365, sortOrder: 3,
    perks: { adFree: true, exportBundle: true, photoQuota: 200, subscribeNotice: true },
    notes: ['MP 后台道具价 16.99 元', '改价要同步 MP 后台（spec §2.4）'],
  },
];

export async function seedPaidProducts(): Promise<number> {
  const r = await PaidProductModel.bulkWrite(
    SEED.map((s) => ({ updateOne: { filter: { key: s.key }, update: { $setOnInsert: s }, upsert: true } })),
    { ordered: false },
  );
  return r.upsertedCount ?? 0;
}
