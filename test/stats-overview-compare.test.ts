import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { bjIsoWeekStart, bjMonthStart } from '../src/utils/bj-time.js';

/**
 * stats overview 上周期对比测试：
 * - prevWeek：本周（东八区自然周，周一起）的前一周
 * - prevMonth：上一个自然月
 * 断言方式：测试内与服务端同口径计算各窗口归属，避免运行日期导致的窗口重叠误判
 */

let app: FastifyInstance;
let token = '';
let userId = '';
const created: number[] = []; // 所有已创建活动的时间戳

const DAY = 86400000;

/** 与服务端同口径的窗口起点（东八区自然周/自然月） */
function windows() {
  const now = Date.now();
  return {
    weekStart: bjIsoWeekStart(now), // 本周 = 自然周（周一 0 点起）
    monthStart: bjMonthStart(now),
    prevMonthStart: bjMonthStart(bjMonthStart(now) - 1),
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
  // 注：finish 现在会作废空轨迹（点数/距离守卫），本文件测的是统计聚合，
  // 直接在库内造 finished 记录（时长 60s 与原 finish 流程一致）
  await ActivityModel.create({
    userId,
    type: 'walking',
    status: 'finished',
    startTime: startTs,
    endTime: startTs + 60000,
    duration: 60,
    distance: 1000,
    trackPoints: [],
    markers: [],
  });
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

  // 固定窗口断言：条数按构造点现算——「本周」是自然周，窗口宽度虽固定，但落到哪几条会随今天是周几变
  const expectedPrevWeek = created.filter(inPrevWeek).length;
  assert.equal(data.prevWeek.count, expectedPrevWeek, 'prevWeek 条数应与构造点一致');
  // 时长：上周窗口每条 60s
  assert.equal(data.prevWeek.duration, expectedPrevWeek * 60);
});
