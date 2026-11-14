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

export const PLAN_MILESTONES: readonly PlanMilestoneDef[] = [
  { key: 'first', label: '首次达成', desc: '完成 1 次目标', ratio: 1, times: 1 },
  { key: 'week', label: '坚持一周', desc: '达成 7 次', ratio: 1, times: 7 },
  { key: 'habit', label: '习惯养成', desc: '达成 20 次', ratio: 1, times: 20 },
  { key: 'x2', label: '200%完成目标', desc: '单周期完成倍数达到 200% 即可获得', ratio: 2, times: 1 },
  { key: 'x3', label: '300%完成目标', desc: '单周期完成倍数达到 300% 即可获得', ratio: 3, times: 1 },
  { key: 'x4', label: '400%完成目标', desc: '单周期完成倍数达到 400% 即可获得', ratio: 4, times: 1 },
  { key: 'x5', label: '500%完成目标', desc: '单周期完成倍数达到 500% 即可获得', ratio: 5, times: 1 },
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
    /** 徽章中央数字：倍数章=百分比（200/300/…），次数章=需要的次数 */
    tier: number;
    /** 进度条百分比（未获得的倍数章恒 0） */
    pct: number;
  }>;
  /** 里程碑奖杯扩展（docs/21）：原 8 个 + 记录/坚持/圆环/目标/完美周，统一卡面（图标+名称+次数） */
  trophies: PlanTrophy[];
  /** 记录与坚持明细（记录型奖杯的详情数据源） */
  records: PlanRecords;
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
      // 进度条：倍数章完成一次即满格；次数章按达成次数/需要次数
      pct: def.ratio >= 2 ? (cur >= 1 ? 100 : 0) : Math.min(Math.round((cur / def.times) * 100), 100),
    };
  });

  // —— 里程碑奖杯扩展（docs/21）——
  const days = await dailyActivityTotals(userId);
  const rec = computeRecordStats(days);
  const dailyRows = rows.filter((r) => r.period === 'daily');
  const perfect = perfectWeekCounts(dailyRows);
  const counts = {
    breaksDistance: rec.breaksDistance,
    breaksDuration: rec.breaksDuration,
    streakBest: rec.streak.best,
    ringsClosed: dailyRows.filter((r) => r.allAchieved).length,
    activities: days.reduce((acc, d) => acc + d.count, 0),
    perfectWeekAll: perfect.all,
    perfectWeekDistance: perfect.distance,
    perfectWeekDuration: perfect.duration,
    perfectWeekCount: perfect.count,
    achievedPeriods: achieved,
  };
  // 每座奖杯的获得记录（获得次数 + 首次获取日期）——卡片三态展示的数据源
  const earns = computeTrophyEarns(days, dailyRows, rows);
  // 数组进度百分比：兼容新奖杯（tier）与原 8 里程碑（字段名是 need）——曾只读 tier 导致里程碑进度条恒 0%
  const pctOf = (t: { cur?: number; tier?: number; need?: number }) => {
    const cur = t.cur ?? 0;
    const tier = t.tier ?? t.need ?? 0;
    return tier > 0 ? Math.min(Math.round((cur / tier) * 100), 100) : 0;
  };
  const trophies: PlanTrophy[] = [
    ...milestones.map(
      (m): PlanTrophy => ({
        key: m.key,
        label: m.label,
        desc: m.desc,
        icon: MILESTONE_ICONS[m.key] || '🏆',
        unlocked: m.unlocked,
        cur: m.cur,
        tier: m.tier, // 倍数章=百分比数字（200/300/…），次数章=需要的次数
        nextTier: null, // 原 8 个各是独立目标，无阶梯成长线
        earnedCount: earns[m.key] ? 1 : 0,
        earnDateText: (earns[m.key] && earns[m.key].earnDate) || '',
        pct: m.pct, // 直接用 milestones 算好的百分比（倍数章「完成一次即满格」，不能再按 cur/tier 除）
        group: 'plan',
      }),
    ),
    ...PLAN_TROPHY_DEFS.map((def): PlanTrophy => {
      const cur = metricCountOf(def.metric, counts);
      // 下一档：阶梯里第一个大于当前计数的档位（完美周无阶梯为 null）
      const nextTier = def.group === 'week' ? null : (TROPHY_TIERS.find((t) => t > cur) ?? null);
      const extra: { valueText?: string; dateText?: string } = {};
      if (def.group === 'record' && def.metric === 'breaksDistance') {
        extra.valueText = formatKmText(rec.distance.bestM);
        extra.dateText = rec.distance.dateText;
      }
      if (def.group === 'record' && def.metric === 'breaksDuration') {
        extra.valueText = formatDurText(rec.duration.bestSec);
        extra.dateText = rec.duration.dateText;
      }
      if (def.group === 'streak') {
        extra.valueText = `${rec.streak.best} 天`;
        extra.dateText = rec.streak.bestEndText;
      }
      const earn = earns[def.key];
      return {
        key: def.key,
        label: def.label,
        desc: def.desc,
        icon: def.icon,
        unlocked: cur >= def.tier,
        cur,
        tier: def.tier,
        nextTier,
        earnedCount: earn ? earn.earnedCount : 0,
        earnDateText: (earn && earn.earnDate) || '',
        pct: pctOf({ cur, tier: def.tier }),
        group: def.group,
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
  };
}

/* ==========================================================================
 * 里程碑奖杯扩展（2026-11-14，docs/21）
 * 新增 27 座：记录与坚持（新距离/新时长/最坚持 × 5 档）+ 圆环与目标（合环/完成目标 × 5 档）
 * + 完美周（全能/单项 × 1）。与原 8 个倍数里程碑统一进 summary.trophies（卡面：图标+名称+次数）。
 * 口径拍板见 docs/21：圆环完成≡目标达成（三项都已设且全达成，未设项不算）、圆环只计 daily 快照、
 * 记录=单日合计（东八区自然日，全部 finished 运动）、完美周按自然周（周一~周日）。
 * ========================================================================== */

export type PlanTrophyMetric =
  | 'breaksDistance'
  | 'breaksDuration'
  | 'streakBest'
  | 'ringsClosed'
  | 'activities'
  | 'perfectWeekAll'
  | 'perfectWeekDistance'
  | 'perfectWeekDuration'
  | 'perfectWeekCount'
  | 'achieved'; // 原 8 个倍数里程碑沿用各自 cur

export interface PlanTrophyDef {
  key: string;
  label: string;
  desc: string;
  icon: string;
  /** 计数口径键；'achieved' 表示沿用原里程碑倍数档 */
  metric: PlanTrophyMetric;
  /** 解锁档位（该计数达到 tier 即解锁） */
  tier: number;
  group: 'record' | 'streak' | 'rings' | 'goal' | 'week';
}

/** 破纪录/合环/活动次数的统一阶梯（配置数组，随时可调） */
const TROPHY_TIERS = [100, 365, 500, 1000, 2000] as const;

/** 各系列奖杯定义（每档一座独立奖杯） */
export const PLAN_TROPHY_DEFS: readonly PlanTrophyDef[] = [
  ...TROPHY_TIERS.map(
    (t): PlanTrophyDef => ({
      key: `rec-dist-${t}`,
      label: `新距离记录·${t}次`,
      desc: `刷新单日运动距离纪录 ${t} 次（纪录指自然日运动距离合计的历史新高）`,
      icon: '📏',
      metric: 'breaksDistance',
      tier: t,
      group: 'record',
    }),
  ),
  ...TROPHY_TIERS.map(
    (t): PlanTrophyDef => ({
      key: `rec-dur-${t}`,
      label: `新时长记录·${t}次`,
      desc: `刷新单日运动时长纪录 ${t} 次`,
      icon: '⏱️',
      metric: 'breaksDuration',
      tier: t,
      group: 'record',
    }),
  ),
  ...TROPHY_TIERS.map(
    (t): PlanTrophyDef => ({
      key: `streak-${t}`,
      label: `最坚持奖·${t}天`,
      desc: `连续运动天数（连续每天有运动记录）达到 ${t} 天`,
      icon: '🔥',
      metric: 'streakBest',
      tier: t,
      group: 'streak',
    }),
  ),
  ...TROPHY_TIERS.map(
    (t): PlanTrophyDef => ({
      key: `ring-${t}`,
      label: `合上圆环·${t}次`,
      desc: `三圆环全合（当日三项目标全部达成）累计 ${t} 次`,
      icon: '⭕',
      metric: 'ringsClosed',
      tier: t,
      group: 'rings',
    }),
  ),
  ...TROPHY_TIERS.map(
    (t): PlanTrophyDef => ({
      key: `goal-${t}`,
      label: `完成目标·${t}次`,
      desc: `累计完成运动 ${t} 次`,
      icon: '🎯',
      metric: 'activities',
      tier: t,
      group: 'goal',
    }),
  ),
  {
    key: 'perfect-week-all',
    label: '完美一周·全能',
    desc: '一个自然周（周一至周日）里七天三项全部达成',
    icon: '🌟',
    metric: 'perfectWeekAll',
    tier: 1,
    group: 'week',
  },
  {
    key: 'perfect-week-distance',
    label: '完美一周·距离',
    desc: '一个自然周（周一至周日）里，七天都达成距离目标',
    icon: '📏',
    metric: 'perfectWeekDistance',
    tier: 1,
    group: 'week',
  },
  {
    key: 'perfect-week-duration',
    label: '完美一周·时长',
    desc: '一个自然周里，七天都达成时长目标',
    icon: '⏱️',
    metric: 'perfectWeekDuration',
    tier: 1,
    group: 'week',
  },
  {
    key: 'perfect-week-count',
    label: '完美一周·次数',
    desc: '一个自然周里，七天都达成次数目标',
    icon: '🔢',
    metric: 'perfectWeekCount',
    tier: 1,
    group: 'week',
  },
];

/** 原 8 个倍数里程碑的卡面图标 */
const MILESTONE_ICONS: Record<string, string> = {
  first: '🥇',
  week: '📅',
  habit: '💪',
  x2: '🔥',
  x3: '👑',
  x4: '🚀',
  x5: '🏆',
};

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
  /** 进度条百分比 0-100（cur/tier 封顶）——未获得时卡片展示进度条 */
  pct: number;
  /** 记录型当前纪录文案（卡面第二行），如 '12.3 km' / '2小时05分' / '15 天' */
  valueText?: string;
  /** 记录型：纪录产生日期（YYYY-MM-DD） */
  dateText?: string;
  group: 'plan' | 'record' | 'streak' | 'rings' | 'goal' | 'week';
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

/** 完美周计数（基于 daily 快照；快照只在计划活跃期存在，属于计划域成就）：
 *  全能 = 一个自然周七天的 daily 快照齐全且全部 allAchieved；
 *  单项（距离/时长/次数）= 七天快照齐全且该单项每天都达成（各算各的，互不冒充）。 */
function perfectWeekCounts(dailyRows: Array<Record<string, unknown>>): {
  all: number;
  distance: number;
  duration: number;
  count: number;
  /** 首次获取日期（最早合格自然周的最后一天，YYYY-MM-DD）；无则空串 */
  firstAllEnd: string;
  firstDistanceEnd: string;
  firstDurationEnd: string;
  firstCountEnd: string;
} {
  interface WeekAcc {
    days: number;
    allAchieved: number;
    metric: { distance: number; duration: number; count: number };
  }
  const weeks = new Map<string, WeekAcc>();
  for (const r of dailyRows) {
    const wk = weekKeyOfDate(String(r.periodKey));
    if (!wk) continue; // periodKey 不是合法日期（脏数据）：不计入完美周，也不影响其它统计
    const acc = weeks.get(wk) ?? { days: 0, allAchieved: 0, metric: { distance: 0, duration: 0, count: 0 } };
    acc.days += 1;
    if (r.allAchieved) acc.allAchieved += 1;
    const targets = (r.targets ?? {}) as Record<string, number>;
    const progress = (r.progress ?? {}) as Record<string, number>;
    // 单项达成：该项设了目标且完成达标（与结算快照同判据）
    if ((targets.distanceM || 0) > 0 && (progress.distanceM || 0) >= (targets.distanceM || 0)) acc.metric.distance += 1;
    if ((targets.durationMin || 0) > 0 && (progress.durationSec || 0) >= (targets.durationMin || 0) * 60) acc.metric.duration += 1;
    if ((targets.count || 0) > 0 && (progress.count || 0) >= (targets.count || 0)) acc.metric.count += 1;
    weeks.set(wk, acc);
  }
  let all = 0;
  let distance = 0;
  let duration = 0;
  let count = 0;
  let firstAllEnd = '';
  let firstDistanceEnd = '';
  let firstDurationEnd = '';
  let firstCountEnd = '';
  for (const [wk, acc] of weeks.entries()) {
    if (acc.days !== 7) continue; // 快照不足七天（计划周内建立/取消）不算完美周
    const end = bjDateStr(Date.parse(`${wk}T00:00:00+08:00`) + 6 * 86_400_000); // 周日
    if (acc.allAchieved === 7) {
      all += 1;
      if (!firstAllEnd || end < firstAllEnd) firstAllEnd = end;
    }
    // 单项完美周按项分别计数（2026-11-14：原来三项混成一个「单项」，卡面看不出是哪一项）
    if (acc.metric.distance === 7) {
      distance += 1;
      if (!firstDistanceEnd || end < firstDistanceEnd) firstDistanceEnd = end;
    }
    if (acc.metric.duration === 7) {
      duration += 1;
      if (!firstDurationEnd || end < firstDurationEnd) firstDurationEnd = end;
    }
    if (acc.metric.count === 7) {
      count += 1;
      if (!firstCountEnd || end < firstCountEnd) firstCountEnd = end;
    }
  }
  return {
    all,
    distance,
    duration,
    count,
    firstAllEnd,
    firstDistanceEnd,
    firstDurationEnd,
    firstCountEnd,
  };
}

function formatKmText(m: number): string {
  return `${(Math.round(m / 10) / 100).toFixed(m % 1000 === 0 ? 0 : 2)} km`;
}

function formatDurText(sec: number): string {
  const h = Math.floor(sec / 3600);
  const min = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}小时${String(min).padStart(2, '0')}分` : `${min}分钟`;
}

/** 奖杯获得记录：earnedCount（获得次数，里程碑恒 1）+ earnDate（首次获取日期） */
interface TrophyEarn {
  earnedCount: number;
  earnDate: string;
}

/**
 * 每座奖杯的获得记录（卡片三态：获得一次=日期 / 多次=次数 / 未获得=进度条）。
 * 各系列获取时点口径：
 *   - 破纪录：第 N 次刷新纪录的那一天
 *   - 最坚持：连续天数第一次达到档位的那一天
 *   - 合上圆环：第 N 个三项全达成日快照的日期
 *   - 完成目标：累计第 N 次 finished 运动的那一天
 *   - 完美周：可重复获得——次数 = 合格自然周数，日期 = 最早合格周的最后一天
 *   - 原 8 里程碑：达成次数跨过 need 的那个周期的结束日期
 */
function computeTrophyEarns(
  days: DailyTotalsRow[],
  dailyRows: Array<Record<string, unknown>>,
  periodRows: Array<Record<string, unknown>>,
): Record<string, TrophyEarn> {
  const earns: Record<string, TrophyEarn> = {};
  const mark = (key: string, date: string) => {
    earns[key] = { earnedCount: 1, earnDate: date };
  };

  // 破纪录：逐日扫描，新高即破一次，记下每次破纪录的日期
  const breakDist: string[] = [];
  const breakDur: string[] = [];
  let maxD = 0;
  let maxDur = 0;
  for (const d of days) {
    if (d.distanceM > maxD) {
      maxD = d.distanceM;
      breakDist.push(d.date);
    }
    if (d.durationSec > maxDur) {
      maxDur = d.durationSec;
      breakDur.push(d.date);
    }
  }
  for (const t of TROPHY_TIERS) {
    if (breakDist.length >= t) mark(`rec-dist-${t}`, breakDist[t - 1]);
    if (breakDur.length >= t) mark(`rec-dur-${t}`, breakDur[t - 1]);
  }

  // 最坚持：连续段第一次到达档位天数的那一天
  let run = 0;
  let prev = '';
  const streakDates: Record<number, string> = {};
  for (const d of days) {
    run = prev && dayDiff(prev, d.date) === 1 ? run + 1 : 1;
    for (const t of TROPHY_TIERS) if (run === t && !streakDates[t]) streakDates[t] = d.date;
    prev = d.date;
  }
  for (const t of TROPHY_TIERS) if (streakDates[t]) mark(`streak-${t}`, streakDates[t]);

  // 合上圆环：第 N 个三项全达成日快照
  let rings = 0;
  const ringDates: Record<number, string> = {};
  for (const r of dailyRows) {
    if (!r.allAchieved) continue;
    rings += 1;
    for (const t of TROPHY_TIERS) if (rings === t && !ringDates[t]) ringDates[t] = String(r.periodKey);
  }
  for (const t of TROPHY_TIERS) if (ringDates[t]) mark(`ring-${t}`, ringDates[t]);

  // 完成目标：累计第 N 次 finished 运动（单日多段跨过档位也算当天）
  let act = 0;
  const goalDates: Record<number, string> = {};
  for (const d of days) {
    const before = act;
    act += d.count;
    for (const t of TROPHY_TIERS) if (before < t && act >= t && !goalDates[t]) goalDates[t] = d.date;
  }
  for (const t of TROPHY_TIERS) if (goalDates[t]) mark(`goal-${t}`, goalDates[t]);

  // 完美周：可重复获得 → 次数；首次获取日期 = 最早合格周的最后一天
  const perfect = perfectWeekCounts(dailyRows);
  if (perfect.all > 0) earns['perfect-week-all'] = { earnedCount: perfect.all, earnDate: perfect.firstAllEnd };
  if (perfect.distance > 0) earns['perfect-week-distance'] = { earnedCount: perfect.distance, earnDate: perfect.firstDistanceEnd };
  if (perfect.duration > 0) earns['perfect-week-duration'] = { earnedCount: perfect.duration, earnDate: perfect.firstDurationEnd };
  if (perfect.count > 0) earns['perfect-week-count'] = { earnedCount: perfect.count, earnDate: perfect.firstCountEnd };

  // 原 8 里程碑：达成计数跨过 need 的那个周期的结束日期
  let achieved = 0;
  const ratioCount: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of periodRows) {
    const targets = (r.targets ?? {}) as Record<string, number>;
    const progress = (r.progress ?? {}) as Record<string, number>;
    const ratio = minRatioOf(
      { distanceM: progress.distanceM || 0, durationSec: progress.durationSec || 0, count: progress.count || 0 },
      { distanceM: targets.distanceM || 0, durationMin: targets.durationMin || 0, count: targets.count || 0 },
    );
    const tier = tierOf(ratio);
    if (tier > 0) ratioCount[tier] += 1;
    if (r.allAchieved) achieved += 1;
    const end = bjDateStr(Number(r.windowEnd) - 1); // windowEnd 是「下一期 0 点」，减 1ms 取本期最后一天
    for (const def of PLAN_MILESTONES) {
      if (earns[def.key]) continue;
      // 计数口径必须与 milestones 的 cur 完全一致（累计：500% 的期也算完成了 200%），
      // 否则会出现「徽章已解锁但 earnedCount=0 / 无获取日期」的自相矛盾卡面
      const counter = def.ratio >= 2
        ? RATIO_TIERS.filter((x) => x >= def.ratio).reduce((acc, x) => acc + (ratioCount[x] || 0), 0)
        : achieved;
      if (counter >= def.times) mark(def.key, end);
    }
  }
  return earns;
}


/** 奖杯计数的聚合形状（getPlanSummary 组装后传给 metricCountOf） */
interface TrophyCounts {
  breaksDistance: number;
  breaksDuration: number;
  streakBest: number;
  ringsClosed: number;
  activities: number;
  perfectWeekAll: number;
  perfectWeekDistance: number;
  perfectWeekDuration: number;
  perfectWeekCount: number;
  achievedPeriods: number;
}

/** 计数 → 该指标当前值（与各奖杯 tier 对比得出解锁态） */
function metricCountOf(metric: PlanTrophyMetric, m: TrophyCounts): number {
  switch (metric) {
    case 'breaksDistance': return m.breaksDistance;
    case 'breaksDuration': return m.breaksDuration;
    case 'streakBest': return m.streakBest;
    case 'ringsClosed': return m.ringsClosed;
    case 'activities': return m.activities;
    case 'perfectWeekAll': return m.perfectWeekAll;
    case 'perfectWeekDistance': return m.perfectWeekDistance;
    case 'perfectWeekDuration': return m.perfectWeekDuration;
    case 'perfectWeekCount': return m.perfectWeekCount;
    case 'achieved': return m.achievedPeriods;
  }
}
