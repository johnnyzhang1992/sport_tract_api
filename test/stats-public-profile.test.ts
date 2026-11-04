import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { XpayOrderModel } from '../src/models/xpay-order.model.js';

/**
 * 榜单用户公开资料：点击排行榜用户列的半屏数据源。
 * 只下发白名单字段 + 累计八项（轨迹/公里/省份/城市/时长/爬升/千卡/运动类型）；
 * 不返回 openid、settings、身高体重等私密字段。
 */
let app: FastifyInstance;
const NOW = Date.now();
const PREFIX = 'openid:public-profile';
const UID = 990777;
const PROV = '公开资料测试省';
let userId = '';

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const old = await UserModel.find({ openid: new RegExp(`^${PREFIX}`) }).select('_id').lean();
  if (old.length) {
    const ids = old.map((u) => u._id);
    await ActivityModel.deleteMany({ userId: { $in: ids } });
    await XpayOrderModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  }
  const u = await UserModel.create({ openid: `${PREFIX}-a`, uid: UID, nickname: '公开甲', avatarUrl: 'https://oss.example.com/u/public-a.jpg', avatarPreset: 'p1' });
  userId = String(u._id);
  await UserModel.collection.updateOne(
    { _id: u._id },
    {
      $set: {
        createdAt: new Date(NOW - 10 * 86400000),
        footprintCache: { provinceCount: 4, cityCount: 7, provinces: [], cities: [] },
        footprintDirty: false,
      },
    },
  );
  await ActivityModel.create({
    userId: u._id, type: 'running', status: 'finished', provinces: [PROV], startProvince: PROV,
    startTime: NOW - 86400000, endTime: NOW - 86400000 + 600000,
    duration: 600, distance: 5000, elevationGain: 1200, calories: 300, trackPoints: [], markers: [],
  });
  await ActivityModel.create({
    userId: u._id, type: 'walking', status: 'finished', provinces: [PROV], startProvince: PROV,
    startTime: NOW - 2 * 86400000, endTime: NOW - 2 * 86400000 + 900000,
    duration: 900, distance: 3000, elevationGain: 0, calories: 0, trackPoints: [], markers: [],
  });
  await XpayOrderModel.create({
    outTradeNo: 'PUBLICPROFILE1', wxOrderId: 'PUBLICPROFILE1',
    userId: u._id, openid: u.openid, productKey: 'month_card', name: '会员月卡',
    priceFen: 199, durationDays: 30, status: 'delivered',
    periodStart: NOW - 86400000, periodEnd: NOW + 10 * 86400000,
  });
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

test('PPROF1 公开资料：白名单字段 + 累计八项，不含私密字段', async () => {
  const res = await app.inject({ method: 'GET', url: `${API}/profile/${UID}` });
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  assert.equal(d.uid, UID);
  assert.equal(d.nickname, '公开甲');
  assert.ok(d.joinDays >= 10, '加入天数按 createdAt 计算');
  assert.equal(d.memberActive, true);
  assert.equal(d.total.count, 2);
  assert.equal(d.total.distance, 8000);
  assert.equal(d.total.typeCount, 2, '运动类型数 = finished 类型去重');
  assert.equal(d.total.elevationGain, 1200);
  assert.equal(d.total.calories, 300);
  assert.equal(d.footprint.provinceCount, 4);
  assert.equal(d.footprint.cityCount, 7);
  assert.ok(d.avatarLargeUrl, '头像大图 URL 要下发（预览用）');
  assert.deepEqual(
    Object.keys(d).sort(),
    ['avatarLargeUrl', 'avatarPreset', 'avatarUrl', 'footprint', 'joinDays', 'memberActive', 'nickname', 'total', 'uid'].sort(),
    '顶层字段必须严格是白名单',
  );
  for (const secret of ['openid', 'settings', 'heightCm', 'weightKg', 'userId']) {
    assert.equal(secret in d, false, `不得下发 ${secret}`);
  }
});

test('PPROF2 非法 / 不存在的 UID', async () => {
  let res = await app.inject({ method: 'GET', url: `${API}/profile/abc` });
  assert.equal(res.statusCode, 400);
  res = await app.inject({ method: 'GET', url: `${API}/profile/99999999` });
  assert.equal(res.statusCode, 404);
});

test('PPROF3 榜单行带公开 uid（用于点开资料）', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `${API}/leaderboard?type=running&period=all&province=${encodeURIComponent(PROV)}`,
  });
  assert.equal(res.statusCode, 200, res.body);
  const top = res.json().data.top as Array<{ uid: number }>;
  assert.equal(top[0]?.uid, UID);
});
