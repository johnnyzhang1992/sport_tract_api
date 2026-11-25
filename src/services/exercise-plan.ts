/**
 * 运动计划（苹果活动目标式三环）：一个用户一份计划（2026-11-14 周计划下线，仅每日），
 * 三项目标（距离米/时长分钟/次数），完成度按所选周期的已完成轨迹实时聚合。
 */
import { Types } from 'mongoose';
import { AppError } from '../utils/app-error.js';
import { ExercisePlanModel } from '../models/exercise-plan.model.js';
import { ExercisePlanPeriodModel } from '../models/exercise-plan-period.model.js';
import { ActivityModel } from '../models/activity.model.js';
import { bjDateStr, bjDayStart } from '../utils/bj-time.js';
import { ACTIVITY_TYPE_META } from '../config/constants.js';
import { loadTrophyRanks } from './trophy-rank.js';
import {
  BADGE_DEFS,
  MILESTONES,
  RATIO_TIERS,
  groupTitleOf,
  categoryOfGroup,
  seriesOfBadge,
  type BadgeCategory,
  type BadgeDef,
  type BadgeGroup,
  type BadgeMetric,
} from '../config/badge-config.js';
import {
  computeBadgeEarns,
  minRatioOf as minRatioOfShared,
  distanceRatioOf,
  perfectWeekCounts as perfectWeekCountsShared,
  tierOf as tierOfRatio,
  type BadgeDailyRow,
  type BadgeRangeRow,
} from './badge-earn.js';

export type PlanPeriod = 'daily';
export const PLAN_PERIODS: readonly PlanPeriod[] = ['daily'];

/** 目标上限：距离 500km、时长 1440 分钟（一天，日计划口径）、次数 999 */
export const PLAN_LIMITS = { distanceM: 500_000, durationMin: 1_440, count: 999 };

export interface PlanTargets {
  distanceM: number;
  durationMin: number;
  count: number;
}

export interface ExercisePlanDto {
  period: PlanPeriod;
  targets: PlanTargets;
  updatedAt: number;
  /** 周计划锚点：已随周计划下线废弃，恒 0 */
  periodStart: number;
  /** 计划生效起点（东八区某天 0 点）：早于它的日期没有计划期，端上不作「未达成」评价 */
  activeFrom: number;
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
  /** 当期窗口 [windowStart, windowEnd)（epoch ms）；无计划时缺省 */
  windowStart?: number;
  windowEnd?: number;
  /** 当期周期键（东八区：日=当天、周=本期起点日期）：端上「当期达成」弹窗按期去重用；无计划时缺省 */
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
 * 改目标也只是把新窗口里改动之前的成绩计入基线，同样不被追溯修改。
 */
export async function upsertPlan(userId: string, input: unknown, now = Date.now()): Promise<ExercisePlanDto> {
  if (!Types.ObjectId.isValid(userId)) throw new AppError(401, '请先登录');
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  /**
   * 周期口径（2026-11-14 周计划下线）：一律按 daily 保存。
   * 宽容处理 weekly 而不是 400——旧版小程序仍带「每周」选项、存量计划打开编辑会把 weekly 原样回传，
   * 直接拒绝会让这些用户「保存不了计划」。收到 weekly 就静默升级为日计划（目标值原样保留）。
   */
  const rawPeriod = body.period;
  if (rawPeriod != null && rawPeriod !== 'daily' && rawPeriod !== 'weekly') {
    throw new AppError(400, '计划周期需为 daily（周计划已下线）');
  }
  const period: PlanPeriod = 'daily';
  if (rawPeriod === 'weekly') {
    console.info('[exercise-plan] 收到已下线的 weekly 周期，按日计划保存', { userId });
  }
  const targets = normalizeTargets(body.targets);
  if (targets.distanceM <= 0 && targets.durationMin <= 0 && targets.count <= 0) {
    throw new AppError(400, '至少设置一项目标（距离/时间/次数）');
  }
  const prev = await ExercisePlanModel.findOne({ userId: new Types.ObjectId(userId) }).lean();
  // 周计划已下线：仅每日计划，锚点概念随之移除（periodStart 恒 0）
  const periodStart = 0;
  /**
   * 计划生效起点：新计划 / 切换周期类型 → 今天 0 点（重新开始算「计划周期」与闲置计时）；
   * 改目标不重置（否则天天改目标就永远不会被判定闲置，历史边界也会一直往后挪）。
   */
  const activeFrom = !prev || prev.period !== period
    ? bjDayStart(now)
    : (planActiveFrom(prev) || bjDayStart(now));
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
        periodStart,
        activeFrom,
        updatedAt: new Date(),
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );
  const doc = await ExercisePlanModel.findOne({ userId: new Types.ObjectId(userId) }).lean();
  return toDto(doc!);
}

/** 查询本人计划；无计划返回 null */
export async function getPlan(userId: string, now = Date.now()): Promise<ExercisePlanDto | null> {
  if (!Types.ObjectId.isValid(userId)) throw new AppError(401, '请先登录');
  const doc = await ExercisePlanModel.findOne({ userId: new Types.ObjectId(userId) }).lean();
  if (!doc) return null;
  // 存量周计划（2026-11-14 下线前创建）：读到即规范化成日计划——
  // 迁移脚本 migrate-weekly-plans.ts 会批量转正，这里做兜底，避免漏迁移的文档
  // 让端上显示「每周」、按日窗口却配周目标，或被后续结算写出跨粒度的脏快照。
  if ((doc as { period?: string }).period !== 'daily') {
    await ExercisePlanModel.updateOne(
      { _id: doc._id, period: { $ne: 'daily' } },
      { $set: { period: 'daily', periodStart: 0 } },
    );
    (doc as { period?: string }).period = 'daily';
    (doc as { periodStart?: number }).periodStart = 0;
  }

  // 闲置取消（见 isPlanIdle）：用户回来读计划时判定，到期即取消，之后按「无计划」引导重建
  const lastActive = await lastActivityAt(userId);
  if (isPlanIdle(doc, lastActive, now)) {
    // 先补上「刚结束的那一期」——里面有真实运动就落一条快照，取消不等于抹掉已发生的成绩
    await settleLastPeriodBeforeCancel(userId, doc, now);
    await cancelPlan(userId, doc, now);
    return null;
  }
  return toDto(doc);
}

/**
 * 取消前补快照：从「上次结算到的下一期」逐期推进到当前期之前，含真实运动的期落快照、
 * 空期跳过——取消不等于抹掉已发生的成绩，但长期不活跃的用户也不该被塞一堆 0 进度记录。
 * （周计划下线后 span 一律按日；闲置判定要求连续 7 天无运动，所以「只补紧邻上一期」
 * 对闲置用户必然为空，必须回溯整个未结算区间才能保住已发生的成绩。）
 */
async function settleLastPeriodBeforeCancel(
  userId: string,
  doc: { period: PlanPeriod; periodStart?: number; activeFrom?: number; createdAt?: Date },
  now: number,
): Promise<void> {
  // 周期一律按日（周计划已下线）：span 恒 1 天，若沿用 doc.period='weekly'
  // 就会写出「标记 weekly、窗口 1 天」的脏快照行
  const period: PlanPeriod = 'daily';
  const span = periodSpan(period);
  const activeFrom = planActiveFrom(doc);
  const curStart = windowStart(period, now);
  if (curStart <= 0) return;
  const last = await ExercisePlanPeriodModel.findOne({ userId: new Types.ObjectId(userId), period })
    .sort({ windowStart: -1 }).select({ windowStart: 1 }).lean();
  const lastSettled = Number(last?.windowStart) || 0;
  let cursor = lastSettled > 0
    ? lastSettled + span
    : Math.max(activeFrom > 0 ? activeFrom : curStart - span, 0);
  let written = 0;
  while (cursor > 0 && cursor < curStart && written < CATCH_UP_MAX_PERIODS) {
    if (!(activeFrom > 0 && cursor < activeFrom)) {
      const progress = await sumActivities(userId, cursor, cursor + span);
      if (progress.distanceM > 0 || progress.durationSec > 0 || progress.count > 0) {
        await finalizePlanPeriod(userId, period, cursor, cursor + span);
        written += 1;
      }
    }
    cursor += span;
  }
}

/**
 * 取消闲置计划：删计划文档（历史快照保留）。删除条件是「仍是同一份计划」——
 * 防止刚删完用户就保存了新计划时把新计划误删（并发）。
 */
