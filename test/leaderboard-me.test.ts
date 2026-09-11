import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { periodStartMs } from '../src/services/leaderboard.js';

/**
 * /stats/leaderboard/me 测试：单次聚合返回当前用户各类型榜名次
 * - 断言方式：库内数据非独占（dev 库共享），用与服务端同口径计算期望名次后比对
 * - 周期外活动不计入（用本人 distance/count 确定性断言验证）
 * - 无活动用户 ranks=[] best=null；非法 period 400
 */

let app: FastifyInstance;
let token = '';
let userId = '';
const userTokens: Array<{ userId: string; token: string }> = [];

const DAY = 86400000;
const NOW = Date.now();

async function loginMock(openid: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: openid },
  });
  assert.equal(res.statusCode, 200, `登录失败: ${res.body}`);
  const body = res.json().data;
  return { userId: body.user?.id ?? body.user?._id, token: body.accessToken };
}

async function seedActivity(uid: string, fields: Record<string, unknown>) {
  await ActivityModel.create({ userId: uid, status: 'finished', startTime: NOW, ...fields });
}

/** 与服务端同口径计算期望名次（周期 finished 总距离降序取位次） */
async function expectedRank(type: string, uid: string, startMs: number | null): Promise<number | null> {
  const match: Record<string, unknown> = { status: 'finished', type };
  if (startMs !== null) match.startTime = { $gte: startMs };
  const rows = await ActivityModel.aggregate([
    { $match: match },
    { $group: { _id: '$userId', distance: { $sum: '$distance' } } },
    { $sort: { distance: -1 } },
  ]);
  const idx = rows.findIndex((r) => String(r._id) === String(uid));
  return idx >= 0 ? idx + 1 : null;
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  // 当前用户：先清历史（mock openid 稳定复用），保证本人 distance/count 断言确定性
  const pre = await loginMock('mock_openid_lb_me');
  await ActivityModel.deleteMany({ userId: pre.userId });
  await UserModel.deleteMany({ _id: pre.userId });
  const me = await loginMock('mock_openid_lb_me');
  token = me.token;
  userId = me.userId;
  userTokens.push(me);

  // 对手用户（同周期造数据，制造名次竞争）
  userTokens.push(await loginMock('mock_openid_lb_me_rival1'));
  userTokens.push(await loginMock('mock_openid_lb_me_rival2'));
});

after(async () => {
  for (const { userId: uid } of userTokens) {
    await ActivityModel.deleteMany({ userId: uid }).catch(() => {});
    await UserModel.deleteMany({ _id: uid }).catch(() => {});
  }
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

test('各类型名次一次返回，best 取名次最优', async () => {
  // 本周期数据：running 榜我 3000m、rival1 10000m 在我前；cycling 榜 rival2 9000m > 我 5000m > rival1 1000m
  await seedActivity(userTokens[1].userId, { type: 'running', distance: 10000 });
  await seedActivity(userTokens[1].userId, { type: 'cycling', distance: 1000 });
  await seedActivity(userTokens[2].userId, { type: 'cycling', distance: 9000 });
  // 本人：running 3000m + 上周期外 999999m（验证周期过滤）+ cycling 5000m
  await seedActivity(userId, { type: 'running', distance: 3000 });
  await seedActivity(userId, { type: 'running', distance: 999999, startTime: NOW - 14 * DAY });
  await seedActivity(userId, { type: 'cycling', distance: 5000 });

  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/leaderboard/me?period=week',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.equal(data.period, 'week');
  assert.equal(data.province, '全国');

  // 周期过滤确定性断言：本人 running 只计本周 3000m（周期外 999999m 不计入）
  const running = data.ranks.find((r: { type: string }) => r.type === 'running');
  const cycling = data.ranks.find((r: { type: string }) => r.type === 'cycling');
  assert.ok(running, 'running 应上榜');
  assert.ok(cycling, 'cycling 应上榜');
  assert.equal(running.distanceKm, 3);
  assert.equal(running.count, 1);

  // 名次与共享库实际数据同口径比对
  const weekStart = periodStartMs('week', new Date(NOW));
  assert.equal(running.rank, await expectedRank('running', userId, weekStart));
  assert.equal(cycling.rank, await expectedRank('cycling', userId, weekStart));

  // best = 名次最靠前（同名词次距离远者在前）
  const bestExpected = [...data.ranks].sort(
    (a: { rank: number; distanceKm: number }, b: { rank: number; distanceKm: number }) =>
      a.rank - b.rank || b.distanceKm - a.distanceKm,
  )[0];
  assert.deepEqual(data.best, bestExpected);
});

test('无活动用户 ranks 为空、best 为 null', async () => {
  const fresh = await loginMock('mock_openid_lb_me_fresh');
  userTokens.push(fresh);
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/leaderboard/me?period=week',
    headers: { authorization: `Bearer ${fresh.token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.deepEqual(data.ranks, []);
  assert.equal(data.best, null);
});

test('本榜最佳：骑行最快均速按 distance/duration 计算（avgPace 为 null 也能出）', async () => {
  await seedActivity(userTokens[1].userId, { type: 'cycling', distance: 30000, duration: 7200 }); // 15 km/h
  await seedActivity(userTokens[2].userId, { type: 'cycling', distance: 20000, duration: 3600 }); // 20 km/h

  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/leaderboard?type=cycling&period=all',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const bestRows = res.json().data.best as Array<{ key: string; value: number }>;
  const avg = bestRows.find((b) => b.key === 'fastestAvg');
  assert.ok(avg, '骑行应返回 fastestAvg 最佳（旧口径用 avgPace，恒为空）');

  // 与库内同口径计算的最快均速比对
  const [expected] = await ActivityModel.aggregate<{ speedKmh: number }>([
    { $match: { status: 'finished', type: 'cycling', duration: { $gt: 0 }, distance: { $gt: 0 } } },
    { $addFields: { speedKmh: { $divide: [{ $multiply: ['$distance', 3.6] }, '$duration'] } } },
    { $sort: { speedKmh: -1 } },
    { $limit: 1 },
    { $project: { speedKmh: 1 } },
  ]);
  assert.ok(expected, '应有骑行数据');
  assert.ok(
    Math.abs(avg!.value - expected.speedKmh) < 1e-6,
    `最快均速应为 ${expected.speedKmh} km/h，实际 ${avg!.value}`,
  );
  assert.ok(avg!.value > 0, '均速应大于 0');
});

test('非法 period 返回 400', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/leaderboard/me?period=bogus',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 400);
});
