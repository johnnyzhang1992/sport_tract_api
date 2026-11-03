/**
 * 微信 xpay 服务端接口封装（spec §6/§7.3/§7.5）。
 * 三条主线：
 * 1) 请求形状——URL 上的接口名、body 里的字段名与微信文档逐字（写错字段名＝静默查不到）；
 * 2) 「未知 status 一律按未支付」——不虚构权益的保守判据；
 * 3) 非零错误码必须换成带对象的 AppError（错误提示要具体：谁、收到什么、建议什么）。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/xpay-api.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  xpayQueryOrder, xpayRefundOrder, __setXpayFetcherForTest, buildXpayRequest,
  XPAY_PAID_ORDER_STATUSES, XPAY_REFUND_DONE_STATUS, XPAY_REFUND_FAILED_STATUS,
} from '../src/services/xpay-api.js';
import { hmacSha256Hex } from '../src/services/xpay-sign.js';

const calls: Array<{ api: string; body: Record<string, unknown> }> = [];

beforeEach(() => {
  calls.length = 0;
  __setXpayFetcherForTest(null);
});

test('XA-1 query_order 的请求形状逐字', async () => {
  __setXpayFetcherForTest(async (api, body) => {
    calls.push({ api, body });
    return { errcode: 0, order: { status: 1, left_fee: 99, order_no: 'wx-1' } };
  });
  const r = await xpayQueryOrder({ openid: 'o1', outTradeNo: 'ST1', wxOrderId: 'wx-1' });
  assert.equal(calls[0].api, 'query_order');
  assert.deepEqual(calls[0].body, { openid: 'o1', out_trade_no: 'ST1', wx_order_id: 'wx-1' });
  assert.equal(r.paid, true);
  assert.equal(r.leftFeeFen, 99);
  assert.equal(r.wxOrderId, 'wx-1');
});

test('XA-2 未知 status 一律按未支付（宁可漏补发货，不虚构权益）', async () => {
  for (const status of [0, 2, 3, 99, undefined]) {
    __setXpayFetcherForTest(async () => ({ errcode: 0, order: { status, left_fee: 199 } }));
    const r = await xpayQueryOrder({ openid: 'o1', outTradeNo: 'ST1' });
    assert.equal(r.paid, false, `status=${String(status)} 不该被判成已支付`);
  }
});

test('XA-3 XPAY_PAID_ORDER_STATUSES 是「一处可改」的集合，且不含 0（改动它必被这条抓红）', () => {
  assert.ok(XPAY_PAID_ORDER_STATUSES instanceof Set);
  assert.equal(XPAY_PAID_ORDER_STATUSES.has(0), false);
  assert.deepEqual([...XPAY_PAID_ORDER_STATUSES], [1], 'Task 14 用真单响应核对后把真实取值集合写进来');
});

test('XA-4 缺 order 对象时不抛，按未支付且 leftFee 为 0（查单还没结果）', async () => {
  __setXpayFetcherForTest(async () => ({ errcode: 0 }));
  const r = await xpayQueryOrder({ openid: 'o1', outTradeNo: 'ST1' });
  assert.equal(r.paid, false);
  assert.equal(r.leftFeeFen, 0);
});

test('XA-5 refund_order 的字段形状 + refundOrderId 复用同值（重试不得换新号）', async () => {
  __setXpayFetcherForTest(async (api, body) => {
    calls.push({ api, body });
    return { errcode: 0, refund_id: 'rf-1', status: 5 };
  });
  const r = await xpayRefundOrder({
    openid: 'o1', outTradeNo: 'ST1', wxOrderId: 'wx-1',
    refundOrderId: 'rf-1', refundFeeFen: 132, leftFeeFen: 199, reason: '客服协商',
  });
  assert.equal(calls[0].api, 'refund_order');
  assert.deepEqual(calls[0].body, {
    openid: 'o1', out_trade_no: 'ST1', refund_id: 'rf-1',
    refund_fee: 132, left_fee: 199, reason: '客服协商', wx_order_id: 'wx-1',
  });
  assert.equal(r.refundOrderId, 'rf-1');
  assert.equal(r.done, true);
});

test('XA-6 退款 status 7＝失败，5/8＝完成，其余＝处理中（spec §2.3）', async () => {
  const mk = (status: number) => async () => ({ errcode: 0, refund_id: 'rf-1', status });
  for (const s of XPAY_REFUND_DONE_STATUS) {
    __setXpayFetcherForTest(mk(s));
    const r = await xpayRefundOrder({ openid: 'o', outTradeNo: 'ST', refundOrderId: 'rf-1', refundFeeFen: 1, leftFeeFen: 1, reason: 'r' });
    assert.equal(r.done, true, `status ${s}`);
    assert.equal(r.failed, false);
  }
  __setXpayFetcherForTest(mk(XPAY_REFUND_FAILED_STATUS));
  assert.equal((await xpayRefundOrder({ openid: 'o', outTradeNo: 'ST', refundOrderId: 'rf-1', refundFeeFen: 1, leftFeeFen: 1, reason: 'r' })).failed, true);
  __setXpayFetcherForTest(mk(3));
  const pending = await xpayRefundOrder({ openid: 'o', outTradeNo: 'ST', refundOrderId: 'rf-1', refundFeeFen: 1, leftFeeFen: 1, reason: 'r' });
  assert.equal(pending.done, false);
  assert.equal(pending.failed, false);
});

test('XA-7 errcode 非 0 → AppError 且句子含接口名与实际错误码（不笼统「调用失败」）', async () => {
  __setXpayFetcherForTest(async () => ({ errcode: 48001, errmsg: 'api unauthorized' }));
  await assert.rejects(
    () => xpayQueryOrder({ openid: 'o', outTradeNo: 'ST' }),
    (e: Error & { statusCode?: number }) => {
      assert.equal(e.statusCode, 502);
      assert.match(e.message, /query_order/);
      assert.match(e.message, /48001/);
      return true;
    },
  );
});

test('XA-8 fetcher 抛网络错时不吞：错误照抛（发货依据不能建立在猜测上）', async () => {
  __setXpayFetcherForTest(async () => { throw new Error('ETIMEDOUT'); });
  await assert.rejects(() => xpayQueryOrder({ openid: 'o', outTradeNo: 'ST' }), /ETIMEDOUT/);
});

test('XA-9 服务端调 xpay 也必须带 pay_sig：URL 带签名、body 与签名字节一致（268490002 的坑）', () => {
  const body = '{"openid":"o1","out_trade_no":"ST1"}';
  const { url, data } = buildXpayRequest('query_order', body, 'AT', 'APPKEY');
  // uri 带前导斜杠且含 xpay 前缀：实测写 query_order 是 268490003 校验失败
  const sig = hmacSha256Hex('APPKEY', `/xpay/query_order&${body}`);
  assert.match(url, /\/xpay\/query_order\?access_token=AT&pay_sig=[0-9a-f]{64}$/);
  assert.ok(url.includes(sig), 'pay_sig 必须是 HMAC(AppKey, "<api>&<body>")');
  assert.equal(data, body, '签名的串与实际发送的字节必须完全一致');
});
