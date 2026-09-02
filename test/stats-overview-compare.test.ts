import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';

/**
 * stats overview 上周期对比测试：
 * - prevWeek：近 7 天窗口（今天往前 6 天的 0 点）的前 7 天
 * - prevMonth：上一个自然月
 * 断言方式：测试内与服务端同口径计算各窗口归属，避免运行日期导致的窗口重叠误判
 */

let app: FastifyInstance;
let token = '';
let userId = '';
const created: number[] = []; // 所有已创建活动的时间戳

const DAY = 86400000;

function dayStartOf(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 与服务端同口径的窗口起点 */
function windows() {
  return {
    weekStart: dayStartOf(Date.now() - 6 * DAY),
    monthStart: new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime(),
    prevMonthStart: new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).getTime(),
  };
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pre = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'mock_openid_stats_cmp' },
  });
  const preUser = pre.json().data.user;
  const preUserId = preUser?.id ?? preUser?._id;
  if (preUserId) {
    await ActivityModel.deleteMany({ userId: preUserId });
    await UserModel.deleteMany({ _id: preUserId });
  }
  const u = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'mock_openid_stats_cmp' },
  });
  userId = u.json().data.user.id;
  token = u.json().data.accessToken;
  assert.ok(token);
});

after(async () => {
  if (userId) {
    await UserModel.deleteOne({ _id: userId }).catch(() => {});
    await ActivityModel.deleteMany({ userId }).catch(() => {});
  }
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

async function createFinishedAt(startTs: number) {
  const createdRes = await app.inject({
    method: 'POST',
    url: '/sport-track/api/activities',
    headers: { authorization: `Bearer ${token}` },
    payload: { type: 'walking', startTime: startTs },
  });
  assert.equal(createdRes.statusCode, 200, `创建活动失败: ${createdRes.body}`);
  const id = createdRes.json().data.activityId;
  const fin = await app.inject({
    method: 'PUT',
    url: `/sport-track/api/activities/${id}/finish`,
    headers: { authorization: `Bearer ${token}` },
    payload: { trackPoints: [], endTime: startTs + 60000, pausedMs: 0 },
  });
  assert.equal(fin.statusCode, 200);
  created.push(startTs);
}

test('overview 返回 prevWeek/prevMonth 对比字段', async () => {
  const { weekStart, monthStart, prevMonthStart } = windows();
  // 覆盖各窗口：上周 2 条、本周 1 条、上月 2 条、本月 1 条、窗口外 1 条
  await createFinishedAt(weekStart - 2 * DAY + 60000);
  await createFinishedAt(weekStart - DAY + 60000);
  await createFinishedAt(weekStart + 2 * DAY + 60000);
  await createFinishedAt(prevMonthStart + 60000);
  await createFinishedAt(prevMonthStart + 2 * DAY + 60000);
  await createFinishedAt(monthStart + 60000);
  await createFinishedAt(Date.now() - 40 * DAY);

  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/overview',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.ok(data.prevWeek, '缺少 prevWeek');
  assert.ok(data.prevMonth, '缺少 prevMonth');

  // 本地同口径期望（窗口可能重叠，动态计算避免日期敏感）
  const inPrevWeek = (t: number) => t >= weekStart - 7 * DAY && t < weekStart;
  const inWeek = (t: number) => t >= weekStart;
  const inPrevMonth = (t: number) => t >= prevMonthStart && t < monthStart;
  const inMonth = (t: number) => t >= monthStart;

  assert.equal(data.prevWeek.count, created.filter(inPrevWeek).length, 'prevWeek.count');
  assert.equal(data.week.count, created.filter(inWeek).length, 'week.count');
  assert.equal(data.prevMonth.count, created.filter(inPrevMonth).length, 'prevMonth.count');
  assert.equal(data.month.count, created.filter(inMonth).length, 'month.count');

  // 固定窗口断言：只有 2 条落在上周窗口（其它构造时间点均不落入）
  assert.equal(data.prevWeek.count, 2);
  // 时长：上周 2 条各 60s
  assert.equal(data.prevWeek.duration, 120);
});
