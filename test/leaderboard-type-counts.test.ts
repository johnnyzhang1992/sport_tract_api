import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { ACTIVITY_TYPES } from '../src/config/constants.js';

/**
 * GET /stats/leaderboard-type-counts 测试：运动榜分类 chips 排序依据
 * - 8 个运动类型零填充全下发（前端才能区分"0 条"和"接口没这项"）
 * - 只计 status:'finished'（与榜单同口径；未完成/已取消不算有人玩）
 * - 榜外脏 type 不冒出来
 * - 库是共享 dev 库，计数一律用「种数据前后差值」断言，不写绝对值
 */

let app: FastifyInstance;
let token = '';
let userId = '';
const NOW = Date.now();

async function loginMock(openid: string) {
  const res = await app.inject({ method: 'POST', url: '/sport-track/api/auth/login', payload: { code: openid } });
  assert.equal(res.statusCode, 200, `登录失败: ${res.body}`);
  const body = res.json().data;
  return { userId: body.user?.id ?? body.user?._id, token: body.accessToken };
}

async function counts(period = ''): Promise<Array<{ type: string; count: number }>> {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/leaderboard-type-counts' + (period ? `?period=${period}` : ''),
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.types;
}

const pick = (rows: Array<{ type: string; count: number }>, type: string) =>
  rows.find((r) => r.type === type)?.count ?? 0;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pre = await loginMock('mock_openid_type_counts');
  await ActivityModel.deleteMany({ userId: pre.userId });
  await UserModel.deleteMany({ _id: pre.userId });
  const me = await loginMock('mock_openid_type_counts');
  token = me.token;
  userId = me.userId;
});

after(async () => {
  await ActivityModel.deleteMany({ userId }).catch(() => {});
  await UserModel.deleteMany({ _id: userId }).catch(() => {});
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

test('TC1 八个运动类型零填充全下发', async () => {
  const rows = await counts();
  assert.deepEqual(
    rows.map((r) => r.type).sort(),
    [...ACTIVITY_TYPES].sort(),
    '下发类型集合应与后端 ACTIVITY_TYPES 一致',
  );
  rows.forEach((r) => assert.equal(typeof r.count, 'number', `${r.type} 的 count 必须是数字（0 也要给）`));
});

test('TC2 计数只认 finished：种 3 条完成 + 1 条进行中，只涨 3', async () => {
  const beforeSwim = pick(await counts(), 'swimming');
  await ActivityModel.create([
    { userId, type: 'swimming', status: 'finished', distance: 800, startTime: NOW },
    { userId, type: 'swimming', status: 'finished', distance: 900, startTime: NOW },
    { userId, type: 'swimming', status: 'finished', distance: 1000, startTime: NOW },
    { userId, type: 'swimming', status: 'in_progress', distance: 5000, startTime: NOW },
  ]);
  const afterSwim = pick(await counts(), 'swimming');
  assert.equal(afterSwim - beforeSwim, 3, '进行中的轨迹不该进榜计数');
});

test('TC3 榜外脏 type 不冒出来、也不影响任何一项', async () => {
  const snapshot = await counts();
  // 绕过 schema 枚举：模拟历史上被砍掉、库里还留着的那种 type
  await ActivityModel.collection.insertOne({
    userId: new mongoose.Types.ObjectId(userId),
    type: 'yoga',
    status: 'finished',
    distance: 1,
    startTime: NOW,
  });
  const rows = await counts();
  assert.ok(!rows.some((r) => r.type === 'yoga'), '响应里不该出现榜外类型');
  assert.deepEqual(
    rows.map((r) => `${r.type}:${r.count}`),
    snapshot.map((r) => `${r.type}:${r.count}`),
    '榜外类型不该串改进合法计数',
  );
});

test('TC4 未登录可看（2026-10-26 改可选鉴权：游客可浏览榜单）', async () => {
  const res = await app.inject({ method: 'GET', url: '/sport-track/api/stats/leaderboard-type-counts' });
  assert.equal(res.statusCode, 200);
});


test('TC6 period 过滤：本周的数据在 week 下计入、all 下也计入（week 是 all 的子集）', async () => {
  // 本周种 2 条 cycling
  await ActivityModel.create([
    { userId, type: 'cycling', status: 'finished', distance: 3000, startTime: NOW },
    { userId, type: 'cycling', status: 'finished', distance: 3000, startTime: NOW },
  ]);
  const weekRows = await counts('week');
  assert.ok(pick(weekRows, 'cycling') >= 2, '本周 cycling 应计入 week');
  const allRows = await counts('all');
  assert.ok(pick(allRows, 'cycling') >= pick(weekRows, 'cycling'), 'all 计数应 ≥ week');
});

test('TC7 period 缺省为 week：旧数据（一年前）不计入缺省，计入 all', async () => {
  // 一年前的 hiking：week/month 都不该算，all 要算
  // 计数是全平台口径（不按用户过滤），共享 dev 库里别人本周的 hiking 也会被计进来，
  // 所以只能断言「种数据前后的差值」，不能写绝对值
  const defBefore = pick(await counts(''), 'hiking');
  const allBefore = pick(await counts('all'), 'hiking');
  await ActivityModel.create({
    userId,
    type: 'hiking',
    status: 'finished',
    distance: 5000,
    startTime: NOW - 365 * 86400000,
  });
  const defAfter = pick(await counts(''), 'hiking');
  const allAfter = pick(await counts('all'), 'hiking');
  assert.equal(defAfter - defBefore, 0, `缺省（week）不该计一年前的数据，实际多计 ${defAfter - defBefore}`);
  assert.ok(allAfter - allBefore >= 1, 'all 应计入一年前的 hiking');
});