/**
 * 建单与订单状态（spec §6.1、§7.1）。
 *
 * session_key 只在下单这一秒用到：现在登录时 code2Session 换来的 session_key 用完即弃
 * （routes/auth.routes.ts 的既定口径），所以这里要求端上带一个**本次新取的 wx.login code**——
 * 既绕开 -15007（会话密钥过期），也避免把敏感会话密钥落库。
 */
import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { XpayOrderModel } from '../models/xpay-order.model.js';
import { UserModel } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { isObjectIdLike } from '../utils/object-id.js';
import { code2Session } from './wechat.js';
import { buildPayParams } from './xpay-sign.js';
import { activePaidProducts, paidProductOf } from './paid-products.js';
import { entitlementsOf, type Entitlements } from './entitlements.js';
import { isMemberPaymentsEnabled } from './member-switch.js';
import { xpayConfig, isXpayPayConfigured, payConfig } from '../config/xpay.js';
import { xpayQueryOrder, xpayRefundOrder, XPAY_REFUND_REASONS } from './xpay-api.js';
import { applyRefund, suggestRefundFeeFen } from './xpay-deliver.js';
import { BJ_OFFSET_MS } from '../utils/bj-time.js';
import {
  MEMBER_CLOSED, ORDER_SESSION_EXPIRED, ORDER_IDENTITY_MISMATCH, ORDER_PRODUCT_UNAVAILABLE,
  MEMBER_PRODUCT_COPY, memberStatusText, MEMBER_ORDERS_NOTICE, fmtCnDate,
} from '../config/member-copy.js';

/**
 * 商户下单号：8–32 位、不以下划线开头（spec §5.2）。
 * 形态：'ST' + 时间戳 base36（8 位）+ userId 尾 6 位 + 6 位随机 hex ≈ 22 位。
 * 随机段用 crypto 而不是 Math.random：撞号会让新订单撞 outTradeNo 唯一索引，症状是「下单莫名失败」。
 */
export function genOutTradeNo(userId: string, now = Date.now()): string {
  const tail = userId.replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase() || '000000';
  return `ST${now.toString(36).padStart(8, '0').slice(-8)}${tail}${randomBytes(3).toString('hex')}`;
}

export interface MemberOrderDto {
  outTradeNo: string;
  status: string;
  mode: 'short_series_goods';
  buyQuantity: 1;
  env: 0;
  priceFen: number;
  name: string;
  durationDays: number;
  payData?: { signData: string; paySig: string; signature: string };
  /** 订单已支付/已发货时回读到权益，端上支付回来立刻刷新广告与额度 */
  entitlements?: Entitlements;
}

/** channel：端上传 'ios'/'android'，只用于对账分列（spec §5.2）；非法值按空串存，不猜 */
function normalizeChannel(v: unknown): 'android' | 'ios' | '' {
  return v === 'ios' || v === 'android' ? v : '';
}

export async function createMemberOrder(p: {
  userId: string;
  productKey: unknown;
  code: unknown;
  channel?: unknown;
  now?: number;
}): Promise<MemberOrderDto> {
  const now = p.now ?? Date.now();
  if (!(await isMemberPaymentsEnabled(now))) throw new AppError(403, MEMBER_CLOSED);
  // 密钥没配齐对用户而言「就是还没开放」——不复用 503 + 内部术语
  if (!isXpayPayConfigured()) throw new AppError(503, MEMBER_CLOSED);

  const productKey = String(p.productKey ?? '').trim();
  const code = String(p.code ?? '').trim();
  if (!code) throw new AppError(400, ORDER_SESSION_EXPIRED);

  if (!isObjectIdLike(p.userId)) throw new AppError(401, '请先登录');
  const user = await UserModel.findById(p.userId).select('openid').lean();
  if (!user?.openid) throw new AppError(401, '请先登录');

  const product = await paidProductOf(productKey);
  if (!product || product.active !== true) throw new AppError(400, ORDER_PRODUCT_UNAVAILABLE);

  // 现换 session_key：这一步同时是「code 属于这个用户」的证明（openid 必须与库里一致）
  const session = await code2Session(code);
  if (session.openid !== user.openid) throw new AppError(400, ORDER_IDENTITY_MISMATCH);

  const outTradeNo = genOutTradeNo(String(p.userId), now);
  await XpayOrderModel.create({
    outTradeNo,
    userId: new Types.ObjectId(String(p.userId)),
    openid: user.openid,
    productKey: product.key,
    name: product.name,
    priceFen: product.priceFen,
    durationDays: product.durationDays,
    perksSnapshot: product.perks,
    status: 'created',
    attach: outTradeNo,
    channel: normalizeChannel(p.channel),
  });

  const { offerId, appKey } = payConfig();
  const payData = buildPayParams(
    {
      offerId,
      buyQuantity: 1,
      env: xpayConfig.env,
      currencyType: 'CNY',
      productId: product.key,
      goodsPrice: product.priceFen,
      outTradeNo,
      attach: outTradeNo,
    },
    appKey,
    session.sessionKey,
  );

  return {
    outTradeNo,
    status: 'created',
    mode: 'short_series_goods',
    buyQuantity: 1,
    env: xpayConfig.env,
    priceFen: product.priceFen,
    name: product.name,
    durationDays: product.durationDays,
    payData,
  };
}

