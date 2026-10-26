/**
 * 一起运动活动（campaign）：轨迹计入判据与汇总聚合。
 *
 * 计入判据（Spec §4.1）——一条轨迹要**同时**满足才计入：
 *   1. 属于该活动的某位成员（按 userId 匹配，时间窗见下）
 *   2. status = 'finished'
 *   3. type ∈ allowedTypes（allowedTypes 为空则不限类型）
 *   4. startTime ∈ [joinedAt, leftAt)（左闭右开；同一用户多段取并集，leftAt = null 视为至今）
 *   5. vehicleMs 未检出疑似搭车
 *   6. driftScore 未超门禁（与个人最佳/全国榜同一套口径）
 *
 * 汇总（count / distance / duration）用一次 `$group by userId` 出所有成员，避免 N+1。
 */
import mongoose from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import { CampaignMemberModel } from '../models/campaign-member.model.js';
import { streakDays } from '../utils/campaign-streak.js';
import { DRIFT_SCORE_PB_GATE } from '../config/constants.js';

/**
 * 按成员统计「被 driftScore 门禁排除」的轨迹数（2026-10-26 用户要求在活动页给出说明）：
 * 计入条件与 baseMatch 完全同源，但 driftScore 条件反过来（> 门禁）。
 * 这些轨迹**数据完整保留**（用户端距离/时长照常显示），只是不计入活动统计与排行；
 * 成员面板给出「N 条未计入」能解释「我明明跑了 21 公里，活动里怎么只有 12」。
 */
export async function excludedCountForMembers(
  campaign: CampaignDoc,
  uids: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (uids.length === 0) return map;
  const segsByUid = await loadSegments(String(campaign._id));
  const or: Record<string, unknown>[] = [];
  for (const uid of uids) {
    const segs = segsByUid.get(uid) ?? [];
    or.push(...timeOr(uid, segs, campaign.startAt));
  }
  if (or.length === 0) return map;
  const rows = await ActivityModel.aggregate<{ _id: string; n: number }>([
    {
      $match: {
        status: 'finished' as const,
        vehicleMs: { $not: { $gt: 0 } }, // 只数被 driftScore 挡掉的那批（vehicle 已单列不算）
        driftScore: { $gt: DRIFT_SCORE_PB_GATE },
        ...(campaign.allowedTypes.length > 0 ? { type: { $in: campaign.allowedTypes } } : {}),
        $or: or,
      },
    },
    { $group: { _id: '$userId', n: { $sum: 1 } } },
  ]);
  for (const r of rows) map.set(String(r._id), r.n);
  return map;
}
import type { Campaign } from '../models/campaign.model.js';

/** 一个「贡献时段」＝ 一行成员记录（加入过的段，含已离开/被踢） */
export interface Segment {
  joinedAt: number;
  leftAt: number | null;
}

export interface MemberStats {
  count: number;
  distance: number;
  duration: number;
}

/**
 * Doc 类型：`_id` 在 `.lean()` 后确实存在，显式补上。
 * 注：mongoose 9 的 `InferSchemaType` 在 `timestamps: true` 时已自动并入 createdAt/updatedAt，
 * 这里重复声明是幂等的（NativeDate = Date），写出来只是为了让读者一眼看到可用字段。
 */
export type CampaignDoc = Campaign & { _id: mongoose.Types.ObjectId; createdAt: Date; updatedAt: Date };

const EMPTY: MemberStats = { count: 0, distance: 0, duration: 0 };

/** 读出全部「贡献时段」（joinedAt 非空的行 = 加入过的段，含已离开/被踢） */
export async function loadSegments(
  campaignId: string | mongoose.Types.ObjectId,
): Promise<Map<string, Segment[]>> {
  const rows = await CampaignMemberModel.find({
    campaignId: new mongoose.Types.ObjectId(campaignId),
    joinedAt: { $ne: null },
  })
    .select('userId joinedAt leftAt')
    .lean();

  const map = new Map<string, Segment[]>();
  for (const r of rows) {
    const uid = String(r.userId);
    const list = map.get(uid) ?? [];
    list.push({ joinedAt: r.joinedAt as number, leftAt: (r.leftAt ?? null) as number | null });
    map.set(uid, list);
  }
  return map;
}

