/**
 * 微信虚拟支付的服务端接口（查单 / 退款）。
 *
 * 注入点（__setXpayFetcherForTest）沿用 services/geo.ts:65-74 的先例：
 * 这两条接口只有真单才有的通，测试不能打微信，但又必须钉住「请求形状」——
 * 字段名写错的症状是「一直查不到」，不报错，是最难发现的一类 bug。
 *
 * ⚠ 待核（spec §12.1）：query_order 的 order.status 枚举，官方表格本地没取到确证值。
 * 现在的判据是「未知一律按未支付」，所以就算 1 猜错，症状也只是懒查单不补发货（推送主路径不受影响），
 * 不会虚构权益。Task 14 用第一笔真单的响应体核对后，改这一个常量并同步 XA-3 的断言。
 */
import axios from 'axios';
import { AppError } from '../utils/app-error.js';
import { callWithRetry } from './wechat-sec.js';
import { hmacSha256Hex } from './xpay-sign.js';
import { payConfig } from '../config/xpay.js';

export const XPAY_PAID_ORDER_STATUSES = new Set<number>([1]);
export const XPAY_REFUND_DONE_STATUS = [5, 8] as const;
export const XPAY_REFUND_FAILED_STATUS = 7;

export type XpayFetcher = (api: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * 服务端调 xpay 接口也要签名：`pay_sig = HMAC-SHA256(AppKey, "/xpay/<api>&<post_body>")`，
 * post_body 必须与真正发出去的字节完全一致（所以这里先序列化一次、再用同一个串签名与发送）。
 *
 * 两点都是 2026-11-03 对微信现网实测出来的：
 * - 漏了 pay_sig → 268490002「签名字段[pay_sig]为空」；
 * - 被签的 uri 必须是 **带前导斜杠的完整路径 `/xpay/query_order`**（写 `query_order` 或
 *   `xpay/query_order` 都是 268490003「支付签名校验失败」）。
 */
export function buildXpayRequest(
  api: string,
  bodyJson: string,
  accessToken: string,
  appKey: string,
): { url: string; data: string } {
  const paySig = hmacSha256Hex(appKey, `/xpay/${api}&${bodyJson}`);
  return {
    url: `https://api.weixin.qq.com/xpay/${api}?access_token=${accessToken}&pay_sig=${paySig}`,
    data: bodyJson,
  };
}

const defaultFetcher: XpayFetcher = async (api, body) => {
  const bodyJson = JSON.stringify(body);
  const data = await callWithRetry(async (token) => {
    const { url, data: payload } = buildXpayRequest(api, bodyJson, token, payConfig().appKey);
    const res = await axios.post<Record<string, unknown>>(url, payload, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' },
    });
    return res.data;
  });
  return data as Record<string, unknown>;
};

let fetcher: XpayFetcher = defaultFetcher;

export function __setXpayFetcherForTest(f: XpayFetcher | null): void {
  fetcher = f ?? defaultFetcher;
}

/** 非零 errcode 一律换成点名接口与错误码的 502（spec §9：提示要含对象+实际值+建议动作） */
function assertOk(api: string, data: Record<string, unknown>): void {
  const code = Number(data.errcode ?? 0);
  if (code !== 0) {
    throw new AppError(
      502,
      `微信支付接口 ${api} 调用失败（错误码 ${code}：${String(data.errmsg ?? '无描述')}），请稍后重试或联系开发者核查商户号状态`,
      { errcode: code },
    );
  }
}

export interface XpayQueryResult {
  paid: boolean;
  status: number;
  leftFeeFen: number;
  wxOrderId: string;
  raw: Record<string, unknown>;
}

export async function xpayQueryOrder(p: {
  openid: string;
  outTradeNo: string;
  wxOrderId?: string;
}): Promise<XpayQueryResult> {
  const body: Record<string, unknown> = { openid: p.openid, out_trade_no: p.outTradeNo };
  if (p.wxOrderId) body.wx_order_id = p.wxOrderId;
  const data = await fetcher('query_order', body);
  assertOk('query_order', data);
  const order = (data.order ?? data.order_info ?? {}) as Record<string, unknown>;
  const status = Number(order.status ?? 0);
  return {
    paid: XPAY_PAID_ORDER_STATUSES.has(status),
    status,
    leftFeeFen: Number(order.left_fee ?? order.leftFee ?? 0) || 0,
    wxOrderId: String(order.order_no ?? order.wx_order_id ?? p.wxOrderId ?? ''),
    raw: data,
  };
}

export interface XpayRefundResult {
  done: boolean;
  failed: boolean;
  status: number;
  refundOrderId: string;
  raw: Record<string, unknown>;
}

export async function xpayRefundOrder(p: {
  openid: string;
  outTradeNo: string;
  wxOrderId?: string;
  refundOrderId: string;
  refundFeeFen: number;
  leftFeeFen: number;
  reason: string;
}): Promise<XpayRefundResult> {
  const body: Record<string, unknown> = {
    openid: p.openid,
    out_trade_no: p.outTradeNo,
    refund_id: p.refundOrderId,
    refund_fee: p.refundFeeFen,
    // left_fee 必须是最新一次 query_order 的值（spec §2.3）；调用方负责刷新后传进来
    left_fee: p.leftFeeFen,
    reason: p.reason,
  };
  if (p.wxOrderId) body.wx_order_id = p.wxOrderId;
  const data = await fetcher('refund_order', body);
  assertOk('refund_order', data);
  const status = Number(data.status ?? data.refund_status ?? 0);
  return {
    done: (XPAY_REFUND_DONE_STATUS as readonly number[]).includes(status),
    failed: status === XPAY_REFUND_FAILED_STATUS,
    status,
    refundOrderId: String(data.refund_id ?? p.refundOrderId),
    raw: data,
  };
}