async function cancelPlan(
  userId: string,
  doc: { _id: unknown; period: PlanPeriod; targets: PlanTargets },
  now: number,
): Promise<void> {
  const res = await ExercisePlanModel.deleteOne({
    _id: doc._id,
    period: doc.period,
    'targets.distanceM': doc.targets?.distanceM || 0,
    'targets.durationMin': doc.targets?.durationMin || 0,
    'targets.count': doc.targets?.count || 0,
  });
  if (res.deletedCount) {
    console.log(`[exercise-plan] 闲置超过 ${PLAN_IDLE_DAYS} 天，已自动取消计划 userId=${userId} at=${now}`);
  }
}

/**
 * 计划生效起点（东八区某天 0 点）：activeFrom（新计划/切换类型）→ periodStart（存量周计划锚点）
 * → createdAt 当天（存量每天计划）。用来给结算快照划边界、给闲置取消算计时起点。
 */
function planActiveFrom(doc: {
  activeFrom?: number;
  periodStart?: number;
  createdAt?: Date;
}): number {
  const active = Number(doc.activeFrom) || 0;
  if (active > 0) return active;
  const anchor = Number(doc.periodStart) || 0;
  if (anchor > 0) return anchor;
  const created = doc.createdAt ? new Date(doc.createdAt).getTime() : 0;
  return created > 0 ? bjDayStart(created) : 0;
}

/**
 * 闲置取消（2026-11-12）：超过一个周期且连续 7 天以上没有任何运动 → 计划自动取消。
 *
 * 判断起点取「最近一次运动」与「计划生效起点」的较晚者：
 * - 刚建计划还没开始运动：从建计划那天算，不会第二天就被取消；
 * - 一直在运动：从最近一次运动算，停下来 7 天后才取消。
 * 取消＝删掉计划文档（历史快照保留，月历/概况照旧可看），用户下次回来就是「无计划」态，
 * 会重新走创建引导。
 */
export const PLAN_IDLE_DAYS = 7;

/** 用户最近一次运动（含进行中）的 startTime；从无轨迹返回 0 */
async function lastActivityAt(userId: string): Promise<number> {
  const last = await ActivityModel.findOne({
    userId: new Types.ObjectId(userId),
    status: { $in: ['finished', 'in_progress'] },
  }).sort({ startTime: -1 }).select({ startTime: 1 }).lean();
  return Number(last?.startTime) || 0;
}

/**
 * 计划是否已闲置到期：距「最近运动 / 计划生效起点」的较晚者已超过 7 天。
 * 同时要求确实跨过了一个完整周期（每天计划 1 天）——1 天都已覆盖 7 天闲置线，
 * 这里保留周期判断做语义兜底（将来加别的周期类型不必再改）。
 */
export function isPlanIdle(
  plan: { period: PlanPeriod; activeFrom?: number; periodStart?: number; createdAt?: Date },
  lastActiveAt: number,
  now = Date.now(),
): boolean {
  const from = planActiveFrom(plan);
  const anchor = Math.max(from || 0, Number(lastActiveAt) || 0);
  if (!anchor) return false; // 两个时间都拿不到：不动用户数据
  const periodMs = 86_400_000;
  const idleMs = now - anchor;
  return idleMs > Math.max(periodMs, PLAN_IDLE_DAYS * 86_400_000);
}

/** 计划生效起点（DTO 版）：activeFrom 缺失时回退 periodStart；都没有返回 0（视为不限制） */
function planActiveFromOf(plan: ExercisePlanDto | null): number {
  if (!plan) return 0;
  return Number(plan.activeFrom) || Number(plan.periodStart) || 0;
}

function toDto(doc: {
  period: PlanPeriod;
  targets: PlanTargets;
  updatedAt: Date;
  periodStart?: number;
  activeFrom?: number;
  createdAt?: Date;
}): ExercisePlanDto {
  return {
    period: doc.period,
    periodStart: Number(doc.periodStart) || 0,
    activeFrom: planActiveFrom(doc),
    targets: {
      distanceM: doc.targets.distanceM || 0,
      durationMin: doc.targets.durationMin || 0,
      count: doc.targets.count || 0,
    },
    updatedAt: new Date(doc.updatedAt).getTime(),
  };
}

