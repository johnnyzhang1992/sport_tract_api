/**
 * 运动计划（苹果活动目标式三环）：一个用户一份计划（周期每天/每周二选一），
 * 三项目标（距离米/时长分钟/次数），完成度按所选周期的已完成轨迹实时聚合。
 */
import { Types } from 'mongoose';
import { AppError } from '../utils/app-error.js';
import { ExercisePlanModel } from '../models/exercise-plan.model.js';
import { ExercisePlanPeriodModel } from '../models/exercise-plan-period.model.js';
import { ActivityModel } from '../models/activity.model.js';
import { bjDateStr, bjIsoWeekStart } from '../utils/bj-time.js';

export type PlanPeriod = 'daily' | 'weekly';
export const PLAN_PERIODS: readonly PlanPeriod[] = ['daily', 'weekly'];

/** 目标上限：距离 500km、时长 10080 分钟（一周）、次数 999 */
export const PLAN_LIMITS = { distanceM: 500_000, durationMin: 10_080, count: 999 };

export interface PlanTargets {
  distanceM: number;
  durationMin: number;
  count: number;
}

export interface ExercisePlanDto {
  period: PlanPeriod;
  targets: PlanTargets;
  updatedAt: number;
}

export interface PlanRing {
  key: 'distance' | 'duration' | 'count';
  /** 当期实际值：距离（米）/ 时长（秒）/ 次数 */
  value: number;
  /** 目标值：距离（米）/ 时长（换算成秒）/ 次数 */
  target: number;
  /** 完成度 0–1（超额封顶 1；目标缺失为 0） */
  pct: number;
}

export interface PlanCurrentResult {
  plan: ExercisePlanDto | null;
  progress: { distanceM: number; durationSec: number; count: number };
  /** 今日已完成轨迹合计（与计划周期无关）：首页卡右侧「今日」栏用 */
  today: { distanceM: number; durationSec: number; count: number };
  rings: PlanRing[];
}

/** 目标归一化：非负整数（距离米/时长分/次数）；非法即 400（对象+实际值提示由调用方组装） */
function normalizeTargets(input: unknown): PlanTargets {
  const v = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const num = (key: string, cap: number): number => {
    const n = Number(v[key]);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      throw new AppError(400, `${key} 需为 0–${cap} 的整数`);
    }
    if (n > cap) throw new AppError(400, `${key} 不能超过 ${cap}`);
    return n;
  };
  return {
    distanceM: num('distanceM', PLAN_LIMITS.distanceM),
    durationMin: num('durationMin', PLAN_LIMITS.durationMin),
    count: num('count', PLAN_LIMITS.count),
  };
}

/**
 * 创建/更新本人计划：三项至少一项 > 0（全零＝没有目标，拒绝）。
 *
 * 改计划不追溯（2026-11-10）：保存前先把「新周期窗口内、改动之前」的已完成进度冻结为基线，
 * 之后进度 = 基线 + 改动之后的新轨迹。所以改目标不会让已经完成的进度倒退/跳增，
 * 改周期（每天↔每周）也只是把新窗口里改动之前的成绩计入基线，同样不被追溯修改。
 */
