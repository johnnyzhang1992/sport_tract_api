/**
 * 管理端订单读与退款发起（spec §6.3、§7.5）。
 * 三步退款在这里落进两个函数：refundPreview（刷 leftFee）→ startRefund（校验 + 发退款 + 置 refunding）
 * → 由 services/xpay-deliver.ts 的 applyRefund 收尾（推送或轮询）。
 * 任何一步都不许「拿旧值猜」：leftFee 过期就用不了，预览会显式给出 canRefund=false。
 */
import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { XpayOrderModel, XPAY_ORDER_STATUS, XPAY_CHANNELS } from '../models/xpay-order.model.js';
import { AppError } from '../utils/app-error.js';
import { assertObjectIdLike } from '../utils/object-id.js';
import { escapeRegex } from '../utils/regex.js';
import { bjDateStr, BJ_OFFSET_MS } from '../utils/bj-time.js';
import { xpayQueryOrder, xpayRefundOrder, XPAY_REFUND_REASONS } from './xpay-api.js';
import { xpayConfig } from '../config/xpay.js';
import { suggestRefundFeeFen, deliverOrder, applyRefund, feeDeductionFen } from './xpay-deliver.js';

const DAY_MS = 86_400_000;
/** 微信退款窗口＝支付后 365 天（spec §2.3） */
export const XPAY_REFUND_WINDOW_MS = 365 * DAY_MS;
/** leftFee 的「新鲜度」上限：超过 5 分钟就要求重新预览，避免运营对着旧值提交 */
export const LEFT_FEE_FRESH_MS = 5 * 60_000;