/**
 * 时间窗并集条件（左闭右开；leftAt=null 视为至今）。
 * 下限取 `max(startAt, joinedAt)`：提前报名的人在开赛前走的里程不计入活动，
 * 开赛后才加入的人则从加入时刻算起 —— 两个方向都由这一条夹住。
 */
function timeOr(uid: string, segs: Segment[], startAt: number) {
  return segs.map((s) => ({
    userId: new mongoose.Types.ObjectId(uid),
    startTime: {
      $gte: Math.max(startAt, s.joinedAt),
      ...(s.leftAt != null ? { $lt: s.leftAt } : {}),
    },
  }));
}

function baseMatch(campaign: CampaignDoc, extra: Record<string, unknown> = {}) {
  return {
    status: 'finished' as const,
    // 缺字段的老文档 = 没搭车；别写 $lte:0
    vehicleMs: { $not: { $gt: 0 } },
    // 漂移门禁（2026-10-26）：与个人最佳/全国榜同一套口径——超门禁的轨迹不进活动的
    // 汇总/分类型/逐日/成员明细/排行（否则成员榜可以被"步行 30km/h"这类轨迹刷高）。
    // 缺字段 = 可信，与 vehicleMs 同惯用法。
    driftScore: { $not: { $gt: DRIFT_SCORE_PB_GATE } },
    ...(campaign.allowedTypes.length > 0 ? { type: { $in: campaign.allowedTypes } } : {}),
    ...extra,
  };
}

/**
 * 单个成员在活动内的轨迹匹配条件（明细与汇总共用，避免口径分叉）。
 * 该成员没有任何贡献时段时返回 null —— 调用方据此短路，别把空 $or 交给 Mongo。
 */
export function memberActivityMatch(
  campaign: CampaignDoc,
  userId: string,
  segs: Segment[],
): Record<string, unknown> | null {
  if (segs.length === 0) return null;
  return baseMatch(campaign, { $or: timeOr(userId, segs, campaign.startAt) });
}

/** 批量汇总：一次聚合出所有成员 { count, distance, duration } */
export async function statsForMembers(
  campaign: CampaignDoc,
  segmentsByUser: Map<string, Segment[]>,
  userIds: string[],
  type?: string,
): Promise<Map<string, MemberStats>> {
  const out = new Map<string, MemberStats>();
  for (const uid of userIds) out.set(uid, { ...EMPTY });

  const or: unknown[] = [];
  for (const uid of userIds) {
    const segs = segmentsByUser.get(uid);
    if (segs && segs.length > 0) or.push(...timeOr(uid, segs, campaign.startAt));
  }
  if (or.length === 0) return out;

  const rows = await ActivityModel.aggregate([
    // type 由调用方按「活动白名单 + 用户筛选」决定；显式覆盖 baseMatch 的 allowedTypes $in
    { $match: baseMatch(campaign, { ...(type ? { type } : {}), $or: or }) },
    {
      $group: {
        _id: '$userId',
        count: { $sum: 1 },
        distance: { $sum: '$distance' },
        duration: { $sum: '$duration' },
      },
    },
  ]);
  for (const r of rows) {
    out.set(String(r._id), { count: r.count, distance: r.distance, duration: r.duration });
  }
  return out;
}

/** 按运动类型的汇总（webAdmin 活动详情）：次数 / 距离 / 时长 */
export interface TypeSummaryRow {
  type: string;
  count: number;
  distance: number;
  duration: number;
}

/**
 * 分类型汇总：判据与 `statsForMembers` 完全一致（baseMatch + 各成员窗口并集），只在 `$group` 上多切一维 type。
 * 只传在队成员 —— 调用方决定范围；空名单直接返回 []，别把空 `$or` 交给 Mongo。
 * 排序：距离降序、同距离次数降序（与类型筛选列表的既有阅读顺序一致）。
 */
export async function typeSummaryForMembers(
  campaign: CampaignDoc,
  segmentsByUser: Map<string, Segment[]>,
  userIds: string[],
): Promise<TypeSummaryRow[]> {
  const or: unknown[] = [];
  for (const uid of userIds) {
    const segs = segmentsByUser.get(uid);
    if (segs && segs.length > 0) or.push(...timeOr(uid, segs, campaign.startAt));
  }
  if (or.length === 0) return [];

  const rows = await ActivityModel.aggregate([
    { $match: baseMatch(campaign, { $or: or }) },
    {
      $group: {
        _id: '$type',
        count: { $sum: 1 },
        distance: { $sum: '$distance' },
        duration: { $sum: '$duration' },
      },
    },
    { $sort: { distance: -1, count: -1 } },
  ]);
  return rows.map((r) => ({
    type: String(r._id),
    count: r.count,
    distance: r.distance,
    duration: r.duration,
  }));
}

