import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';

/**
 * /overview 下发 startProvince：轨迹合集页的「省份筛选」靠它在前端聚合候选与条数
 * （不新增聚合接口，与足迹页同一套做法：候选来自未过滤快照）。
 * 老数据/导入数据可能没有省（模型默认空串），断言空串照常下发、不炸。
 * 同时钉住「from/to 精确区间」这条历史年份筛选要走的路径。
 */

let app: FastifyInstance;
let token = '';
let userId = '';
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

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pre = await loginMock('mock_openid_overview_province');
  await ActivityModel.deleteMany({ userId: pre.userId });
  await UserModel.deleteMany({ _id: pre.userId });
  const me = await loginMock('mock_openid_overview_province');
  token = me.token;
  userId = me.userId;
  await ActivityModel.create([
    {
      userId,
      type: 'running',
      status: 'finished',
      startTime: NOW,
      distance: 3000,
      duration: 1800,
      startProvince: '湖北省',
      startCity: '武汉市',
      trackPoints: [
        { seq: 1, lat: 30.0, lng: 114.0, timestamp: NOW },
        { seq: 2, lat: 30.001, lng: 114.001, timestamp: NOW + 60000 },
      ],
    },
    {
      // 老数据：没有省市（默认空串）
      userId,
      type: 'walking',
      status: 'finished',
      startTime: NOW - 86400000,
      distance: 1000,
      duration: 600,
      trackPoints: [
        { seq: 1, lat: 31.0, lng: 121.0, timestamp: NOW - 86400000 },
        { seq: 2, lat: 31.001, lng: 121.001, timestamp: NOW - 86400000 + 60000 },
      ],
    },
  ]);
});

after(async () => {
  await ActivityModel.deleteMany({ userId }).catch(() => {});
  await UserModel.deleteMany({ _id: userId }).catch(() => {});
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

test('默认模式：每条轨迹都带 startProvince（没有省的老数据下发空串）', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/overview?range=all',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const tracks: Array<{ startProvince?: unknown }> = res.json().data.tracks;
  assert.equal(tracks.length, 2);
  const provinces = tracks.map((t) => t.startProvince).sort();
  assert.deepEqual(provinces, ['', '湖北省'], `每条轨迹都要下发 startProvince，实际 ${JSON.stringify(provinces)}`);
});

test('lean 模式：元数据里也带 startProvince（两种模式共用同一份 DTO）', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/overview?range=all&lean=1',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const tracks: Array<{ startProvince?: unknown }> = res.json().data.tracks;
  assert.ok(tracks.length > 0);
  assert.ok(
    tracks.every((t) => typeof t.startProvince === 'string'),
    'lean 模式也要有 startProvince，否则两种模式的 DTO 会分叉',
  );
});

test('from/to 精确区间：历史年份筛选按自然年区间取数（省份照样下发）', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sport-track/api/overview?from=${NOW - 1000}&to=${NOW + 60000}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.equal(data.count, 1, '只应命中今天那条');
  assert.equal(data.tracks[0].startProvince, '湖北省');
});
