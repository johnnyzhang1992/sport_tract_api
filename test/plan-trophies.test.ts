import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { ExercisePlanPeriodModel } from '../src/models/exercise-plan-period.model.js';
import { bjDateStr } from '../src/utils/bj-time.js';
import type { PlanTrophy } from '../src/services/exercise-plan.js';

/**
 * 里程碑奖杯扩展（docs/21）：getPlanSummary 的 trophies/records 计算口径。
 * 种子场景（全部相对「今天」构造，任何一天跑都成立）：
 *   - 连续 120 天、每天恰好 1 次 finished 运动，距离/时长逐日递增
 *     → 破纪录次数 120/120（每天都是新高）、最长连续 120 天、累计活动 120 次
 *   - 前 100 天的 daily 快照三项全达成（合环 100 次）
 *     → 完美周（全能/单项）至少各 1 个；第 101~107 天只达成距离+次数（时长没达）→ 单项完美周再 +1
 * 档位阶梯 100/365/500/1000/2000 下：100 档五座全解锁，365 档全未解锁。
 */

const API = '/sport-track/api';
const DAY = 86_400_000;
let app: FastifyInstance;
let tokenA = '';

function bjDate(offsetDays: number): string {
  return bjDateStr(Date.now() - offsetDays * DAY);
}

function bjDayStartMs(offsetDays: number): number {
  return Date.parse(`${bjDate(offsetDays)}T00:00:00+08:00`);
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  const users = await UserModel.find({ openid: /^wrt-/ }).select('_id');
  const ids = users.map((u) => u._id);
  await ActivityModel.deleteMany({ userId: { $in: ids } });
  await ExercisePlanPeriodModel.deleteMany({ userId: { $in: ids } });
  await UserModel.deleteMany({ _id: { $in: ids } });

  const login = await app.inject({ method: 'POST', url: `${API}/auth/login`, payload: { code: 'openid:wrt-a' } });
  tokenA = login.json().data.accessToken;
  const user = await UserModel.findOne({ openid: 'wrt-a' });
  const userId = user!._id;

  // 120 天连续运动：第 i 天（1=最早，120=今天）距离 1000+i*10 m、时长 1800+i*60 s
  // → 距离/时长各自天天破纪录（120 次）、最长连续 120 天、累计活动 120 次
  const activities = [] as Record<string, unknown>[];
  for (let i = 1; i <= 120; i++) {
    const start = bjDayStartMs(120 - i) + 3600_000;
    activities.push({
      userId,
      type: 'walking',
      status: 'finished',
      startTime: start,
      endTime: start + 1800_000,
      duration: 1800 + i * 60,
      distance: 1000 + i * 10,
      trackPoints: [],
      markers: [],
    });
  }
  await ActivityModel.insertMany(activities);

  // daily 快照两段：
  //   A. 最早 100 天（offset 119→20）三项全达成 → 合环 100 次 + 完美周（全能）若干
  //   B. 上一个完整自然周（周一~周日，offset 随今天星期浮动）只达成距离+次数（时长没达）
  //      → 全能不计、单项完美周 +1（验证全能/单项分开计数）
  const snapshots = [] as Record<string, unknown>[];
  for (let off = 119; off >= 20; off--) {
    snapshots.push({
      userId,
      period: 'daily',
      periodKey: bjDate(off),
      windowStart: bjDayStartMs(off),
      windowEnd: bjDayStartMs(off) + DAY,
      targets: { distanceM: 1000, durationMin: 30, count: 1 },
      progress: { distanceM: 2000, durationSec: 2400, count: 1 },
      allAchieved: true,
    });
  }
  const dow = new Date(Date.now() + 8 * 3600_000).getUTCDay(); // 0=周日
  const thisMonday = (dow + 6) % 7; // 今天的星期一 offset
  for (let off = thisMonday + 7; off >= thisMonday + 1; off--) {
    snapshots.push({
      userId,
      period: 'daily',
      periodKey: bjDate(off),
      windowStart: bjDayStartMs(off),
      windowEnd: bjDayStartMs(off) + DAY,
      targets: { distanceM: 1000, durationMin: 30, count: 1 },
      progress: { distanceM: 2000, durationSec: 600, count: 1 }, // 时长没达（30min 目标只动 10min）
      allAchieved: false,
    });
  }
  await ExercisePlanPeriodModel.insertMany(snapshots);
});

