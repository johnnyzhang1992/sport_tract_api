/**
 * 管理端订单闭环（spec §6.3 的三步退款，一步都不许跳）：
 * OA-1 鉴权：五条路由 401/403，不许 404；
 * OA-2 预览必须先刷 leftFee（query_order 失败 → canRefund false + 原因）；
 * OA-3 建议值算例（月卡第 10 天 132 分、年卡第 300 天 302 分）；
 * OA-4 refundFee 越界（0 / 负 / > leftFee）→ 400，句子含实际值与上限；
 * OA-5 备注必填；
 * OA-6 refundOrderId 生成后落库、重试复用同值；
 * OA-7 iOS 渠道禁用退款（403 + 由用户在 App Store 申请）；
 * OA-8 超过 365 天窗口拒绝发起；
 * OA-9 列表过滤 + keyword 转义；
 * OA-10 手动查单查到已支付即补发货。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/admin-xpay-orders.test.ts
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
import { __setEntitlementFetchersForTest } from '../src/services/entitlements.js';
import { listXpayOrders, LEFT_FEE_FRESH_MS } from '../src/services/xpay-admin.js';

const DAY = 86_400_000;
const RUN = Date.now().toString(36);
const OPENID = `axo_${RUN}`;
let app: FastifyInstance;
let token = '';
let uid: Types.ObjectId;
let seq = 0;

async function mk(over: Record<string, unknown> = {}) {
  seq += 1;
  return XpayOrderModel.create({
    outTradeNo: `AXO${RUN}${String(seq).padStart(3, '0')}`.slice(0, 32),
    wxOrderId: `axowx${RUN}${seq}`.slice(0, 32),
    userId: uid, openid: OPENID,
    productKey: 'month_card', name: '会员月卡', priceFen: 199, durationDays: 30,
    perksSnapshot: { adFree: true, exportBundle: true, photoQuota: 300, subscribeNotice: true },
    status: 'delivered',
    periodStart: Date.now() - 10 * DAY, periodEnd: Date.now() + 20 * DAY,
    leftFeeFen: 199, leftFeeAt: Date.now(),
    ...over,
  });
}

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  // 发货要按 userId 反查用户（OA-10），所以这里得有一个真用户，不能随手 new ObjectId
  const u = await UserModel.findOneAndUpdate(
    { openid: OPENID },
    { $setOnInsert: { openid: OPENID, nickname: 'axo 测试' } },
    { upsert: true, new: true, lean: true },
  );
  uid = (u as { _id: Types.ObjectId })._id;
  app = await buildApp({ logger: false });
  await app.ready();
  const res = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/admin/login`,
    payload: { username: config.adminUsername, password: config.adminPassword },
  });
  token = res.json().data.token as string;
});
beforeEach(async () => {
  await XpayOrderModel.deleteMany({ openid: OPENID });
  __setEntitlementFetchersForTest(null);
});
after(async () => {
  await XpayOrderModel.deleteMany({ openid: OPENID });
  await UserModel.deleteOne({ openid: OPENID });
  __setXpayFetcherForTest(null);
  __setEntitlementFetchersForTest(null);
  await app.close();
  await mongoose.disconnect().catch(() => {});
});
const H = () => ({ authorization: `Bearer ${token}` });

test('OA-1 五条订单路由都要过鉴权且不许是 404', async () => {
  const id = String(new Types.ObjectId());
  const cases: Array<[string, string]> = [
    ['GET', '/admin/xpay/orders'],
    ['GET', `/admin/xpay/orders/${id}`],
    ['POST', `/admin/xpay/orders/${id}/refund-preview`],
    ['POST', `/admin/xpay/orders/${id}/refund`],
    ['POST', `/admin/xpay/orders/${id}/query`],
  ];
  for (const [method, path] of cases) {
    const res = await app.inject({ method: method as never, url: `${config.apiPrefix}${path}` });
    assert.ok(res.statusCode === 401 || res.statusCode === 403, `${method} ${path} → ${res.statusCode}`);
  }
});

test('OA-2 query_order 失败时预览给出 canRefund=false 与实际原因，且不用库里旧额度', async () => {
  const o = await mk();
  __setXpayFetcherForTest(async () => ({ errcode: 48001, errmsg: 'api unauthorized' }));
  const res = await app.inject({ method: 'POST', url: `${config.apiPrefix}/admin/xpay/orders/${o._id}/refund-preview`, headers: H() });
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  assert.equal(d.canRefund, false);
  assert.match(d.reason ?? '', /48001/);
  assert.equal(d.leftFeeFen, 0, '不许把库里旧的 leftFeeFen 当成可用依据');
});

test('OA-3 建议值＝按剩余天数折算（月卡第 10 天 132 分；年卡第 300 天 302 分）', async () => {
  __setXpayFetcherForTest(async () => ({ errcode: 0, order: { status: 1, left_fee: 199, order_no: 'x' } }));
  const m = await mk();
  let r = await app.inject({ method: 'POST', url: `${config.apiPrefix}/admin/xpay/orders/${m._id}/refund-preview`, headers: H() });
  assert.equal(r.json().data.suggestFeeFen, 132);
  assert.equal(r.json().data.leftFeeFen, 199);
  assert.equal(r.json().data.canRefund, true);

  const y = await mk({
    productKey: 'year_card', name: '会员年卡', priceFen: 1699, durationDays: 365,
    periodStart: Date.now() - 300 * DAY, periodEnd: Date.now() + 65 * DAY, leftFeeFen: 1699,
  });
  __setXpayFetcherForTest(async () => ({ errcode: 0, order: { status: 1, left_fee: 1699, order_no: 'y' } }));
  r = await app.inject({ method: 'POST', url: `${config.apiPrefix}/admin/xpay/orders/${y._id}/refund-preview`, headers: H() });
  assert.equal(r.json().data.suggestFeeFen, 302);
});

test('OA-4 refundFee 越界 → 400，句子含对象 + 实际值 + 上限', async () => {
  const o = await mk({ leftFeeFen: 99, leftFeeAt: Date.now() });
  for (const refundFee of [0, -5, 100, 99999]) {
    const res = await app.inject({
      method: 'POST', url: `${config.apiPrefix}/admin/xpay/orders/${o._id}/refund`,
      headers: H(), payload: { refundFee, reason: '测试' },
    });
    assert.equal(res.statusCode, 400, `${refundFee}: ${res.body}`);
    assert.match(res.json().message, /99/, `要含上限：${res.json().message}`);
    assert.match(res.json().message, new RegExp(String(refundFee).replace('-', '\\-')), `要含实际值：${res.json().message}`);
  }
});

test('OA-4b 可退额度超过 5 分钟未刷新 → 拒绝（不许拿旧值猜）', async () => {
  const o = await mk({ leftFeeFen: 199, leftFeeAt: Date.now() - LEFT_FEE_FRESH_MS - 1000 });
  const res = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/admin/xpay/orders/${o._id}/refund`,
    headers: H(), payload: { refundFee: 100, reason: '测试' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /重新预览/);
});

test('OA-5 备注（reason）必填', async () => {
  const o = await mk();
  for (const reason of [undefined, '', '   ']) {
    const res = await app.inject({
      method: 'POST', url: `${config.apiPrefix}/admin/xpay/orders/${o._id}/refund`,
      headers: H(), payload: { refundFee: 100, reason },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /备注/);
  }
});

test('OA-6 refundOrderId 生成后落库，重试复用同值', async () => {
  const seen: string[] = [];
  __setXpayFetcherForTest(async (api, body) => {
    seen.push(String(body.refund_id));
    return api === 'refund_order'
      ? { errcode: 0, status: 3 }
      : { errcode: 0, order: { status: 1, left_fee: 199, order_no: 'x' } };
  });
  const o = await mk();
  const first = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/admin/xpay/orders/${o._id}/refund`,
    headers: H(), payload: { refundFee: 100, reason: '客服协商' },
  });
  assert.equal(first.statusCode, 200, first.body);
  const id1 = first.json().data.refundOrderId as string;
  assert.ok(id1);
  assert.equal((await XpayOrderModel.findById(o._id).lean())?.status, 'refunding');
  const second = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/admin/xpay/orders/${o._id}/refund`,
    headers: H(), payload: { refundFee: 50, reason: '重试' },
  });
  assert.equal(second.json().data.refundOrderId, id1, '重试必须复用同一退款单号');
  assert.equal(seen.filter((s) => s === id1).length, 2);
});

test('OA-7 iOS 渠道退款按钮禁用：403 且说明由用户在 App Store 申请', async () => {
  const o = await mk({ channel: 'ios' });
  const res = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/admin/xpay/orders/${o._id}/refund`,
    headers: H(), payload: { refundFee: 100, reason: '测试' },
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().message, /App Store/);
  const p = await app.inject({ method: 'POST', url: `${config.apiPrefix}/admin/xpay/orders/${o._id}/refund-preview`, headers: H() });
  assert.equal(p.json().data.canRefund, false);
});

test('OA-8 超过支付后 365 天窗口 → 拒绝发起（提前给明确原因）', async () => {
  const o = await mk({ leftFeeFen: 100, leftFeeAt: Date.now() });
  // 走原生驱动：mongoose 的 timestamps 会把这个字段当只读，普通 updateOne 写不进去
  await XpayOrderModel.collection.updateOne({ _id: o._id }, { $set: { createdAt: new Date(Date.now() - 400 * DAY) } });
  const res = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/admin/xpay/orders/${o._id}/refund`,
    headers: H(), payload: { refundFee: 100, reason: '测试' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /365/);
});

test('OA-9 列表过滤 + keyword 转义（畸形串不许打挂查询）', async () => {
  await mk({ status: 'delivered', channel: 'android' });
  await mk({ status: 'refunded', channel: 'ios' });
  const mine = (r: { items: Array<{ openid: string }> }) => r.items.filter((i) => i.openid === OPENID).length;

  const all = await listXpayOrders({ page: 1, pageSize: 50, keyword: OPENID });
  assert.equal(mine(all), 2);
  const onlyRefunded = await listXpayOrders({ status: 'refunded', page: 1, pageSize: 50, keyword: OPENID });
  assert.equal(mine(onlyRefunded), 1);
  assert.ok(onlyRefunded.items.every((i) => i.status === 'refunded'));
  await assert.rejects(() => listXpayOrders({ status: 'nonsense', page: 1, pageSize: 50 }), /状态/);
  await assert.rejects(() => listXpayOrders({ channel: 'pc', page: 1, pageSize: 50 }), /渠道/);
  // 未转义时这是一个非法正则（会抛 SyntaxError 变成 500）；转义后只是一个搜不到的普通串
  const weird = await listXpayOrders({ keyword: 'a(', page: 1, pageSize: 50 });
  assert.equal(mine(weird), 0, '括号必须被转义，不能当正则元字符');
});

test('OA-10 手动查单查到已支付即补发货（幂等仍生效）', async () => {
  const o = await mk({ status: 'paid', wxOrderId: '', periodStart: 0, periodEnd: 0 });
  __setXpayFetcherForTest(async (_api, body) => ({
    errcode: 0,
    order: { status: 1, left_fee: 199, order_no: `manual_${String((body as { out_trade_no?: string }).out_trade_no)}` },
  }));
  const res = await app.inject({ method: 'POST', url: `${config.apiPrefix}/admin/xpay/orders/${o._id}/query`, headers: H() });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().data.paid, true);
  const row = await XpayOrderModel.findById(o._id).lean();
  assert.equal(row?.status, 'delivered');
  assert.ok((row?.periodEnd ?? 0) > (row?.periodStart ?? 0));
});
