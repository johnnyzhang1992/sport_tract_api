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
  /** 当期周期键（东八区：日=YYYY-MM-DD、周=周一日期）：端上「当期达成」弹窗按期去重用；无计划时缺省 */
  periodKey?: string;
  /** 当期三项是否都设了目标且都达到（与结算快照同判据） */
  allAchieved?: boolean;
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
  // 当期达成（与结算快照同判据）：三项都设了目标且都达到；端上据此当天弹「目标达成」
  const achieved = {
    distance: t.distanceM > 0 && progress.distanceM >= t.distanceM,
    duration: t.durationMin > 0 && progress.durationSec >= t.durationMin * 60,
    count: t.count > 0 && progress.count >= t.count,
  };
  return {
    plan, progress, today, rings,
    periodKey: periodKeyOf(plan.period, start),
    allAchieved: achieved.distance && achieved.duration && achieved.count,
  };
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

/* ==========================================================================
 * 月历与单日详情（2026-11-10，参照 Apple 健身的月历三环 + 单日大环）
 * - 有周期快照的日期/周 → 直接用快照（历史目标，改计划不追溯）
 * - 尚未结算的当期（今天/本周）→ 实时聚合（当前目标）
 * ========================================================================== */

export interface PlanCalendarDay {
  /** 东八区 YYYY-MM-DD */
  date: string;
  /** 当天窗口起点（epoch ms） */
  windowStart: number;
  /** 三项完成度环（无数据时 pct 全 0） */
  rings: PlanRing[];
  allAchieved: boolean;
  /** snapshot=历史快照；live=当期实时聚合；none=该日无计划记录 */
  source: 'snapshot' | 'live' | 'none';
}

export interface PlanCalendarWeek extends PlanPeriodSnapshot {
  /** snapshot=已结算；live=本周实时 */
  source: 'snapshot' | 'live';
}

export interface PlanCalendarResult {
  /** YYYY-MM */
  month: string;
  days: PlanCalendarDay[];
  /** 与本月有交集的周计划记录（周计划用户用；单独列在月历下方） */
  weeks: PlanCalendarWeek[];
}

/** 'YYYY-MM' → 该月东八区窗口 [start, end) */
function monthRange(month: string): { start: number; end: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new AppError(400, '月份格式应为 YYYY-MM');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new AppError(400, '月份不合法');
  return { start: Date.UTC(y, mo - 1, 1) - 8 * 3600_000, end: Date.UTC(y, mo, 1) - 8 * 3600_000 };
}

/** 某天窗口内按轨迹聚合（单日/单周通用） */
async function sumByDay(userId: string, from: number, to: number) {
  const rows = await ActivityModel.aggregate<{ _id: number; distance: number; duration: number; count: number }>([
    { $match: { userId: new Types.ObjectId(userId), status: 'finished', startTime: { $gte: from, $lt: to } } },
    {
      $group: {
        // 按东八区自然日分桶：startTime + 8h 后取整日
        _id: { $floor: { $divide: [{ $add: ['$startTime', 8 * 3600_000] }, 86_400_000] } },
        distance: { $sum: '$distance' },
        duration: { $sum: '$duration' },
        count: { $sum: 1 },
      },
    },
  ]);
  const byDay = new Map<number, { distanceM: number; durationSec: number; count: number }>();
  for (const r of rows) {
    byDay.set(Number(r._id), {
      distanceM: r.distance || 0,
      durationSec: r.duration || 0,
      count: r.count || 0,
    });
  }
  return byDay;
}

/**
 * 月历：每天一项完成度 + 本月涉及的周计划记录。
 * 有快照用快照；当期（今天）实时聚合；再往前没有快照的日期按「当前目标」实时聚合（功能上线前的历史）。
 */
