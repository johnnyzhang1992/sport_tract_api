/**
 * 运动计划（苹果活动目标式三环）：一个用户一份计划（周期每天/每周二选一），
 * 三项目标（距离米/时长分钟/次数），完成度按所选周期的已完成轨迹实时聚合。
 */
import { Types } from 'mongoose';
import { AppError } from '../utils/app-error.js';
import { ExercisePlanModel } from '../models/exercise-plan.model.js';
import { ActivityModel } from '../models/activity.model.js';
import { bjIsoWeekStart } from '../utils/bj-time.js';

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
