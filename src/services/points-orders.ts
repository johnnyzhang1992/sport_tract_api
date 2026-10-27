/**
 * 实物订单：地址校验、限购判据、我的订单与确认收货。
 *
 * 口径（spec §7.4 / 2026-10-27 设计）：
 * - 订单三态 pending_ship → shipped → completed，无取消/退分；
 * - 地址与商品名/价格都是下单快照（写在 PointOrder 行上），后台改目录不追认；
 * - `perUserLimit` 对两类道具都生效：实物数该用户的订单数，虚拟数该用户的持卡数；
 *   0 = 不限（种子虚拟道具全是 0，行为与加限购字段前一致）；
 * - 兑换本身（扣分/库存/回滚）在 points-items.exchangeItem，这里只提供可复用的判据与查询。
 */
import { PointCardModel, PointOrderModel, ORDER_STATUS, type OrderStatus } from '../models/point.model.js';
import { UserModel } from '../models/user.model.js';
import type { ItemDoc } from './points-catalog.js';
import { AppError } from '../utils/app-error.js';
import { assertObjectIdLike, type ObjectIdLike } from '../utils/object-id.js';
import { userKeywordFilter } from '../utils/user-keyword.js';

export { ORDER_STATUS };
export type { OrderStatus };

export const ORDER_STATUS_TEXT: Record<OrderStatus, string> = {
  pending_ship: '待发货',
  shipped: '已发货',
  completed: '已完成',
};

export interface OrderAddress {
  receiver: string;
  phone: string;
  detail: string;
}

export interface OrderDto {
  id: string;
  itemKey: string;
  itemName: string;
  cost: number;
  address: OrderAddress;
  status: OrderStatus;
  statusText: string;
  trackingNo: string;
  trackingCompany: string;
  shippedAt: number;
  completedAt: number;
  createdAt: number;
}

/** 入参里回显收到的值：空值写「空」，别把 undefined/对象直接拼进句子（同 points-items/points-grant） */
function shown(value: unknown): string {
  if (value === undefined || value === null || value === '') return '空';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * 收货地址校验（兑换前，先于库存闸门与扣分）：
 * receiver 1–20 字（trim 后非空）、phone 大陆 11 位、detail 5–120 字。
 * 错误文案点名字段（address/receiver/phone/detail）并带上收到的值。
 */
export function validateAddress(input: unknown): OrderAddress {
  if (input === undefined || input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, `缺少收货地址(address)（收到 ${shown(input)}）`);
  }
  const raw = input as Record<string, unknown>;
  const receiver = typeof raw.receiver === 'string' ? raw.receiver.trim() : '';
  if (receiver.length < 1 || receiver.length > 20) {
    throw new AppError(400,
      `收货人姓名(receiver) 长度需为 1–20 字（收到「${shown(raw.receiver)}」，共 ${receiver.length} 字）`);
  }
  const phone = typeof raw.phone === 'string' ? raw.phone.trim() : '';
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    throw new AppError(400, `手机号(phone) 格式不正确（收到「${shown(raw.phone)}」，应为 11 位大陆手机号）`);
  }
  const detail = typeof raw.detail === 'string' ? raw.detail.trim() : '';
  if (detail.length < 5 || detail.length > 120) {
    throw new AppError(400,
      `详细地址(detail) 长度需为 5–120 字（收到「${shown(raw.detail)}」，共 ${detail.length} 字）`);
  }
  return { receiver, phone, detail };
}

/** 该用户已兑数量：实物数订单（本设计无取消，全部订单都算），虚拟数持卡（未过期与已使用都在卡表里） */
async function redeemedCount(userId: string, item: Pick<ItemDoc, 'key' | 'kind'>): Promise<number> {
  if (item.kind === 'physical') {
    return PointOrderModel.countDocuments({ userId, itemKey: item.key });
  }
  return PointCardModel.countDocuments({ userId, itemKey: item.key });
}

