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

test('EPC1 月历：整月每天一项；有快照用快照，今天实时聚合算 live', async () => {
  await ActivityModel.deleteMany({ userId: new mongoose.Types.ObjectId(userId) });
  await ExercisePlanPeriodModel.deleteMany({ userId: new mongoose.Types.ObjectId(userId) });
  await upsertPlan(userId, { period: 'daily', targets: { distanceM: 3000, durationMin: 30, count: 1 } });

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

test('EPC2 周计划记录：当前期实时一条 + 已结算的期快照', async () => {
  await upsertPlan(userId, { period: 'weekly', targets: { distanceM: 21000, durationMin: 210, count: 7 } });
  // 固定 7 天一期：锚点＝定计划当天；上一期结算一条快照
  const curStart = bjDayStart(0);
  const prevStart = curStart - 7 * DAY;
  // 落在上一期第一天，避开 EPC3 用到的「今天-5」那天
  await seed(prevStart + 3600_000, 12000, 7200);
  await finalizePlanPeriod(userId, 'weekly', prevStart, curStart);
  // 本期跑一点 → 本期 live
  await seed(curStart + 9 * 3600_000, 3000, 1800);

  const cal = await listPlanCalendar(userId, monthOf(Date.now()));
  assert.ok(cal.weeks.length >= 1);
  const live = cal.weeks.find((w) => w.windowStart === curStart);
  assert.ok(live, '当前期实时记录存在');
  assert.equal(live!.source, 'live');
  // 当前期实时进度 = 本期全部已完成轨迹合计 / 期目标（本期还有前面用例造的轨迹，按实际合计断言）
  const rows = await ActivityModel.find({
    userId: new mongoose.Types.ObjectId(userId), status: 'finished',
    startTime: { $gte: curStart, $lt: curStart + 7 * DAY },
  }).select({ distance: 1 }).lean();
  const weekDist = rows.reduce((n, r) => n + (Number(r.distance) || 0), 0);
  assert.equal(live!.rings[0].value, weekDist, '周进度＝本周合计');
  assert.ok(
    Math.abs(live!.rings[0].pct - Math.min(1, weekDist / 21000)) < 1e-9,
    `周完成度按 21km 目标换算（实际 ${weekDist}m）`,
  );
});

test('EPC3 单日详情：三环 + 当天轨迹摘要', async () => {
  const d = bjDayStart(-5);
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
