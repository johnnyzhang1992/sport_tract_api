/**
 * 管理端「运动计划」数据页（docs/22）只读接口：
 * - /admin/plans/overview：渗透率（分母=近 30 天有运动用户）/ 有效计划 / 今日有运动 / 达成率
 * - /admin/plans/trend：总/单项达成率（快照）+ 新增计划（现存文档 createdAt）
 * - /admin/plans/distribution：目标档位 + 完成率分档（minRatio 口径）
 * - /admin/plans/users + /admin/plans/users/:id：列表筛选排序 / 详情日历
 *
 * 断言策略：这些接口是跨用户全局聚合，dev 库里有真实/预览数据会污染「相对今天」的窗口，
 * 所以服务层直调统一传 FIXED_NOW（2026-06-15，无污染窗口）做精确断言；路由只做鉴权与结构冒烟。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/admin-plan-stats.test.ts
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
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { bjDateStr, bjToday0 } from '../src/utils/bj-time.js';
import {
  adminPlanOverview,
  adminPlanTrend,
  adminPlanDistribution,
  adminPlanUsers,
  adminPlanUserDetail,
} from '../src/services/admin-plan-stats.js';

const API = '/sport-track/api';
const DAY = 86_400_000;
const ADMIN_USER = 't-admin-plan-stats';
const ADMIN_PASS = 'test-admin-pass-123';
/** 无污染的固定「现在」：2026-06-15 10:00 东八区（真实数据都在 11 月前后） */
const FIXED_NOW = Date.parse('2026-06-15T10:00:00+08:00');
const fixedToday0 = bjToday0(FIXED_NOW);
const fixedYesterdayKey = bjDateStr(fixedToday0 - DAY);

let app: FastifyInstance;
let adminToken = '';
let idA = ''; // 建计划 + 有运动 + 有快照（进行中）
let idB = ''; // 只有快照（已取消）
let idD = ''; // 建计划 + 有运动（无快照）

/** 基线（seed 前抓取）：全局聚合断言一律「基线 + 已知增量」，dev 库的真实数据不干扰 */
const base = {
  overview: null as null | Awaited<ReturnType<typeof adminPlanOverview>>,
  dist: null as null | Awaited<ReturnType<typeof adminPlanDistribution>>,
  trend: null as null | Awaited<ReturnType<typeof adminPlanTrend>>,
  usersTotal: 0,
  cancelledTotal: 0,
  t4Total: 0,
};

/** 列表默认按 createdAt 倒序且每页上限 100，快照-only 用户（createdAt=0）会沉底——翻页合并成全量 */
async function fetchAllUsers(q: Record<string, unknown>): Promise<Awaited<ReturnType<typeof adminPlanUsers>>['items']> {
  const first = await adminPlanUsers({ page: 1, pageSize: 100, ...q }, FIXED_NOW);
  const out = [...first.items];
  for (let page = 2; page <= Math.ceil(first.total / 100); page += 1) {
    const next = await adminPlanUsers({ page, pageSize: 100, ...q }, FIXED_NOW);
    out.push(...next.items);
  }
  return out;
}

function fixedDayStart(offsetDays: number): number {
  return fixedToday0 - offsetDays * DAY;
}

