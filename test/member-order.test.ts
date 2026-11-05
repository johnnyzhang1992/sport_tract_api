/**
 * 建单与会员页接口（spec §6.1、§7.1、§9）。
 * 关键闸门逐条单独变异：开关关 / 密钥未配 / 商品下架 / code 换出的 openid 与登录用户不是同一个人 /
 * outTradeNo 形态 / 轮询只能读自己的单。
 * 用注入的假 fetcher 与 mock 登录（WX_MOCK_LOGIN=true，openid 是 'openid:' 前缀直接透传）。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/member-order.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import mongoose, { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { XpayOrderModel } from '../src/models/xpay-order.model.js';
import { PaidProductModel } from '../src/models/paid-product.model.js';
import { UserModel } from '../src/models/user.model.js';
import { genOutTradeNo } from '../src/services/xpay-orders.js';
import { __setXpayFetcherForTest } from '../src/services/xpay-api.js';
import { setMemberPaymentsEnabled, resetMemberSwitchCacheForTest, MEMBER_SWITCH_KEY } from '../src/services/member-switch.js';
import { __setEntitlementFetchersForTest } from '../src/services/entitlements.js';
import { seedPaidProducts } from '../src/services/paid-products.js';
import { __setPayConfigForTest } from '../src/config/xpay.js';
import { AppSettingModel } from '../src/models/app-setting.model.js';
import { MEMBER_PHOTO_QUOTA } from '../src/config/member-copy.js';
import {
  MEMBER_CLOSED, ORDER_IDENTITY_MISMATCH, ORDER_PRODUCT_UNAVAILABLE, ORDER_SESSION_EXPIRED,
} from '../src/config/member-copy.js';

let app: FastifyInstance;
const RUN = Date.now().toString(36);
const OPENID = `member_test_${RUN}`;
let token = '';

async function login(openid = OPENID) {
  const res = await app.inject({ method: 'POST', url: `${config.apiPrefix}/auth/login`, payload: { code: `openid:${openid}` } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.accessToken as string;
}

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  app = await buildApp({ logger: false });
  await app.ready();
  await seedPaidProducts();
  // 两把钥匙用假值：既让下单链路可跑，又不把真密钥写进测试
  __setPayConfigForTest({ offerId: 'offer-test', appKey: 'platform-key-test' });
  token = await login();
});
beforeEach(async () => {
  await XpayOrderModel.deleteMany({ openid: OPENID });
  resetMemberSwitchCacheForTest();
  await setMemberPaymentsEnabled(true);
  __setXpayFetcherForTest(async () => ({ errcode: 0, order: { status: 0, left_fee: 0 } }));
  __setEntitlementFetchersForTest(null);
});
after(async () => {
  await XpayOrderModel.deleteMany({ openid: OPENID });
  await AppSettingModel.deleteMany({ _id: MEMBER_SWITCH_KEY });
  resetMemberSwitchCacheForTest();
  __setPayConfigForTest(null);
  __setXpayFetcherForTest(null);
  __setEntitlementFetchersForTest(null);
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

test('MO-1 outTradeNo 形态：8–32 位且不以下划线开头；500 次不撞号', () => {
  for (let i = 0; i < 200; i++) {
    const n = genOutTradeNo(String(new Types.ObjectId()));
    assert.match(n, /^[A-Za-z0-9][A-Za-z0-9_-]{7,31}$/, `形态不符: ${n}`);
  }
  assert.equal(new Set(Array.from({ length: 500 }, () => genOutTradeNo(String(new Types.ObjectId())))).size, 500, '500 次不能撞号');
  // 同一个用户、同一毫秒连下两单（双击/重试）也必须拿到不同单号——这才是随机段存在的理由：
  // 光靠「时间戳 + userId 尾号」，同毫秒必撞 outTradeNo 唯一索引
  const uid = String(new Types.ObjectId());
  const sameMs = Array.from({ length: 50 }, () => genOutTradeNo(uid, 1_800_000_000_000));
  assert.equal(new Set(sameMs).size, 50, '同用户同毫秒必须靠随机段区分');
});

test('MO-2 下单返回 payData 三件套，且服务端不下发任何密钥类字段', async () => {
  const res = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/member/order`,
    headers: { authorization: `Bearer ${token}` },
    payload: { productKey: 'month_card', code: `openid:${OPENID}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  assert.equal(d.mode, 'short_series_goods');
  assert.equal(d.buyQuantity, 1);
  assert.ok(d.payData.signData && d.payData.paySig && d.payData.signature);
  const parsed = JSON.parse(d.payData.signData);
  assert.equal(parsed.goodsPrice, 199);
  assert.equal(parsed.productId, 'month_card');
  assert.equal(parsed.outTradeNo, d.outTradeNo);
  assert.equal(parsed.env, 0);
  assert.ok(!/appKey|session_key|sessionKey|secret/i.test(res.body), '响应体里不许出现密钥类字段名');

  const row = await XpayOrderModel.findOne({ outTradeNo: d.outTradeNo }).lean();
  assert.equal(row?.status, 'created');
  assert.equal(row?.priceFen, 199);
  assert.equal(row?.durationDays, 30);
  assert.equal(row?.openid, OPENID);
});

test('MO-3 开关关闭时下单 403（端上入口已隐藏，服务端仍要拦：开关是钱闸）', async () => {
  await setMemberPaymentsEnabled(false);
  const res = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/member/order`,
    headers: { authorization: `Bearer ${token}` },
    payload: { productKey: 'month_card', code: `openid:${OPENID}` },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().message, MEMBER_CLOSED);
  assert.equal(await XpayOrderModel.countDocuments({ openid: OPENID }), 0, '被拒的下单不许留行');
});

test('MO-4 商品不存在/已下架 → 400 且用批准文案（MC-21）', async () => {
  for (const productKey of ['nope_card', 'season_card']) {
    if (productKey === 'season_card') await PaidProductModel.updateOne({ key: 'season_card' }, { $set: { active: false } });
    const res = await app.inject({
      method: 'POST', url: `${config.apiPrefix}/member/order`,
      headers: { authorization: `Bearer ${token}` },
      payload: { productKey, code: `openid:${OPENID}` },
    });
    assert.equal(res.statusCode, 400, `${productKey}: ${res.statusCode}`);
    assert.equal(res.json().message, ORDER_PRODUCT_UNAVAILABLE);
    assert.equal(await XpayOrderModel.countDocuments({ openid: OPENID }), 0, '被拒的下单不许留行');
  }
  await PaidProductModel.updateOne({ key: 'season_card' }, { $set: { active: true } });
});

test('MO-5 code 换出的 openid 与登录用户不一致 → 400（不许用别人的会话密钥挂我的单）', async () => {
  const res = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/member/order`,
    headers: { authorization: `Bearer ${token}` },
    payload: { productKey: 'month_card', code: 'openid:someone_else_openid' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().message, ORDER_IDENTITY_MISMATCH);
});

test('MO-5b 缺 code → 会话过期文案（服务端不猜）', async () => {
  const res = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/member/order`,
    headers: { authorization: `Bearer ${token}` },
    payload: { productKey: 'month_card' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().message, ORDER_SESSION_EXPIRED);
});

test('MO-6 轮询只能读自己的单：别人的 outTradeNo → 404；畸形单号也是 404（不 500）', async () => {
  const mine = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/member/order`,
    headers: { authorization: `Bearer ${token}` },
    payload: { productKey: 'month_card', code: `openid:${OPENID}` },
  });
  const outTradeNo = mine.json().data.outTradeNo as string;
  const ok = await app.inject({ method: 'GET', url: `${config.apiPrefix}/member/order/${outTradeNo}`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().data.status, 'created');

  const otherOpenid = `member_other_${RUN}`;
  const otherToken = await login(otherOpenid);
  const steal = await app.inject({ method: 'GET', url: `${config.apiPrefix}/member/order/${outTradeNo}`, headers: { authorization: `Bearer ${otherToken}` } });
  assert.equal(steal.statusCode, 404);

  const bad = await app.inject({ method: 'GET', url: `${config.apiPrefix}/member/order/short`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(bad.statusCode, 404, '畸形单号按资源不存在处理，不落 500');

  await XpayOrderModel.deleteMany({ openid: otherOpenid });
  await UserModel.deleteMany({ openid: otherOpenid });
});

test('MO-7 GET /member/products：开关关时 enabled=false 且 items 为空（端上整块隐藏入口）', async () => {
  await setMemberPaymentsEnabled(false);
  const res = await app.inject({ method: 'GET', url: `${config.apiPrefix}/member/products`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.enabled, false);
  assert.deepEqual(res.json().data.items, []);
});

test('MO-8 GET /member/products：三档齐全、价格/日均/权益行由服务端下发（端上不自算）', async () => {
  const res = await app.inject({ method: 'GET', url: `${config.apiPrefix}/member/products`, headers: { authorization: `Bearer ${token}` } });
  const d = res.json().data;
  assert.equal(d.enabled, true);
  assert.deepEqual(d.items.map((i: { key: string }) => i.key), ['month_card', 'season_card', 'year_card']);
  assert.equal(d.items[0].priceText, '1.99 元');
  assert.equal(d.items[0].perDayText, '约 0.07 元/天');
  assert.equal(d.items[2].perDayText, '约 0.05 元/天');
  assert.deepEqual(d.items[0].perkLines, ['免广告', '多条轨迹打包导出 GPX', `照片额度 ${MEMBER_PHOTO_QUOTA} 张`, '订阅消息提醒']);
  assert.equal(typeof d.entitlements.memberUntil, 'number');
  assert.equal(d.statusText, '', '从没开通过的用户没有状态行');
});

test('MO-9 四个会员接口都要登录（无 token → 401，且不许是 404）', async () => {
  const cases: Array<[string, string]> = [
    ['GET', '/member/products'],
    ['GET', '/member/entitlements'],
    ['GET', '/member/order/ST12345678'],
    ['POST', '/member/order'],
  ];
  for (const [method, path] of cases) {
    const res = await app.inject({ method: method as never, url: `${config.apiPrefix}${path}`, payload: method === 'POST' ? {} : undefined });
    assert.equal(res.statusCode, 401, `${method} ${path} → ${res.statusCode}`);
  }
});

test('MO-10 建单时把目录的 name/priceFen/durationDays/perks 快照进订单（改目录不影响历史单）', async () => {
  const res = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/member/order`,
    headers: { authorization: `Bearer ${token}` },
    payload: { productKey: 'year_card', code: `openid:${OPENID}` },
  });
  const outTradeNo = res.json().data.outTradeNo as string;
  await PaidProductModel.updateOne({ key: 'year_card' }, { $set: { priceFen: 1, name: '改名', durationDays: 1 } });
  const row = await XpayOrderModel.findOne({ outTradeNo }).lean();
  assert.equal(row?.priceFen, 1699);
  assert.equal(row?.name, '会员年卡');
  assert.equal(row?.durationDays, 365);
  assert.equal(row?.perksSnapshot.photoQuota, MEMBER_PHOTO_QUOTA);
  await PaidProductModel.updateOne({ key: 'year_card' }, { $set: { priceFen: 1699, name: '会员年卡', durationDays: 365 } });
});