const OUT_TRADE_NO_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,31}$/;

/** 用户只能读自己的单（越权按 404，与仓内「外来 id 藏进 404」口径一致） */
export async function readOrderForUser(userId: string, outTradeNo: string): Promise<MemberOrderDto> {
  const raw = String(outTradeNo ?? '');
  if (!OUT_TRADE_NO_RE.test(raw)) throw new AppError(404, '订单不存在');
  const row = await XpayOrderModel.findOne({ outTradeNo: raw, userId }).lean();
  if (!row) throw new AppError(404, '订单不存在');
  const base: MemberOrderDto = {
    outTradeNo: row.outTradeNo,
    status: row.status,
    mode: 'short_series_goods',
    buyQuantity: 1,
    env: xpayConfig.env,
    priceFen: row.priceFen,
    name: row.name,
    durationDays: row.durationDays,
  };
  // 已发货才带权益快照：用户付完钱回来 polling，这一趟就把广告闸门和额度一起刷新到位
  if (row.status === 'delivered' || row.status === 'refunding' || row.status === 'refunded') {
    base.entitlements = await entitlementsOf(String(userId));
  }
  return base;
}

// ===== 我的订单：列表 / 继续支付 / 取消 / 自助退款（2026-11-04）=====

/** 用户自助退款可选的原因（微信枚举去掉「0 暂无描述」——用户侧必须选个真实原因） */
const USER_REFUNDABLE_REASONS = XPAY_REFUND_REASONS.filter((r) => r.code !== '0');

const ORDER_STATUS_TEXT: Record<string, string> = {
  created: '待支付',
  paid: '已支付·待发货',
  delivered: '已生效',
  refunding: '退款中',
  refunded: '已退款',
  closed: '已关闭',
};

