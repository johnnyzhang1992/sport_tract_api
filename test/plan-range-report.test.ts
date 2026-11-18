/**
 * 区间计划报告接口（2026-11-19）：GET /plan/report?from=&to=
 * 年报页与运动报告页共用：区间内计划达成（快照）+ 区间内新解锁徽章数。
 * 数据全部按 userId 过滤（非全局聚合），测试可直接精确断言。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/plan-range-report.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { ExercisePlanPeriodModel } from '../src/models/exercise-plan-period.model.js';

const API = '/sport-track/api';
const DAY = 86_400_000;

let app: FastifyInstance;
let token = '';
let uid = '';

/** 东八区某天 0 点 */
const day0 = (y: number, m: number, d: number) => Date.parse(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00+08:00`);
const dateKey = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);

/** 造一条全达成/未达成快照（目标 1km·30min·1次；达成时 progress 恰好 = 目标 → minRatio=1，不触发倍数章） */
function snap(ms: number, achieved: boolean) {
  return {
    userId: uid,
    period: 'daily',
    periodKey: dateKey(ms),
    windowStart: ms,
    windowEnd: ms + DAY,
    targets: { distanceM: 1000, durationMin: 30, count: 1 },
    progress: achieved
      ? { distanceM: 1000, durationSec: 1800, count: 1 }
      : { distanceM: 0, durationSec: 0, count: 0 },
    achieved: achieved
      ? { distance: true, duration: true, count: true }
      : { distance: false, duration: false, count: false },
    allAchieved: achieved,
  };
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: `${API}/auth/login`, payload: { code: 'openid:prr-a' } });
  token = login.json().data.accessToken;
  uid = (await UserModel.findOne({ openid: 'prr-a' }).select('_id').lean())!._id as unknown as string;

  await ActivityModel.deleteMany({ userId: uid });
  await ExercisePlanPeriodModel.deleteMany({ userId: uid });

  // 2025-09-15 起连续 108 天全达成（跨到 2025-12-31；第 100 个达成日 = 12-23，合环/里程碑/完美周都在这段解锁）
  const year2025 = Array.from({ length: 108 }, (_, i) => snap(day0(2025, 9, 15) + i * DAY, true));
  // 2026-01-01 全达成、01-02 未达成
  const year2026 = [snap(day0(2026, 1, 1), true), snap(day0(2026, 1, 2), false)];
  await ExercisePlanPeriodModel.insertMany([...year2025, ...year2026]);

  // 2026-01-01 一段运动（撑活动侧统计；2025 无活动 → 活动型徽章保持锁定，快照型徽章可精确预期）
  await ActivityModel.create({
    userId: uid,
    type: 'walking',
    status: 'finished',
    startTime: day0(2026, 1, 1) + 3600_000,
    endTime: day0(2026, 1, 1) + 5400_000,
    duration: 1800,
    distance: 1000,
    trackPoints: [],
    markers: [],
  });
});

after(async () => {
  await ActivityModel.deleteMany({ userId: uid });
  await ExercisePlanPeriodModel.deleteMany({ userId: uid });
  await UserModel.deleteMany({ _id: uid });
  await app.close();
});

async function getReport(from: number, to: number): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'GET',
    url: `${API}/plan/report?from=${from}&to=${to}`,
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.statusCode, body: res.json() };
}

test('PRR1 鉴权与参数校验：未登录 401、区间缺失/倒置 400', async () => {
  const noAuth = await app.inject({ method: 'GET', url: `${API}/plan/report?from=1&to=2` });
  assert.equal(noAuth.statusCode, 401);
  const missing = await app.inject({
    method: 'GET', url: `${API}/plan/report`, headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(missing.statusCode, 400, '缺 from/to → 区间不合法');
  const inverted = await getReport(day0(2026, 1, 2), day0(2026, 1, 1));
  assert.equal(inverted.status, 400, 'to <= from → 区间不合法');
});

test('PRR2 2026 区间：2 期达成 1 期（50%）、连续 1 天、徽章 0 座新解锁但累计 >= 5', async () => {
  const { status, body } = await getReport(day0(2026, 1, 1), day0(2027, 1, 1));
  assert.equal(status, 200, JSON.stringify(body));
  const d = body.data as {
    plan: { snapshotDays: number; achievedDays: number; achievedRate: number; bestStreak: number; planDistanceKm: number };
    badges: { unlockedInRange: number; unlockedTotal: number; total: number };
  };
  assert.deepEqual(d.plan, {
    snapshotDays: 2,
    achievedDays: 1,
    achievedRate: 50,
    bestStreak: 1,
    planDistanceKm: 1, // 达成日 1km + 未达成日 0
  });
  assert.equal(d.badges.unlockedInRange, 0, '全部徽章都在 2025 解锁，2026 无新解锁');
  // first(9-15) / week(9-21) / habit(10-04) / ring-100(12-23) / 完美周全能+距离+时长+次数(9-21)
  assert.equal(d.badges.unlockedTotal, 8);
  assert.ok(d.badges.total >= 34, `徽章总数 34 座，实际 ${d.badges.total}`);
});

test('PRR3 2025 区间：108 期全达成、连续 108 天、区间内解锁数 = 累计解锁数', async () => {
  const { status, body } = await getReport(day0(2025, 9, 1), day0(2026, 1, 1));
  assert.equal(status, 200, JSON.stringify(body));
  const d = body.data as {
    plan: { snapshotDays: number; achievedDays: number; achievedRate: number; bestStreak: number };
    badges: { unlockedInRange: number; unlockedTotal: number };
  };
  assert.equal(d.plan.snapshotDays, 108);
  assert.equal(d.plan.achievedDays, 108);
  assert.equal(d.plan.achievedRate, 100);
  assert.equal(d.plan.bestStreak, 108);
  assert.equal(d.badges.unlockedInRange, 8, '8 座徽章的解锁日期都在 9-15 ~ 12-23 之间');
  assert.equal(d.badges.unlockedTotal, 8);
});

test('PRR4 跨年区间：连续达成跨年拼接（区间内 12 月 31 天 + 1 月 1 天 = 32）', async () => {
  const { status, body } = await getReport(day0(2025, 12, 1), day0(2027, 1, 1));
  assert.equal(status, 200, JSON.stringify(body));
  const d = body.data as {
    plan: { snapshotDays: number; bestStreak: number };
    badges: { unlockedInRange: number; unlockedTotal: number };
  };
  assert.equal(d.plan.snapshotDays, 33, '2025 年 12 月 31 天 + 2026 年 2 天');
  // 区间只看区间内快照：12 月整月连续 31 天 + 与 2026-01-01 相邻拼接 = 32（更早的 9-11 月不在区间内）
  assert.equal(d.plan.bestStreak, 32);
  assert.equal(d.badges.unlockedInRange, 1, '跨年区间从 12-01 起，只含 ring-100（12-23）一个解锁日');
  assert.equal(d.badges.unlockedTotal, 8);
});

test('PRR5 开区间边界：to 当天不含（[from, to)）', async () => {
  const { status, body } = await getReport(day0(2026, 1, 1), day0(2026, 1, 2));
  assert.equal(status, 200, JSON.stringify(body));
  const d = body.data as { plan: { snapshotDays: number; achievedDays: number; achievedRate: number } };
  assert.equal(d.plan.snapshotDays, 1, '01-02 的快照不属于 [01-01, 01-02)');
  assert.equal(d.plan.achievedDays, 1);
  assert.equal(d.plan.achievedRate, 100);
});