export async function upsertPlan(userId: string, input: unknown, now = Date.now()): Promise<ExercisePlanDto> {
  if (!Types.ObjectId.isValid(userId)) throw new AppError(401, '请先登录');
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const period = body.period as PlanPeriod;
  if (!PLAN_PERIODS.includes(period)) throw new AppError(400, '计划周期需为 daily 或 weekly');
  const targets = normalizeTargets(body.targets);
  if (targets.distanceM <= 0 && targets.durationMin <= 0 && targets.count <= 0) {
    throw new AppError(400, '至少设置一项目标（距离/时间/次数）');
  }
  // 冻结基线：新周期窗口内、此刻之前已经完成的进度（轨迹不可变，这就是「过去日期」的真实成绩）
  const start = windowStart(period, now);
  const before = await sumActivities(userId, start, now);
  await ExercisePlanModel.findOneAndUpdate(
    { userId: new Types.ObjectId(userId) },
    {
      $set: {
        period,
        targets,
        baseline: before,
        baselineWindowStart: start,
        baselineAt: now,
        updatedAt: new Date(),
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );
  const doc = await ExercisePlanModel.findOne({ userId: new Types.ObjectId(userId) }).lean();
  return toDto(doc!);
}

/** 查询本人计划；无计划返回 null */
export async function getPlan(userId: string): Promise<ExercisePlanDto | null> {
  if (!Types.ObjectId.isValid(userId)) throw new AppError(401, '请先登录');
  const doc = await ExercisePlanModel.findOne({ userId: new Types.ObjectId(userId) }).lean();
  return doc ? toDto(doc) : null;
}

function toDto(doc: {
  period: PlanPeriod;
  targets: PlanTargets;
  updatedAt: Date;
}): ExercisePlanDto {
  return {
    period: doc.period,
    targets: {
      distanceM: doc.targets.distanceM || 0,
      durationMin: doc.targets.durationMin || 0,
      count: doc.targets.count || 0,
    },
    updatedAt: new Date(doc.updatedAt).getTime(),
  };
}

/** 完成度窗口起点（东八区）：daily=今天 00:00；weekly=本周一 00:00（含首尾，窗口＝[start, start+周期)） */
function windowStart(period: PlanPeriod, now: number): number {
  if (period === 'daily') {
    const b = new Date(now + 8 * 3600_000);
    return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - 8 * 3600_000;
  }
  return bjIsoWeekStart(now);
}

/** 当期进度 + 三环（超额封顶；目标缺失的环 pct=0） */
/** 某窗口内的已完成轨迹合计 */
async function sumActivities(userId: string, from: number, to: number) {
  const [agg] = await ActivityModel.aggregate<{ distance: number; duration: number; count: number }>([
    {
      $match: {
        userId: new Types.ObjectId(userId),
        status: 'finished',
        startTime: { $gte: from, $lt: to },
      },
    },
    { $group: { _id: null, distance: { $sum: '$distance' }, duration: { $sum: '$duration' }, count: { $sum: 1 } } },
  ]);
  return {
    distanceM: agg?.distance || 0,
    durationSec: agg?.duration || 0,
    count: agg?.count || 0,
  };
}

export async function getPlanWithProgress(userId: string, now = Date.now()): Promise<PlanCurrentResult> {
  if (!Types.ObjectId.isValid(userId)) throw new AppError(401, '请先登录');
  const plan = await getPlan(userId);
  // 今日栏与计划周期无关：无计划也要给（首页卡引导态之外的「今日」数据）
  const todayStart = windowStart('daily', now);
  const today = await sumActivities(userId, todayStart, todayStart + 86_400_000);
  if (!plan) {
    return { plan: null, progress: { distanceM: 0, durationSec: 0, count: 0 }, today, rings: [] };
  }
  const start = windowStart(plan.period, now);
  const end = start + (plan.period === 'daily' ? 86_400_000 : 7 * 86_400_000);
  const real = await sumActivities(userId, start, end);
  /**
   * 改计划不追溯（2026-11-10）：窗口内真实合计永远算全（补录的旧日期轨迹也算，不做时间点切分），
   * 只是用保存计划那一刻冻结的成绩做**下限**——改计划不会让已完成的进度倒退。
   * 基线只在同一周期窗口内有效：换天/换周后窗口起点变了，不沿用旧基线。
   */
  const doc = await ExercisePlanModel.findOne({ userId: new Types.ObjectId(userId) })
    .select({ baseline: 1, baselineWindowStart: 1, baselineAt: 1 })
    .lean();
  const sameWindow = !!doc && Number(doc.baselineWindowStart) === start && Number(doc.baselineAt) > 0;
  const floor = sameWindow ? (doc!.baseline || { distanceM: 0, durationSec: 0, count: 0 }) : null;
  const progress = {
    distanceM: Math.max(real.distanceM, floor?.distanceM || 0),
    durationSec: Math.max(real.durationSec, floor?.durationSec || 0),
    count: Math.max(real.count, floor?.count || 0),
  };
  const t = plan.targets;
  const pctOf = (value: number, target: number) => (target > 0 ? Math.min(1, value / target) : 0);
  const rings: PlanRing[] = [
    { key: 'distance', value: progress.distanceM, target: t.distanceM, pct: pctOf(progress.distanceM, t.distanceM) },
    // 时长目标按分钟，进度按轨迹秒：环比较统一换算成秒
    { key: 'duration', value: progress.durationSec, target: t.durationMin * 60, pct: pctOf(progress.durationSec, t.durationMin * 60) },
    { key: 'count', value: progress.count, target: t.count, pct: pctOf(progress.count, t.count) },
  ];
  return { plan, progress, today, rings };
}

/* ==========================================================================
 * 周期快照（历史）：周期结束后把「目标 + 最终完成值」冻结成一条记录，
 * 供历史查询页（GET /plan/history）与后续达成统计使用。
 * ========================================================================== */

export interface PlanPeriodSnapshot {
  period: PlanPeriod;
  periodKey: string;
  windowStart: number;
  windowEnd: number;
  targets: { distanceM: number; durationMin: number; count: number };
  progress: { distanceM: number; durationSec: number; count: number };
  /** 三项完成度（0–1，超额封顶）——读时按快照算出，不落冗余字段 */
  rings: PlanRing[];
  achieved: { distance: boolean; duration: boolean; count: boolean };
  allAchieved: boolean;
}

/** 周期键：daily=该日 YYYY-MM-DD；weekly=该周周一 YYYY-MM-DD（东八区） */
function periodKeyOf(period: PlanPeriod, windowStartMs: number): string {
  return bjDateStr(windowStartMs);
}

/** 给定时刻所属窗口；上一窗口＝当前窗口整体往前挪一个周期 */
function previousWindow(period: PlanPeriod, now: number): { start: number; end: number } {
  const span = period === 'daily' ? 86_400_000 : 7 * 86_400_000;
  const end = windowStart(period, now);
  return { start: end - span, end };
}

function buildSnapshot(
  period: PlanPeriod,
  start: number,
  end: number,
  targets: PlanTargets,
  progress: { distanceM: number; durationSec: number; count: number },
): PlanPeriodSnapshot {
  const pctOf = (value: number, target: number) => (target > 0 ? Math.min(1, value / target) : 0);
  const rings: PlanRing[] = [
    { key: 'distance', value: progress.distanceM, target: targets.distanceM, pct: pctOf(progress.distanceM, targets.distanceM) },
    { key: 'duration', value: progress.durationSec, target: targets.durationMin * 60, pct: pctOf(progress.durationSec, targets.durationMin * 60) },
    { key: 'count', value: progress.count, target: targets.count, pct: pctOf(progress.count, targets.count) },
  ];
  const achieved = {
    distance: targets.distanceM > 0 && progress.distanceM >= targets.distanceM,
    duration: targets.durationMin > 0 && progress.durationSec >= targets.durationMin * 60,
    count: targets.count > 0 && progress.count >= targets.count,
  };
  return {
    period,
    periodKey: periodKeyOf(period, start),
    windowStart: start,
    windowEnd: end,
    targets,
    progress,
    rings,
    achieved,
    allAchieved: achieved.distance && achieved.duration && achieved.count,
  };
}

/**
 * 结算某个已结束的周期并落快照（幂等：唯一索引 {userId,period,periodKey}）。
 * 目标取「该周期最后一次保存的计划目标」——历史周期用当时的目标评价，之后改计划不影响历史。
 */
export async function finalizePlanPeriod(
  userId: string,
  period: PlanPeriod,
  start: number,
  end: number,
): Promise<PlanPeriodSnapshot | null> {
  if (!Types.ObjectId.isValid(userId)) return null;
  const doc = await ExercisePlanModel.findOne({ userId: new Types.ObjectId(userId) })
    .select({ targets: 1 }).lean();
  if (!doc) return null;
  const real = await sumActivities(userId, start, end);
  const targets: PlanTargets = {
    distanceM: doc.targets?.distanceM || 0,
    durationMin: doc.targets?.durationMin || 0,
    count: doc.targets?.count || 0,
  };
  const snap = buildSnapshot(period, start, end, targets, real);
  try {
    await ExercisePlanPeriodModel.updateOne(
      { userId: new Types.ObjectId(userId), period, periodKey: snap.periodKey },
      {
        $set: {
          windowStart: snap.windowStart,
          windowEnd: snap.windowEnd,
          targets: snap.targets,
          progress: snap.progress,
          achieved: snap.achieved,
          allAchieved: snap.allAchieved,
        },
        $setOnInsert: { userId: new Types.ObjectId(userId), period, periodKey: snap.periodKey },
      },
      { upsert: true },
    );
  } catch (e) {
    // 并发 upsert 撞唯一键：另一路已经写好了，视为成功
    if ((e as { code?: number }).code !== 11000) throw e;
  }
  return snap;
}

/** 上一周期结算（用户打开卡/页面时顺手补一条，保证活跃用户一定有历史） */
export async function finalizePreviousPeriod(userId: string, now = Date.now()): Promise<void> {
  const plan = await getPlan(userId);
  if (!plan) return;
  const w = previousWindow(plan.period, now);
  await finalizePlanPeriod(userId, plan.period, w.start, w.end);
}

/**
 * 全量结算（定时任务用）：给所有有计划的人补上一周期快照。
 * 只处理「上一周期已结束」的那一个单元，幂等可反复跑。
 */
export async function finalizeAllPreviousPeriods(now = Date.now()): Promise<{ done: number; failed: number }> {
  const plans = await ExercisePlanModel.find({}).select({ userId: 1, period: 1 }).lean();
  let done = 0;
  let failed = 0;
  for (const p of plans) {
    const w = previousWindow(p.period as PlanPeriod, now);
    try {
      await finalizePlanPeriod(String(p.userId), p.period as PlanPeriod, w.start, w.end);
      done += 1;
    } catch (e) {
      console.error('[exercise-plan] 周期结算失败', { userId: String(p.userId) }, e);
      failed += 1;
    }
  }
  return { done, failed };
}

export interface PlanHistoryQuery {
  /** 不传＝该用户计划的周期 */
  period?: string;
  /** 一次最多 60 条（默认 20），按窗口倒序 */
  limit?: number;
  /** 翻页游标：上一页最后一条的 windowStart（返回 windowStart < cursor 的记录） */
  cursor?: number;
}

/** 历史计划完成情况：按窗口倒序返回快照（含完成度环与达成标记） */
export async function listPlanHistory(
  userId: string,
  query: PlanHistoryQuery = {},
): Promise<{ items: PlanPeriodSnapshot[]; nextCursor: number | null }> {
  if (!Types.ObjectId.isValid(userId)) throw new AppError(401, '请先登录');
  const plan = await getPlan(userId);
  const period = (query.period === 'daily' || query.period === 'weekly')
    ? (query.period as PlanPeriod)
    : (plan?.period ?? null);
  if (!period) return { items: [], nextCursor: null };
  const limit = Math.max(1, Math.min(60, Math.floor(Number(query.limit) || 20)));
  const filter: Record<string, unknown> = { userId: new Types.ObjectId(userId), period };
  const cursor = Number(query.cursor);
  if (Number.isFinite(cursor) && cursor > 0) filter.windowStart = { $lt: cursor };

  const rows = await ExercisePlanPeriodModel.find(filter)
    .sort({ windowStart: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const items = page.map((r) => buildSnapshot(
    r.period as PlanPeriod,
    Number(r.windowStart),
    Number(r.windowEnd),
    {
      distanceM: r.targets?.distanceM || 0,
      durationMin: r.targets?.durationMin || 0,
      count: r.targets?.count || 0,
    },
    {
      distanceM: r.progress?.distanceM || 0,
      durationSec: r.progress?.durationSec || 0,
      count: r.progress?.count || 0,
    },
  ));
  return { items, nextCursor: hasMore ? Number(page[page.length - 1].windowStart) : null };
}

/** 每小时扫一次：结算上一周期（测试/显式关闭时不启动） */
export function startPlanSnapshotJob(intervalMs = 60 * 60 * 1000): NodeJS.Timeout | null {
  if (process.env.NODE_ENV === 'test' || process.env.PLAN_SNAPSHOT_JOB === 'off') return null;
  const tick = () => {
    finalizeAllPreviousPeriods().catch((e) => console.error('[exercise-plan] 周期结算扫描失败：', e));
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  const first = setTimeout(tick, 120_000);
  first.unref?.();
  return timer;
}