/** 完成度窗口起点（东八区）：当天 00:00 */
function windowStart(period: PlanPeriod, now: number): number {
  return bjDayStart(now);
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
  const plan = await getPlan(userId, now);
  // 今日栏与计划周期无关：无计划也要给（首页卡引导态之外的「今日」数据）
  const todayStart = windowStart('daily', now);
  const today = await sumActivities(userId, todayStart, todayStart + 86_400_000);
  if (!plan) {
    return { plan: null, progress: { distanceM: 0, durationSec: 0, count: 0 }, today, rings: [] };
  }
  const start = windowStart(plan.period, now);
  const end = start + 86_400_000;
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
    windowStart: start,
    windowEnd: end,
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

/** 周期键：该日 YYYY-MM-DD（东八区） */
function periodKeyOf(period: PlanPeriod, windowStartMs: number): string {
  return bjDateStr(windowStartMs);
}

/** 给定时刻所属窗口；上一窗口＝当前窗口整体往前挪一个周期 */
function previousWindow(period: PlanPeriod, now: number): { start: number; end: number } {
  const span = 86_400_000;
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
 *
 * 两条硬规则（2026-11-12 修复）：
 * 1. **不补「计划还不存在」的期**：窗口起点早于计划生效起点（planActiveFrom）直接不写快照。
 *    否则用户今天新建计划，就会给昨天补出一条「已完成/已达成」的假历史。
 * 2. **目标只在首次结算时冻结**：之后改计划不重算历史——重结算只更新 progress/达成，
 *    不再用当前目标改写 targets（否则改目标会把昨天的「已达成」翻成「未达成」）。
 */
export async function finalizePlanPeriod(
  userId: string,
  period: PlanPeriod,
  start: number,
  end: number,
): Promise<PlanPeriodSnapshot | null> {
  if (!Types.ObjectId.isValid(userId)) return null;
  const uid = new Types.ObjectId(userId);
  const doc = await ExercisePlanModel.findOne({ userId: uid })
    .select({ targets: 1, activeFrom: 1, periodStart: 1, createdAt: 1 }).lean();
  if (!doc) return null;
  // 规则 1：计划生效之前没有「计划周期」这回事（含存量计划迁移前的空档）
  const activeFrom = planActiveFrom(doc);
  if (activeFrom > 0 && start < activeFrom) return null;

  const periodKey = periodKeyOf(period, start);
  // 规则 2：已有快照的目标是当时冻结的，重结算沿用（不存在才用当前目标）
  const existing = await ExercisePlanPeriodModel.findOne({ userId: uid, period, periodKey })
    .select({ targets: 1 }).lean();
  const targets: PlanTargets = existing
    ? {
        distanceM: existing.targets?.distanceM || 0,
        durationMin: existing.targets?.durationMin || 0,
        count: existing.targets?.count || 0,
      }
    : {
        distanceM: doc.targets?.distanceM || 0,
        durationMin: doc.targets?.durationMin || 0,
        count: doc.targets?.count || 0,
      };

  const real = await sumActivities(userId, start, end);
  const snap = buildSnapshot(period, start, end, targets, real);
  try {
    await ExercisePlanPeriodModel.updateOne(
      { userId: uid, period, periodKey: snap.periodKey },
      {
        $set: {
          windowStart: snap.windowStart,
          windowEnd: snap.windowEnd,
          progress: snap.progress,
          achieved: snap.achieved,
          allAchieved: snap.allAchieved,
        },
        // 目标只在插入时写入：重结算不改历史目标
        $setOnInsert: { userId: uid, period, periodKey: snap.periodKey, targets: snap.targets },
      },
      { upsert: true },
    );
  } catch (e) {
    // 并发 upsert 撞唯一键：另一路已经写好了，视为成功
    if ((e as { code?: number }).code !== 11000) throw e;
  }
  return snap;
}

/** 补结算上限：一次最多补这么多期（超长闲置用户不至于一次跑几百次） */
export const CATCH_UP_MAX_PERIODS = 60;

/** 周期跨度（毫秒）：1 天 */
function periodSpan(period: PlanPeriod): number {
  return 86_400_000;
}

/**
 * 把「已漏掉的周期」一次性补齐（2026-11-14）。
 *
 * 为什么需要：结算原来是「只补紧邻上一期」——服务器停机/任务失败一整天，那天就永久没快照
 * （完美周因此报废），离开多个周期回来也只补一条。
 *
 * 做法：取该用户已结算的最新一期（没有则从计划生效起点后的第一期开始），
 * 逐段推进到「当前期之前」，每段调 finalizePlanPeriod（幂等 upsert）。
 * 边界仍由 activeFrom / 周锚点兜住（计划开始之前不会有期）。
 * @returns 本次补写的期数
 */
async function catchUpPeriods(
  userId: string,
  doc: { period: PlanPeriod; periodStart?: number; activeFrom?: number; createdAt?: Date },
  now: number,
): Promise<number> {
  // 周期一律按日（周计划已下线）：doc.period 可能是未迁移的存量 'weekly'，
  // 沿用它会把「1 天窗口 + 周目标」写成 period=weekly 的脏快照，污染历史查询
  const period: PlanPeriod = 'daily';
  const span = periodSpan(period);
  const activeFrom = planActiveFrom(doc);
  const curStart = windowStart(period, now);
  if (curStart <= 0) return 0;

  // 已结算到哪一期（同周期类型的最新一条；存量周快照忽略——它们属于已下线的周计划）
  const last = await ExercisePlanPeriodModel.findOne({ userId: new Types.ObjectId(userId), period })
    .sort({ windowStart: -1 })
    .select({ windowStart: 1 })
    .lean();
  const lastSettled = Number(last?.windowStart) || 0;

  // 起点：已结算的下一期；从未结算过 → 计划生效起点所在的那一期
  let from = lastSettled > 0
    ? lastSettled + span
    : Math.max(activeFrom > 0 ? activeFrom : curStart - span, 0);
  if (from <= 0) return 0;
  if (from >= curStart) {
    // 没有漏掉的期：仍要结算「紧邻上一期」（常规路径）
    const w = previousWindow(period, now);
    if (w.start <= 0) return 0;
    if (activeFrom > 0 && w.start < activeFrom) return 0;
    if (lastSettled === w.start) return 0; // 已结算过，省一次查询
    await finalizePlanPeriod(userId, period, w.start, w.end);
    return 1;
  }

  let written = 0;
  let cursor = from;
  while (cursor < curStart && written < CATCH_UP_MAX_PERIODS) {
    if (activeFrom > 0 && cursor < activeFrom) {
      cursor += span;
      continue;
    }
    await finalizePlanPeriod(userId, period, cursor, cursor + span);
    written += 1;
    cursor += span;
  }
  return written;
}

/** 上一周期结算（用户打开卡/页面时顺手补齐）：含漏结算的多期补写，见 catchUpPeriods */
export async function finalizePreviousPeriod(userId: string, now = Date.now()): Promise<void> {
  const plan = await getPlan(userId, now);
  if (!plan) return;
  const doc = await ExercisePlanModel.findOne({ userId: new Types.ObjectId(userId) }).lean();
  if (!doc) return;
  await catchUpPeriods(userId, doc, now);
}

/**
 * 全量结算（定时任务用）：给所有有计划的人补齐漏掉的周期。
 * 每期结算幂等（唯一索引 + 首次冻结目标），可反复跑。
 */
export async function finalizeAllPreviousPeriods(now = Date.now()): Promise<{ done: number; failed: number }> {
  const plans = await ExercisePlanModel.find({})
    .select({ userId: 1, period: 1, periodStart: 1, activeFrom: 1, createdAt: 1 })
    .lean();
  let done = 0;
  let failed = 0;
  for (const p of plans) {
    try {
      done += await catchUpPeriods(String(p.userId), p, now);
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
  // period 缺省取计划自身的周期（存量周计划文档照常按 weekly 查询历史）
  // period 缺省取计划自身周期（存量周计划文档照常按 weekly 查历史）；不再有「无周期」分支
  const period: PlanPeriod = query.period === 'daily' || query.period === 'weekly'
    ? (query.period as PlanPeriod)
    : (plan?.period ?? 'daily');
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
  /**
   * 该日不在任何计划期内（计划还没开始 / 已取消），三环目标为 0、不算达成。
   * 端上据此显示「当天没有计划」而不是拿当前目标去回溯评价历史。
   */
  noPlan: boolean;
  /** snapshot=历史快照；live=当期实时聚合；none=该日无计划记录 */
  source: 'snapshot' | 'live' | 'none';
}


export interface PlanCalendarResult {
  /** YYYY-MM */
  month: string;
  days: PlanCalendarDay[];
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
  const plan = await getPlan(userId, now);
  const targets: PlanTargets = plan?.targets || { distanceM: 0, durationMin: 0, count: 0 };
  // 计划生效起点：早于它的日期没有计划期（历史日期不拿当前目标回溯评价）
  const planStart = plan ? planActiveFromOf(plan) : 0;

  // 1) 本月内的日快照
  const daySnaps = await ExercisePlanPeriodModel.find({
    userId: uid, period: 'daily', windowStart: { $gte: start, $lt: end },
  }).lean();
  const snapByDate = new Map(daySnaps.map((s) => [String(s.periodKey), s]));

  // 2) 实时聚合本月全部轨迹（按月一次查完，避免逐天 N 次）；周计划下线后月历不再有周快照层
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
        noPlan: false, // 有快照＝该日确实在计划期内
        source: 'snapshot',
      });
      continue;
    }
    // 无快照的日期：只有「计划期内」才用当前目标评价；计划开始之前（含计划已取消）算「当天没有计划」
    const idx = Math.floor((ws + 8 * 3600_000) / 86_400_000);
    const agg = liveByDayIdx.get(idx) || { distanceM: 0, durationSec: 0, count: 0 };
    const hasData = agg.distanceM > 0 || agg.durationSec > 0 || agg.count > 0;
    const noPlan = planStart > 0 && ws < planStart;
    // noPlan：目标全 0（三环全空、不算达成），历史日期不再被当前目标回溯评价
    const dayTargets: PlanTargets = noPlan ? { distanceM: 0, durationMin: 0, count: 0 } : targets;
    const snapBuilt = buildSnapshot('daily', ws, ws + 86_400_000, dayTargets, agg);
    const future = ws > todayStart;
    days.push({
      date,
      windowStart: ws,
      rings: snapBuilt.rings,
      allAchieved: !noPlan && !future && hasData && snapBuilt.allAchieved,
      noPlan,
      source: noPlan ? 'none' : ((future || !hasData) ? 'none' : 'live'),
    });
  }

  return { month, days };
}

export interface PlanDayDetail {
  date: string;
  windowStart: number;
  rings: PlanRing[];
  allAchieved: boolean;
  /** 该日不在任何计划期内（计划还没开始/已取消）：目标为 0，端上显示「当天没有计划」 */
  noPlan: boolean;
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

  const plan = await getPlan(userId, now);
  const targets: PlanTargets = plan?.targets || { distanceM: 0, durationMin: 0, count: 0 };
  const planStart = plan ? planActiveFromOf(plan) : 0;

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
  // 没有快照且该日早于计划生效起点：当天没有计划 → 目标全 0（不拿当前目标回溯）
  const noPlan = !useSnap && planStart > 0 && ws < planStart;
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
      : (noPlan ? { distanceM: 0, durationMin: 0, count: 0 } : targets),
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
    allAchieved: useSnap ? !!snap!.allAchieved : (!noPlan && hasData && built.allAchieved),
    noPlan,
    source: useSnap ? 'snapshot' : ((noPlan || !hasData) ? 'none' : 'live'),
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

export const PLAN_MILESTONES: readonly PlanMilestoneDef[] = MILESTONES;

/**
 * 一个周期落在哪一档：只按它达到的最高档归位，**不向低档重复计数**
 * （500% 的一期只算 5x，不算 1x/2x/3x/4x）。未达成（<100%）返回 0。
 * 实现已收口到 badge-earn.ts（与解锁日期同一套档位逻辑）。
 */
const tierOf = tierOfRatio;

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
    /** 徽章中央数字：倍数章=百分比（200/300/…），次数章=需要的次数 */
    tier: number;
    /** 进度条百分比（未获得的倍数章恒 0） */
    pct: number;
  }>;
  /** 里程碑奖杯扩展（docs/21）：原 8 个 + 记录/坚持/圆环/目标/完美周，统一卡面（图标+名称+次数） */
  trophies: PlanTrophy[];
  /** 记录与坚持明细（记录型奖杯的详情数据源） */
  records: PlanRecords;
  /** 分运动类型累计概览（我的徽章页「按类型」区用）：只含有数据的类型 */
  activityTypes: Array<{ type: string; label: string; distanceM: number; durationSec: number; count: number }>;
}

/** 一个周期的「最弱一项」完成倍数（实现收口在 badge-earn.ts，与解锁日期同一套口径） */
const minRatioOf = minRatioOfShared;