/** 按「成员 × 东八日」聚合距离（活动内趋势图用） */
export interface DailyDistanceRow {
  userId: string;
  /** 东八区日期串 YYYY-MM-DD */
  date: string;
  distance: number;
}

/** 一批成员在活动内的「贡献时段」并集条件（`$or`）；空数组＝没有任何时段，调用方据此短路 */
function joinedTimeOr(
  campaign: CampaignDoc,
  segmentsByUser: Map<string, Segment[]>,
  userIds: string[],
): unknown[] {
  const or: unknown[] = [];
  for (const uid of userIds) {
    const segs = segmentsByUser.get(uid);
    if (segs && segs.length > 0) or.push(...timeOr(uid, segs, campaign.startAt));
  }
  return or;
}

/** `$dateToString` 的东八区日表达式——两处趋势聚合共用，桶口径写两遍迟早分叉 */
const BJ_DAY_EXPR = {
  $dateToString: {
    format: '%Y-%m-%d',
    date: { $toDate: '$startTime' },
    timezone: '+08:00',
  },
};

/**
 * 每日距离：判据与 `statsForMembers` 同源（baseMatch + 各成员窗口并集），
 * 只把 `$group` 的键从 userId 换成 userId + 东八日。空名单直接返回 []，别把空 `$or` 交给 Mongo。
 */
export async function dailyDistanceForMembers(
  campaign: CampaignDoc,
  segmentsByUser: Map<string, Segment[]>,
  userIds: string[],
  type?: string,
): Promise<DailyDistanceRow[]> {
  const or = joinedTimeOr(campaign, segmentsByUser, userIds);
  if (or.length === 0) return [];

  const rows = await ActivityModel.aggregate([
    { $match: baseMatch(campaign, { ...(type ? { type } : {}), $or: or }) },
    {
      $group: {
        _id: { uid: '$userId', date: BJ_DAY_EXPR },
        distance: { $sum: '$distance' },
      },
    },
  ]);
  return rows.map((r) => ({
    userId: String(r._id.uid),
    date: r._id.date,
    distance: r.distance,
  }));
}

/** 按「运动类型 × 东八日」聚合距离（全队分类型趋势图用；类型不再按人切，一条线＝一类） */
export interface DailyDistanceByTypeRow {
  type: string;
  /** 东八区日期串 YYYY-MM-DD */
  date: string;
  distance: number;
}

/**
 * 与 `dailyDistanceForMembers` 同一条判据链（`joinedTimeOr` + `baseMatch` + `BJ_DAY_EXPR`），
 * 只换 `$group` 的键，所以「各类型线终点相加」必然等于「全队汇总」的运动距离。
 */
export async function dailyDistanceByType(
  campaign: CampaignDoc,
  segmentsByUser: Map<string, Segment[]>,
  userIds: string[],
  type?: string,
): Promise<DailyDistanceByTypeRow[]> {
  const or = joinedTimeOr(campaign, segmentsByUser, userIds);
  if (or.length === 0) return [];

  const rows = await ActivityModel.aggregate([
    { $match: baseMatch(campaign, { ...(type ? { type } : {}), $or: or }) },
    {
      $group: {
        _id: { type: '$type', date: BJ_DAY_EXPR },
        distance: { $sum: '$distance' },
      },
    },
  ]);
  return rows.map((r) => ({
    type: String(r._id.type),
    date: r._id.date,
    distance: r.distance,
  }));
}

/** 某人「连续运动天数」：取他在活动内计入轨迹的东八区开始日，交给 streakDays */
export async function streakForUser(
  campaign: CampaignDoc,
  segs: Segment[],
  userId: string,
  now = Date.now(),
): Promise<number> {
  if (!segs || segs.length === 0) return 0;
  const rows = await ActivityModel.aggregate([
    { $match: baseMatch(campaign, { $or: timeOr(userId, segs, campaign.startAt) }) },
    {
      $group: {
        _id: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: { $toDate: '$startTime' }, // startTime 是数值，必须 $toDate
            timezone: '+08:00',
          },
        },
      },
    },
  ]);
  return streakDays(rows.map((r) => r._id), now);
}
