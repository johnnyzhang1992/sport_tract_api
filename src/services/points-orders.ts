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
import type { ItemDoc } from './points-catalog.js';
import { AppError } from '../utils/app-error.js';
import { assertObjectIdLike, type ObjectIdLike } from '../utils/object-id.js';

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
