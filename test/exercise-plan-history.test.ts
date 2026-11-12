/**
 * 运动计划周期快照与历史查询：
 * - 周期结束后落一条快照（目标 + 最终完成值 + 达成标记），幂等；
 * - 历史按窗口倒序 + 游标翻页；
 * - 改计划不影响已生成的历史快照；
 * - GET /plan/history 需登录、按周期过滤。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/exercise-plan-history.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { ExercisePlanModel } from '../src/models/exercise-plan.model.js';
import { ExercisePlanPeriodModel } from '../src/models/exercise-plan-period.model.js';
import {
  finalizePlanPeriod, listPlanHistory, finalizeAllPreviousPeriods, upsertPlan,
} from '../src/services/exercise-plan.js';
import { bjDateStr } from '../src/utils/bj-time.js';

let app: FastifyInstance;
const PREFIX = 'openid:plan-history';
const DAY = 86_400_000;
let token = '';
let userId = '';

/** 东八区某天 0 点（epoch ms） */
function bjDayStart(offsetDays = 0, base = Date.now()): number {
  const b = new Date(base + 8 * 3600_000 + offsetDays * DAY);
  return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - 8 * 3600_000;
}

async function seedFinished(startTime: number, distance: number, duration: number) {
  await ActivityModel.create({
    userId: new mongoose.Types.ObjectId(userId),
    type: 'running', status: 'finished',
    startTime, endTime: startTime + duration * 1000,
    duration, distance, trackPoints: [], markers: [],
  });
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const old = await UserModel.find({ openid: `${PREFIX}_a` }).select('_id').lean();
  if (old.length) {
    const ids = old.map((u) => u._id);
    await ActivityModel.deleteMany({ userId: { $in: ids } });
    await ExercisePlanModel.deleteMany({ userId: { $in: ids } });
    await ExercisePlanPeriodModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  }
  const res = await app.inject({
    method: 'POST', url: '/sport-track/api/auth/login', payload: { code: `openid:${PREFIX}_a` },
  });
  assert.equal(res.statusCode, 200, res.body);
  token = res.json().data.accessToken;
  userId = String(res.json().data.user?.id ?? res.json().data.user?._id);
});

after(async () => {
  const old = await UserModel.find({ openid: `${PREFIX}_a` }).select('_id').lean();
  const ids = old.map((u) => u._id);
  await ActivityModel.deleteMany({ userId: { $in: ids } });
  await ExercisePlanModel.deleteMany({ userId: { $in: ids } });
  await ExercisePlanPeriodModel.deleteMany({ userId: { $in: ids } });
  await UserModel.deleteMany({ _id: { $in: ids } });
  await app.close();
});

/**
 * 把计划「回拨」成 days 天前创建（模拟老用户）。
 * 2026-11-12 起结算有生效边界：早于计划开始的窗口不再补快照，
 * 所以「结算昨天」这类用例必须先把计划回拨，否则会被边界正确拦下。
 */
async function backdatePlan(days: number) {
  await ExercisePlanModel.updateOne(
    { userId: new mongoose.Types.ObjectId(userId) },
    { $set: { activeFrom: bjDayStart(-days) } },
  );
}

test('EPH1 昨日快照：目标 + 最终完成值 + 达成标记，且幂等', async () => {
  await ActivityModel.deleteMany({ userId: new mongoose.Types.ObjectId(userId) });
  await ExercisePlanPeriodModel.deleteMany({ userId: new mongoose.Types.ObjectId(userId) });
  await upsertPlan(userId, { period: 'daily', targets: { distanceM: 3000, durationMin: 30, count: 1 } });
  await backdatePlan(4); // 计划 4 天前就存在（否则昨天的窗口早于生效边界）

  const yesterdayStart = bjDayStart(-1);
  // 昨天跑了 4km/40 分钟（两项超额，次数 1 次达成）→ 全部达成
  await seedFinished(yesterdayStart + 9 * 3600_000, 4000, 2400);

  const snap = await finalizePlanPeriod(userId, 'daily', yesterdayStart, yesterdayStart + DAY);
  assert.ok(snap);
  assert.equal(snap!.periodKey, bjDateStr(yesterdayStart), 'periodKey＝该日东八日期串');
  assert.equal(snap!.progress.distanceM, 4000);
  assert.equal(snap!.progress.durationSec, 2400);
  assert.equal(snap!.progress.count, 1);
  assert.equal(snap!.allAchieved, true, '三项都达成');
  assert.deepEqual(snap!.achieved, { distance: true, duration: true, count: true });

  // 幂等：再结算一次仍只有一条
  await finalizePlanPeriod(userId, 'daily', yesterdayStart, yesterdayStart + DAY);
  const count = await ExercisePlanPeriodModel.countDocuments({
    userId: new mongoose.Types.ObjectId(userId), period: 'daily', periodKey: snap!.periodKey,
  });
  assert.equal(count, 1, '同周期只有一条快照');
});