/** 记录数据概况 + 里程碑（历史快照聚合；无历史时全 0、奖杯全灰） */
export async function getPlanSummary(userId: string): Promise<PlanSummaryResult> {
  if (!Types.ObjectId.isValid(userId)) throw new AppError(401, '请先登录');
  const plan = await getPlan(userId);
  // 概况是累计成就：锚点之前的历史快照照常计入（仅展示列表按锚点过滤）
  const rows = await ExercisePlanPeriodModel.find({ userId: new Types.ObjectId(userId) })
    .select({ period: 1, periodKey: 1, windowStart: 1, windowEnd: 1, targets: 1, progress: 1, allAchieved: 1 })
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
    /*
     * 倍率档只看距离（2026-11-20 产品裁定）：原来取三项最弱，导致
     * 「跑了 18km（目标 3km）但次数没补齐」的用户拿不到 200% 徽章。
     * 与 badge-earn.ts 的解锁日必须同口径（那里也用 distanceRatioOf）。
     * 注意：下面的 overStreak 仍用 minRatioOf——那是「建议加量」的信号，
     * 语义是「整体已轻松超额」，三项都高才算，不要一起改。
     */
    const tier = tierOf(distanceRatioOf(progress, targets));
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

  /*
   * 连续超额：从最后一次往前数连续 minRatio ≥ OVER_RATIO 的期数（加量建议的触发信号）。
   * ⚠️ 这里**故意**仍用三项最弱（minRatioOf），与倍率徽章的距离口径不同：
   * 建议加量的前提是「三项整体都轻松超额，目标定低了」；
   * 只看距离会把「距离很远但次数总差一点」的用户也劝去加量，反而更挫败。
   */
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
    // 1x 档就是「达成」本身（≥100% 都算）
    const cur = def.ratio >= 2
      // 倍数章（2026-11-14 调整）：完成一次对应百分比即获得——cur = 完成倍数 ≥ 该百分比的周期数
      // （500% 的周期同样算完成了 200%，累计口径）
      ? RATIO_TIERS.filter((t) => t >= def.ratio).reduce((acc, t) => acc + (ratioCount[t] || 0), 0)
      : achieved;
    return {
      key: def.key,
      label: def.label,
      desc: def.desc,
      unlocked: cur >= def.times,
      cur,
      need: def.times,
      // 徽章中央数字：倍数章印百分比（200/300/400/500），次数章印需要的次数（1/7/20）
      tier: def.ratio >= 2 ? def.ratio * 100 : def.times,
      /** 是否倍率型里程碑（单周期完成倍数，如 200%）：显式带出来，别靠 tier/need 反推 */
      isRatio: def.ratio >= 2,
      // 进度条：倍数章完成一次即满格；次数章按达成次数/需要次数
      pct: def.ratio >= 2 ? (cur >= 1 ? 100 : 0) : Math.min(Math.round((cur / def.times) * 100), 100),
    };
  });

  // —— 里程碑奖杯扩展（docs/21）——
  const days = await dailyActivityTotals(userId);
  // 分运动类型的每日汇总（分类型徽章 + 类型概览用）
  const typeDays = await dailyTotalsByType(userId);
  const rec = computeRecordStats(days);
  const dailyRows = rows.filter((r) => r.period === 'daily');
  const perfect = perfectWeekCountsShared(dailyRows as unknown as BadgeRangeRow[]);
  // 累计总量（原始单位：米 / 秒）——阶梯按 km / 小时比，卡面显示原始值
  const totalDistanceM = days.reduce((acc, d) => acc + d.distanceM, 0);
  const totalDurationSec = days.reduce((acc, d) => acc + d.durationSec, 0);
  const counts = {
    streakBest: rec.streak.best,
    ringsClosed: dailyRows.filter((r) => r.allAchieved).length,
    // 累计总量（全历史，不设计划边界：与「破纪录」看峰值互补）
    totalDistanceKm: Math.floor(totalDistanceM / 1000),
    totalDurationHour: Math.floor(totalDurationSec / 3600),
    perfectWeekAll: perfect.all,
    perfectWeekDistance: perfect.distance,
    perfectWeekDuration: perfect.duration,
    perfectWeekCount: perfect.count,
    achievedPeriods: achieved,
    byType: buildByTypeCounts(typeDays),
  };
  // 每座徽章的获得记录（获得次数 + 首次获取日期）——卡片三态展示的数据源（算法收口在 badge-earn.ts）
  const earns = computeBadgeEarns({
    days,
    dailyRows: dailyRows as unknown as BadgeRangeRow[],
    periodRows: rows as unknown as BadgeRangeRow[],
    typeDays: typeDays as unknown as Record<string, BadgeDailyRow[]>,
  });
  // 全站「第 N 位迹路者」：按首次解锁日排名（同一天并列同名次）。
  // 传入**本人实时解锁日**（而不是让排名侧自己去缓存里查），保证「刚解锁的徽章立刻有名次」。
  // 失败/超时不能连累整个 summary——名次是附加信息，缺了只是不显示这一行
  const myUnlockDates: Record<string, string> = {};
  for (const [key, v] of Object.entries(earns)) if (v.earnDate) myUnlockDates[key] = v.earnDate;
  const ranks = await loadTrophyRanks(userId, myUnlockDates).catch((e: unknown) => {
    void e;
    return {} as Record<string, { rank: number; total: number }>;
  });
  const rankOf = (key: string) => ranks[key] || { rank: 0, total: 0 };
  // 进度百分比：普通系列按 cur/tier；原 8 里程碑用各自算好的 pct（倍数章「完成一次即满格」）
  const pctOf = (cur: number, tier: number) =>
    tier > 0 ? Math.min(Math.round((cur / tier) * 100), 100) : 0;

  /**
   * 详情半屏的进度文案：由配置里的模板渲染（前端不再自己拼文案）。
   * 模板占位：{cur} 当前值、{tier} 档位、{remain} 还差多少、{valueText} 后端算好的展示值。
   */
  /**
   * 详情半屏的进度行（2026-11-17 调整）：
   *   - **未解锁**：显示进度（`还差 12 次…`）——这是用户真正需要的「离目标还有多远」
   *   - **已解锁**：不再显示「已完成 24 次」这类已完成态流水账（徽章都拿到了，再报次数没信息量）；
   *     只有「累计/当前纪录」这类**有独立价值的事实**才保留（如「已累计 415.38 km」「最长连续 120 天」）。
   *     是否保留由下面的 keepWhenEarned 判定，而不是靠文案模板。
   * 返回空串表示这一行不展示。
   */
  /**
   * 「最坚持」专属文案（2026-11-18）：
   * 这一组的进度是**连续天数**，光说「最长连续纪录 N 天 · 还差 M 天」看不出用户
   * 「现在这段连续到第几天了」「还要坚持几天」——而当前这段连续**是算数的**
   * （解锁判定是「连续累计到第 t 天」，从今天往前数也算），所以要把两者都讲清楚。
   *
   *   未解锁且正在连续：`当前连续 3 天 · 再坚持 362 天解锁`
   *   未解锁且已中断：  `最长连续纪录 14 天 · 还差 351 天`
   *   已解锁：          `最长连续运动 120 天`
   */
  const renderStreakDetail = (def: BadgeDef): string =>
    streakDetailText({ best: rec.streak.best, current: rec.streak.current, tier: def.tier });

  /**
   * 里程碑的进度文案（2026-11-18 修）：
   *   次数型（ratio=1，如「坚持一周」需 7 次）→ `已达成 {cur} 次 · 目标 {need} 次`
   *   倍率型（ratio≥2，如「200%完成目标」）  → `已完成 {cur} 次 · 单周期达到 {n}% 即可获得`
   * 倍率型的 tier 是**百分比**（200/300/…），不是次数，绝不能写成「目标 200 次」。
   */
  const milestoneProgressText = (m: { cur: number; need: number; tier: number; isRatio: boolean }): string => {
    if (!m.isRatio) return `已达成 ${m.cur} 次 · 目标 ${m.need} 次`;
    /*
     * 倍率型（200%/300%/…完成目标）：`need` 恒为 1（完成一次对应倍数即解锁），
     * 所以这里只可能是「还没达成过」——`cur > 0` 时早已 unlocked，detailText 走空串，
     * 「已完成 N 次」那条分支永远不可达，2026-11-18 删掉（留着会被误读成「再做 N 次运动」）。
     * 规则本身（单周期达到 N% 即可获得）写在徽章 desc 里，不再重复。
     */
    return '还未达成过';
  };

  const renderDetail = (def: BadgeDef, cur: number, valueText: string): string => {
    const rule = def.detail;
    const unlocked = cur >= def.tier;
    if (unlocked) {
      // 已解锁：只有「当前值本身有独立意义」的指标才展示（累计量/纪录值），
      // 次数类（已完成 N 次）不再重复播报
      if (!KEEP_VALUE_WHEN_EARNED.has(def.metric)) return '';
    }
    const remain = Math.max(0, def.tier - cur);
    // 「最坚持」要看「当前连续几天 / 还需几天」，模板表达不了，走专属渲染
    if (def.metric === 'streakBest') return renderStreakDetail(def);
    if (unlocked && rule) return rule.earned.replace('{cur}', String(cur)).replace('{valueText}', valueText);
    if (rule && rule.locked) {
      // locked 模板原先只替换 {remain}/{tier}；补上 {cur}/{valueText}，
      // 否则像 streak 的「最长连续纪录 {cur} 天」会原样露出占位符（2026-11-18）
      return rule.locked
        .replace('{cur}', String(cur))
        .replace('{remain}', String(remain))
        .replace('{tier}', String(def.tier))
        .replace('{valueText}', valueText);
    }
    return unlocked ? '' : `已达成 ${cur} 次 · 目标 ${def.tier} 次`;
  };

  /**
   * 详情半屏的附加明细行：原先由前端按 key 前缀拼文案（哪些系列多一行"当前纪录…"硬编码在前端），
   * 现收口到这里——加徽章只需在配置里写 detail 模板，前端不再判断系列。
   */
  /**
   * 「获得信息」（2026-11-17）拆两句：
   *   已解锁 → 第一句 `2026年9月 · 第 2 位获得此徽章的迹路者`，第二句 `6 位迹路者获得`
   *   未解锁 → 只有第二句 `7 位迹路者获得`（让用户知道这枚章有多稀有）
   *   - 时间只到**年月**（精确到日对用户没价值且暴露活跃度）
   *   - 已解锁但名次缺失（缓存未就绪等）时只显示年月，不显示「第 0 位」
   *   - 未解锁且全站 0 人获得 → 空串（前端整行不渲染）
   */
  const earnedTextOf = (earnDateText: string, rank: number, rankTotal: number): EarnInfo => {
    if (!earnDateText) {
      // 未解锁：只报全站已获得人数（单独一句）
      return {
        earnedText: '',
        rankText: '',
        totalText: rankTotal > 0 ? `${rankTotal} 位迹路者获得` : '',
      };
    }
    // 已解锁拆成两句：
    //   第一句 `2026年9月 · 第 2 位获得此徽章的迹路者`
    //   第二句 `6 位迹路者获得`（全站总人数）
    return {
      earnedText: formatYearMonth(earnDateText),
      rankText: rank > 0 ? `第 ${rank} 位获得此徽章的迹路者` : '',
      totalText: rankTotal > 0 ? `${rankTotal} 位迹路者获得` : '',
    };
  };

  const detailLinesOf = (def: BadgeDef | null, t: { key: string; cur: number }): string[] => {
    const lines: string[] = [];
    if (!def) return lines;
    if (def.metric === 'streakBest') {
      /*
       * 「历史最长」独立一行（2026-11-18 二次调整）：
       *
       * 主行（detailText）在「正在连续」时讲的是**当前这段**（`当前连续 2 天 · 再坚持 98 天解锁`），
       * 而卡面进度条是按**历史最长**算的（best/tier）。两个数并列时（10% 进度 + 再坚持 98 天）
       * 读者会当成算错，所以这里把历史最长**单独一行、带上数值与日期**，给进度条一个明确归属。
       *
       * 不放主行是因为太长：`当前连续 2 天（历史最长 10 天）· 再坚持 98 天解锁` 一行读不完。
       *
       * 已解锁时主行已经是「最长连续运动 N 天」，这里只补日期/状态，不重复数字。
       */
      lines.push(...streakHistoryLines({
        best: rec.streak.best,
        current: rec.streak.current,
        bestEndText: rec.streak.bestEndText,
        unlocked: rec.streak.best >= def.tier,
      }));
    }
    return lines;
  };

  const trophies: PlanTrophy[] = [
    ...milestones.map(
      (m): PlanTrophy => {
        const def = MILESTONES.find((x) => x.key === m.key);
        return {
          key: m.key,
          label: m.label,
          desc: m.desc,
          icon: (def && def.icon) || '🏆',
          shortLabel: (def && def.shortLabel) || m.label,
          shape: (def && def.shape) || 'plan',
          groupTitle: groupTitleOf('plan'),
          category: categoryOfGroup('plan'),
          // 卡面数字（2026-11-18）：倍率章印百分比「200%」，只印 200 会被读成「200 次」；
          // 次数章照旧印次数。
          badgeText: m.isRatio ? `${m.tier}%` : String(m.tier),
          unlocked: m.unlocked,
          cur: m.cur,
          tier: m.tier, // 倍数章=百分比数字（200/300/…），次数章=需要的次数
          nextTier: null, // 原 8 个各是独立目标，无阶梯成长线
          earnedCount: earns[m.key] ? 1 : 0,
          earnDateText: (earns[m.key] && earns[m.key].earnDate) || '',
          rank: rankOf(m.key).rank,
          rankTotal: rankOf(m.key).total,
          pct: m.pct, // 直接用 milestones 算好的百分比
          group: 'plan' as BadgeGroup,
          // 进度文案按里程碑类型分流（2026-11-18）：
          //   次数型（坚持一周 7 次等）→「已达成 3 次 · 目标 7 次」
          //   倍率型（200% 完成目标）  →「单周期达 200% 已 X 次 · 达成 1 次即得」
          // 原来两者都用「目标 {tier} 次」，倍率章的 tier=200 就被说成「目标 200 次」，
          // 与它的真实规则（单周期达到 200% 一次即可）完全不符。
          detailText: m.unlocked ? '' : milestoneProgressText(m),
          detailLines: [],
          ...earnedTextOf((earns[m.key] && earns[m.key].earnDate) || '', rankOf(m.key).rank, rankOf(m.key).total),
        };
      },
    ),
    ...BADGE_DEFS.map((def): PlanTrophy => {
      const cur = metricCountOf(def.metric, counts, def.activityType);
      const series = seriesOfBadge(def);
      // 下一档：同系列阶梯里第一个大于当前计数的档位（完美周无阶梯为 null）
      const nextTier = series.repeatable ? null : (series.tiers.find((t) => t > cur) ?? null);
      const extra: { valueText?: string; dateText?: string } = {};
      if (def.metric === 'totalDistanceKm') {
        extra.valueText = formatKmText(totalDistanceM);
      } else if (def.metric === 'totalDurationHour') {
        extra.valueText = formatDurText(totalDurationSec);
      } else if (def.metric === 'streakBest') {
        extra.valueText = `${rec.streak.best} 天`;
        extra.dateText = rec.streak.bestEndText;
      } else if (def.activityType) {
        // 分类型徽章：展示该类型的累计值
        const c = counts.byType[def.activityType] || { km: 0, hour: 0, count: 0, distanceM: 0, durationSec: 0 };
        if (def.metric === 'typeDistanceKm') extra.valueText = formatKmText(c.distanceM);
        else if (def.metric === 'typeDurationHour') extra.valueText = formatDurText(c.durationSec);
        else extra.valueText = `${c.count} 次`;
      }
      const earn = earns[def.key];
      const unlocked = cur >= def.tier;
      return {
        key: def.key,
        label: def.label,
        desc: def.desc,
        icon: def.icon,
        // ↓ 展示元数据：前端直接拿来渲染，不再维护映射表
        shortLabel: def.shortLabel,
        shape: def.shape,
        groupTitle: groupTitleOf(def.group),
        category: categoryOfGroup(def.group),
        activityLabel: def.activityLabel || '',
        activityIconId: def.activityIconId || '',
        badgeText: def.badgeText || String(def.tier),
        unlocked,
        cur,
        tier: def.tier,
        nextTier,
        earnedCount: earn ? earn.earnedCount : 0,
        earnDateText: (earn && earn.earnDate) || '',
        rank: rankOf(def.key).rank,
        rankTotal: rankOf(def.key).total,
        pct: pctOf(cur, def.tier),
        group: def.group,
        detailText: renderDetail(def, cur, extra.valueText || ''),
        detailLines: detailLinesOf(def, { key: def.key, cur }),
        ...earnedTextOf((earn && earn.earnDate) || '', rankOf(def.key).rank, rankOf(def.key).total),
        ...extra,
      };
    }),
  ];

  const totalPeriods = rows.length;
  return {
    totalPeriods,
    achievedPeriods: achieved,
    rate: totalPeriods > 0 ? achieved / totalPeriods : 0,
    streak: { current, best },
    overStreak,
    totals,
    milestones,
    trophies,
    records: {
      distance: { bestM: rec.distance.bestM, dateText: rec.distance.dateText, breaks: rec.breaksDistance },
      duration: { bestSec: rec.duration.bestSec, dateText: rec.duration.dateText, breaks: rec.breaksDuration },
      streak: { best: rec.streak.best, bestEndText: rec.streak.bestEndText, current: rec.streak.current },
    },
    // 分运动类型概览：只拉有数据的类型（前端「按类型」区展示距离/时长/次数）
    activityTypes: ACTIVITY_TYPE_META
      ? Object.entries(counts.byType).map(([type, c]) => ({
        type,
        label: (ACTIVITY_TYPE_META as Record<string, { label?: string }>)[type]?.label || type,
        distanceM: c.distanceM,
        durationSec: c.durationSec,
        count: c.count,
      }))
      : [],
  };
}

