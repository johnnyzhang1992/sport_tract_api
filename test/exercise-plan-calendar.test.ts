/**
 * 计划月历与单日详情：
 * - 月历返回当月每天的三环（有快照用快照、当期/无快照用实时聚合）；
 * - 周计划记录与本月有交集时单独返回；
 * - 单日详情含三环 + 当天轨迹摘要；
 * - 路由鉴权与参数校验。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/exercise-plan-calendar.test.ts
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
import { upsertPlan, finalizePlanPeriod, listPlanCalendar, getPlanDayDetail } from '../src/services/exercise-plan.js';
import { bjDateStr } from '../src/utils/bj-time.js';

let app: FastifyInstance;
const PREFIX = 'openid:plan-calendar';
const DAY = 86_400_000;
let token = '';
let userId = '';

function bjDayStart(off = 0, base = Date.now()): number {
  const b = new Date(base + 8 * 3600_000 + off * DAY);
  return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - 8 * 3600_000;
}
const monthOf = (ms: number) => {
  const b = new Date(ms + 8 * 3600_000);
  return `${b.getUTCFullYear()}-${String(b.getUTCMonth() + 1).padStart(2, '0')}`;
};

async function seed(startTime: number, distance: number, duration: number, type = 'running') {
  await ActivityModel.create({
    userId: new mongoose.Types.ObjectId(userId), type, status: 'finished',
    startTime, endTime: startTime + duration * 1000, duration, distance, trackPoints: [], markers: [],
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

/** 把计划回拨成 days 天前创建：结算有生效边界，结算「昨天」前必须先回拨（2026-11-12） */
async function backdatePlan(days: number) {
  await ExercisePlanModel.updateOne(
    { userId: new mongoose.Types.ObjectId(userId) },
    { $set: { activeFrom: bjDayStart(-days) } },
  );
}

test('EPC1 月历：整月每天一项；有快照用快照，今天实时聚合算 live', async () => {
  await ActivityModel.deleteMany({ userId: new mongoose.Types.ObjectId(userId) });
  await ExercisePlanPeriodModel.deleteMany({ userId: new mongoose.Types.ObjectId(userId) });
  await upsertPlan(userId, { period: 'daily', targets: { distanceM: 3000, durationMin: 30, count: 1 } });
  await backdatePlan(2);

  // 昨天：跑 4km → 结算成快照（目标 3km，全达成）
  const yest = bjDayStart(-1);
  await seed(yest + 9 * 3600_000, 4000, 2400);
  await finalizePlanPeriod(userId, 'daily', yest, yest + DAY);
  // 今天：跑 1.5km（未结算 → live）
  await seed(bjDayStart(0) + 8 * 3600_000, 1500, 600);

  const month = monthOf(Date.now());
  const cal = await listPlanCalendar(userId, month);
  assert.equal(cal.month, month);
  assert.ok(cal.days.length >= 28, `整月天数，实际 ${cal.days.length}`);

  const y = cal.days.find((d) => d.date === bjDateStr(yest));
  assert.equal(y!.source, 'snapshot');
  assert.equal(y!.allAchieved, true, '快照里昨天三项达成');

  const today = cal.days.find((d) => d.date === bjDateStr(bjDayStart(0)));
  assert.equal(today!.source, 'live', '今天未结算 → 实时');
  assert.ok(today!.rings[0].pct > 0.4 && today!.rings[0].pct < 0.6, '1.5/3.0 = 50%');
  assert.equal(today!.allAchieved, false);

  // 未来日期没有数据
  const future = cal.days.find((d) => d.windowStart > Date.now() + DAY);
  if (future) {
    assert.equal(future.source, 'none');
    assert.equal(future.rings[0].pct, 0);
  }
});


test('EPC3 单日详情：三环 + 当天轨迹摘要', async () => {
  const d = bjDayStart(-5);
  await backdatePlan(6); // 计划 6 天前就存在，否则该日属「当天没有计划」
  await seed(d + 7 * 3600_000, 2000, 1200, 'running');
  await seed(d + 18 * 3600_000, 1000, 600, 'walking');

  const detail = await getPlanDayDetail(userId, bjDateStr(d));
  assert.equal(detail.date, bjDateStr(d));
  assert.equal(detail.tracks.length, 2, '当天两条轨迹');
  assert.equal(detail.tracks[0].type, 'running', '按开始时间正序');
  assert.equal(detail.tracks[1].type, 'walking');
  assert.equal(detail.source, 'live');
  const distRing = detail.rings.find((r) => r.key === 'distance')!;
  assert.equal(distRing.value, 3000, '两项距离合计');
});

test('EPC4 路由：/calendar 与 /day 需登录；非法参数 400', async () => {
  const g1 = await app.inject({ method: 'GET', url: '/sport-track/api/plan/calendar' });
  assert.equal(g1.statusCode, 401);
  const g2 = await app.inject({ method: 'GET', url: '/sport-track/api/plan/day' });
  assert.equal(g2.statusCode, 401);

  const ok = await app.inject({
    method: 'GET', url: `/sport-track/api/plan/calendar?month=${monthOf(Date.now())}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.ok(Array.isArray(ok.json().data.days));

  const bad = await app.inject({
    method: 'GET', url: '/sport-track/api/plan/day?date=2026-02-30',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(bad.statusCode, 400, '不存在的日期要 400');

  const day = await app.inject({
    method: 'GET', url: `/sport-track/api/plan/day?date=${bjDateStr(bjDayStart(-5))}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(day.statusCode, 200, day.body);
  assert.ok(Array.isArray(day.json().data.tracks));
});

test('EPC5 未覆盖计划期的日期：noPlan=true、目标为 0，不拿当前目标回溯评价', async () => {
  // 计划从今天-6 开始（EPC3 回拨过），今天-10 在计划开始之前
  const before = bjDayStart(-10);
  await seed(before + 8 * 3600_000, 2000, 1200, 'running');
  await seed(before + 19 * 3600_000, 1000, 600, 'walking');
  const detail = await getPlanDayDetail(userId, bjDateStr(before));
  assert.equal(detail.noPlan, true, '计划开始之前 → 当天没有计划');
  assert.equal(detail.source, 'none');
  assert.equal(detail.allAchieved, false, '不算达成');
  for (const r of detail.rings) assert.equal(r.target, 0, `目标应为 0（${r.key}）`);
  assert.equal(detail.tracks.length, 2, '当天轨迹照常返回（数据本身还是要能看）');

  // 月历同一格也要带 noPlan，且三环全空
  const cal = await listPlanCalendar(userId, monthOf(before));
  const cell = cal.days.find((x) => x.date === bjDateStr(before))!;
  assert.equal(cell.noPlan, true);
  assert.equal(cell.allAchieved, false);
  for (const r of cell.rings) assert.equal(r.pct, 0, '目标 0 → 完成度 0');

  // 计划期之内的今天：noPlan=false，正常按当前目标评价
  const today = await getPlanDayDetail(userId, bjDateStr(bjDayStart(0)));
  assert.equal(today.noPlan, false);
});