test('EPH2 未达成：完成值低于目标时 allAchieved=false', async () => {
  const d2 = bjDayStart(-2);
  await seedFinished(d2 + 8 * 3600_000, 1000, 600); // 1km/10 分钟/1 次
  const snap = await finalizePlanPeriod(userId, 'daily', d2, d2 + DAY);
  assert.equal(snap!.allAchieved, false);
  assert.deepEqual(snap!.achieved, { distance: false, duration: false, count: true });
  assert.ok(snap!.rings[0].pct > 0.3 && snap!.rings[0].pct < 0.4, '1km/3km ≈ 33%');
});

test('EPH3 历史查询：按窗口倒序 + 游标翻页 + 周期过滤', async () => {
  const d3 = bjDayStart(-3);
  await finalizePlanPeriod(userId, 'daily', d3, d3 + DAY);

  const page1 = await listPlanHistory(userId, { period: 'daily', limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.ok(page1.items[0].windowStart > page1.items[1].windowStart, '倒序：最近的在前');
  assert.ok(page1.nextCursor, '还有更多 → 给出游标');

  const page2 = await listPlanHistory(userId, { period: 'daily', limit: 2, cursor: page1.nextCursor! });
  assert.ok(page2.items.length >= 1);
  assert.ok(page2.items[0].windowStart < page1.items[1].windowStart, '游标之后（更早）的记录');

  // 周期过滤：查 weekly 时没有记录
  const weekly = await listPlanHistory(userId, { period: 'weekly' });
  assert.deepEqual(weekly.items, []);
});

test('EPH4 改计划不影响已生成的历史快照', async () => {
  const before = await listPlanHistory(userId, { period: 'daily', limit: 5 });
  const yesterday = before.items.find((i) => i.periodKey === bjDateStr(bjDayStart(-1)));
  assert.ok(yesterday);

  // 把目标改成 100km（远超昨天的 4km）
  await upsertPlan(userId, { period: 'daily', targets: { distanceM: 100_000, durationMin: 600, count: 5 } });
  const after = await listPlanHistory(userId, { period: 'daily', limit: 5 });
  const same = after.items.find((i) => i.periodKey === yesterday!.periodKey);
  assert.deepEqual(same!.targets, yesterday!.targets, '历史周期的目标保持快照值');
  assert.equal(same!.allAchieved, true, '达成标记也不变');
});

test('EPH5 全量结算：给所有有计划的人补上一周期快照', async () => {
  await ExercisePlanPeriodModel.deleteMany({ userId: new mongoose.Types.ObjectId(userId) });
  await upsertPlan(userId, { period: 'daily', targets: { distanceM: 1000, durationMin: 10, count: 1 } });
  await backdatePlan(2);
  const r = await finalizeAllPreviousPeriods();
  assert.ok(r.done >= 1, `至少结算了本用户，实际 ${r.done}`);
  const rows = await ExercisePlanPeriodModel.countDocuments({ userId: new mongoose.Types.ObjectId(userId) });
  assert.equal(rows, 1, '上一周期已落库');
});

test('EPH6 路由：GET /plan/history 需登录；登录后返回快照列表', async () => {
  const guest = await app.inject({ method: 'GET', url: '/sport-track/api/plan/history' });
  assert.equal(guest.statusCode, 401);

  const res = await app.inject({
    method: 'GET', url: '/sport-track/api/plan/history?period=daily&limit=10',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.ok(Array.isArray(data.items));
  assert.ok(data.items.length >= 1);
  const item = data.items[0];
  for (const key of ['period', 'periodKey', 'windowStart', 'windowEnd', 'targets', 'progress', 'rings', 'achieved', 'allAchieved']) {
    assert.ok(key in item, `快照应包含 ${key}`);
  }
});