export async function listPlanCalendar(
  userId: string,
  month: string,
  now = Date.now(),
): Promise<PlanCalendarResult> {
  if (!Types.ObjectId.isValid(userId)) throw new AppError(401, '请先登录');
  const { start, end } = monthRange(month);
  const uid = new Types.ObjectId(userId);
  const plan = await getPlan(userId);
  const targets: PlanTargets = plan?.targets || { distanceM: 0, durationMin: 0, count: 0 };

  // 1) 本月内的日快照
  const daySnaps = await ExercisePlanPeriodModel.find({
    userId: uid, period: 'daily', windowStart: { $gte: start, $lt: end },
  }).lean();
  const snapByDate = new Map(daySnaps.map((s) => [String(s.periodKey), s]));

  // 2) 本月涉及的周快照（窗口与本月有交集：从月初前 7 天开始找）
  const weekSnaps = await ExercisePlanPeriodModel.find({
    userId: uid, period: 'weekly', windowStart: { $gte: start - 7 * 86_400_000, $lt: end },
  }).sort({ windowStart: -1 }).lean();

  // 3) 实时聚合本月全部轨迹（按月一次查完，避免逐天 N 次）
  const liveByDayIdx = await sumByDay(userId, start, end);

  const days: PlanCalendarDay[] = [];
  const todayStart = windowStart('daily', now);
  for (let ws = start; ws < end; ws += 86_400_000) {
    const date = bjDateStr(ws);
    const snap = snapByDate.get(date);
    if (snap) {
      days.push({
        date,
        windowStart: ws,
        rings: buildSnapshot('daily', ws, ws + 86_400_000, {
          distanceM: snap.targets?.distanceM || 0,
          durationMin: snap.targets?.durationMin || 0,
          count: snap.targets?.count || 0,
        }, {
          distanceM: snap.progress?.distanceM || 0,
          durationSec: snap.progress?.durationSec || 0,
          count: snap.progress?.count || 0,
        }).rings,
        allAchieved: !!snap.allAchieved,
        source: 'snapshot',
      });
      continue;
    }
    // 当期（今天）与上线前无快照的日期：实时聚合，目标用当前计划
    const idx = Math.floor((ws + 8 * 3600_000) / 86_400_000);
    const agg = liveByDayIdx.get(idx) || { distanceM: 0, durationSec: 0, count: 0 };
    const hasData = agg.distanceM > 0 || agg.durationSec > 0 || agg.count > 0;
    const snapBuilt = buildSnapshot('daily', ws, ws + 86_400_000, targets, agg);
    const future = ws > todayStart;
    days.push({
      date,
      windowStart: ws,
      rings: snapBuilt.rings,
      allAchieved: !future && hasData && snapBuilt.allAchieved,
      source: (future || !hasData) ? 'none' : 'live',
    });
  }

  // 4) 周记录：快照 + 本周实时（若本月包含本周）
  const weeks: PlanCalendarWeek[] = weekSnaps.map((s) => ({
    ...buildSnapshot('weekly', Number(s.windowStart), Number(s.windowEnd), {
      distanceM: s.targets?.distanceM || 0,
      durationMin: s.targets?.durationMin || 0,
      count: s.targets?.count || 0,
    }, {
      distanceM: s.progress?.distanceM || 0,
      durationSec: s.progress?.durationSec || 0,
      count: s.progress?.count || 0,
    }),
    source: 'snapshot' as const,
  }));
  const thisWeekStart = windowStart('weekly', now);
  const inThisMonth = thisWeekStart >= start && thisWeekStart < end;
  // 只有当前计划就是「每周」时，才把本周实时进度作为一条周记录（否则周目标＝日目标，会显示成 6.2/3.0）
  if (plan?.period === 'weekly' && inThisMonth && !weeks.some((w) => w.windowStart === thisWeekStart)) {
    const agg = await sumActivities(userId, thisWeekStart, thisWeekStart + 7 * 86_400_000);
    weeks.unshift({
      ...buildSnapshot('weekly', thisWeekStart, thisWeekStart + 7 * 86_400_000, targets, agg),
      source: 'live',
    });
  }
  weeks.sort((a, b) => b.windowStart - a.windowStart);

  return { month, days, weeks };
}

export interface PlanDayDetail {
  date: string;
  windowStart: number;
  rings: PlanRing[];
  allAchieved: boolean;
  source: 'snapshot' | 'live' | 'none';
  /** 当天轨迹摘要（按开始时间正序，最多 20 条） */
  tracks: Array<{
    id: string;
    type: string;
    distanceM: number;
    durationSec: number;
    startTime: number;
  }>;
}

