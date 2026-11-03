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
import {
  MEMBER_CLOSED, ORDER_SESSION_EXPIRED, ORDER_IDENTITY_MISMATCH, ORDER_PRODUCT_UNAVAILABLE,
  MEMBER_PRODUCT_COPY, memberStatusText,
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
