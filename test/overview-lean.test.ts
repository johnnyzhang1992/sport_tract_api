import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';

/**
 * /overview lean 模式测试：lean=1 不下发 tracks[].points 与 heat（报告页/年度报告瘦身）
 * - 先清 mock 用户历史，种子数据确定性
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
  const pre = await loginMock('mock_openid_overview_lean');
  await ActivityModel.deleteMany({ userId: pre.userId });
  await UserModel.deleteMany({ _id: pre.userId });
  const me = await loginMock('mock_openid_overview_lean');
  token = me.token;
  userId = me.userId;
  await ActivityModel.create({
    userId,
    type: 'running',
    status: 'finished',
    startTime: NOW,
    distance: 3000,
    duration: 1800,
    calories: 200,
    trackPoints: [
      { seq: 1, lat: 30.0, lng: 114.0, timestamp: NOW },
      { seq: 2, lat: 30.001, lng: 114.001, timestamp: NOW + 60000 },
    ],
  });
});

after(async () => {
  await ActivityModel.deleteMany({ userId }).catch(() => {});
  await UserModel.deleteMany({ _id: userId }).catch(() => {});
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

test('lean=1：不下发 points 与 heat，汇总照常', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/overview?range=all&lean=1',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.equal(data.count, 1);
  assert.equal(data.tracks.length, 1);
  assert.equal(data.tracks[0].points, undefined, 'lean 模式不应下发 points');
  assert.deepEqual(data.heat, [], 'lean 模式 heat 应为空');
});

test('默认模式：points 照常下发（轨迹合集页不受影响）', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/overview?range=all',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.ok(Array.isArray(data.tracks[0].points), '默认模式应下发 points');
  assert.ok(data.heat.length > 0, '默认模式应计算热力');
});
