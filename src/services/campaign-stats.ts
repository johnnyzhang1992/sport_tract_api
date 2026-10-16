/**
 * 一起运动活动（campaign）：轨迹计入判据与汇总聚合。
 *
 * 计入判据（Spec §4.1）——一条轨迹要**同时**满足才计入：
 *   1. 属于该活动的某位成员（按 userId 匹配，时间窗见下）
 *   2. status = 'finished'
 *   3. type ∈ allowedTypes（allowedTypes 为空则不限类型）
 *   4. startTime ∈ [joinedAt, leftAt)（左闭右开；同一用户多段取并集，leftAt = null 视为至今）
 *   5. vehicleMs 未检出疑似搭车
 *
 * 汇总（count / distance / duration）用一次 `$group by userId` 出所有成员，避免 N+1。
 */
import mongoose from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import { CampaignMemberModel } from '../models/campaign-member.model.js';
import { streakDays } from '../utils/campaign-streak.js';
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
    { $match: baseMatch(campaign, { $or: or }) },
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