async function login(openid: string): Promise<{ token: string; id: string }> {
  const res = await app.inject({ method: 'POST', url: `${API}/auth/login`, payload: { code: `openid:${openid}` } });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json().data;
  return { token: body.accessToken, id: body.user?.id ?? body.user?._id };
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  const existing = await AdminModel.findOne({ username: ADMIN_USER });
  if (existing) {
    existing.passwordHash = await hashPassword(ADMIN_PASS);
    await existing.save();
  } else {
    await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  }
  const adminLogin = await app.inject({ method: 'POST', url: `${API}/admin/login`, payload: { username: ADMIN_USER, password: ADMIN_PASS } });
  adminToken = adminLogin.json().data.token;
  assert.ok(adminToken);

  // 清理本套件的旧数据（openid 前缀隔离）
  const olds = await UserModel.find({ openid: /^aps-/ }).select('_id');
  const oldIds = olds.map((u) => u._id);
  await ActivityModel.deleteMany({ userId: { $in: oldIds } });
  await ExercisePlanModel.deleteMany({ userId: { $in: oldIds } });
  await ExercisePlanPeriodModel.deleteMany({ userId: { $in: oldIds } });
  await UserModel.deleteMany({ _id: { $in: oldIds } });

  // seed 前抓基线（此时库里只有 dev 环境的真实/预览数据）
  base.overview = await adminPlanOverview(FIXED_NOW);
  base.dist = await adminPlanDistribution(FIXED_NOW);
  base.trend = await adminPlanTrend({ days: 7 }, FIXED_NOW);
  base.usersTotal = (await adminPlanUsers({ page: 1, pageSize: 100 }, FIXED_NOW)).total;
  base.cancelledTotal = (await adminPlanUsers({ page: 1, pageSize: 100, status: 'cancelled' }, FIXED_NOW)).total;
  base.t4Total = (await adminPlanUsers({ page: 1, pageSize: 100, distTier: 't4' }, FIXED_NOW)).total;

  const a = await login('aps-a');
  const b = await login('aps-b');
  const d = await login('aps-d');
  idA = a.id;
  idB = b.id;
  idD = d.id;
  await UserModel.updateOne({ _id: idA }, { nickname: '计划用户A' });

  // 运动（都落在 FIXED_NOW 窗口内）：A 今天有 finished；D 5 天前；C（不建计划）10 天前撑分母
  const mkActivity = (uid: string, startMs: number, distanceM: number, durationS: number) =>
    ActivityModel.create({
      userId: new mongoose.Types.ObjectId(uid),
      type: 'walking',
      status: 'finished',
      startTime: startMs,
      endTime: startMs + 1800_000,
      duration: durationS,
      distance: distanceM,
      trackPoints: [],
      markers: [],
    });
  await mkActivity(idA, fixedDayStart(0) + 3600_000, 2000, 1800);
  await mkActivity(idD, fixedDayStart(5) + 3600_000, 1500, 1200);
  const idC = (await login('aps-c')).id;
  await mkActivity(idC, fixedDayStart(10) + 3600_000, 1000, 600);

  // 计划：A 3km·30min·1次（改过目标）；D 12km（>10km 档）；B 无文档（已取消）
  // createdAt/updatedAt 定到 FIXED_NOW 附近：mongoose timestamps 会把 createdAt 设为 immutable
  // （updateOne 的 $set 被静默丢弃），必须走原生 collection.updateOne 绕过
  await ExercisePlanModel.create({
    userId: idA,
    period: 'daily',
    targets: { distanceM: 3000, durationMin: 30, count: 1 },
    activeFrom: fixedDayStart(3),
  });
  await ExercisePlanModel.collection.updateOne(
    { userId: new mongoose.Types.ObjectId(idA) },
    { $set: { createdAt: new Date(fixedDayStart(2)), updatedAt: new Date(fixedDayStart(2) + 300_000) } },
  );
  await ExercisePlanModel.create({
    userId: idD,
    period: 'daily',
    targets: { distanceM: 12000, durationMin: 0, count: 0 },
    activeFrom: fixedDayStart(4),
  });
  await ExercisePlanModel.collection.updateOne(
    { userId: new mongoose.Types.ObjectId(idD) },
    { $set: { createdAt: new Date(fixedDayStart(1)), updatedAt: new Date(fixedDayStart(1)) } },
  );

  // 快照：A 昨天全达成（minRatio=1 → 100–199% 档）；B 昨天只设距离且超额 2 倍（≥200% 档、allAchieved=false）
  await ExercisePlanPeriodModel.create({
    userId: idA,
    period: 'daily',
    periodKey: fixedYesterdayKey,
    windowStart: fixedDayStart(1),
    windowEnd: fixedDayStart(0),
    targets: { distanceM: 3000, durationMin: 30, count: 1 },
    progress: { distanceM: 5000, durationSec: 2400, count: 1 },
    achieved: { distance: true, duration: true, count: true },
    allAchieved: true,
  });
  await ExercisePlanPeriodModel.create({
    userId: idB,
    period: 'daily',
    periodKey: fixedYesterdayKey,
    windowStart: fixedDayStart(1),
    windowEnd: fixedDayStart(0),
    targets: { distanceM: 3000, durationMin: 0, count: 0 },
    progress: { distanceM: 9000, durationSec: 0, count: 0 },
    achieved: { distance: true, duration: false, count: false },
    allAchieved: false,
  });
});

after(async () => {
  const olds = await UserModel.find({ openid: /^aps-/ }).select('_id');
  const oldIds = olds.map((u) => u._id);
  await ActivityModel.deleteMany({ userId: { $in: oldIds } });
  await ExercisePlanModel.deleteMany({ userId: { $in: oldIds } });
  await ExercisePlanPeriodModel.deleteMany({ userId: { $in: oldIds } });
  await UserModel.deleteMany({ _id: { $in: oldIds } });
  await app.close();
});

