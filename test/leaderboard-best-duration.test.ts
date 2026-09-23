import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';

/**
 * 本榜最佳「最长距离」带回运动时长（durationSec）。
 * 用户口径：每个分类的最长距离都要能看出这条纪录跑了多久（前端同排显示「12.34 km · 1:23:45」）。
 * 断言用「播种一条绝对最大距离」保证确定性（dev 库共享，正常数据都在 30km 内），用完全部删除。
 * 注意：durationSec 只挂 farthest，其它指标（最快配速/最大爬升）不带。
 */

let app: FastifyInstance;
let token = '';
let userId = '';
const seeded: string[] = [];

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

async function seedActivity(fields: Record<string, unknown>) {
  const doc = await ActivityModel.create({ userId, status: 'finished', startTime: NOW, ...fields });
  seeded.push(String(doc._id));
  return doc;
}

async function fetchBest(type: string): Promise<Array<{ key: string; value: number; durationSec?: number }>> {
  const res = await app.inject({
    method: 'GET',
    url: `/sport-track/api/stats/leaderboard?type=${type}&period=all`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.best;
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const me = await loginMock('mock_openid_lb_best_duration');
  userId = me.userId;
  token = me.token;
  await ActivityModel.deleteMany({ userId });
});

after(async () => {
  // 播的百万米级数据是测试专用，必须清掉，别留在 dev 榜单上
  if (seeded.length) await ActivityModel.deleteMany({ _id: { $in: seeded } });
  await UserModel.deleteMany({ _id: userId });
  await app.close();
});

test('BD1 最长距离条目带回该纪录的运动时长（durationSec，秒）', async () => {
  await seedActivity({ type: 'walking', distance: 9999999, duration: 5000 }); // 5000s ≈ 1:23:20

  const best = await fetchBest('walking');
  const farthest = best.find((b) => b.key === 'farthest');
  assert.ok(farthest, '散步榜应有最长距离条目');
  assert.equal(farthest!.value, 9999999);
  assert.equal(farthest!.durationSec, 5000, '最长距离要能看出这条纪录跑了多久');
});

test('BD2 其它指标不带 durationSec（只有最长距离需要）', async () => {
  await seedActivity({ type: 'running', distance: 9999998, duration: 3000, fastestKm: 240 });

  const best = await fetchBest('running');
  const farthest = best.find((b) => b.key === 'farthest');
  const fastest = best.find((b) => b.key === 'fastestKm');
  assert.ok(farthest && fastest, '跑步榜应有最长距离与最快配速两条');
  assert.equal(farthest!.durationSec, 3000, '最长距离条目要带时长');
  assert.equal(fastest!.durationSec, undefined, '最快配速是配速纪录，不挂运动时长');
});

test('BD3 纪录时长为 0（老数据/未记录）时不下发 durationSec', async () => {
  await seedActivity({ type: 'swimming', distance: 9999997, duration: 0 });

  const best = await fetchBest('swimming');
  const farthest = best.find((b) => b.key === 'farthest');
  assert.ok(farthest, '游泳榜应有最长距离条目');
  assert.equal(farthest!.value, 9999997);
  assert.equal(farthest!.durationSec, undefined, '没有可信时长就不下发，前端别显示 0:00');
});