/* ==========================================================================
 * 里程碑奖杯扩展（2026-11-14，docs/21）
 * 新增 27 座：记录与坚持（新距离/新时长/最坚持 × 5 档）+ 圆环与目标（合环/完成目标 × 5 档）
 * + 完美周（全能/单项 × 1）。与原 8 个倍数里程碑统一进 summary.trophies（卡面：图标+名称+次数）。
 * 口径拍板见 docs/21：圆环完成≡目标达成（三项都已设且全达成，未设项不算）、圆环只计 daily 快照、
 * 记录=单日合计（东八区自然日，全部 finished 运动）、完美周按自然周（周一~周日）。
 * ========================================================================== */

/** 详情半屏的「获得信息」两行（2026-11-17 拆行展示） */
export interface EarnInfo {
  /** 第一行：获得时间（只到年月，如 `2026年11月`）；未获得为空串 */
  earnedText: string;
  /** 名次段（如 `第 3 位获得此徽章的迹路者`）：已解锁才有；未获得为空串 */
  rankText: string;
  /** 总人数段（如 `6 位迹路者获得`）：已解锁=全站总人数；未解锁=已获得人数；无人获得为空串 */
  totalText: string;
}

export interface PlanTrophy {
  key: string;
  label: string;
  desc: string;
  icon: string;
  unlocked: boolean;
  /** 当前计数（所有奖杯都有——记录型的计数是「破纪录次数」） */
  cur: number;
  /** 解锁档位（cur >= tier 解锁） */
  tier: number;
  /** 下一档（次数档位型的成长线）；完美周无阶梯为 null */
  nextTier: number | null;
  /** 获得次数（里程碑型恒 1；完美周为合格周数；未获得 0）——卡片三态展示用 */
  earnedCount: number;
  /** 首次获取日期（YYYY-MM-DD）；未获得空串 */
  earnDateText: string;
  /** 全站第几位迹路者获得该徽章（按首次解锁日排名，同一天并列同名次）；未获得 0 */
  rank: number;
  /** 全站已获得该徽章的人数（徽章详情「第 N 位…」的分母参考）；未获得也照常给出 */
  rankTotal: number;
  /* ── 展示元数据（2026-11-16 配置化）：前端直接渲染，不再维护写死的映射表 ── */
  /** 卡面短名（如「距离纪录」），同名各档共用 */
  shortLabel: string;
  /** 徽章形状（前端据 shape 取 CSS class：b-<shape>） */
  shape: string;
  /** 分区标题（前端分组用，顺序按 BADGE_GROUPS） */
  groupTitle: string;
  /** 大类：plan=运动计划（计划页）/ data=运动数据（我的徽章页） */
  category: BadgeCategory;
  /** 分运动类型徽章的类型名（如「跑步」），普通徽章为空 */
  activityLabel?: string;
  /** 分运动类型徽章的类型图标 id（前端拼 /assets/icons/activity-<id>-white.png） */
  activityIconId?: string;
  /** 徽章中央文字（档位数或固定 emoji） */
  badgeText: string;
  /** 详情半屏的一句进度文案（已由模板渲染好，前端直接显示） */
  detailText: string;
  /** 详情半屏的附加明细行（如当前纪录值与产生日期），已按系列渲染好 */
  detailLines: string[];
  /**
   * 详情半屏「获得信息」第一句的第一段：获得时间，只到年月，如 `2026年9月`
   * 未解锁为空串。
   */
  earnedText: string;
  /**
   * 详情半屏「获得信息」第一句的后半段：名次，如 `第 3 位获得此徽章的迹路者`
   * 未解锁为空串（未解锁只有第二句 totalText）。
   */
  rankText: string;
  /**
   * 详情半屏「获得信息」第二句：总人数，如 `6 位迹路者获得`
   * 已解锁=全站总人数；未解锁=已获得人数；全站无人获得为空串。
   */
  totalText: string;
  /** 进度条百分比 0-100（cur/tier 封顶）——未获得时卡片展示进度条 */
  pct: number;
  /** 记录型当前纪录文案（卡面第二行），如 '12.3 km' / '2小时05分' / '15 天' */
  valueText?: string;
  /** 记录型：纪录产生日期（YYYY-MM-DD） */
  dateText?: string;
  group: BadgeGroup;
}