/** 东八区「YYYY-MM-DD HH:mm」：与 admin 侧同一口径，运营/用户看的取数时刻用 */
function bjDateTimeText(ms: number): string {
  return new Date(ms + BJ_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

export interface MemberOrderRowDto {
  outTradeNo: string;
  status: string;
  statusText: string;
  name: string;
  priceFen: number;
  refundedFen: number;
  periodText: string;
  createdAtText: string;
  canPay: boolean;
  canCancel: boolean;
  canRefund: boolean;
}

/** 我的订单（仅本人，最多 20 条）：动作旗标由服务端裁定，端上只按旗标渲染按钮 */
export async function listOrdersForUser(
  userId: string,
  _now = Date.now(),
): Promise<{ items: MemberOrderRowDto[]; notice: string }> {
  const rows = await XpayOrderModel.find({ userId: new Types.ObjectId(String(userId)) })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
  const items = rows.map((r) => {
    const refunded = Number(r.refundedFen ?? 0);
    const price = Number(r.priceFen ?? 0);
    return {
      outTradeNo: r.outTradeNo,
      status: r.status,
      statusText: ORDER_STATUS_TEXT[r.status] ?? r.status,
      name: r.name,
      priceFen: price,
      refundedFen: refunded,
      periodText: r.periodStart > 0 ? `${fmtCnDate(r.periodStart)} ~ ${fmtCnDate(r.periodEnd)}` : '',
      createdAtText: bjDateTimeText(new Date(r.createdAt as never).getTime()),
      canPay: r.status === 'created',
      canCancel: r.status === 'created',
      // iOS 订单由用户在 Apple 侧退款（与管理端同一政策），自助仅 Android
      canRefund: (r.status === 'delivered' || r.status === 'refunding')
        && price - refunded > 0 && r.channel !== 'ios',
    };
  });
  return { items, notice: MEMBER_ORDERS_NOTICE };
}

/** 取消待支付订单：本地置 closed 即可（未支付单微信侧不会发货，若收到推送会因陌生单被丢） */
export async function cancelOrder(
  userId: string,
  outTradeNo: unknown,
): Promise<{ outTradeNo: string; status: 'closed' }> {
  const raw = String(outTradeNo ?? '');
  if (!OUT_TRADE_NO_RE.test(raw)) throw new AppError(404, '订单不存在');
  if (!isObjectIdLike(userId)) throw new AppError(401, '请先登录');
  const row = await XpayOrderModel.findOne({ outTradeNo: raw, userId: new Types.ObjectId(String(userId)) }).lean();
  if (!row) throw new AppError(404, '订单不存在');
  if (row.status !== 'created') throw new AppError(400, '只有待支付订单可以取消');
  await XpayOrderModel.updateOne({ _id: row._id, status: 'created' }, { $set: { status: 'closed' } });
  return { outTradeNo: row.outTradeNo, status: 'closed' };
}

/** 继续支付：复用原 outTradeNo 重签支付参数（session_key 用完即弃，所以每次都要新取的 code） */
export async function repayOrder(
  userId: string,
  outTradeNo: unknown,
  code: unknown,
): Promise<MemberOrderDto> {
  if (!(await isMemberPaymentsEnabled())) throw new AppError(403, MEMBER_CLOSED);
  if (!isXpayPayConfigured()) throw new AppError(503, MEMBER_CLOSED);
  const raw = String(outTradeNo ?? '');
  if (!OUT_TRADE_NO_RE.test(raw)) throw new AppError(404, '订单不存在');
  const codeStr = String(code ?? '').trim();
  if (!codeStr) throw new AppError(400, ORDER_SESSION_EXPIRED);
  if (!isObjectIdLike(userId)) throw new AppError(401, '请先登录');
  const user = await UserModel.findById(userId).select('openid').lean();
  if (!user?.openid) throw new AppError(401, '请先登录');
  const row = await XpayOrderModel.findOne({ outTradeNo: raw, userId: new Types.ObjectId(String(userId)) }).lean();
  if (!row) throw new AppError(404, '订单不存在');
  if (row.status !== 'created') throw new AppError(400, '只有待支付订单可以继续支付');
  const session = await code2Session(codeStr);
  if (session.openid !== user.openid) throw new AppError(400, ORDER_IDENTITY_MISMATCH);
  const { offerId, appKey } = payConfig();
  const attach = row.attach || row.outTradeNo;
  const payData = buildPayParams(
    {
      offerId,
      buyQuantity: 1,
      env: xpayConfig.env,
      currencyType: 'CNY',
      productId: row.productKey,
      goodsPrice: row.priceFen,
      outTradeNo: row.outTradeNo,
      attach,
    },
    appKey,
    session.sessionKey,
  );
  return {
    outTradeNo: row.outTradeNo,
    status: row.status,
    mode: 'short_series_goods',
    buyQuantity: 1,
    env: xpayConfig.env,
    priceFen: row.priceFen,
    name: row.name,
    durationDays: row.durationDays,
    payData,
  };
}

/**
 * 用户自助退款：金额按剩余天数折算、服务端算定（不可自选，防「用满再全退」）；
 * 原因必选（微信枚举 1-5），备注可选只进订单留痕。iOS 单走 Apple，不在此通道。
 */
export async function startUserRefund(
  userId: string,
  outTradeNo: unknown,
  input: { reasonCode?: unknown; note?: unknown },
): Promise<{ status: string; refundOrderId: string; refundFeeFen: number; refundedFen: number; entitlements: Entitlements }> {
  if (!(await isMemberPaymentsEnabled())) throw new AppError(403, MEMBER_CLOSED);
  if (!isXpayPayConfigured()) throw new AppError(503, MEMBER_CLOSED);
  const raw = String(outTradeNo ?? '');
  if (!OUT_TRADE_NO_RE.test(raw)) throw new AppError(404, '订单不存在');
  if (!isObjectIdLike(userId)) throw new AppError(401, '请先登录');
  const row = await XpayOrderModel.findOne({ outTradeNo: raw, userId: new Types.ObjectId(String(userId)) }).lean();
  if (!row) throw new AppError(404, '订单不存在');
  if (row.channel === 'ios') throw new AppError(403, 'iOS 购买的订单请在 App Store 里申请退款');
  if (row.status !== 'delivered' && row.status !== 'refunding') {
    throw new AppError(400, '仅已生效的会员订单支持自助退款');
  }
  const price = Number(row.priceFen ?? 0);
  const already = Number(row.refundedFen ?? 0);
  if (price - already <= 0) throw new AppError(400, '该订单已全额退款');

  const reasonCode = String(input.reasonCode ?? '').trim();
  const knownReason = XPAY_REFUND_REASONS.find((r) => r.code === reasonCode && r.code !== '0');
  if (!knownReason) {
    throw new AppError(400, `请选择退款原因（可选：${USER_REFUNDABLE_REASONS.map((r) => r.label).join('；')}）`);
  }
  const note = String(input.note ?? '').trim();
  if (note.length > 100) throw new AppError(400, `退款说明不能超过 100 字（当前 ${note.length} 字）`);

  // 金额基线＝实时微信侧剩余可退（提交前现查，不拿库里旧值猜），再按剩余天数折算
  const fresh = await xpayQueryOrder({ openid: row.openid, outTradeNo: row.outTradeNo, wxOrderId: row.wxOrderId || undefined });
  const left = Math.max(0, Math.min(Number(fresh.leftFeeFen) || 0, price - already));
  if (left <= 0) throw new AppError(400, '该订单在微信侧已没有可退金额');
  const fee = row.periodStart > 0
    ? suggestRefundFeeFen({ leftFeeFen: left, periodStart: row.periodStart, periodEnd: row.periodEnd })
    : left; // 未生效的顺延单：一天没消费，全额退
  const finalFee = Math.max(1, Math.min(fee, left));

  // refundOrderId 复用纪律与 admin 路径一致（微信要求重试同值）
  const refundOrderId = row.refundOrderId
    || `R${Date.now().toString(36).toUpperCase()}${randomBytes(2).toString('hex').toUpperCase()}`;
  if (!row.refundOrderId) await XpayOrderModel.updateOne({ _id: row._id }, { $set: { refundOrderId } });

  const r = await xpayRefundOrder({
    openid: row.openid,
    outTradeNo: row.outTradeNo,
    wxOrderId: row.wxOrderId || undefined,
    refundOrderId,
    refundFeeFen: finalFee,
    leftFeeFen: left,
    reason: reasonCode,
    reqFrom: '2', // 用户自己发起
  });
  if (r.failed) {
    await XpayOrderModel.updateOne({ _id: row._id }, { $set: { lastError: `退款失败（微信返回 status ${r.status}）` } });
    throw new AppError(502, `微信退款失败（status ${r.status}），未受理，请稍后重试`);
  }
  const refundReason = `[${knownReason.label}]${note}`;
  await XpayOrderModel.updateOne(
    { _id: row._id },
    { $set: { status: 'refunding', refundReason, lastQueryAt: Date.now() } },
  );
  console.warn(`[xpay] 用户发起退款 ${row.outTradeNo} ${finalFee} 分（user=${userId}，原因=${reasonCode}${note ? `，说明=${note}` : ''}）→ refunding`);
  if (r.done) {
    // 极少见：受理即完成。复用 applyRefund 的截断与幂等
    await applyRefund({ outTradeNo: row.outTradeNo, refundFeeFen: finalFee, refundOrderId: r.refundOrderId });
  }
  const after = await XpayOrderModel.findById(row._id).lean();
  return {
    status: r.done ? 'refunded' : 'refunding',
    refundOrderId: r.refundOrderId,
    refundFeeFen: finalFee,
    refundedFen: Number(after?.refundedFen ?? 0),
    entitlements: await entitlementsOf(String(userId)),
  };
}

/** 会员页数据（文案服务端下发：spec §6.1，端上不自算日均也不拼句） */
export async function memberProductsPayload(userId: string, now = Date.now()) {
  const enabled = await isMemberPaymentsEnabled(now);
  const entitlements = await entitlementsOf(userId, now);
  if (!enabled) {
    // 关闭态也要有一句服务端下发的说明：端上不许自己写「暂未开放」
    return { enabled: false, items: [] as unknown[], entitlements, statusText: memberStatusText(entitlements, now), notice: MEMBER_CLOSED };
  }
  const items = (await activePaidProducts()).map((i) => ({
    ...i,
    priceText: MEMBER_PRODUCT_COPY.price(i.priceFen),
    perDayText: MEMBER_PRODUCT_COPY.perDay(i.priceFen, i.durationDays),
    durationText: MEMBER_PRODUCT_COPY.duration(i.durationDays),
    perkLines: MEMBER_PRODUCT_COPY.perkLines(i.perks.photoQuota),
  }));
  return { enabled: true, items, entitlements, statusText: memberStatusText(entitlements, now), notice: '' };
}