/**
 * 是否已达到每人限购。0 = 不限（永远 false）。
 * `now` 预留给「虚拟只数未过期卡」的口径；现行口径是数全部持卡行（status used 也占名额）。
 */
export async function limitReached(
  userId: string,
  item: Pick<ItemDoc, 'key' | 'kind' | 'perUserLimit'>,
  now = Date.now(),
): Promise<boolean> {
  void now;
  const limit = Number(item.perUserLimit ?? 0);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  return (await redeemedCount(userId, item)) >= limit;
}

/** 限购错误文案（兑换路径与测试共用一处，别两边各写一句） */
export async function limitError(
  userId: string,
  item: Pick<ItemDoc, 'key' | 'kind' | 'name' | 'perUserLimit'>,
): Promise<AppError> {
  const used = await redeemedCount(userId, item);
  return new AppError(400, `「${item.name}」每人限兑 ${item.perUserLimit} 件（已兑 ${used} 件）`);
}

interface OrderRow {
  _id: unknown;
  userId: unknown;
  itemKey: string;
  itemName: string;
  cost: number;
  address: OrderAddress;
  status: string;
  trackingNo?: string | null;
  trackingCompany?: string | null;
  shippedAt?: number | null;
  completedAt?: number | null;
  createdAt: number;
}

function toOrderDto(row: OrderRow): OrderDto {
  const status = row.status as OrderStatus;
  return {
    id: String(row._id),
    itemKey: row.itemKey,
    itemName: row.itemName,
    cost: row.cost,
    address: {
      receiver: row.address.receiver,
      phone: row.address.phone,
      detail: row.address.detail,
    },
    status,
    statusText: ORDER_STATUS_TEXT[status] ?? row.status,
    trackingNo: row.trackingNo ?? '',
    trackingCompany: row.trackingCompany ?? '',
    shippedAt: row.shippedAt ?? 0,
    completedAt: row.completedAt ?? 0,
    createdAt: row.createdAt,
  };
}

/** 我的实物订单：只含本人，按 createdAt 倒序（同刻用 _id 兜底） */
export async function listMyOrders(userId: string): Promise<OrderDto[]> {
  const rows = await PointOrderModel.find({ userId })
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  return rows.map((r) => toOrderDto(r));
}

/**
 * 确认收货：只有 shipped 能 → completed。
 * - 他人的/不存在的订单一律 404 `订单不存在`（不泄露存在性）；
 * - 状态不对 400 并点名当前状态（pending_ship 不能跳过发货）。
 * 用带 status:'shipped' 条件的原子更新，连点只会成功一次。
 */
export async function confirmReceipt(
  userId: string,
  orderId: ObjectIdLike,
  now = Date.now(),
): Promise<OrderDto> {
  assertObjectIdLike(orderId, '订单不存在');
  const updated = await PointOrderModel.findOneAndUpdate(
    { _id: orderId, userId, status: 'shipped' },
    { $set: { status: 'completed', completedAt: now, updatedAt: now } },
    { returnDocument: 'after' },
  ).lean();
  if (updated) return toOrderDto(updated);

  const order = await PointOrderModel.findOne({ _id: orderId, userId }).lean();
  if (!order) throw new AppError(404, '订单不存在');
  const text = ORDER_STATUS_TEXT[order.status as OrderStatus] ?? order.status;
  throw new AppError(400, `当前订单状态为「${text}」，只有已发货订单可确认收货`);
}

// ==================== 管理端订单（列表 / 发货 / 代确认） ====================

/** 管理端单页上限：与用户/发放记录列表同一口径 */
const ADMIN_ORDER_PAGE_CAP = 100;

