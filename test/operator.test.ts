/**
 * 运营者接口（role=admin 微信用户＝站内运营者，2026-11-04）。
 * 逐条：未登录 401 / 普通用户 403 / me 与概览 / 列表多状态 / 移动端退款（req_from=1
 * 走管理端同链路）/ iOS 单 403 指引。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/operator.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { XpayOrderModel } from '../src/models/xpay-order.model.js';
import { UserModel } from '../src/models/user.model.js';
import { AppSettingModel } from '../src/models/app-setting.model.js';
import { __setXpayFetcherForTest } from '../src/services/xpay-api.js';
import { setMemberPaymentsEnabled, resetMemberSwitchCacheForTest, MEMBER_SWITCH_KEY } from '../src/services/member-switch.js';
import { seedPaidProducts } from '../src/services/paid-products.js';

let app: FastifyInstance;
const RUN = Date.now().toString(36);
const OP = `operator_test_${RUN}`;
const NORMAL = `operator_norm_${RUN}`;
const DAY = 86_400_000;
let opToken = '';
let normToken = '';
let opUid = '';
let seq = 0;

async function login(openid: string) {
  const res = await app.inject({ method: 'POST', url: `${config.apiPrefix}/auth/login`, payload: { code: `openid:${openid}` } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.accessToken as string;
}

async function mk(over: Record<string, unknown> = {}) {
  seq += 1;
  const u = await UserModel.findOne({ openid: OP }).lean();
  return XpayOrderModel.create({
    outTradeNo: `OPR${RUN}${String(seq).padStart(3, '0')}`.slice(0, 32),
    userId: u?._id, openid: OP,
    productKey: 'month_card', name: '会员月卡', priceFen: 199, durationDays: 30,
    perksSnapshot: { adFree: true, exportBundle: true, photoQuota: 300, subscribeNotice: true },
    status: 'delivered', periodStart: Date.now() - 3600_000, periodEnd: Date.now() + 30 * DAY,
    leftFeeFen: 199, leftFeeAt: Date.now(),
    attach: '', channel: 'android', ...over,
  });
}

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  app = await buildApp({ logger: false });
  await app.ready();
  await seedPaidProducts();
  opToken = await login(OP);
  normToken = await login(NORMAL);
  const u = await UserModel.findOne({ openid: OP }).lean();
  opUid = String(u?._id);
  await UserModel.updateOne({ _id: u?._id }, { $set: { role: 'admin' } });
  await setMemberPaymentsEnabled(true);
});
beforeEach(async () => {
  await XpayOrderModel.deleteMany({ openid: OP });
  resetMemberSwitchCacheForTest();
  __setXpayFetcherForTest(async () => ({ errcode: 0, order: { status: 0, left_fee: 0 } }));
});
after(async () => {
  await XpayOrderModel.deleteMany({ openid: OP });
  await UserModel.deleteMany({ openid: { $in: [OP, NORMAL] } });
  await AppSettingModel.deleteMany({ _id: MEMBER_SWITCH_KEY });
  resetMemberSwitchCacheForTest();
  __setXpayFetcherForTest(null);
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

test('OP-1 闸门：未登录 401；普通用户 403（仅运营者可用）', async () => {
  const anon = await app.inject({ method: 'GET', url: `${config.apiPrefix}/operator/stats/summary` });
  assert.equal(anon.statusCode, 401);
  const norm = await app.inject({ method: 'GET', url: `${config.apiPrefix}/operator/stats/summary`, headers: auth(normToken) });
  assert.equal(norm.statusCode, 403);
  assert.match(norm.json().message, /仅运营者可用/);
});

test('OP-2 me：返回 uid/nickname/role/能力清单', async () => {
  const res = await app.inject({ method: 'GET', url: `${config.apiPrefix}/operator/me`, headers: auth(opToken) });
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  assert.equal(d.role, 'admin');
  assert.deepEqual(d.capabilities, ['stats', 'orders', 'refund']);
});

test('OP-3 概览：today/yesterday 两个自然日的六项指标齐备', async () => {
  const res = await app.inject({ method: 'GET', url: `${config.apiPrefix}/operator/stats/summary`, headers: auth(opToken) });
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  for (const key of ['today', 'yesterday']) {
    for (const f of ['uv', 'pv', 'tracksCreated', 'tracksFinished', 'newUsers']) {
      assert.equal(typeof d[key][f], 'number', `${key}.${f}`);
    }
  }
});

test('OP-4 列表默认只看已生效+退款中；多状态过滤', async () => {
  await mk(); // delivered
  await mk({ status: 'refunding' });
  await mk({ status: 'created' }); // 不应出现在默认列表
  await mk({ status: 'closed' });
  const res = await app.inject({
    method: 'GET', url: `${config.apiPrefix}/operator/orders`, headers: auth(opToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  const statuses = res.json().data.items.map((i: { status: string }) => i.status);
  assert.deepEqual([...new Set(statuses)].sort(), ['delivered', 'refunding'], 'created/closed 不在默认视图');
  const single = await app.inject({
    method: 'GET', url: `${config.apiPrefix}/operator/orders?status=created`, headers: auth(opToken),
  });
  assert.equal(single.json().data.items.length, 1, '可按单状态覆盖');
});

test('OP-5 移动端退款：预览 → 发起（req_from=1、审计含 operator:）→ iOS 单 403', async () => {
  const o = await mk();
  const bodies: Array<Record<string, unknown>> = [];
  __setXpayFetcherForTest(async (api, body) => {
    if (api === 'query_order') return { errcode: 0, order: { status: 3, left_fee: 199 } };
    bodies.push(body as Record<string, unknown>);
    return { errcode: 0, refund_id: 'rfOP', status: 3 };
  });
  const pv = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/operator/orders/${o._id}/refund-preview`, headers: auth(opToken),
  });
  assert.equal(pv.statusCode, 200, pv.body);
  assert.equal(pv.json().data.canRefund, true);
  assert.equal(pv.json().data.suggestFeeFen, 199, 'day-0 建议全额');

  const res = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/operator/orders/${o._id}/refund`,
    headers: auth(opToken), payload: { refundFee: 199, reasonCode: '3', reason: '用户申请' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().data.status, 'refunding');
  assert.equal(bodies[0].refund_reason, '3');
  assert.equal(bodies[0].req_from, '1', '运营者代客服发起');
  assert.equal((await XpayOrderModel.findById(o._id).lean())?.status, 'refunding');

  const ios = await mk({ channel: 'ios', status: 'delivered', periodStart: Date.now() - 3600_000, periodEnd: Date.now() + 30 * DAY });
  const denied = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/operator/orders/${ios._id}/refund`,
    headers: auth(opToken), payload: { refundFee: 100, reasonCode: '3', reason: '' },
  });
  assert.equal(denied.statusCode, 403, 'iOS 单仍按渠道拦（690000020）');
  assert.match(denied.json().message, /App Store/);
});
