/**
 * 我的订单：列表 / 待支付继续支付 / 取消 / 用户自助退款（2026-11-04）。
 * 逐条单独变异：越权 404；状态闸门（created 才能支付/取消，delivered/refunding 才能退）；
 * 原因枚举必选（0 不给用户选）；金额服务端按剩余天数折算、真单第 0 天=全额；
 * refundOrderId 重试复用；done 即截断权益。
 * 用注入的假 fetcher 与 mock 登录（WX_MOCK_LOGIN=true，code 'openid:<x>' 透传）。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/member-orders.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import mongoose, { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { XpayOrderModel } from '../src/models/xpay-order.model.js';
import { UserModel } from '../src/models/user.model.js';
import { __setXpayFetcherForTest } from '../src/services/xpay-api.js';
import { setMemberPaymentsEnabled, resetMemberSwitchCacheForTest, MEMBER_SWITCH_KEY } from '../src/services/member-switch.js';
import { __setEntitlementFetchersForTest, entitlementsOf } from '../src/services/entitlements.js';
import { seedPaidProducts } from '../src/services/paid-products.js';
import { __setPayConfigForTest } from '../src/config/xpay.js';
import { AppSettingModel } from '../src/models/app-setting.model.js';

let app: FastifyInstance;
const RUN = Date.now().toString(36);
const OPENID = `orders_test_${RUN}`;
const BOB = `orders_bob_${RUN}`;
const DAY = 86_400_000;
const allPerks = { adFree: true, exportBundle: true, photoQuota: 300, subscribeNotice: true };
let alice = ''; // accessToken
let bob = '';
let uid = '';
let seq = 0;

async function login(openid: string) {
  const res = await app.inject({ method: 'POST', url: `${config.apiPrefix}/auth/login`, payload: { code: `openid:${openid}` } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.accessToken as string;
}

/** 直接落一行订单（跳过建单 API，便于摆各种状态） */
async function mkRow(over: Record<string, unknown> = {}, openid = OPENID) {
  seq += 1;
  const u = await UserModel.findOne({ openid }).lean();
  return XpayOrderModel.create({
    outTradeNo: `MOT${RUN}${String(seq).padStart(3, '0')}`.slice(0, 32),
    userId: u?._id, openid,
    productKey: 'month_card', name: '会员月卡', priceFen: 199, durationDays: 30,
    perksSnapshot: allPerks, status: 'created', attach: '', channel: 'android', ...over,
  });
}

