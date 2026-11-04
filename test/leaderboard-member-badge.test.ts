import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { XpayOrderModel } from '../src/models/xpay-order.model.js';

/**
 * 榜单头像会员徽标：服务端按「付费会员订单区间」给每一行下发 memberActive。
 * - 只认会员订单（delivered/refunding/refunded），不含积分免广告卡；
 * - 过期单、退款截断到当前之前的单都不算；
 * - TOP10 用户端口径仍不暴露 userId。
 */
let app: FastifyInstance;
const NOW = Date.now();
const PREFIX = 'openid:lb-member-badge';
const PROV = '会员徽标测试省';

async function createUser(nick: string, distance: number) {
  const u = await UserModel.create({ openid: `${PREFIX}-${nick}`, nickname: nick, gender: 1 });
  await ActivityModel.create({
    userId: u._id, type: 'running', status: 'finished',
    startTime: NOW - 86400000, endTime: NOW - 86400000 + 600000,
    duration: 600, distance, provinces: [PROV], startProvince: PROV, trackPoints: [], markers: [],
  });
  return u;
}

async function createOrder(userId: unknown, openid: string, periodStart: number, periodEnd: number, truncatedAt = 0) {
  return XpayOrderModel.create({
    outTradeNo: `LBMB${Math.random().toString(36).slice(2, 10)}`,
    userId,
    openid,
    productKey: 'month_card',
    name: '会员月卡',
    priceFen: 199,
    durationDays: 30,
    status: 'delivered',
    periodStart,
    periodEnd,
    truncatedAt,
  });
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const ids = (await UserModel.find({ openid: new RegExp(`^${PREFIX}`) }).select('_id').lean()).map((u) => u._id);
  if (ids.length) {
    await ActivityModel.deleteMany({ userId: { $in: ids } });
    await XpayOrderModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  }
  const active = await createUser('会员甲', 3000);
  const expired = await createUser('过期乙', 2000);
  const cut = await createUser('截断丙', 1000);
  await createOrder(active._id, active.openid, NOW - 86400000, NOW + 86400000 * 10);
  await createOrder(expired._id, expired.openid, NOW - 86400000 * 30, NOW - 3600000);
  // 退款截断到过去：区间原本覆盖现在，但权益已在 1 小时前截断 → 不是会员
  await createOrder(cut._id, cut.openid, NOW - 86400000, NOW + 86400000 * 10, Math.floor((NOW - 3600000) / 1000));
});

after(async () => {
  const ids = (await UserModel.find({ openid: new RegExp(`^${PREFIX}`) }).select('_id').lean()).map((u) => u._id);
  if (ids.length) {
    await ActivityModel.deleteMany({ userId: { $in: ids } });
    await XpayOrderModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  }
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

const API = '/sport-track/api/stats';

test('LBMB1 榜单行下发 memberActive：只有当前生效的付费会员为 true', async () => {
  const res = await app.inject({ method: 'GET', url: `${API}/leaderboard?type=running&period=all&province=${encodeURIComponent(PROV)}` });
  assert.equal(res.statusCode, 200, res.body);
  const rows = res.json().data.top as Array<{ rank: number; memberActive: boolean; userId?: string }>;
  assert.equal(rows.length, 3, '专属省份榜只有这 3 个用户');
  assert.equal(rows[0].memberActive, true, '距离第一的生效会员');
  assert.equal(rows[1].memberActive, false, '过期单不算');
  assert.equal(rows[2].memberActive, false, '退款截断到当前之前不算');
  for (const r of rows) assert.equal('userId' in r, false, '用户端口径仍不暴露 userId');
});

test('LBMB2 本榜最佳行也带 memberActive', async () => {
  const res = await app.inject({ method: 'GET', url: `${API}/leaderboard?type=running&period=all&province=${encodeURIComponent(PROV)}` });
  const best = res.json().data.best as Array<{ key: string; memberActive: boolean }>;
  const farthest = best.find((b) => b.key === 'farthest');
  assert.ok(farthest, '应有最长距离纪录');
  assert.equal(farthest!.memberActive, true, '纪录保持者（会员甲）带徽标');
});