/** 东八区「YYYY-MM-DD HH:mm」：运营看 leftFee 取数时刻用（api 侧 bj-time 没有现成的分钟级格式化） */
function bjDateTimeText(ms: number): string {
  return new Date(ms + BJ_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

export interface XpayOrderListQuery {
  status?: string;
  channel?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

/** 管理端自己的 DTO：字段语义与用户侧 MemberOrderDto 不同（一个看账，一个看档位），不复用 */
export interface XpayOrderAdminDto {
  id: string;
  outTradeNo: string;
  wxOrderId: string;
  userId: string;
  openid: string;
  productKey: string;
  name: string;
  priceFen: number;
  durationDays: number;
  status: string;
  channel: string;
  periodStart: number;
  periodEnd: number;
  truncatedAt: number;
  refundedFen: number;
  refundCount: number;
  refundOrderId: string;
  refundReason: string;
  leftFeeFen: number;
  leftFeeAt: number;
  /** 对账净收入＝已收 − 已退（spec §7.5） */
  netFen: number;
  lastError: string;
  createdAt: number;
  paidAtText: string;
  periodEndText: string;
}

function normalizePage(q: XpayOrderListQuery) {
  const page = Math.max(1, Math.floor(Number(q.page ?? 1)) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(q.pageSize ?? 20)) || 20));
  return { page, pageSize };
}

function toDto(r: Record<string, unknown> & { _id: Types.ObjectId }): XpayOrderAdminDto {
  const priceFen = Number(r.priceFen ?? 0);
  const refundedFen = Number(r.refundedFen ?? 0);
  return {
    id: String(r._id),
    outTradeNo: String(r.outTradeNo ?? ''),
    wxOrderId: String(r.wxOrderId ?? ''),
    userId: String(r.userId ?? ''),
    openid: String(r.openid ?? ''),
    productKey: String(r.productKey ?? ''),
    name: String(r.name ?? ''),
    priceFen,
    durationDays: Number(r.durationDays ?? 0),
    status: String(r.status ?? ''),
    channel: String(r.channel ?? ''),
    periodStart: Number(r.periodStart ?? 0),
    periodEnd: Number(r.periodEnd ?? 0),
    truncatedAt: Number(r.truncatedAt ?? 0),
    refundedFen,
    refundCount: Number(r.refundCount ?? 0),
    refundOrderId: String(r.refundOrderId ?? ''),
    refundReason: String(r.refundReason ?? ''),
    leftFeeFen: Number(r.leftFeeFen ?? 0),
    leftFeeAt: Number(r.leftFeeAt ?? 0),
    netFen: priceFen - refundedFen,
    lastError: String(r.lastError ?? ''),
    createdAt: r.createdAt ? new Date(r.createdAt as never).getTime() : 0,
    paidAtText: Number(r.periodStart) > 0 ? bjDateStr(Number(r.periodStart)) : '',
    periodEndText: Number(r.periodEnd) > 0 ? bjDateStr(Number(r.periodEnd)) : '',
  };
}

export async function listXpayOrders(q: XpayOrderListQuery = {}) {
  const { page, pageSize } = normalizePage(q);
  const filter: Record<string, unknown> = {};
  if (q.status !== undefined && String(q.status) !== '') {
    // 支持逗号分隔多状态（如 delivered,refunding）；每个值都单独校验，坏值整句 400
    const parts = String(q.status).split(',').map((s) => s.trim()).filter(Boolean);
    for (const s of parts) {
      if (!(XPAY_ORDER_STATUS as readonly string[]).includes(s)) {
        throw new AppError(400, `订单状态不合法（收到 "${s}"；可用：${XPAY_ORDER_STATUS.join('、')}）`);
      }
    }
    filter.status = parts.length === 1 ? parts[0] : { $in: parts };
  }
  if (q.channel !== undefined && String(q.channel) !== '') {
    if (!(XPAY_CHANNELS as readonly string[]).includes(String(q.channel))) {
      throw new AppError(400, `渠道不合法（收到 "${String(q.channel)}"；可用：${XPAY_CHANNELS.join('、')}）`);
    }
    filter.channel = q.channel;
  }
  const kw = String(q.keyword ?? '').trim();
  if (kw) {
    // 只匹配自己的四个可搜字段，且先转义：keyword 是从未信任的输入直接进 $regex 的老口子
    const re = new RegExp(escapeRegex(kw), 'i');
    filter.$or = [{ outTradeNo: re }, { wxOrderId: re }, { openid: re }, { productKey: re }];
  }
  const [rows, total] = await Promise.all([
    XpayOrderModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    XpayOrderModel.countDocuments(filter),
  ]);
  return { total, page, pageSize, items: rows.map((r) => toDto(r as never)) };
}

export async function getXpayOrderDetail(id: string): Promise<XpayOrderAdminDto> {
  assertObjectIdLike(id, '订单不存在');
  const row = await XpayOrderModel.findById(id).lean();
  if (!row) throw new AppError(404, '订单不存在');
  return toDto(row as never);
}

/** 第一步：打开弹窗即调 query_order 刷新 leftFee；失败就禁用提交（不许用库里旧值猜） */
export async function refundPreview(id: string) {
  assertObjectIdLike(id, '订单不存在');
  const row = await XpayOrderModel.findById(id).lean();
  if (!row) throw new AppError(404, '订单不存在');
  const base = {
    priceFen: row.priceFen,
    refundedFen: row.refundedFen ?? 0,
    periodEndText: row.periodEnd > 0 ? bjDateStr(row.periodEnd) : '（未发货）',
    truncateToText: bjDateStr(Date.now()),
    channel: row.channel ?? '',
  };
  if (row.channel === 'ios') {
    return {
      ...base, leftFeeFen: 0, suggestFeeFen: 0, canRefund: false,
      reason: 'iOS 订单由用户在 App Store 申请退款（微信 690000020：开发者不可发起）',
    };
  }
  if (row.status === 'closed') {
    return { ...base, leftFeeFen: 0, suggestFeeFen: 0, canRefund: false, reason: '订单已超时关闭，没有可退金额' };
  }
  if (Date.now() - new Date(row.createdAt as never).getTime() > XPAY_REFUND_WINDOW_MS) {
    return { ...base, leftFeeFen: 0, suggestFeeFen: 0, canRefund: false, reason: '已超过支付后 365 天的退款窗口' };
  }

  let leftFeeFen = 0;
  try {
    const r = await xpayQueryOrder({ openid: row.openid, outTradeNo: row.outTradeNo, wxOrderId: row.wxOrderId || undefined });
    leftFeeFen = r.leftFeeFen;
    await XpayOrderModel.updateOne(
      { _id: row._id },
      { $set: { leftFeeFen, leftFeeAt: Date.now(), ...(r.wxOrderId ? { wxOrderId: r.wxOrderId } : {}) } },
    );
  } catch (e) {
    return { ...base, leftFeeFen: 0, suggestFeeFen: 0, canRefund: false, reason: `微信查单失败：${(e as Error).message}` };
  }
  if (leftFeeFen <= 0) {
    return { ...base, leftFeeFen: 0, suggestFeeFen: 0, canRefund: false, reason: '微信侧剩余可退金额为 0（可能已全额退款）' };
  }
  const suggest = suggestRefundFeeFen({ leftFeeFen, periodStart: row.periodStart, periodEnd: row.periodEnd });
  const createdAtMs = new Date(row.createdAt as never).getTime();
  const deduct = feeDeductionFen(createdAtMs, suggest);
  return {
    ...base,
    leftFeeFen,
    suggestFeeFen: Math.max(1, suggest - deduct),
    ...(deduct > 0 ? { feeNote: `支付已超 180 天：平台不退手续费，建议值已扣除 ${deduct} 分（费率 ${xpayConfig.feeRatePercent}%）` } : {}),
    canRefund: true,
  };
}

/** 第二、三步：金额校验（0 < refundFee ≤ leftFee）+ 备注必填 + refundOrderId 复用 */
export async function startRefund(
  id: string,
  input: { refundFee?: unknown; reason?: unknown; reasonCode?: unknown },
  adminId: string,
): Promise<{ status: string; refundOrderId: string; leftFeeFen: number }> {
  assertObjectIdLike(id, '订单不存在');
  const row = await XpayOrderModel.findById(id).lean();
  if (!row) throw new AppError(404, '订单不存在');
  if (row.channel === 'ios') throw new AppError(403, 'iOS 订单由用户在 App Store 申请退款（微信 690000020：开发者不可发起）');

  const reason = String(input.reason ?? '').trim();
  if (!reason) throw new AppError(400, '退款备注必填（会写进订单留痕，方便日后与用户核对）');
  if (reason.length > 100) throw new AppError(400, `退款备注不能超过 100 字（当前 ${reason.length} 字）`);
  // 微信 refund_order 的 reason 只收枚举（2026-11-04 真单实测 268490002）；备注只进我们的库、不发微信
  const reasonCode = String(input.reasonCode ?? '').trim();
  const knownReason = XPAY_REFUND_REASONS.find((r) => r.code === reasonCode);
  if (!knownReason) {
    throw new AppError(
      400,
      `退款原因必须是枚举值（收到 ${JSON.stringify(input.reasonCode)}，可选：${XPAY_REFUND_REASONS.map((r) => `${r.code}=${r.label}`).join('；')}）`,
    );
  }

  const age = Date.now() - new Date(row.createdAt as never).getTime();
  if (age > XPAY_REFUND_WINDOW_MS) {
    throw new AppError(400, `超过退款窗口（该单已 ${Math.floor(age / DAY_MS)} 天，窗口 365 天）`);
  }

  const fee = Number(input.refundFee);
  const left = Number(row.leftFeeFen ?? 0);
  if (!Number.isInteger(fee) || fee <= 0) {
    throw new AppError(400, `退款金额必须是正整数分（收到 ${JSON.stringify(input.refundFee)}，本次可退上限 ${left} 分）`);
  }
  if (left <= 0) throw new AppError(400, '还没有可退金额：请先点「刷新可退额度」重新查一次单');
  if (Date.now() - Number(row.leftFeeAt ?? 0) > LEFT_FEE_FRESH_MS) {
    throw new AppError(
      400,
      `可退额度已超过 ${LEFT_FEE_FRESH_MS / 60_000} 分钟未刷新（取数于 ${bjDateTimeText(row.leftFeeAt)}），请重新预览后再提交`,
    );
  }
  if (fee > left) throw new AppError(400, `退款金额超过可退上限（本次填 ${fee} 分，可退 ${left} 分）`);
  if (Number(row.refundedFen ?? 0) + fee > Number(row.priceFen ?? 0)) {
    throw new AppError(400, `累计退款会超过订单金额（已退 ${row.refundedFen} 分 + 本次 ${fee} 分 > 订单 ${row.priceFen} 分）`);
  }

  // refundOrderId：已有就复用（微信要求重试同值），没有才生成并落库
  const refundOrderId = row.refundOrderId
    || `R${Date.now().toString(36).toUpperCase()}${randomBytes(2).toString('hex').toUpperCase()}`;
  if (!row.refundOrderId) await XpayOrderModel.updateOne({ _id: row._id }, { $set: { refundOrderId } });

  const r = await xpayRefundOrder({
    openid: row.openid,
    outTradeNo: row.outTradeNo,
    wxOrderId: row.wxOrderId || undefined,
    refundOrderId,
    refundFeeFen: fee,
    leftFeeFen: left,
    reason: reasonCode,
    reqFrom: '1', // 人工客服发起（管理端代客服操作）
  });
  if (r.failed) {
    await XpayOrderModel.updateOne({ _id: row._id }, { $set: { lastError: `退款失败（微信返回 status ${r.status}）` } });
    throw new AppError(502, `微信退款失败（status ${r.status}），未受理，请核对额度后重试`);
  }
  await XpayOrderModel.updateOne(
    { _id: row._id },
    { $set: { status: 'refunding', refundReason: reason, lastQueryAt: Date.now() } },
  );
  console.warn(`[xpay] 发起退款 ${row.outTradeNo} ${fee} 分（admin=${adminId}，原因=${reasonCode}，备注=${reason}）→ refunding`);
  if (r.done) {
    // 极少见：启动即完成。复用 Task 9 的回收路径，别让状态卡在 refunding，也不在运营侧另写一份落账
    await applyRefund({ outTradeNo: row.outTradeNo, refundFeeFen: fee, refundOrderId: r.refundOrderId });
  }
  return { status: r.done ? 'refunded' : 'refunding', refundOrderId: r.refundOrderId, leftFeeFen: Math.max(0, left - fee) };
}

/** 手动查单：查到已支付就补发货（幂等仍由 xpay-deliver 负责） */
export async function manualQuery(id: string) {
  assertObjectIdLike(id, '订单不存在');
  const row = await XpayOrderModel.findById(id).lean();
  if (!row) throw new AppError(404, '订单不存在');
  const r = await xpayQueryOrder({ openid: row.openid, outTradeNo: row.outTradeNo, wxOrderId: row.wxOrderId || undefined });
  await XpayOrderModel.updateOne(
    { _id: row._id },
    {
      $set: {
        leftFeeFen: r.leftFeeFen,
        leftFeeAt: Date.now(),
        lastQueryAt: Date.now(),
        queryAttempts: (row.queryAttempts ?? 0) + 1,
        ...(r.wxOrderId ? { wxOrderId: r.wxOrderId } : {}),
        ...(r.paid && row.status === 'created' ? { status: 'paid' } : {}),
      },
    },
  );
  // 退款对账兑底：delivered/refunding 的单若微信侧已退而本地缺记，按差额补落账（与懒查单同一口径）
  if (row.status === 'delivered' || row.status === 'refunding') {
    const refundedTotal = Math.max(0, r.paidFeeFen - r.leftFeeFen);
    const delta = refundedTotal - Number(row.refundedFen ?? 0);
    if (delta > 0) {
      console.warn(`[xpay] 手动查单对出退款差额 ${delta} 分（${row.outTradeNo}），补落账`);
      await applyRefund({ outTradeNo: row.outTradeNo, refundFeeFen: delta, refundedAt: Date.now() });
    }
  }
  if (!r.paid) return { paid: false, status: r.status, leftFeeFen: r.leftFeeFen };
  const d = await deliverOrder({ outTradeNo: row.outTradeNo, wxOrderId: r.wxOrderId || row.wxOrderId || `q_${row.outTradeNo}` });
  return { paid: true, status: r.status, leftFeeFen: r.leftFeeFen, deliverResult: d };
}