async function mkDelivered(over: Record<string, unknown> = {}) {
  return mkRow({
    status: 'delivered', wxOrderId: `wx${seq}`, periodStart: Date.now(), periodEnd: Date.now() + 30 * DAY, ...over,
  });
}

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  app = await buildApp({ logger: false });
  await app.ready();
  await seedPaidProducts();
  __setPayConfigForTest({ offerId: 'offer-test', appKey: 'platform-key-test' });
  alice = await login(OPENID);
  bob = await login(BOB);
  const u = await UserModel.findOne({ openid: OPENID }).lean();
  uid = String(u?._id);
});
beforeEach(async () => {
  await XpayOrderModel.deleteMany({ openid: { $in: [OPENID, BOB] } });
  resetMemberSwitchCacheForTest();
  await setMemberPaymentsEnabled(true);
  __setXpayFetcherForTest(async () => ({ errcode: 0, order: { status: 0, left_fee: 0 } }));
  __setEntitlementFetchersForTest(null);
});
after(async () => {
  await XpayOrderModel.deleteMany({ openid: { $in: [OPENID, BOB] } });
  await UserModel.deleteMany({ openid: { $in: [OPENID, BOB] } });
  await AppSettingModel.deleteMany({ _id: MEMBER_SWITCH_KEY });
  resetMemberSwitchCacheForTest();
  __setPayConfigForTest(null);
  __setXpayFetcherForTest(null);
  __setEntitlementFetchersForTest(null);
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

test('ML-1 列表：只回自己的单；动作旗标按状态裁定', async () => {
  const mine = await mkRow(); // created
  const droid = await mkDelivered(); // android 已生效
  const iphone = await mkDelivered({ channel: 'ios' }); // ios 已生效
  await mkRow({ status: 'refunded', refundedFen: 199 });
  const bobRow = await mkRow({}, BOB); // 别人的
  const res = await app.inject({ method: 'GET', url: `${config.apiPrefix}/member/orders`, headers: auth(alice) });
  assert.equal(res.statusCode, 200, res.body);
  const items = res.json().data.items;
  assert.equal(items.length, 4, '别人的单不能出现');
  assert.ok(!items.some((i: { outTradeNo: string }) => i.outTradeNo === bobRow.outTradeNo));
  const byId = (id: string) => items.find((i: { outTradeNo: string }) => i.outTradeNo === id);
  const a = byId(mine.outTradeNo);
  assert.equal(a.canPay, true); assert.equal(a.canCancel, true); assert.equal(a.canRefund, false);
  assert.equal(a.statusText, '待支付');
  assert.equal(byId(droid.outTradeNo).canRefund, true, 'android 已生效可自助退');
  assert.equal(byId(iphone.outTradeNo).canRefund, true, 'ios 单同样可自助退');
  assert.ok(items.every((i: { notice?: string }) => !i.notice), 'notice 在列表外层');
  assert.match(res.json().data.notice, /剩余天数/);
});

test('MP-R1 继续支付：created 单重签 payData（同单号），身份不符/非待支付都拒', async () => {
  const o = await mkRow();
  const ok = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/member/order/${o.outTradeNo}/repay`,
    headers: auth(alice), payload: { code: `openid:${OPENID}` },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const d = ok.json().data;
  assert.equal(d.outTradeNo, o.outTradeNo, '继续支付必须复用原单号');
  assert.ok(d.payData?.signData && d.payData?.paySig && d.payData?.signature);

  const stranger = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/member/order/${o.outTradeNo}/repay`,
    headers: auth(alice), payload: { code: `openid:${BOB}` },
  });
  assert.equal(stranger.statusCode, 400, '别人的 code 不能续付自己的单');

  const done = await mkDelivered();
  const notCreated = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/member/order/${done.outTradeNo}/repay`,
    headers: auth(alice), payload: { code: `openid:${OPENID}` },
  });
  assert.equal(notCreated.statusCode, 400);
});

test('MP-R2 取消：created → closed；非待支付 400；取消后不可再支付', async () => {
  const o = await mkRow();
  const res = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/member/order/${o.outTradeNo}/cancel`, headers: auth(alice),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((await XpayOrderModel.findById(o._id).lean())?.status, 'closed');
  const again = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/member/order/${o.outTradeNo}/cancel`, headers: auth(alice),
  });
  assert.equal(again.statusCode, 400);
  const list = await app.inject({ method: 'GET', url: `${config.apiPrefix}/member/orders`, headers: auth(alice) });
  const row = list.json().data.items.find((i: { outTradeNo: string }) => i.outTradeNo === o.outTradeNo);
  assert.equal(row.canPay, false);
});

test('MF-1 自助退款（真单形状）：day-0 全额、原因枚举入库、done 即截断权益', async () => {
  const o = await mkDelivered({ periodStart: Date.now() - 3600_000 }); // 今天刚生效
  const refundBodies: Array<Record<string, unknown>> = [];
  __setXpayFetcherForTest(async (api, body) => {
    if (api === 'query_order') return { errcode: 0, order: { status: 3, left_fee: 199 } };
    refundBodies.push(body as Record<string, unknown>);
    return { errcode: 0, refund_id: 'rfU1', status: 5 }; // 受理即完成（少见但存在）
  });
  const res = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/member/order/${o.outTradeNo}/refund`,
    headers: auth(alice), payload: { reasonCode: '1', note: '用着不舒服' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  assert.equal(d.status, 'refunded');
  assert.equal(d.refundFeeFen, 199, 'day-0 剩余 30/30 天＝全额');
  assert.equal(d.refundedFen, 199);
  assert.equal(refundBodies[0].refund_reason, '1', '发微信的 refund_reason 是枚举码');
  assert.equal(refundBodies[0].req_from, '2', '用户自助退款的 req_from=2');
  const row = await XpayOrderModel.findById(o._id).lean();
  assert.equal(row?.status, 'refunded');
  assert.match(String(row?.refundReason), /^\[产品问题，影响使用或效果不佳\]用着不舒服$/);
  const e = await entitlementsOf(String(uid));
  assert.ok(e.memberUntil <= Date.now(), '全额退款后会员立即截断');
});

test('MF-1b iOS 订单同样可自助退款：走同一条微信退款链路', async () => {
  const o = await mkDelivered({ channel: 'ios', periodStart: Date.now() - 3600_000 });
  const refundBodies: Array<Record<string, unknown>> = [];
  __setXpayFetcherForTest(async (api, body) => {
    if (api === 'query_order') return { errcode: 0, order: { status: 3, left_fee: 199 } };
    refundBodies.push(body as Record<string, unknown>);
    return { errcode: 0, refund_id: 'rfIOS', status: 5 };
  });
  const res = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/member/order/${o.outTradeNo}/refund`,
    headers: auth(alice), payload: { reasonCode: '1' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().data.status, 'refunded');
  assert.equal(refundBodies[0].req_from, '2', 'iOS 自助退款同样 req_from=2');
  const row = await XpayOrderModel.findById(o._id).lean();
  assert.equal(row?.status, 'refunded');
});

test('MF-2 闸门：别人的单 404；created 不可退；原因/说明校验', async () => {
  const bobRow = await mkRow({}, BOB);
  const alien = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/member/order/${bobRow.outTradeNo}/refund`,
    headers: auth(alice), payload: { reasonCode: '1' },
  });
  assert.equal(alien.statusCode, 404, '越权按 404');

  const created = await mkRow();
  const bad = async (payload: Record<string, unknown>, outTradeNo: string) => app.inject({
    method: 'POST', url: `${config.apiPrefix}/member/order/${outTradeNo}/refund`,
    headers: auth(alice), payload,
  });
  assert.equal((await bad({ reasonCode: '1' }, created.outTradeNo)).statusCode, 400, '仅已生效可退');
  const iosRow = await mkDelivered({ channel: 'ios' });
  const iosNoReason = await bad({}, iosRow.outTradeNo);
  assert.equal(iosNoReason.statusCode, 400, 'iOS 单不再按渠道拦');
  assert.match(iosNoReason.json().message, /请选择退款原因/, '照样走到原因校验');
  const live = await mkDelivered();
  const noReason = await bad({}, live.outTradeNo);
  assert.equal(noReason.statusCode, 400);
  assert.match(noReason.json().message, /请选择退款原因/);
  const zero = await bad({ reasonCode: '0' }, live.outTradeNo);
  assert.equal(zero.statusCode, 400, '「暂无描述」不给用户选');
  const long = await bad({ reasonCode: '1', note: '字'.repeat(101) }, live.outTradeNo);
  assert.equal(long.statusCode, 400);
});

test('MF-3 退款中重试：refundOrderId 复用同值（微信要求重试同单号）', async () => {
  const o = await mkDelivered();
  __setXpayFetcherForTest(async (api) => {
    if (api === 'query_order') return { errcode: 0, order: { status: 3, left_fee: 199 } };
    return { errcode: 0, refund_id: 'rfU2', status: 3 }; // 受理、处理中（非 done）
  });
  const p = { reasonCode: '2', note: '' };
  const first = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/member/order/${o.outTradeNo}/refund`, headers: auth(alice), payload: p,
  });
  const second = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/member/order/${o.outTradeNo}/refund`, headers: auth(alice), payload: p,
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().data.refundOrderId, first.json().data.refundOrderId, '重试复用同一退款单号');
  assert.equal(second.json().data.status, 'refunding');
});
