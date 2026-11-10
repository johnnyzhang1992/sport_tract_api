/**
 * 计划摘要 overStreak（连续超额周期数，2026-11-10）：
 * 从最近一期往前数连续 minRatio ≥ 200% 的期数（按当前计划周期类型），加量建议的触发信号。
 * 快照直接插库（结算逻辑已有别的测试覆盖），只验证统计口径。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/exercise-plan-over-streak.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ExercisePlanModel } from '../src/models/exercise-plan.model.js';
import { ExercisePlanPeriodModel } from '../src/models/exercise-plan-period.model.js';

let app: FastifyInstance;
const PREFIX = 'openid:exercise-plan-over';
let token = '';
let id = '';
let tokenQ = '';
let idQ = '';

async function login(openid: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/sport-track/api/auth/login', payload: { code: `openid:${openid}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.accessToken;
}

const bjDayStart = (offsetDays: number) => {
  const b = new Date(Date.now() + 8 * 3600_000);
  const base = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - 8 * 3600_000;
  return base + offsetDays * 86_400_000;
};

let seq = 0;
async function seedPeriodFor(o: {
  userId: string;
  period: 'daily' | 'weekly';
  offsetDays: number;
  distTarget: number;
  distMul: number;
  cntTarget?: number;
  cntMul?: number;
}) {
  seq += 1;
  const start = bjDayStart(o.offsetDays);
  const cntTarget = o.cntTarget ?? 0;
  const cntMul = o.cntMul ?? 1;
  await ExercisePlanPeriodModel.create({
    userId: o.userId,
    period: o.period,
    periodKey: `T${seq}`,
    windowStart: start,
    windowEnd: start + (o.period === 'daily' ? 86_400_000 : 7 * 86_400_000),
    targets: { distanceM: o.distTarget, durationMin: 0, count: cntTarget },
    progress: {
      distanceM: o.distTarget * o.distMul,
      durationSec: 0,
      count: cntTarget * cntMul,
    },
    achieved: { distance: o.distMul >= 1, duration: false, count: cntTarget > 0 ? cntMul >= 1 : false },
    allAchieved: o.distMul >= 1 && (cntTarget === 0 || cntMul >= 1),
  });
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const openids = [`${PREFIX}_p`, `${PREFIX}_q`];
  const olds = await UserModel.find({ openid: { $in: openids } }).select('_id').lean();
  if (olds.length) {
    const ids = olds.map((u) => u._id);
    await ExercisePlanModel.deleteMany({ userId: { $in: ids } });
    await ExercisePlanPeriodModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  }
  token = await login(`${PREFIX}_p`);
  tokenQ = await login(`${PREFIX}_q`);
  const me = await app.inject({ method: 'GET', url: '/sport-track/api/users/me', headers: { authorization: `Bearer ${token}` } });
  id = me.json().data.id;
  const meQ = await app.inject({ method: 'GET', url: '/sport-track/api/users/me', headers: { authorization: `Bearer ${tokenQ}` } });
  idQ = meQ.json().data.id;
  // 建计划：P 每日 / Q 每周（overStreak 只统计与当前计划同周期的快照）
  await app.inject({
    method: 'PUT', url: '/sport-track/api/plan',
    headers: { authorization: `Bearer ${token}` },
    payload: { period: 'daily', targets: { distanceM: 3000, durationMin: 0, count: 0 } },
  });
  await app.inject({
    method: 'PUT', url: '/sport-track/api/plan',
    headers: { authorization: `Bearer ${tokenQ}` },
    payload: { period: 'weekly', targets: { distanceM: 21000, durationMin: 0, count: 0 } },
  });
});

after(async () => {
  const olds = await UserModel.find({ openid: { $in: [`${PREFIX}_p`, `${PREFIX}_q`] } }).select('_id').lean();
  const ids = olds.map((u) => u._id);
  await ExercisePlanModel.deleteMany({ userId: { $in: ids } });
  await ExercisePlanPeriodModel.deleteMany({ userId: { $in: ids } });
  await UserModel.deleteMany({ _id: { $in: ids } });
  await app.close();
});

const getSummary = () =>
  app.inject({ method: 'GET', url: '/sport-track/api/plan/summary', headers: { authorization: `Bearer ${token}` } });

test('OS1 无快照：overStreak=0', async () => {
  const res = await getSummary();
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().data.overStreak, 0);
});

test('OS2 连续超额：最近 3 期 ≥200% → overStreak=3；更早的超额不重复计（中间被 100% 打断）', async () => {
  // 时间正序插入：-5 天 250%（超额但被打断）→ -4 天 100%（打断）→ -3/-2/-1 天 200%+ 
  await seedPeriodFor({ userId: id, period: 'daily', offsetDays: -5, distTarget: 3000, distMul: 2.5 });
  await seedPeriodFor({ userId: id, period: 'daily', offsetDays: -4, distTarget: 3000, distMul: 1 });
  await seedPeriodFor({ userId: id, period: 'daily', offsetDays: -3, distTarget: 3000, distMul: 2 });
  await seedPeriodFor({ userId: id, period: 'daily', offsetDays: -2, distTarget: 3000, distMul: 2.6 });
  await seedPeriodFor({ userId: id, period: 'daily', offsetDays: -1, distTarget: 3000, distMul: 3 });
  const res = await getSummary();
  assert.equal(res.json().data.overStreak, 3);
});

test('OS3 最近一期未超额：连续数从最近往前数，超额期在更早也不算', async () => {
  await seedPeriodFor({ userId: id, period: 'daily', offsetDays: 0, distTarget: 3000, distMul: 1 });
  const res = await getSummary();
  assert.equal(res.json().data.overStreak, 0);
});

test('OS4 最弱一项口径：距离超额但次数未达标（<200%）→ 不算超额', async () => {
  // 距离 300%、次数 100%：minRatio=100% < 200%
  await seedPeriodFor({ userId: id, period: 'daily', offsetDays: -1, distTarget: 3000, distMul: 3, cntTarget: 2, cntMul: 1 });
  const res = await getSummary();
  assert.equal(res.json().data.overStreak, 0);
});

test('OS5 只统计当前计划周期类型（双向）：daily 计划不算 weekly 快照；weekly 计划只算 weekly', async () => {
  // Q 是 weekly 计划：3 个连续 ≥200% 的周快照 → overStreak=3；插 daily 超额快照不影响
  await seedPeriodFor({ userId: idQ, period: 'weekly', offsetDays: -21, distTarget: 21000, distMul: 2.1 });
  await seedPeriodFor({ userId: idQ, period: 'weekly', offsetDays: -14, distTarget: 21000, distMul: 3 });
  await seedPeriodFor({ userId: idQ, period: 'weekly', offsetDays: -7, distTarget: 21000, distMul: 2.5 });
  await seedPeriodFor({ userId: idQ, period: 'daily', offsetDays: -1, distTarget: 21000, distMul: 5 });
  const q = await app.inject({ method: 'GET', url: '/sport-track/api/plan/summary', headers: { authorization: `Bearer ${tokenQ}` } });
  assert.equal(q.json().data.overStreak, 3, 'weekly 计划只统计 weekly 快照');

  // P 是 daily 计划：最近的 daily 快照未超额 → 0（weekly 快照本来也不在统计内）
  const p = await getSummary();
  assert.equal(p.json().data.overStreak, 0);
});
