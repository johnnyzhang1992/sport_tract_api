/**
 * 计划记录概况 + 里程碑：
 * - 总周期数/达成次数/达成率/累计；
 * - 连续达成（按当前计划周期类型，正序扫、倒序数当前连续）；
 * - 里程碑按「最弱一项完成倍数」计数解锁（1x/2x/3x）。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/exercise-plan-summary.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ExercisePlanModel } from '../src/models/exercise-plan.model.js';
import { ExercisePlanPeriodModel } from '../src/models/exercise-plan-period.model.js';
import { getPlanSummary, PLAN_MILESTONES } from '../src/services/exercise-plan.js';

let app: FastifyInstance;
const PREFIX = 'openid:plan-summary';
const DAY = 86_400_000;
let token = '';
let userId = '';

function bjDayStart(off = 0): number {
  const b = new Date(Date.now() + 8 * 3600_000 + off * DAY);
  return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - 8 * 3600_000;
}

/** 造一条日快照：ratio 为「最弱一项」的完成倍数 */
async function makeSnap(offDays: number, ratio: number, achieved: boolean) {
  const ws = bjDayStart(offDays);
  const base = { distanceM: 3000, durationMin: 30, count: 1 };
  await ExercisePlanPeriodModel.create({
    userId: new mongoose.Types.ObjectId(userId),
    period: 'daily',
    periodKey: new Date(ws + 8 * 3600_000).toISOString().slice(0, 10),
    windowStart: ws,
    windowEnd: ws + DAY,
    targets: base,
    progress: {
      distanceM: Math.round(base.distanceM * ratio),
      durationSec: Math.round(base.durationMin * 60 * ratio),
      count: Math.round(base.count * ratio),
    },
    achieved: { distance: achieved, duration: achieved, count: achieved },
    allAchieved: achieved,
  });
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const old = await UserModel.find({ openid: `${PREFIX}_a` }).select('_id').lean();
  if (old.length) {
    const ids = old.map((u) => u._id);
    await ExercisePlanModel.deleteMany({ userId: { $in: ids } });
    await ExercisePlanPeriodModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  }
  const res = await app.inject({
    method: 'POST', url: '/sport-track/api/auth/login', payload: { code: `openid:${PREFIX}_a` },
  });
  token = res.json().data.accessToken;
  userId = String(res.json().data.user?.id ?? res.json().data.user?._id);
  await ExercisePlanModel.create({
    userId: new mongoose.Types.ObjectId(userId), period: 'daily',
    targets: { distanceM: 3000, durationMin: 30, count: 1 },
  });
});

after(async () => {
  const old = await UserModel.find({ openid: `${PREFIX}_a` }).select('_id').lean();
  const ids = old.map((u) => u._id);
  await ExercisePlanModel.deleteMany({ userId: { $in: ids } });
  await ExercisePlanPeriodModel.deleteMany({ userId: { $in: ids } });
  await UserModel.deleteMany({ _id: { $in: ids } });
  await app.close();
});

test('EPS1 概况：总周期/达成次数/达成率/累计 + 连续达成', async () => {
  // 5 天：达成、达成、未达成、达成、达成（当前计划 daily → 连续从最后往前数 = 2，最佳 = 2）
  await makeSnap(-5, 1, true);
  await makeSnap(-4, 1, true);
  await makeSnap(-3, 0.4, false);
  await makeSnap(-2, 1.2, true);
  await makeSnap(-1, 1.5, true);

  const s = await getPlanSummary(userId);
  assert.equal(s.totalPeriods, 5);
  assert.equal(s.achievedPeriods, 4);
  assert.ok(Math.abs(s.rate - 0.8) < 1e-9, '4/5 = 80%');
  assert.equal(s.streak.current, 2, '最后两天连续达成');
  assert.equal(s.streak.best, 2);
  assert.ok(s.totals.distanceM > 0 && s.totals.count > 0, '累计求和');
});

test('EPS2 里程碑：按最弱一项的完成倍数计数（1x/2x/3x）', async () => {
  // 清空后造：3 天 200%（含 1 天 300%）
  await ExercisePlanPeriodModel.deleteMany({ userId: new mongoose.Types.ObjectId(userId) });
  await makeSnap(-3, 2, true);
  await makeSnap(-2, 2, true);
  await makeSnap(-1, 3, true);

  const s = await getPlanSummary(userId);
  const byKey = Object.fromEntries(s.milestones.map((m) => [m.key, m]));
  assert.equal(byKey.first.cur, 3, '1x 达成 3 次');
  assert.equal(byKey.x2.cur, 3, '200% 达成 3 次（300% 也计入 2x 档）');
  assert.equal(byKey.x3.cur, 1, '300% 只有 1 次');
  assert.equal(byKey.first.unlocked, true, '首次达成已解锁');
  assert.equal(byKey.week.unlocked, false, '7 次还没到');
  assert.equal(byKey.x2.need, 10);
  assert.equal(s.milestones.length, PLAN_MILESTONES.length, '固定档位全量返回（未解锁也占位）');
});

test('EPS3 路由：GET /plan/summary 需登录；登录后返回概况与奖杯', async () => {
  const guest = await app.inject({ method: 'GET', url: '/sport-track/api/plan/summary' });
  assert.equal(guest.statusCode, 401);

  const res = await app.inject({
    method: 'GET', url: '/sport-track/api/plan/summary',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  for (const key of ['totalPeriods', 'achievedPeriods', 'rate', 'streak', 'totals', 'milestones']) {
    assert.ok(key in d, `应包含 ${key}`);
  }
  assert.ok(Array.isArray(d.milestones) && d.milestones.length > 0);
});
