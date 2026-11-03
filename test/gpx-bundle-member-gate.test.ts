/**
 * 多条轨迹打包改读权益层（spec §5.4 第 4 处判据）。
 * 三条都要钉：非会员 403（整句文案来自服务端）、会员放行到原有链路、
 * 单条导出仍然免费——本轮只收紧打包这一条路，别顺手把单条也锁了。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/gpx-bundle-member-gate.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { XpayOrderModel } from '../src/models/xpay-order.model.js';
import { UserModel } from '../src/models/user.model.js';
import { __setEntitlementFetchersForTest } from '../src/services/entitlements.js';
import { GPX_BUNDLE_MEMBER_REQUIRED } from '../src/config/member-copy.js';

let app: FastifyInstance;
const RUN = Date.now().toString(36);
const OPENID = `gpxgate_${RUN}`;
const DAY = 86_400_000;

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  app = await buildApp({ logger: false });
  await app.ready();
});
after(async () => {
  await XpayOrderModel.deleteMany({ openid: OPENID });
  __setEntitlementFetchersForTest(null);
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

async function token() {
  const res = await app.inject({
    method: 'POST',
    url: `${config.apiPrefix}/auth/login`,
    payload: { code: `openid:${OPENID}`, platform: 'ios' },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.accessToken as string;
}

async function grantMembership() {
  const u = await UserModel.findOne({ openid: OPENID }).select('_id').lean();
  assert.ok(u?._id, '登录后应能查到用户');
  await XpayOrderModel.deleteMany({ openid: OPENID });
  await XpayOrderModel.create({
    outTradeNo: `GGB${RUN}`.slice(0, 32), wxOrderId: `ggbwx_${RUN}`.slice(0, 32),
    userId: u._id, openid: OPENID, productKey: 'month_card', name: '会员月卡',
    priceFen: 199, durationDays: 30, status: 'delivered',
    periodStart: Date.now() - DAY, periodEnd: Date.now() + DAY,
    perksSnapshot: { adFree: true, exportBundle: true, photoQuota: 300, subscribeNotice: true },
  });
}

test('GGB-1 非会员请求打包 → 403 且整句服务端下发', async () => {
  const t = await token();
  const res = await app.inject({
    method: 'GET',
    url: `${config.apiPrefix}/activities/export/gpx?ids=000000000000000000000001`,
    headers: { authorization: `Bearer ${t}` },
  });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().message, GPX_BUNDLE_MEMBER_REQUIRED);
});

test('GGB-2 会员（一条覆盖当下的 delivered 订单）放行（不再 403）', async () => {
  const t = await token();
  await grantMembership();
  __setEntitlementFetchersForTest(null);
  const res = await app.inject({
    method: 'GET',
    url: `${config.apiPrefix}/activities/export/gpx?ids=000000000000000000000001`,
    headers: { authorization: `Bearer ${t}` },
  });
  assert.notEqual(res.statusCode, 403, `仍被判非会员：${res.statusCode} ${res.body.slice(0, 200)}`);
});

test('GGB-3 单条 /:id/gpx 不受会员闸门影响（本轮只收紧打包这一条路）', async () => {
  await XpayOrderModel.deleteMany({ openid: OPENID }); // 先退回非会员
  const t = await token();
  const res = await app.inject({
    method: 'GET',
    url: `${config.apiPrefix}/activities/000000000000000000000001/gpx`,
    headers: { authorization: `Bearer ${t}` },
  });
  assert.notEqual(res.statusCode, 403);
});