export interface PlanRecords {
  distance: { bestM: number; dateText: string; breaks: number };
  duration: { bestSec: number; dateText: string; breaks: number };
  streak: { best: number; bestEndText: string; current: number };
}

/** 自然周键（东八区周一为一周起点）：'YYYY-MM-DD'（周一日期）。
 *  星期要按「北京日历」取——ms 是东八区零点的绝对时刻，UTC 侧还是前一天下午，
 *  直接 getUTCDay() 会算成前一天的星期（差一天导致周一识别错位，完美周永远凑不齐 7 天） */
function weekKeyOfDate(dateStr: string): string {
  const ms = Date.parse(`${dateStr}T00:00:00+08:00`);
  // 历史/导入数据的 periodKey 可能不是 YYYY-MM-DD：返回空串让调用方跳过，
  // 绝不能让 bjDateStr(NaN) 抛 RangeError 把整个 /plan/summary 打成 500
  if (!Number.isFinite(ms)) return '';
  const dow = new Date(ms + 8 * 3600_000).getUTCDay(); // 0=周日（北京日历口径）
  const monday = ms - ((dow + 6) % 7) * 86_400_000;
  return new Date(monday + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 相邻两个自然日相差天数（两个都是 YYYY-MM-DD） */
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00+08:00`) - Date.parse(`${a}T00:00:00+08:00`)) / 86_400_000);
}

interface DailyTotalsRow {
  date: string;
  distanceM: number;
  durationSec: number;
  count: number;
}

/** 按东八区自然日聚合全部已完成运动（距离合计/时长合计/次数）——日期升序 */
export async function dailyActivityTotals(userId: string): Promise<DailyTotalsRow[]> {
  return ActivityModel.aggregate<DailyTotalsRow>([
    { $match: { userId: new Types.ObjectId(userId), status: 'finished' } },
    {
      $group: {
        // startTime 库内是 epoch 毫秒（Number），$dateToString 前先 $toDate；按东八区自然日分桶
        _id: {
          $dateToString: { format: '%Y-%m-%d', date: { $toDate: '$startTime' }, timezone: '+08:00' },
        },
        distanceM: { $sum: { $ifNull: ['$distance', 0] } },
        durationSec: { $sum: { $ifNull: ['$duration', 0] } },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, date: '$_id', distanceM: 1, durationSec: 1, count: 1 } },
  ]);
}

/**
 * 按运动类型聚合（2026-11-16 分类型徽章）：
 * 返回 type → 按东八区自然日汇总的行（日期升序），口径与 dailyActivityTotals 一致，只多一个类型维度。
 */
export async function dailyTotalsByType(userId: string): Promise<Record<string, DailyTotalsRow[]>> {
  const rows = await ActivityModel.aggregate<{
    _id: { type: string; date: string };
    distanceM: number;
    durationSec: number;
    count: number;
  }>([
    { $match: { userId: new Types.ObjectId(userId), status: 'finished' } },
    {
      $group: {
        _id: {
          type: '$type',
          date: { $dateToString: { format: '%Y-%m-%d', date: { $toDate: '$startTime' }, timezone: '+08:00' } },
        },
        distanceM: { $sum: { $ifNull: ['$distance', 0] } },
        durationSec: { $sum: { $ifNull: ['$duration', 0] } },
        count: { $sum: 1 },
      },
    },
    { $sort: { '_id.date': 1 } },
  ]);
  const out: Record<string, DailyTotalsRow[]> = {};
  for (const r of rows) {
    const type = String(r._id.type || '');
    if (!type) continue;
    (out[type] ??= []).push({ date: r._id.date, distanceM: r.distanceM, durationSec: r.durationSec, count: r.count });
  }
  return out;
}

/**
 * 徽章总览（「我的徽章」页，2026-11-16）：
 * 与 getPlanSummary 同源（同一套 earns/ranks），额外按大类分组 + 类型概览，
 * 前端直接按 category → groups 渲染，不需要再自己分。
 */
export interface BadgeOverviewResult {
  total: number;
  earned: number;
  categories: Array<{ key: BadgeCategory; title: string; total: number; earned: number }>;
  groups: Array<{ key: string; title: string; category: BadgeCategory; total: number; earned: number }>;
  trophies: PlanTrophy[];
  activityTypes: Array<{ type: string; label: string; distanceM: number; durationSec: number; count: number }>;
}

const CATEGORY_TITLES: Record<BadgeCategory, string> = {
  plan: '运动计划',
  data: '运动数据',
};

export async function getBadgeOverview(userId: string): Promise<BadgeOverviewResult> {
  // 复用 summary 的全部计算（轨迹聚合/计划快照/名次），保证同一座徽章两处结论一致
  const sum = await getPlanSummary(userId);
  const trophies = sum.trophies;
  const earnedOf = (list: PlanTrophy[]) => list.filter((t) => t.unlocked).length;

  const categories = (['plan', 'data'] as BadgeCategory[]).map((key) => {
    const list = trophies.filter((t) => t.category === key);
    return { key, title: CATEGORY_TITLES[key], total: list.length, earned: earnedOf(list) };
  });

  // 分组：顺序按 trophies 出现顺序（后端 BADGE_GROUPS 已排好），只保留有徽章的分组
  const groups: BadgeOverviewResult['groups'] = [];
  const seen = new Map<string, BadgeOverviewResult['groups'][number]>();
  for (const t of trophies) {
    let g = seen.get(t.group);
    if (!g) {
      g = { key: t.group, title: t.groupTitle, category: t.category, total: 0, earned: 0 };
      seen.set(t.group, g);
      groups.push(g);
    }
    g.total += 1;
    if (t.unlocked) g.earned += 1;
  }

  return {
    total: trophies.length,
    earned: earnedOf(trophies),
    categories,
    groups,
    trophies,
    activityTypes: sum.activityTypes,
  };
}

/**
 * 轻量徽章计数（「我的」页角标用）：只回「已获得 / 总数」。
 *
 * 为什么单独一个接口：`/plan/badges` 会跑完整 summary（2 次全量轨迹聚合 + 名次），
 * 而「我的」页只需要一个整数。这里加 5 分钟进程内缓存——同一用户 5 分钟内重复进
 * 「我的」页不再重复计算；跨用户互不影响（Map 键是 userId）。
 *
 * 触发条件：若缓存命中率低/计算变慢，再考虑把「解锁日期」落成物化表（见 trophy-rank 的说明）。
 */
const BADGE_COUNT_TTL_MS = 5 * 60 * 1000;
const badgeCountCache = new Map<string, { at: number; earned: number; total: number }>();

export async function getBadgeCounts(userId: string): Promise<{ earned: number; total: number }> {
  if (!Types.ObjectId.isValid(userId)) throw new AppError(401, '请先登录');
  const hit = badgeCountCache.get(userId);
  if (hit && Date.now() - hit.at < BADGE_COUNT_TTL_MS) {
    return { earned: hit.earned, total: hit.total };
  }
  const sum = await getPlanSummary(userId);
  const earned = sum.trophies.filter((t) => t.unlocked).length;
  const total = sum.trophies.length;
  // 简单的容量上限保护：超过 5000 个用户时清空重建（没有引入 LRU 依赖）
  if (badgeCountCache.size > 5000) badgeCountCache.clear();
  badgeCountCache.set(userId, { at: Date.now(), earned, total });
  return { earned, total };
}

/** 测试用：清空计数缓存 */
export function __resetBadgeCountCache(): void {
  badgeCountCache.clear();
}

/* ==================== 区间计划报告（年报 / 运动报告页共用，2026-11-19） ==================== */

/** 徽章解锁日期是 YYYY-MM-DD 字符串，字典序即时间序，可直接做区间比较 */
const EARN_DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface PlanRangeReportResult {
  plan: {
    /** 区间内有计划快照的天数（有计划的日子） */
    snapshotDays: number;
    /** 区间内三项全达成的天数（合上圆环口径） */
    achievedDays: number;
    /** 达成率（百分比；区间内无快照为 0） */
    achievedRate: number;
    /** 区间内最长连续全达成天数（连续自然日） */
    bestStreak: number;
    /** 区间内计划期完成的累计距离（公里，快照 progress 求和） */
    planDistanceKm: number;
  };
  badges: {
    /** 区间内首次解锁的徽章数（按徽章首次获取日期） */
    unlockedInRange: number;
    /** 累计已解锁（全历史口径，年报里展示「累计 M/T」用） */
    unlockedTotal: number;
    /** 徽章总数 */
    total: number;
    /**
     * 区间内首次解锁的徽章明细（2026-11-19）：按解锁日期倒序。
     * 年度报告要把徽章列出来，只给数字看不出「解锁了哪些」。
     * 字段够前端直接画章面（shape/badgeText/shortLabel/earnDateText），不需要再取一次 summary。
     */
    unlockedList: Array<{
      key: string;
      shortLabel: string;
      label: string;
      shape: string;
      badgeText: string;
      groupTitle: string;
      /** 分组 key：前端判断合环组（rings）渲染三层三环造型（isRingBadge 同口径） */
      group: string;
      activityIconId?: string;
      earnDateText: string;
    }>;
  };
}

/**
 * 区间运动计划报告：[from, to) 内的 daily 快照达成统计 + 区间内新解锁徽章数。
 * 徽章口径走 getPlanSummary 的 trophies（earnDateText = 首次获取日期），区间外不重复计。
 */
export async function planRangeReport(
  userId: string,
  fromMs: number,
  toMs: number,
): Promise<PlanRangeReportResult> {
  if (!Types.ObjectId.isValid(userId)) throw new AppError(401, '请先登录');
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new AppError(400, '时间区间不合法');
  }
  const fromKey = bjDateStr(fromMs);
  const toKey = bjDateStr(toMs - 1); // to 为开区间，取前一秒所在的自然日
  const snaps = await ExercisePlanPeriodModel.find({
    userId: new Types.ObjectId(userId),
    period: 'daily',
    periodKey: { $gte: fromKey, $lte: toKey, $regex: EARN_DATE_KEY_RE.source },
  })
    .select({ windowStart: 1, allAchieved: 1, progress: 1 })
    .sort({ windowStart: 1 })
    .lean();
  const achievedDays = snaps.filter((s) => s.allAchieved).length;
  const planDistanceM = snaps.reduce((acc, s) => acc + (s.progress?.distanceM || 0), 0);
  let bestStreak = 0;
  let run = 0;
  let prev = 0;
  for (const s of snaps) {
    if (!s.allAchieved) {
      run = 0;
      prev = 0;
      continue;
    }
    run = prev > 0 && s.windowStart - prev === 86_400_000 ? run + 1 : 1;
    prev = s.windowStart;
    if (run > bestStreak) bestStreak = run;
  }
  const sum = await getPlanSummary(userId);
  const unlockedTotal = sum.trophies.filter((t) => t.unlocked).length;
  const unlockedInRangeTrophies = sum.trophies.filter(
    (t) => t.unlocked && t.earnDateText >= fromKey && t.earnDateText <= toKey,
  );
  const unlockedInRange = unlockedInRangeTrophies.length;
  // 明细按解锁日期倒序（最近解锁的排前面），同日按 key 稳定排序避免每次顺序抖动
  const unlockedList = [...unlockedInRangeTrophies]
    .sort((a, b) => (a.earnDateText === b.earnDateText ? a.key.localeCompare(b.key) : b.earnDateText.localeCompare(a.earnDateText)))
    .map((t) => ({
      key: t.key,
      shortLabel: t.shortLabel,
      label: t.label,
      shape: t.shape,
      badgeText: t.badgeText,
      groupTitle: t.groupTitle,
      /** 分组 key：前端判断合环组（rings）走三层三环造型，其余走单章 */
      group: t.group,
      activityIconId: t.activityIconId,
      earnDateText: t.earnDateText,
    }));
  return {
    plan: {
      snapshotDays: snaps.length,
      achievedDays,
      achievedRate: snaps.length ? Math.round((achievedDays / snaps.length) * 100) : 0,
      bestStreak,
      planDistanceKm: Math.round(planDistanceM / 100) / 10,
    },
    badges: {
      unlockedInRange,
      unlockedTotal,
      total: sum.trophies.length,
      unlockedList,
    },
  };
}

/** 记录与坚持：破纪录次数/当前纪录+日期/最长连续+结束日期/当前连续 */
export function computeRecordStats(days: DailyTotalsRow[]): PlanRecords & { breaksDistance: number; breaksDuration: number } {
  let bestDist = 0;
  let bestDistDate = '';
  let breaksDist = 0;
  let bestDur = 0;
  let bestDurDate = '';
  let breaksDur = 0;
  // 连续段：日期升序扫，只看有运动的日子；段内相邻日期差 1 天即延续
  let bestRun = 0;
  let bestRunEnd = '';
  let run = 0;
  let prevDate = '';
  for (const d of days) {
    if (d.distanceM > bestDist) {
      bestDist = d.distanceM;
      breaksDist += 1;
      bestDistDate = d.date;
    }
    if (d.durationSec > bestDur) {
      bestDur = d.durationSec;
      breaksDur += 1;
      bestDurDate = d.date;
    }
    run = prevDate && dayDiff(prevDate, d.date) === 1 ? run + 1 : 1;
    if (run > bestRun) {
      bestRun = run;
      bestRunEnd = d.date;
    }
    prevDate = d.date;
  }
  // 当前连续：从最后一天往前数连续段
  let current = 0;
  if (days.length) {
    const set = new Set(days.map((d) => d.date));
    // 今天还没动不算断：从「今天或昨天」起算（与 stats streakDays 同口径）
    let cursor = set.has(bjDateStr(Date.now())) ? bjDateStr(Date.now()) : bjDateStr(Date.now() - 86_400_000);
    while (set.has(cursor)) {
      current += 1;
      cursor = bjDateStr(Date.parse(`${cursor}T00:00:00+08:00`) - 86_400_000);
    }
  }
  return {
    distance: { bestM: bestDist, dateText: bestDistDate, breaks: breaksDist },
    duration: { bestSec: bestDur, dateText: bestDurDate, breaks: breaksDur },
    streak: { best: bestRun, bestEndText: bestRunEnd, current },
    breaksDistance: breaksDist,
    breaksDuration: breaksDur,
  };
}

function formatKmText(m: number): string {
  return `${(Math.round(m / 10) / 100).toFixed(m % 1000 === 0 ? 0 : 2)} km`;
}

/**
 * 已解锁后仍值得展示「当前值」的指标（2026-11-17）：
 * 这些数值本身就是有用的成就事实（累计了多少公里、纪录多长、连续多久），
 * 与「已完成 N 次」这种重复播报不同。次数类不在此列。
 */
const KEEP_VALUE_WHEN_EARNED = new Set<BadgeMetric>([
  'totalDistanceKm',
  'totalDurationHour',
  'streakBest',
  'typeDistanceKm',
  'typeDurationHour',
]);
/**
 * 次数类（typeCount / 里程碑 / 完美周等）**故意不在此列**：徽章已到手，再播报次数是流水账。
 *
 * 历史（2026-11-17）：这里的排除项原本是给「破纪录」系列（breaksDistance/breaksDuration）加的，
 * 该系列后续整组下线（徽章墙去掉「新纪录」分组），相关 metric/earnKind 已从配置删除；
 * 破纪录的**当前纪录值**仍由 summary.records 下发（不再挂徽章）。
 */

/** 'YYYY-MM-DD' → 'YYYY年M月'；非法日期原样返回空串 */
function formatYearMonth(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return '';
  return `${m[1]}年${Number(m[2])}月`;
}

function formatDurText(sec: number): string {
  const h = Math.floor(sec / 3600);
  const min = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}小时${String(min).padStart(2, '0')}分` : `${min}分钟`;
}

/** 奖杯计数的聚合形状（getPlanSummary 组装后传给 metricCountOf） */
interface TrophyCounts {
  streakBest: number;
  ringsClosed: number;
  totalDistanceKm: number;
  totalDurationHour: number;
  perfectWeekAll: number;
  perfectWeekDistance: number;
  perfectWeekDuration: number;
  perfectWeekCount: number;
  achievedPeriods: number;
  /** 分运动类型的累计（type → 公里/小时/次数 + 原始米与秒） */
  byType: Record<string, { km: number; hour: number; count: number; distanceM: number; durationSec: number }>;
}

/** 分运动类型累计：把 typeDays 汇总成 { km, hour, count, distanceM, durationSec } */
function buildByTypeCounts(typeDays: Record<string, DailyTotalsRow[]>): TrophyCounts['byType'] {
  const out: TrophyCounts['byType'] = {};
  for (const [type, rows] of Object.entries(typeDays)) {
    let distanceM = 0;
    let durationSec = 0;
    let count = 0;
    for (const r of rows) {
      distanceM += r.distanceM;
      durationSec += r.durationSec;
      count += r.count;
    }
    out[type] = {
      distanceM,
      durationSec,
      count,
      km: Math.floor(distanceM / 1000),
      hour: Math.floor(durationSec / 3600),
    };
  }
  return out;
}

/* ==========================================================================
 * 「最坚持」文案（2026-11-18）：纯函数，便于表驱动测试（原先是 getPlanSummary 的内部闭包，
 * 只能靠真实数据跑，分支覆盖随「今天」漂移）。
 *
 * 口径（产品 2026-11-18 定）：
 *   - 主行必须回答「还要坚持多少天才能解锁」——这是用户最需要的那句话
 *   - 历史最长放**单独一行**（主行塞不下：`当前连续 2 天（历史最长 10 天）· 再坚持 98 天解锁` 太长）
 *   - 卡面进度条按历史最长算（best/tier），历史最长那行给它一个明确归属
 * ======================================================================== */

/**
 * 主行文案。
 *   已解锁：          `最长连续运动 120 天`
 *   未解锁且正在连续：`当前连续 3 天 · 再坚持 97 天解锁`
 *   未解锁且已中断：  `最长连续纪录 10 天 · 还差 90 天`
 */
export function streakDetailText(p: { best: number; current: number; tier: number }): string {
  const best = Math.max(0, Math.floor(p.best));
  const now = Math.max(0, Math.floor(p.current));
  const tier = Math.max(1, Math.floor(p.tier));
  if (best >= tier) return `最长连续运动 ${best} 天`;
  /*
   * 未解锁时**主行只回答一个问题**：从今天起还要坚持几天才能解锁。
   * 历史最长不在主行出现（它由 streakHistoryLines 单独一行给，顺带解释卡面进度条）——
   * 2026-11-18 用户明确：一行塞「最长连续纪录 14 天 · 还差 351 天」太长，
   * 而且会被读成「再连续 351 天」的混口径。
   */
  if (now > 0) return `当前连续 ${now} 天 · 再坚持 ${Math.max(1, tier - now)} 天解锁`;
  return `再坚持 ${tier} 天解锁`;
}

/**
 * 附加行：历史最长（+ 日期或「就是这段」）。
 *   未解锁：`历史最长 10 天 · 截至 2026-11-07` / `历史最长 3 天 · 就是当前这段`
 *   已解锁：`该纪录截至 2026-11-07`（主行已有天数，不重复）/ `该纪录就是当前这段`
 *   没有任何连续（best=0）：空数组
 */
export function streakHistoryLines(p: {
  best: number;
  current: number;
  bestEndText: string;
  unlocked: boolean;
}): string[] {
  const best = Math.max(0, Math.floor(p.best));
  if (best <= 0) return [];
  const ongoingBest = p.current > 0 && p.current >= best;
  const when = ongoingBest ? '就是当前这段' : p.bestEndText ? `截至 ${p.bestEndText}` : '';
  /*
   * 已解锁时主行已经写了「最长连续运动 N 天」→ 这里只说哪段/哪天，避免同一数字出现两次。
   * 未解锁时主行**只说还要几天**（不含历史最长）→ 这里必须带上数字，否则用户不知道
   * 卡面那条进度条是什么意思（它是按历史最长算的）。
   */
  if (p.unlocked) return when ? [`该纪录${when}`] : [];
  return [`历史最长 ${best} 天${when ? ` · ${when}` : ''}`];
}

/** 计数 → 该指标当前值（与各奖杯 tier 对比得出解锁态） */
function metricCountOf(metric: BadgeMetric, m: TrophyCounts, activityType?: string): number {
  switch (metric) {
    case 'streakBest': return m.streakBest;
    case 'ringsClosed': return m.ringsClosed;
    case 'totalDistanceKm': return m.totalDistanceKm;
    case 'totalDurationHour': return m.totalDurationHour;
    case 'perfectWeekAll': return m.perfectWeekAll;
    case 'perfectWeekDistance': return m.perfectWeekDistance;
    case 'perfectWeekDuration': return m.perfectWeekDuration;
    case 'perfectWeekCount': return m.perfectWeekCount;
    case 'achieved': return m.achievedPeriods;
    // 分运动类型：按 activityType 取该类型的累计值
    case 'typeDistanceKm': return (m.byType[activityType || ''] || {}).km || 0;
    case 'typeDurationHour': return (m.byType[activityType || ''] || {}).hour || 0;
    case 'typeCount': return (m.byType[activityType || ''] || {}).count || 0;
  }
}
