import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { bjDateStr, bjToday0 } from '../src/utils/bj-time.js';

/**
 * 统计页增强能力：
 * - 距离里程碑奖杯（1K/5K/10K/半马/全马最快）
 * - 平台累计距离分位（超越全站 XX%）
 * - 趋势接口按运动类型筛选
 */

let app: FastifyInstance;
let token = '';
let userId = '';
const extraUserIds: string[] = [];

const DAY = 86400000;

async function login(code: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code },
  });
  assert.equal(res.statusCode, 200);
  return res.json().data;
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  // 清理上次异常退出留下的同名用户
  const stale = await UserModel.find({ openid: /mock_openid_stats_extras/ }).select('_id').lean();
  for (const u of stale) {
    await ActivityModel.deleteMany({ userId: u._id });
    await UserModel.deleteOne({ _id: u._id });
  }
  const me = await login('mock_openid_stats_extras_me');
  userId = me.user.id;
  token = me.accessToken;
});

after(async () => {
  const ids = [userId, ...extraUserIds].filter(Boolean);
  for (const id of ids) {
    await ActivityModel.deleteMany({ userId: id }).catch(() => {});
    await UserModel.deleteOne({ _id: id }).catch(() => {});
  }
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

async function createTrack(over: Record<string, unknown>) {
  return ActivityModel.create({
    userId,
    status: 'finished',
    type: 'running',
    startTime: Date.now() - 3 * DAY,
    endTime: Date.now() - 3 * DAY + 3600000,
    duration: 3600,
    distance: 1000,
    trackPoints: [],
    markers: [],
    ...over,
  });
}

test('best.milestones：1K/5K/10K 取最快纪录，半马/全马取达标轨迹中最短用时', async () => {
  await ActivityModel.deleteMany({ userId });
  const t = Date.now() - 10 * DAY;
  // A：5K/10K 最快；达到半马距离
  await createTrack({
    startTime: t,
    duration: 3600,
    distance: 22000,
    fastestKm: 300,
    pbMarks: [
      { km: 5, sec: 1500 },
      { km: 10, sec: 3100 },
      { km: 20, sec: 6600 },
    ],
  });
  // B：全马唯一达标（用时较长）
  await createTrack({
    startTime: t + DAY,
    duration: 15000,
    distance: 45000,
    fastestKm: 290,
    pbMarks: [
      { km: 5, sec: 1600 },
      { km: 10, sec: 3200 },
      { km: 40, sec: 13000 },
    ],
  });
  // C：只有 1K 最快，未达 5K
  await createTrack({
    startTime: t + 2 * DAY,
    duration: 900,
    distance: 3000,
    fastestKm: 280,
    pbMarks: [],
  });

  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/best',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.ok(Array.isArray(data.milestones), '缺少 milestones');

  const map = new Map<string, any>(data.milestones.map((m: any) => [m.key, m]));
  assert.equal(map.get('1k')?.sec, 280, '1K 取全局最快 1km 分段');
  assert.equal(map.get('5k')?.sec, 1500, '5K 取最快里程碑');
  assert.equal(map.get('10k')?.sec, 3100, '10K 取最快里程碑');
  assert.equal(map.get('half')?.sec, 3600, '半马取达标轨迹最短用时');
  assert.equal(map.get('full')?.sec, 15000, '全马取达标轨迹最短用时');
  assert.equal(map.size, 5, '五项里程碑均达成');
  for (const m of data.milestones) {
    assert.ok(m.id, `${m.key} 应带轨迹 id`);
    assert.equal(m.type, 'running');
  }
});

test('best.milestones：未达标的里程碑不下发（前端显示未解锁）', async () => {
  await ActivityModel.deleteMany({ userId });
  await createTrack({ distance: 6000, duration: 1800, fastestKm: 330, pbMarks: [{ km: 5, sec: 1600 }] });

  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/best',
    headers: { authorization: `Bearer ${token}` },
  });
  const keys = res.json().data.milestones.map((m: any) => m.key);
  assert.deepEqual(keys, ['1k', '5k']);
});

