/**
 * 运动计划（苹果活动目标式三环）：一个用户一份计划（周期每天/每周二选一），
 * 三项目标（距离米/时长分钟/次数），完成度按所选周期的已完成轨迹实时聚合。
 */
import { Types } from 'mongoose';
import { AppError } from '../utils/app-error.js';
import { ExercisePlanModel } from '../models/exercise-plan.model.js';
import { ExercisePlanPeriodModel } from '../models/exercise-plan-period.model.js';
import { ActivityModel } from '../models/activity.model.js';
import { bjDateStr, bjDayStart } from '../utils/bj-time.js';

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
  /** 周计划锚点（东八区某天 0 点，固定 7 天一期从锚点起切块）；每天计划为 0 */
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
  /**
   * 周计划锚点：新计划 / 从每天切过来 → 锚到当天 0 点（第一期＝今天起 7 天）；
   * 本来就是每周 → 沿用原锚点（改目标不重开当期）。每天计划不需要锚点（0）。
   */
  const prev = await ExercisePlanModel.findOne({ userId: new Types.ObjectId(userId) }).lean();
  const prevAnchor = Number(prev?.periodStart) || 0;
  const periodStart = period === 'weekly'
    ? (prev?.period === 'weekly' && prevAnchor > 0 ? prevAnchor : bjDayStart(now))
    : 0;
  /**
   * 计划生效起点：新计划 / 切换周期类型 → 今天 0 点（重新开始算「计划周期」与闲置计时）；
   * 改目标不重置（否则天天改目标就永远不会被判定闲置，历史边界也会一直往后挪）。
   */
  const activeFrom = !prev || prev.period !== period
    ? bjDayStart(now)
    : (planActiveFrom(prev) || bjDayStart(now));
  // 冻结基线：新周期窗口内、此刻之前已经完成的进度（轨迹不可变，这就是「过去日期」的真实成绩）
  const start = windowStart(period, now, periodStart);
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
  // 存量周计划没有锚点：首次读取时锚定到当天 0 点（上线迁移），不再沿用旧的「本周一」口径
  if (doc.period === 'weekly' && !(Number(doc.periodStart) > 0)) {
    const anchor = bjDayStart(now);
    await ExercisePlanModel.updateOne(
      { _id: doc._id, $or: [{ periodStart: 0 }, { periodStart: { $exists: false } }] },
      { $set: { periodStart: anchor } },
    );
    doc.periodStart = anchor;
    if (!(Number(doc.activeFrom) > 0)) doc.activeFrom = anchor;
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
 * 取消前补最后一条快照：只结算「刚结束的那一期」，且该期确实有运动才写法——
 * 空期直接跳过（长期不活跃的用户不该被塞一堆 0 进度记录）。
 */
async function settleLastPeriodBeforeCancel(
  userId: string,
  doc: { period: PlanPeriod; periodStart?: number; activeFrom?: number; createdAt?: Date },
  now: number,
): Promise<void> {
  const activeFrom = planActiveFrom(doc);
  const w = previousWindow(doc.period, now, Number(doc.periodStart) || 0);
  if (w.start <= 0) return;
  if (activeFrom > 0 && w.start < activeFrom) return; // 该期早于计划生效：本来就没有计划周期
  const progress = await sumActivities(userId, w.start, w.end);
  if (progress.distanceM <= 0 && progress.durationSec <= 0 && progress.count <= 0) return;
  await finalizePlanPeriod(userId, doc.period, w.start, w.end);
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
 * 同时要求确实跨过了一个完整周期（每天计划 1 天、每周计划 7 天）——对每天/每周计划，
 * 7 天都已覆盖，这里保留周期判断做语义兜底（将来加别的周期类型不必再改）。
 */
export function isPlanIdle(
  plan: { period: PlanPeriod; activeFrom?: number; periodStart?: number; createdAt?: Date },
  lastActiveAt: number,
  now = Date.now(),
): boolean {
  const from = planActiveFrom(plan);
  const anchor = Math.max(from || 0, Number(lastActiveAt) || 0);
  if (!anchor) return false; // 两个时间都拿不到：不动用户数据
  const periodMs = plan.period === 'weekly' ? 7 * 86_400_000 : 86_400_000;
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

/**
 * 周计划固定 7 天一期：从锚点日 0 点起每 7 天切块，返回含 now 的那一期起点。
 * 不在期内逐日平移——11-12 定计划，本期一直是 11-12~11-18。
 */
function weeklyStartOf(anchor: number, now: number): number {
  const span = 7 * 86_400_000;
  const k = Math.max(0, Math.floor((now - anchor) / span));
  return anchor + k * span;
}

/** 完成度窗口起点（东八区）：daily=今天 00:00；weekly=锚点起固定 7 天一期（窗口＝[start, start+周期)） */
function windowStart(period: PlanPeriod, now: number, weeklyAnchor = 0): number {
  if (period === 'daily') return bjDayStart(now);
  const anchor = weeklyAnchor > 0 ? weeklyAnchor : bjDayStart(now);
  return weeklyStartOf(anchor, now);
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
  const start = windowStart(plan.period, now, plan.periodStart);
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

/** 周期键：daily=该日 YYYY-MM-DD；weekly=本期起点日期 YYYY-MM-DD（东八区） */
function periodKeyOf(period: PlanPeriod, windowStartMs: number): string {
  return bjDateStr(windowStartMs);
}

/** 给定时刻所属窗口；上一窗口＝当前窗口整体往前挪一个周期 */
function previousWindow(period: PlanPeriod, now: number, weeklyAnchor = 0): { start: number; end: number } {
  const span = period === 'daily' ? 86_400_000 : 7 * 86_400_000;
  const end = windowStart(period, now, weeklyAnchor);
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

/**
 * 周计划从锚点开始才有「期」：上一期起点早于锚点 → 该时段没有真实计划周期，不能补快照
 * （否则迁移后会把 11-05~11-11 这种虚构期写进历史）。
 */
function beforeWeeklyAnchor(period: PlanPeriod, anchor: number, windowStartMs: number): boolean {
  return period === 'weekly' && anchor > 0 && windowStartMs < anchor;
}

/** 上一周期结算（用户打开卡/页面时顺手补一条，保证活跃用户一定有历史） */
export async function finalizePreviousPeriod(userId: string, now = Date.now()): Promise<void> {
  const plan = await getPlan(userId, now);
  if (!plan) return;
  const w = previousWindow(plan.period, now, plan.periodStart);
  if (beforeWeeklyAnchor(plan.period, plan.periodStart, w.start)) return;
  await finalizePlanPeriod(userId, plan.period, w.start, w.end);
}

/**
 * 全量结算（定时任务用）：给所有有计划的人补上一周期快照。
 * 只处理「上一周期已结束」的那一个单元，幂等可反复跑。
 */
export async function finalizeAllPreviousPeriods(now = Date.now()): Promise<{ done: number; failed: number }> {
  const plans = await ExercisePlanModel.find({}).select({ userId: 1, period: 1, periodStart: 1 }).lean();
  let done = 0;
  let failed = 0;
  for (const p of plans) {
    const period = p.period as PlanPeriod;
    const anchor = Number(p.periodStart) || 0;
    // 存量周计划尚未锚定：等用户首次读取锚定后再结算；锚点之前的时段没有真实期
    if (period === 'weekly' && !anchor) continue;
    const w = previousWindow(period, now, anchor);
    if (beforeWeeklyAnchor(period, anchor, w.start)) continue;
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
  // 周计划只返回锚点之后的期（迁移不回推：锚点前的旧自然周/虚构期不展示）
  const anchor = plan?.period === 'weekly' && period === 'weekly' ? plan.periodStart : 0;
  const windowCond: Record<string, number> = {};
  if (anchor > 0) windowCond.$gte = anchor;
  const cursor = Number(query.cursor);
  if (Number.isFinite(cursor) && cursor > 0) windowCond.$lt = cursor;
  if (Object.keys(windowCond).length) filter.windowStart = windowCond;

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
  const plan = await getPlan(userId, now);
  const targets: PlanTargets = plan?.targets || { distanceM: 0, durationMin: 0, count: 0 };
  // 计划生效起点：早于它的日期没有计划期（历史日期不拿当前目标回溯评价）
  const planStart = plan ? planActiveFromOf(plan) : 0;

  // 1) 本月内的日快照
  const daySnaps = await ExercisePlanPeriodModel.find({
    userId: uid, period: 'daily', windowStart: { $gte: start, $lt: end },
  }).lean();
  const snapByDate = new Map(daySnaps.map((s) => [String(s.periodKey), s]));

  // 2) 本月涉及的周快照（窗口与本月有交集：从月初前 7 天开始找）
  // 周计划从锚点开始才有真实期：锚点之前的旧自然周/虚构期不参与展示
  const weeklyAnchor = plan?.period === 'weekly' ? plan.periodStart : 0;
  const weekFrom = weeklyAnchor > 0 ? Math.max(start - 7 * 86_400_000, weeklyAnchor) : start - 7 * 86_400_000;
  const weekSnaps = await ExercisePlanPeriodModel.find({
    userId: uid, period: 'weekly', windowStart: { $gte: weekFrom, $lt: end },
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
  // 当前期＝锚点起固定 7 天一期；与本月有交集就列出来（跨月的一期也要显示）
  const curPeriodStart = plan?.period === 'weekly' ? windowStart('weekly', now, plan.periodStart) : 0;
  const overlapsMonth = curPeriodStart > 0 && curPeriodStart < end && curPeriodStart + 7 * 86_400_000 > start;
  // 只有当前计划就是「每周」时，才把本期实时进度作为一条期记录（否则期目标＝日目标，会显示成 6.2/3.0）
  if (plan?.period === 'weekly' && overlapsMonth && !weeks.some((w) => w.windowStart === curPeriodStart)) {
    const agg = await sumActivities(userId, curPeriodStart, curPeriodStart + 7 * 86_400_000);
    weeks.unshift({
      ...buildSnapshot('weekly', curPeriodStart, curPeriodStart + 7 * 86_400_000, targets, agg),
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
  // 概况是累计成就：锚点之前的历史快照照常计入（仅展示列表按锚点过滤）
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
