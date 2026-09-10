import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';

/**
 * /stats/activity-monthly 测试：按月聚合当前用户某类型的全量 次数/距离/时长/千卡
 * - 测试前清空 mock 用户历史 → 本人聚合结果确定性可断言
 * - 仅统计 finished + 指定类型；非法 type 400
 */

let app: FastifyInstance;
let token = '';
let userId = '';

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

async function seed(uid: string, fields: Record<string, unknown>) {
  await ActivityModel.create({ userId: uid, status: 'finished', startTime: NOW, ...fields });
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  // 清历史（mock openid 稳定复用）保证聚合确定性
  const pre = await loginMock('mock_openid_act_monthly');
  await ActivityModel.deleteMany({ userId: pre.userId });
  await UserModel.deleteMany({ _id: pre.userId });
  const me = await loginMock('mock_openid_act_monthly');
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

test('按月聚合：仅 finished + 指定类型，每月汇总正确', async () => {
  // 本月：running 2 条（距离/时长/千卡可加和）；walking 1 条与 in_progress 1 条不参与
  await seed(userId, { type: 'running', distance: 3000, duration: 1800, calories: 200 });
  await seed(userId, { type: 'running', distance: 1500, duration: 900, calories: 100 });
  await seed(userId, { type: 'walking', distance: 9999, duration: 999, calories: 99 });
  await seed(userId, { type: 'running', distance: 7777, duration: 777, calories: 77, status: 'in_progress' });
  // 上月：running 1 条
  await seed(userId, { type: 'running', distance: 5000, duration: 3000, calories: 350, startTime: NOW - 35 * DAY });

  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/activity-monthly?type=running',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.equal(data.type, 'running');
  assert.ok(Array.isArray(data.months) && data.months.length >= 2, '应至少包含本月与上月');

  interface MonthRow {
    year: number;
    month: number;
    count: number;
    distance: number;
    duration: number;
    calories: number;
  }
  const byKey = new Map<string, MonthRow>(
    data.months.map((m: MonthRow) => [`${m.year}-${m.month}`, m]),
  );
  const dNow = new Date(NOW);
  const dPrev = new Date(NOW - 35 * DAY);
  const cur = byKey.get(`${dNow.getFullYear()}-${dNow.getMonth() + 1}`);
  const prev = byKey.get(`${dPrev.getFullYear()}-${dPrev.getMonth() + 1}`);
  assert.ok(cur, '本月聚合行应存在');
  assert.ok(prev, '上月聚合行应存在');
  assert.deepEqual(
    { count: cur.count, distance: cur.distance, duration: cur.duration, calories: cur.calories },
    { count: 2, distance: 4500, duration: 2700, calories: 300 },
  );
  assert.equal(prev.count, 1);
  assert.equal(prev.distance, 5000);

  // 倒序：本月在前
  assert.ok(data.months[0].year * 12 + data.months[0].month >= data.months[1].year * 12 + data.months[1].month);
});

test('非法 type 返回 400', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/activity-monthly?type=bogus',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 400);
});

test('活动列表附带页内月份的全量聚合（带 type 时）', async () => {
  // 复用上一测试的种子：本月 running 2 条（4500m/2700s/300kcal）、上月 1 条、本月 walking 1 条
  const withType = await app.inject({
    method: 'GET',
    url: '/sport-track/api/activities?type=running',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(withType.statusCode, 200, withType.body);
  const ok = withType.json().data;
  assert.ok(Array.isArray(ok.monthlyStats), '响应应包含 monthlyStats');
  const dNow = new Date(NOW);
  const cur = ok.monthlyStats.find(
    (m: { year: number; month: number }) => m.year === dNow.getFullYear() && m.month === dNow.getMonth() + 1,
  );
  assert.ok(cur, '应包含本月聚合');
  // 整月全量口径：本月含 in_progress 一条不计，running 共 2 条
  assert.deepEqual(
    { count: cur.count, distance: cur.distance, calories: cur.calories },
    { count: 2, distance: 4500, calories: 300 },
  );

  // 不带 type：不附带聚合（统计块仅在选中类型时展示）
  const noType = await app.inject({
    method: 'GET',
    url: '/sport-track/api/activities',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(noType.statusCode, 200, noType.body);
  assert.deepEqual(noType.json().data.monthlyStats, []);
});