/** 管理端订单行：手机号只下发打码值，完整号码不出列表接口（AO-1 钉这条） */
export interface AdminOrderRow {
  id: string;
  userId: string;
  uid: number;
  nickname: string;
  itemKey: string;
  itemName: string;
  cost: number;
  receiver: string;
  phoneMasked: string;
  detail: string;
  status: OrderStatus;
  statusText: string;
  trackingNo: string;
  trackingCompany: string;
  createdAt: number;
  shippedAt: number;
  completedAt: number;
}

/** 列表查询：status / keyword（持单人昵称或 UID）/ page / pageSize 都可选 */
export interface OrderListQuery {
  status?: unknown;
  keyword?: unknown;
  page?: unknown;
  pageSize?: unknown;
}

/** 发货入参：快递公司 + 单号（单号必填，空白 400 点名字段） */
export interface ShipOrderInput {
  trackingCompany?: unknown;
  trackingNo?: unknown;
}

/**
 * 手机号打码：前 3 + `****` + 后 4（13800138000 → 138****8000）。
 * 长度不足 8 的脏值整串替换成 `****`——打码函数宁可丢信息，也绝不把原号透出去。
 */
export function maskPhone(phone: unknown): string {
  const raw = String(phone ?? '').trim();
  if (raw.length < 8) return '****';
  return `${raw.slice(0, 3)}****${raw.slice(-4)}`;
}

interface AdminUserLite {
  _id: unknown;
  uid?: number | string | null;
  nickname?: string | null;
}

function toAdminOrderRow(row: OrderRow, user?: AdminUserLite): AdminOrderRow {
  const status = row.status as OrderStatus;
  return {
    id: String(row._id),
    userId: String(row.userId),
    // 存量 uid 混着 int/string 两种 BSON 类型（同发放记录口径）：一律 Number 归一，缺号给 0
    uid: Number(user?.uid ?? 0),
    nickname: String(user?.nickname ?? ''),
    itemKey: row.itemKey,
    itemName: row.itemName,
    cost: row.cost,
    receiver: row.address.receiver,
    phoneMasked: maskPhone(row.address.phone),
    detail: row.address.detail,
    status,
    statusText: ORDER_STATUS_TEXT[status] ?? row.status,
    trackingNo: row.trackingNo ?? '',
    trackingCompany: row.trackingCompany ?? '',
    createdAt: row.createdAt,
    shippedAt: row.shippedAt ?? 0,
    completedAt: row.completedAt ?? 0,
  };
}

/** 按订单上的 userId 批量取 user 行（列表一页一次、单条操作一次） */
async function usersOf(ids: unknown[]): Promise<Map<string, AdminUserLite>> {
  const unique = [...new Set(ids.map(String))];
  if (unique.length === 0) return new Map();
  const users = await UserModel.find({ _id: { $in: unique } })
    .select({ _id: 1, uid: 1, nickname: 1 })
    .lean();
  return new Map(users.map((u) => [String(u._id), u as AdminUserLite]));
}

/**
 * 管理端订单列表（GET /points/orders）：按状态/持单人筛选，newest first，分页上限 100。
 * - keyword 复用 userKeywordFilter（昵称子串 + 精确 UID），先查人再按 userId 预筛：
 *   在 DB 侧分页之前收口，total 与翻页才按同一条件走（同发放记录 GR-9 口径）；
 * - 排序在 DB 侧做，skip/limit 之后不再重排——全局顺序由 createdAt 决定，不是每页各排各的（AO-5）；
 * - 手机号只在行上以 phoneMasked 出现，完整号码绝不下发。
 */