/** 单日详情：三环 + 当天轨迹摘要（Apple 单日页的简化版，不带分时图表） */
export async function getPlanDayDetail(
  userId: string,
  date: string,
  now = Date.now(),
): Promise<PlanDayDetail> {
  if (!Types.ObjectId.isValid(userId)) throw new AppError(401, '请先登录');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400, '日期格式应为 YYYY-MM-DD');
  const ws = Date.parse(`${date}T00:00:00+08:00`);
  if (Number.isNaN(ws) || bjDateStr(ws) !== date) throw new AppError(400, '日期不合法');
  const we = ws + 86_400_000;
  const uid = new Types.ObjectId(userId);

  const plan = await getPlan(userId);
  const targets: PlanTargets = plan?.targets || { distanceM: 0, durationMin: 0, count: 0 };

  const snap = await ExercisePlanPeriodModel.findOne({ userId: uid, period: 'daily', periodKey: date }).lean();
  const rows = await ActivityModel.find({ userId: uid, status: 'finished', startTime: { $gte: ws, $lt: we } })
    .select({ type: 1, distance: 1, duration: 1, startTime: 1 })
    .sort({ startTime: 1 })
    .limit(20)
    .lean();
  const agg = rows.reduce((acc, r) => ({
    distanceM: acc.distanceM + (Number(r.distance) || 0),
    durationSec: acc.durationSec + (Number(r.duration) || 0),
    count: acc.count + 1,
  }), { distanceM: 0, durationSec: 0, count: 0 });

  const useSnap = !!snap;
  const built = buildSnapshot(
    'daily',
    ws,
    we,
    useSnap
      ? {
        distanceM: snap!.targets?.distanceM || 0,
        durationMin: snap!.targets?.durationMin || 0,
        count: snap!.targets?.count || 0,
      }
      : targets,
    useSnap
      ? {
        distanceM: snap!.progress?.distanceM || 0,
        durationSec: snap!.progress?.durationSec || 0,
        count: snap!.progress?.count || 0,
      }
      : agg,
  );
  const hasData = agg.count > 0;
  return {
    date,
    windowStart: ws,
    rings: built.rings,
    allAchieved: useSnap ? !!snap!.allAchieved : (hasData && built.allAchieved),
    source: useSnap ? 'snapshot' : (hasData ? 'live' : 'none'),
    tracks: rows.map((r) => ({
      id: String(r._id),
      type: String(r.type || ''),
      distanceM: Number(r.distance) || 0,
      durationSec: Number(r.duration) || 0,
      startTime: Number(r.startTime) || 0,
    })),
  };
}

/* ==========================================================================
 * 记录数据概况 + 里程碑奖杯（2026-11-10）
 * 奖杯口径：某个周期「三项里最弱的一项」的完成倍数 ratio（100%=达成、200%/300%=超额），
 * 达到指定倍数的周期数够了就解锁——比只看次数更能体现持续与超额完成。
 * ========================================================================== */

export interface PlanMilestoneDef {
  key: string;
  label: string;
  desc: string;
  /** 需要的最低完成倍数（1=达成目标，2=200%，3=300%） */
  ratio: number;
  /** 需要达到该倍数的周期次数 */
  times: number;
}

export const PLAN_MILESTONES: readonly PlanMilestoneDef[] = [
  { key: 'first', label: '首次达成', desc: '完成 1 次目标', ratio: 1, times: 1 },
  { key: 'week', label: '坚持一周', desc: '达成 7 次', ratio: 1, times: 7 },
  { key: 'habit', label: '习惯养成', desc: '达成 20 次', ratio: 1, times: 20 },
  { key: 'x2', label: '双倍火力', desc: '200% 达成 10 次', ratio: 2, times: 10 },
  { key: 'x2pro', label: '双倍宗师', desc: '200% 达成 20 次', ratio: 2, times: 20 },
  { key: 'x3', label: '三倍王者', desc: '300% 达成 10 次', ratio: 3, times: 10 },
  { key: 'x4', label: '四倍狂人', desc: '400% 达成 5 次', ratio: 4, times: 5 },
  { key: 'x5', label: '五倍传奇', desc: '500% 达成 3 次', ratio: 5, times: 3 },
];

/** 里程碑支持的倍数档位（ratio → 该档周期计数）；新加档位时同步这里 */
const RATIO_TIERS = [1, 2, 3, 4, 5] as const;

/**
 * 一个周期落在哪一档：只按它达到的最高档归位，**不向低档重复计数**
 * （500% 的一期只算 5x，不算 1x/2x/3x/4x）。未达成（<100%）返回 0。
 */
function tierOf(ratio: number): number {
  let tier = 0;
  for (const t of RATIO_TIERS) {
    if (ratio >= t) tier = t;
  }
  return tier;
}

export interface PlanSummaryResult {
  /** 已结算周期总数（日+周） */
  totalPeriods: number;
  /** 其中达成（三项全达标）的次数 */
  achievedPeriods: number;
  /** 达成率 0–1 */
  rate: number;
  /** 连续达成：按当前计划周期类型统计 */
  streak: { current: number; best: number };
  /** 连续超额：从最近一期往前数连续 ≥200% 的期数（按当前计划周期类型；计划可能偏轻的信号） */
  overStreak: number;
  /** 已结算周期累计（跨周期求和） */
  totals: { distanceM: number; durationSec: number; count: number };
  milestones: Array<{
    key: string;
    label: string;
    desc: string;
    unlocked: boolean;
    /** 当前已完成次数 / 需要次数 */
    cur: number;
    need: number;
  }>;
}