test('stats/percentile：累计距离超越全站用户占比', async () => {
  await ActivityModel.deleteMany({ userId });
  await createTrack({ distance: 10000, duration: 3600 });

  const otherA = await login('mock_openid_stats_extras_a');
  extraUserIds.push(otherA.user.id);
  const otherB = await login('mock_openid_stats_extras_b');
  extraUserIds.push(otherB.user.id);
  await createTrack({ userId: otherA.user.id, distance: 5000, duration: 1800 });
  await createTrack({ userId: otherB.user.id, distance: 20000, duration: 7200 });
  // 非 finished 不计入
  await createTrack({ userId: otherA.user.id, status: 'in_progress', distance: 99999 });

  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/percentile',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.myDistance, 10000, '只统计本人 finished 累计距离');
  assert.ok(data.usersTotal >= 3, '至少包含三位有成绩的用户');
  // 期望值从库里独立统计（避免被同库其它用户数据影响）
  const rows = await ActivityModel.aggregate([
    { $match: { status: 'finished' } },
    { $group: { _id: '$userId', distance: { $sum: '$distance' } } },
  ]);
  const below = rows.filter((r) => r.distance < 10000).length;
  assert.equal(data.betterThan, below);
  assert.equal(data.percentile, Math.floor((below / rows.length) * 100));
});

test('stats/trend?activityType=：只聚合指定运动类型', async () => {
  await ActivityModel.deleteMany({ userId });
  const today0 = bjToday0();
  const day = today0 - 3 * DAY + 9 * 3600 * 1000;
  await createTrack({ type: 'running', startTime: day, distance: 2000, duration: 600 });
  await createTrack({ type: 'walking', startTime: day, distance: 3000, duration: 1200 });

  const key = bjDateStr(day);
  const filtered = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/trend?type=week&activityType=running',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(filtered.statusCode, 200);
  const row = filtered.json().data.data.find((r: any) => r.date === key);
  assert.equal(row.distance, 2000, '仅跑步距离');
  assert.equal(row.count, 1);

  const all = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/trend?type=week',
    headers: { authorization: `Bearer ${token}` },
  });
  const allRow = all.json().data.data.find((r: any) => r.date === key);
  assert.equal(allRow.distance, 5000, '不传类型时聚合全部');
});

test('stats/trend：每桶带 calories 与 standstillMs（消耗要日均、配速要剔静止）', async () => {
  await ActivityModel.deleteMany({ userId });
  const today0 = bjToday0();
  const day = today0 - 2 * DAY + 9 * 3600 * 1000;
  await createTrack({ startTime: day, distance: 2000, duration: 900, calories: 150, standstillMs: 120000 });
  await createTrack({ startTime: day + 3600 * 1000, distance: 1000, duration: 600, calories: 80, standstillMs: 30000 });

  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/trend?type=week',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const rows = res.json().data.data as any[];
  const key = bjDateStr(day);
  const row = rows.find((r) => r.date === key);
  assert.ok(row, '当天有桶');
  assert.equal(row.calories, 230, '当天两次运动消耗之和');
  assert.equal(row.standstillMs, 150000, '静止时长用来把配速的静止扣掉');

  // 没运动的日子补 0 而不是 undefined：端上直接参与求和/相除
  const empty = rows.find((r) => r.date !== key && r.distance === 0);
  assert.ok(empty, '周视图里必有无运动日');
  assert.equal(empty.calories, 0);
  assert.equal(empty.standstillMs, 0);
});

test('stats/trend?activityType=：非法运动类型返回 400', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/trend?type=week&activityType=dancing',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 400);
});

test('best：物理上不可能的里程成绩被剔除，回落到下一条有效纪录', async () => {
  await ActivityModel.deleteMany({ userId });
  // 脏数据：14.5km 只用了 123s，5K 标记 70s
  await createTrack({ distance: 14492, duration: 123, fastestKm: 4, pbMarks: [{ km: 5, sec: 70 }, { km: 10, sec: 100 }] });
  // 合法：5K 25 分钟
  await createTrack({ distance: 6000, duration: 1600, fastestKm: 300, pbMarks: [{ km: 5, sec: 1500 }] });
  // 达标半马但用时不可能（22km / 5min）+ 一条合法半马（22km / 2h）
  await createTrack({ distance: 22000, duration: 300, fastestKm: 4, pbMarks: [] });
  await createTrack({ distance: 22000, duration: 7200, fastestKm: 300, pbMarks: [] });

  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/best',
    headers: { authorization: `Bearer ${token}` },
  });
  const data = res.json().data;
  const map = new Map<string, any>(data.milestones.map((m: any) => [m.key, m]));
  assert.equal(map.get('5k')?.sec, 1500, '5K 应跳过不可能的 70s');
  assert.equal(map.has('10k'), false, '10K 的 100s 不可能，且没有其它有效纪录');
  assert.equal(map.get('half')?.sec, 7200, '半马应跳过 5 分钟的脏轨迹');
  assert.equal(map.has('full'), false);

  const km5 = data.fastestDistanceByKm.filter((r: any) => r.km === 5);
  assert.equal(km5.length, 1);
  assert.equal(km5[0].sec, 1500, '距离 PB 列表同口径剔除不可能成绩');
});