after(async () => {
  const users = await UserModel.find({ openid: /^wrt-/ }).select('_id');
  const ids = users.map((u) => u._id);
  await ActivityModel.deleteMany({ userId: { $in: ids } });
  await ExercisePlanPeriodModel.deleteMany({ userId: { $in: ids } });
  await UserModel.deleteMany({ _id: { $in: ids } });
  await app.close();
});

async function summary() {
  const res = await app.inject({
    method: 'GET',
    url: `${API}/plan/summary`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data;
}

test('TP1 trophies 全量下发：原 8 + 新 27 = 35 座', async () => {
  const s = await summary();
  assert.equal(s.trophies.length, 34, '双倍宗师与 200% 章合并后 34 座');
  const keys = new Set(s.trophies.map((t: PlanTrophy) => t.key));
  for (const key of ['first', 'x5', 'rec-dist-100', 'rec-dur-2000', 'streak-365', 'ring-100', 'goal-500', 'perfect-week-all', 'perfect-week-single', 'x2', 'x3', 'x4']) {
    assert.ok(keys.has(key), `缺奖杯 ${key}`);
  }
});

test('TP2 记录与坚持：破纪录次数/当前纪录+日期/最长连续+结束日期/当前连续', async () => {
  const s = await summary();
  assert.equal(s.records.distance.breaks, 120, '距离逐日递增 → 天天破纪录');
  assert.equal(s.records.duration.breaks, 120, '时长逐日递增 → 天天破纪录');
  assert.equal(s.records.distance.bestM, 1000 + 120 * 10);
  assert.equal(s.records.distance.dateText, bjDate(0), '最佳产生于今天（最后一天）');
  assert.equal(s.records.streak.best, 120, '连续 120 天都有运动');
  assert.equal(s.records.streak.bestEndText, bjDate(0));
  assert.equal(s.records.streak.current, 120, '最后一天是今天，当前连续=120');

  const recDist100 = s.trophies.find((t: PlanTrophy) => t.key === 'rec-dist-100');
  assert.equal(recDist100.cur, 120);
  assert.equal(recDist100.unlocked, true, '120 ≥ 100 档解锁');
  assert.equal(recDist100.valueText.includes('km'), true);
  assert.equal(recDist100.dateText, bjDate(0));
  // 获得记录：破纪录次数 120 ≥ 100 → 已获得一次，首次获取日期 = 第 100 次破纪录那天
  assert.equal(recDist100.earnedCount, 1);
  const breakDays = [];
  for (let i = 1; i <= 120; i++) breakDays.push(bjDate(120 - i));
  assert.equal(recDist100.earnDateText, breakDays[99], '第 100 次破纪录的那一天');
  assert.equal(recDist100.pct, 100, '进度条已满');
  const recDist365 = s.trophies.find((t: PlanTrophy) => t.key === 'rec-dist-365');
  assert.equal(recDist365.unlocked, false, '120 < 365 档未解锁');
  assert.equal(recDist100.nextTier, 365, '已过 100 档 → 下一档 365');
  const streak365 = s.trophies.find((t: PlanTrophy) => t.key === 'streak-365');
  assert.equal(streak365.cur, 120);
  assert.equal(streak365.unlocked, false);
  const streak2000 = s.trophies.find((t: PlanTrophy) => t.key === 'streak-2000');
  assert.equal(streak2000.nextTier, 365, 'cur 120 → 下一档也是 365（阶梯首个大于 cur 的档）');
  assert.equal(streak365.valueText, '120 天');
});

test('TP3 合环与活动：daily 快照全达成 100 次、累计活动 120 次', async () => {
  const s = await summary();
  const ring100 = s.trophies.find((t: PlanTrophy) => t.key === 'ring-100');
  assert.equal(ring100.cur, 100);
  assert.equal(ring100.unlocked, true);
  assert.equal(ring100.earnedCount, 1, '第 100 个全达成日 → 获得一次');
  assert.equal(ring100.earnDateText, bjDate(20), '第 100 个全达成日 = 最旧快照日（offset 20）');
  assert.equal(ring100.pct, 100);
  const ring365 = s.trophies.find((t: PlanTrophy) => t.key === 'ring-365');
  assert.equal(ring365.cur, 100, 'ring-365 的 cur 与 ring-100 同源，只是档位更高');
  assert.equal(ring365.unlocked, false);
  assert.equal(ring365.earnedCount, 0, '未获得');
  assert.equal(ring365.pct, Math.round((100 / 365) * 100), '进度条百分比');
  assert.equal(ring100.nextTier, 365, '合环 100 → 下一档 365');
  const goal100 = s.trophies.find((t: PlanTrophy) => t.key === 'goal-100');
  assert.equal(goal100.cur, 120, '活动次数 = 120 天各 1 次');
  assert.equal(goal100.unlocked, true);
});

test('TP4 完美周：全能与单项分开计数、互不冒充', async () => {
  const s = await summary();
  const all = s.trophies.find((t: PlanTrophy) => t.key === 'perfect-week-all');
  const single = s.trophies.find((t: PlanTrophy) => t.key === 'perfect-week-single');
  assert.ok(all.cur >= 12, `100 个连续全达成天里至少十余个完整自然周，实际 ${all.cur}`);
  assert.equal(single.cur, all.cur + 1, `单项完美周 = 全能周 + 上个自然周（距离/次数达成、时长没达）：${single.cur} vs ${all.cur}`);
  assert.equal(all.unlocked, true, '档位 1，存在即解锁');
  assert.equal(single.unlocked, true);
  assert.equal(all.nextTier, null, '完美周无阶梯成长线');
});

test('TP5 记录口径=单日合计：同日两段运动加总后才破纪录', async () => {
  // 今天再加一段 500m：今天合计从 2200 → 2700，仍 > 纪录（2200 本身就是今天的），不改计数；
  // 关键在「加总口径」：造一段 5000m 的新活动 → 今日合计 2200+5000=7200，比原纪录多 5000，仍只算 1 次破纪录
  const user = await UserModel.findOne({ openid: 'wrt-a' });
  const start = bjDayStartMs(0) + 7200_000;
  await ActivityModel.create({
    userId: user!._id, type: 'running', status: 'finished',
    startTime: start, endTime: start + 600_000, duration: 600, distance: 5000,
    trackPoints: [], markers: [],
  });
  const s = await summary();
  assert.equal(s.records.distance.bestM, 1000 + 120 * 10 + 5000, '单日合计口径：今天两段加总');
  assert.equal(s.records.distance.breaks, 120, '今天两段合并只算同一天的合计，破纪录次数不变（仍是 120 次逐日递增）');
  assert.equal(s.records.streak.current, 120);
});

/* --------- 2026-11-14 review 修复的三个 bug 的回归 --------- */

test('TP6 脏数据不炸接口：periodKey 不是合法日期时跳过该行（曾 RangeError → summary 500）', async () => {
  const uid = (await UserModel.findOne({ openid: 'wrt-a' }).select('_id').lean())!._id;
  const now = Date.now();
  // 插入前先取一次基准（120 天场景本身已产生若干完美周）
  const before = (await app.inject({
    method: 'GET', url: `${API}/plan/summary`, headers: { authorization: `Bearer ${tokenA}` },
  })).json().data.trophies.find((t: PlanTrophy) => t.key === 'perfect-week-all').cur;
  // 直接插一条 periodKey 非日期的日快照（历史导入/迁移事故的极端情况）
  await ExercisePlanPeriodModel.create({
    userId: uid, period: 'daily', periodKey: 'T-bad',
    windowStart: now - DAY, windowEnd: now,
    targets: { distanceM: 3000, durationMin: 30, count: 1 },
    progress: { distanceM: 3000, durationSec: 1800, count: 1 },
    achieved: { distance: true, duration: true, count: true }, allAchieved: true,
  });

  const res = await app.inject({
    method: 'GET', url: `${API}/plan/summary`, headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(res.statusCode, 200, '脏数据不能让接口 500');
  const s = res.json().data;
  assert.equal(s.trophies.length, 34, '奖杯照常下发');
  const perfectAll = s.trophies.find((t: PlanTrophy) => t.key === 'perfect-week-all');
  assert.equal(perfectAll.cur, before, '非法日期不计入完美周（计数与插入脏数据前一致）');

  await ExercisePlanPeriodModel.deleteMany({ userId: uid, periodKey: 'T-bad' });
});

test('TP7 里程碑进度条：原 8 座的 pct 按 need 计算（曾读 tier 恒为 0%）', async () => {
  const uid = (await UserModel.findOne({ openid: 'wrt-a' }).select('_id').lean())!._id;
  // 造 3 条达成快照：first(need 1) 解锁、「坚持一周」(need 7) 进度 3/7=43%
  await ExercisePlanPeriodModel.deleteMany({ userId: uid, period: 'daily' });
  for (let i = 1; i <= 3; i += 1) {
    const key = bjDate(i);
    await ExercisePlanPeriodModel.create({
      userId: uid, period: 'daily', periodKey: key,
      windowStart: Date.parse(`${key}T00:00:00+08:00`),
      windowEnd: Date.parse(`${key}T00:00:00+08:00`) + DAY,
      targets: { distanceM: 3000, durationMin: 30, count: 1 },
      progress: { distanceM: 5000, durationSec: 2400, count: 1 },
      achieved: { distance: true, duration: true, count: true }, allAchieved: true,
    });
  }

  const res = await app.inject({
    method: 'GET', url: `${API}/plan/summary`, headers: { authorization: `Bearer ${tokenA}` },
  });
  const s = res.json().data;
  const first = s.trophies.find((t: PlanTrophy) => t.key === 'first');
  const week = s.trophies.find((t: PlanTrophy) => t.key === 'week');
  assert.equal(first.pct, 100, 'first: 1/1 = 100%');
  assert.equal(week.cur, 3);
  assert.equal(week.tier, 7);
  assert.equal(week.pct, Math.round((3 / 7) * 100), '未解锁里程碑也有进度（曾恒 0%）');
});

test('TP8 里程碑获取日期取本期最后一天（曾用 windowEnd 偏一天）', async () => {
  const uid = (await UserModel.findOne({ openid: 'wrt-a' }).select('_id').lean())!._id;
  const res = await app.inject({
    method: 'GET', url: `${API}/plan/summary`, headers: { authorization: `Bearer ${tokenA}` },
  });
  const s = res.json().data;
  const first = s.trophies.find((t: PlanTrophy) => t.key === 'first');
  assert.equal(first.unlocked, true);
  // TP7 造的 3 天里，第 1 次达成发生在 3 天前 → 获取日期必须是那天，不是第二天
  assert.equal(first.earnDateText, bjDate(3), 'earnDate = 该期窗口最后一天（不是 windowEnd 的次日）');
});

test('TP9 倍数章口径一致：300% 的周期同时算完成 200%（unlocked/cur/pct/earnedCount 不自相矛盾）', async () => {
  const uid = (await UserModel.findOne({ openid: 'wrt-a' }).select('_id').lean())!._id;
  await ExercisePlanPeriodModel.deleteMany({ userId: uid });
  await ActivityModel.deleteMany({ userId: uid });

  // 一个三项都 300% 的日周期
  const d = bjDayStartMs(3);
  await ExercisePlanPeriodModel.create({
    userId: uid, period: 'daily', periodKey: bjDate(3),
    windowStart: d, windowEnd: d + DAY,
    targets: { distanceM: 3000, durationMin: 30, count: 1 },
    progress: { distanceM: 9000, durationSec: 5400, count: 3 },
    achieved: { distance: true, duration: true, count: true }, allAchieved: true,
  });

  const res = await app.inject({
    method: 'GET', url: `${API}/plan/summary`, headers: { authorization: `Bearer ${tokenA}` },
  });
  const s = res.json().data;
  const x2 = s.trophies.find((t: PlanTrophy) => t.key === 'x2');
  const x3 = s.trophies.find((t: PlanTrophy) => t.key === 'x3');

  // 300% 的期：x3 直接达成；x2 按累计口径也算达成（一次 300% 就是「完成了 200%」）
  assert.equal(x2.unlocked, true, 'x2 解锁（累计口径）');
  assert.equal(x2.cur, 1);
  assert.equal(x2.earnedCount, 1, 'earnedCount 与 unlocked 必须一致（曾为 0 → 卡面「已解锁但未获得」）');
  assert.equal(x2.earnDateText, bjDate(3), '获取日期为该周期最后一天');
  assert.equal(x2.pct, 100, '完成一次即满格（曾按 cur/tier 算成 1%）');
  assert.equal(x3.unlocked, true);
  assert.equal(x3.pct, 100);
  assert.equal(s.trophies.find((t: PlanTrophy) => t.key === 'x4').unlocked, false, '400% 未达成');
});