/** 一个周期的「最弱一项」完成倍数：三项里 progress/target 的最小值（目标 0 的项跳过） */
function minRatioOf(progress: { distanceM: number; durationSec: number; count: number }, targets: PlanTargets): number {
  const ratios: number[] = [];
  if (targets.distanceM > 0) ratios.push((progress.distanceM || 0) / targets.distanceM);
  if (targets.durationMin > 0) ratios.push((progress.durationSec || 0) / (targets.durationMin * 60));
  if (targets.count > 0) ratios.push((progress.count || 0) / targets.count);
  if (!ratios.length) return 0;
  return Math.min(...ratios);
}

/** 记录数据概况 + 里程碑（历史快照聚合；无历史时全 0、奖杯全灰） */
export async function getPlanSummary(userId: string): Promise<PlanSummaryResult> {
  if (!Types.ObjectId.isValid(userId)) throw new AppError(401, '请先登录');
  const plan = await getPlan(userId);
  const rows = await ExercisePlanPeriodModel.find({ userId: new Types.ObjectId(userId) })
    .select({ period: 1, periodKey: 1, windowStart: 1, targets: 1, progress: 1, allAchieved: 1 })
    .sort({ windowStart: 1 })
    .lean();

  let achieved = 0;
  const totals = { distanceM: 0, durationSec: 0, count: 0 };
  // 按倍数分档计数（1x…5x）：每期只进它所在的那一档，不向低档重复计数
  const ratioCount: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of rows) {
    const targets: PlanTargets = {
      distanceM: r.targets?.distanceM || 0,
      durationMin: r.targets?.durationMin || 0,
      count: r.targets?.count || 0,
    };
    const progress = {
      distanceM: r.progress?.distanceM || 0,
      durationSec: r.progress?.durationSec || 0,
      count: r.progress?.count || 0,
    };
    if (r.allAchieved) achieved += 1;
    totals.distanceM += progress.distanceM;
    totals.durationSec += progress.durationSec;
    totals.count += progress.count;
    const tier = tierOf(minRatioOf(progress, targets));
    if (tier > 0) ratioCount[tier] += 1;
  }

  // 连续达成：只看当前计划周期类型（日/周），按窗口正序扫一遍
  const periodType: PlanPeriod = plan?.period ?? 'daily';
  const seq = rows.filter((r) => r.period === periodType);
  let best = 0;
  let run = 0;
  for (const r of seq) {
    if (r.allAchieved) {
      run += 1;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
  }
  // 当前连续：从最后一次往前数
  let current = 0;
  for (let i = seq.length - 1; i >= 0 && seq[i].allAchieved; i -= 1) current += 1;

  // 连续超额：从最后一次往前数连续 minRatio ≥ OVER_RATIO 的期数（加量建议的触发信号）
  const OVER_RATIO = 2;
  const ratioOfRow = (r: (typeof seq)[number]) =>
    minRatioOf(
      {
        distanceM: r.progress?.distanceM || 0,
        durationSec: r.progress?.durationSec || 0,
        count: r.progress?.count || 0,
      },
      {
        distanceM: r.targets?.distanceM || 0,
        durationMin: r.targets?.durationMin || 0,
        count: r.targets?.count || 0,
      },
    );
  let overStreak = 0;
  for (let i = seq.length - 1; i >= 0 && ratioOfRow(seq[i]) >= OVER_RATIO; i -= 1) overStreak += 1;

  const milestones = PLAN_MILESTONES.map((def) => {
    // 1x 档就是「达成」本身（≥100% 都算）；2x 及以上只统计落在该档的周期
    const tier = RATIO_TIERS.filter((t) => t <= def.ratio).pop() ?? 1;
    const cur = tier === 1 ? achieved : (ratioCount[tier] || 0);
    return {
      key: def.key,
      label: def.label,
      desc: def.desc,
      unlocked: cur >= def.times,
      cur,
      need: def.times,
    };
  });

  const totalPeriods = rows.length;
  return {
    totalPeriods,
    achievedPeriods: achieved,
    rate: totalPeriods > 0 ? achieved / totalPeriods : 0,
    streak: { current, best },
    overStreak,
    totals,
    milestones,
  };
}