export async function listOrders(q: OrderListQuery = {}): Promise<{
  total: number; page: number; pageSize: number; items: AdminOrderRow[];
}> {
  const rawStatus = String(q.status ?? '').trim();
  if (rawStatus && !(ORDER_STATUS as readonly string[]).includes(rawStatus)) {
    throw new AppError(400,
      `筛选状态只能是 ${ORDER_STATUS.join(' / ')}（收到「${shown(q.status)}」）`);
  }
  const p = Math.max(1, Math.trunc(Number(q.page) || 1));
  const ps = Math.min(ADMIN_ORDER_PAGE_CAP, Math.max(1, Math.trunc(Number(q.pageSize) || 20)));

  const filter: Record<string, unknown> = {};
  if (rawStatus) filter.status = rawStatus;
  const keywordFilter = userKeywordFilter(q.keyword);
  if (keywordFilter) {
    // 一个人都没命中时 $in: [] 让结果为空（不能把条件省掉）
    const matched = await UserModel.find(keywordFilter).select({ _id: 1 }).lean();
    filter.userId = { $in: matched.map((u) => u._id) };
  }

  const [total, rows] = await Promise.all([
    PointOrderModel.countDocuments(filter),
    PointOrderModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((p - 1) * ps)
      .limit(ps)
      .lean(),
  ]);
  const userMap = await usersOf(rows.map((r) => r.userId));
  const items = rows.map((r) => toAdminOrderRow(r, userMap.get(String(r.userId))));
  return { total, page: p, pageSize: ps, items };
}

/**
 * 发货（PATCH /points/orders/:id/ship）：只允许 pending_ship → shipped。
 * 用带 status 条件的原子更新：连点只会成功一次，第二次一定落到「当前状态」的 400 上。
 * 单号先于状态校验：空白单号是入参错误，不该因为订单已成已发货就换个说法。
 */
export async function shipOrder(
  orderId: ObjectIdLike,
  input: ShipOrderInput,
  adminId: string,
  now = Date.now(),
): Promise<AdminOrderRow> {
  assertObjectIdLike(orderId, '订单不存在');
  const trackingNo = String(input?.trackingNo ?? '').trim();
  if (!trackingNo) {
    throw new AppError(400, `快递单号(trackingNo) 不能为空（收到「${shown(input?.trackingNo)}」）`);
  }
  const trackingCompany = String(input?.trackingCompany ?? '').trim();

  const updated = await PointOrderModel.findOneAndUpdate(
    { _id: orderId, status: 'pending_ship' },
    {
      $set: {
        status: 'shipped',
        trackingNo,
        trackingCompany,
        shippedAt: now,
        shippedBy: String(adminId ?? ''),
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  ).lean();
  if (!updated) {
    const order = await PointOrderModel.findById(orderId).lean();
    if (!order) throw new AppError(404, '订单不存在');
    const text = ORDER_STATUS_TEXT[order.status as OrderStatus] ?? order.status;
    throw new AppError(400, `当前订单状态为「${text}」，只有待发货订单可发货`);
  }
  const userMap = await usersOf([updated.userId]);
  return toAdminOrderRow(updated, userMap.get(String(updated.userId)));
}

/**
 * 代确认收货（PATCH /points/orders/:id/complete）：只允许 shipped → completed。
 * adminId 只为与 shipOrder 的调用口径对齐（订单表没有 completedBy 字段，设计只记 completedAt）。
 */
export async function completeOrder(
  orderId: ObjectIdLike,
  adminId: string,
  now = Date.now(),
): Promise<AdminOrderRow> {
  void adminId;
  assertObjectIdLike(orderId, '订单不存在');
  const updated = await PointOrderModel.findOneAndUpdate(
    { _id: orderId, status: 'shipped' },
    { $set: { status: 'completed', completedAt: now, updatedAt: now } },
    { returnDocument: 'after' },
  ).lean();
  if (!updated) {
    const order = await PointOrderModel.findById(orderId).lean();
    if (!order) throw new AppError(404, '订单不存在');
    const text = ORDER_STATUS_TEXT[order.status as OrderStatus] ?? order.status;
    throw new AppError(400, `当前订单状态为「${text}」，只有已发货订单可代确认收货`);
  }
  const userMap = await usersOf([updated.userId]);
  return toAdminOrderRow(updated, userMap.get(String(updated.userId)));
}