test('APS1 路由：无 admin token 401，带 token 返回结构', async () => {
  const noAuth = await app.inject({ method: 'GET', url: `${API}/admin/plans/overview` });
  assert.equal(noAuth.statusCode, 401);
  const ok = await app.inject({ method: 'GET', url: `${API}/admin/plans/overview`, headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(ok.statusCode, 200, ok.body);
  const d = ok.json().data as Record<string, unknown>;
  for (const key of ['planUsers', 'active30Users', 'penetration', 'activePlans', 'todayMoved', 'yesterday', 'last7']) {
    assert.ok(key in d, `缺字段 ${key}`);
  }
  const badStatus = await app.inject({
    method: 'GET', url: `${API}/admin/plans/users?status=xxx`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(badStatus.statusCode, 400, '非法 status 参数 → 400');
});

const pctOf = (part: number, total: number): number => (total > 0 ? Math.round((part / total) * 100) : 0);

test('APS2 汇总卡：渗透率分母=近30天有运动用户，达成率按快照（基线+增量）', async () => {
  const b = base.overview!;
  const d = (await adminPlanOverview(FIXED_NOW)) as Awaited<ReturnType<typeof adminPlanOverview>>;
  assert.equal(d.active30Users, b.active30Users + 3, '增量：A/D/C 近 30 天有 finished 运动');
  assert.equal(d.planUsers, b.planUsers + 3, '增量：现存计划（A/D）∪ 有快照（B）');
  // 渗透率分子分母同窗口：A/D 在近 30 天活跃且建过计划（B 无活动、C 无计划）
  assert.equal(d.penetrationUsers, b.penetrationUsers + 2);
  assert.equal(d.penetration, pctOf(d.penetrationUsers, d.active30Users), '渗透率 = 交集 / 活跃30');
  assert.equal(d.activePlans, b.activePlans + 2, '增量：A/D 两份计划文档');
  assert.equal(d.todayMoved, b.todayMoved + 1, '增量：只有 A 今天有 finished 运动');
  assert.equal(d.yesterday.total, b.yesterday.total + 2);
  assert.equal(d.yesterday.achieved, b.yesterday.achieved + 1, '昨天 A 全达成、B 未全达成');
  assert.equal(d.yesterday.rate, pctOf(d.yesterday.achieved, d.yesterday.total), '达成率公式');
  assert.equal(d.last7.total, b.last7.total + 2);
  assert.equal(d.last7.achieved, b.last7.achieved + 1);
  assert.equal(d.last7.rate, pctOf(d.last7.achieved, d.last7.total));
});

test('APS3 趋势：7 天桶 + 达成率分组 + 新增计划按现存文档 createdAt（June 桶无外部污染可精确）', async () => {
  const d = (await adminPlanTrend({ days: 7 }, FIXED_NOW)) as Awaited<ReturnType<typeof adminPlanTrend>>;
  const expectedLabels: string[] = [];
  for (let i = 6; i >= 0; i -= 1) expectedLabels.push(bjDateStr(fixedToday0 - i * DAY));
  assert.deepEqual(d.labels, expectedLabels);
  const yi = d.labels.indexOf(fixedYesterdayKey);
  // achieveRate[yi] 可由基线 overview 的昨天计数精确推出（同一个 periodKey 分组口径）
  const b = base.overview!;
  assert.equal(d.achieveRate[yi], pctOf(b.yesterday.achieved + 1, b.yesterday.total + 2));
  // 集合关系：全达成 ⊆ 单项达成 → 单项率 ≥ 总达成率
  assert.ok(d.distRate[yi] >= d.achieveRate[yi]);
  assert.ok(d.durRate[yi] >= d.achieveRate[yi]);
  assert.ok(d.cntRate[yi] >= d.achieveRate[yi]);
  for (const arr of [d.achieveRate, d.distRate, d.durRate, d.cntRate]) {
    assert.ok(arr.every((v) => v >= 0 && v <= 100), '达成率取值 0–100');
  }
  // 新增计划（增量）：A createdAt=前天（labels[4]）、D=昨天（labels[5]）；库里其它计划不在窗口内变动
  const bTrend = base.trend!;
  assert.deepEqual(
    d.newPlans,
    bTrend.newPlans.map((v, i) => v + [0, 0, 0, 0, 1, 1, 0][i]),
  );
  assert.ok(d.newPlansNote.includes('近似'));
  const fallback = (await adminPlanTrend({ days: 999 }, FIXED_NOW)) as Awaited<ReturnType<typeof adminPlanTrend>>;
  assert.equal(fallback.days, 30, '非法 days 回退默认 30');
  assert.equal(fallback.labels.length, 30);
});

test('APS4 分布：目标档位按现存计划、完成率分档按近30天快照 minRatio（基线+增量）', async () => {
  const b = base.dist!;
  const d = (await adminPlanDistribution(FIXED_NOW)) as Awaited<ReturnType<typeof adminPlanDistribution>>;
  const deltaAssert = (arr: { count: number }[], bArr: { count: number }[], delta: number[], msg: string) =>
    assert.deepEqual(arr.map((t) => t.count), bArr.map((t) => t.count).map((v, i) => v + delta[i]), msg);
  deltaAssert(d.distTiers, b.distTiers, [0, 1, 0, 1], 'A 3km→2–5km 档、D 12km→>10km 档');
  deltaAssert(d.durTiers, b.durTiers, [0, 1, 0, 0], 'A 30min→15–30min 档，D 未设时长');
  deltaAssert(d.cntTiers, b.cntTiers, [1, 0, 0], 'A 1 次；D 未设次数');
  deltaAssert(d.completionTiers, b.completionTiers, [0, 0, 1, 1], 'A minRatio=1 → 100–199%；B 只设距离且 2 倍 → ≥200%');
  assert.equal(d.completionSampleDays, 30);
});

test('APS5 用户列表：状态/距离档筛选、排序与分页（基线+增量）', async () => {
  const all = await fetchAllUsers({});
  assert.equal(all.length, base.usersTotal + 3);
  const mine = all.filter((i) => [idA, idB, idD].includes(i.userId));
  assert.equal(mine.length, 3);
  const byUser = new Map(mine.map((i) => [i.userId, i]));
  assert.equal(byUser.get(idA)?.status, 'active');
  assert.equal(byUser.get(idA)?.nickname, '计划用户A');
  assert.equal(byUser.get(idA)?.changed, true, 'updatedAt 晚于 createdAt → 改过目标');
  assert.equal(byUser.get(idD)?.changed, false, 'updatedAt=createdAt → 未改过');
  assert.equal(byUser.get(idB)?.status, 'cancelled', '无计划文档但有快照 → 已取消');
  assert.equal(byUser.get(idA)?.rate30, 100);
  assert.equal(byUser.get(idA)?.bestStreak, 1);
  assert.equal(byUser.get(idB)?.bestStreak, 0, 'B 那期 allAchieved=false 不进连续');

  const cancelled = await fetchAllUsers({ status: 'cancelled' });
  assert.equal(cancelled.length, base.cancelledTotal + 1);
  assert.ok(cancelled.some((i) => i.userId === idB), 'cancelled 里包含 B');

  const t4 = await fetchAllUsers({ distTier: 't4' });
  assert.equal(t4.length, base.t4Total + 1);
  assert.ok(t4.some((i) => i.userId === idD), '目标 >10km → 含 D');
  assert.ok(!t4.some((i) => i.userId === idA), 'A 3km 不在 t4');

  const byRate = await fetchAllUsers({ sortBy: 'rate30' });
  const order = byRate.map((i) => i.userId).filter((uid) => [idA, idB, idD].includes(uid));
  assert.equal(order[0], idA, 'rate30 倒序 → A（100）在我的用户里排第一');

  const page1 = (await adminPlanUsers({ page: 1, pageSize: 2 }, FIXED_NOW)) as Awaited<ReturnType<typeof adminPlanUsers>>;
  assert.equal(page1.total, base.usersTotal + 3);
  assert.equal(page1.items.length, 2);

  await assert.rejects(
    () => adminPlanUsers({ page: 1, pageSize: 20, status: 'xxx' as never }, FIXED_NOW),
    /status 不合法/,
  );
  await assert.rejects(
    () => adminPlanUsers({ page: 1, pageSize: 20, sortBy: 'xxx' }, FIXED_NOW),
    /sortBy 不合法/,
  );
  await assert.rejects(
    () => adminPlanUsers({ page: 1, pageSize: 20, status: 'cancelled', distTier: 't4' }, FIXED_NOW),
    /不能同时筛选/,
    'cancelled 无计划文档，与 distTier 组合必然 0 结果 → 直接 400',
  );
});

test('APS6 用户详情：目标 + 逐日快照倒序 + 汇总；非法/未知用户报错', async () => {
  const d = (await adminPlanUserDetail(idA, FIXED_NOW)) as unknown as {
    user: { nickname: string };
    plan: { targets: { distanceM: number } } | null;
    totals: { snapshotDays: number; achievedTotal: number; rate30: number; bestStreak: number };
    calendar: Array<{ date: string; allAchieved: boolean }>;
  };
  assert.equal(d.user.nickname, '计划用户A');
  assert.equal(d.plan?.targets.distanceM, 3000);
  assert.equal(d.totals.snapshotDays, 1);
  assert.equal(d.totals.achievedTotal, 1);
  assert.equal(d.totals.rate30, 100);
  assert.equal(d.totals.bestStreak, 1);
  assert.equal(d.calendar.length, 1);
  assert.equal(d.calendar[0].date, fixedYesterdayKey);
  assert.equal(d.calendar[0].allAchieved, true);

  await assert.rejects(() => adminPlanUserDetail('not-an-id', FIXED_NOW), /userId 不合法/);
  await assert.rejects(() => adminPlanUserDetail(`${idB.slice(0, -2)}ff`, FIXED_NOW), /用户不存在/);
});
