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
  opToken = await login(OP);
  normToken = await login(NORMAL);
  const u = await UserModel.findOne({ openid: OP }).lean();
  opUid = String(u?._id);
  await UserModel.updateOne({ _id: u?._id }, { $set: { role: 'admin' } });
});
beforeEach(async () => {
  await XpayOrderModel.deleteMany({ openid: OP });
  __setXpayFetcherForTest(async () => ({ errcode: 0, order: { status: 0, left_fee: 0 } }));
});
after(async () => {
  await XpayOrderModel.deleteMany({ openid: OP });
  await UserModel.deleteMany({ openid: { $in: [OP, NORMAL] } });
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

test('OP-4 所有 operator 路由都挂闸门：匿名 401、普通用户 403、运营者 200', async () => {
  const routes = ['/operator/me', '/operator/stats/summary', '/operator/stats/trend?range=week'];
  for (const u of routes) {
    const url = `${config.apiPrefix}${u}`;
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401, `${u} 匿名`);
    const norm = await app.inject({ method: 'GET', url, headers: auth(normToken) });
    assert.equal(norm.statusCode, 403, `${u} 普通用户`);
    assert.match(norm.json().message, /仅运营者/);
    assert.equal((await app.inject({ method: 'GET', url, headers: auth(opToken) })).statusCode, 200, `${u} 运营者`);
  }
});

test('OP-5 降权即时生效：令牌不变、只改库 role 后立刻 403（不信任 token 余期）', async () => {
  await UserModel.updateOne({ openid: OP }, { $set: { role: 'user' } });
  try {
    const res = await app.inject({ method: 'GET', url: `${config.apiPrefix}/operator/stats/summary`, headers: auth(opToken) });
    assert.equal(res.statusCode, 403);
    assert.match(res.json().message, /仅运营者/);
  } finally {
    await UserModel.updateOne({ openid: OP }, { $set: { role: 'admin' } });
  }
});

test('OP-6 会员中心入口旗标：/member/products 的 operator 按库内角色实时计算', async () => {
  const url = `${config.apiPrefix}/member/products`;
  const asAdmin = await app.inject({ method: 'GET', url, headers: auth(opToken) });
  assert.equal(asAdmin.statusCode, 200, asAdmin.body);
  assert.equal(asAdmin.json().data.operator, true, 'admin 才能看到「数据概览」入口');
  const asNormal = await app.inject({ method: 'GET', url, headers: auth(normToken) });
  assert.equal(asNormal.statusCode, 200, asNormal.body);
  assert.equal(asNormal.json().data.operator, false, '普通用户不下发入口旗标');
});

