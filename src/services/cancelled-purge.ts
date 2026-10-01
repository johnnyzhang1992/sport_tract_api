/**
 * 清理「已作废」轨迹（管理员专用，默认试运行）
 *
 * 作废行对用户不可见、也不能纠偏，唯一价值是管理员点「恢复」的退路。
 * dev 库实测 3172 条作废行 / 1.4MB，其中 2992 条 0 点空壳，剩下 180 条点数最多的也只有
 * 21 点且 distance=0m —— 恢复出来照样过不了 finish 的无效守卫，留着只是后台列表里的噪音。
 * 所以判据不是"有没有点"，而是"恢复后能不能成一条运动"，门槛直接复用守卫那两个常量，
 * 不另立数字（否则将来守卫改了，这里的"可恢复"就和守卫不一致了）。
 */
import { Types } from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import { MIN_EFFECTIVE_DISTANCE_M, MIN_EFFECTIVE_POINTS } from '../config/constants.js';

const DAY_MS = 86400_000;

/** 默认保留期：过了这些天，"恢复也成不了一条运动"的作废行才可以被清掉 */
export const CANCELLED_RETENTION_DAYS = 30;

export type PurgeCancelledResult = {
  dryRun: boolean;
  retentionDays: number;
  /** 超期的作废行总数 */
  scanned: number;
  wouldDelete: number;
  deleted: number;
  /** 超期但"恢复出来能成一条运动"的，保留 */
  keptRescuable: number;
  /** 未到保留期的作废行，本轮不动（就是下一轮可删的量） */
  keptRecent: number;
  sampleIds: string[];
};

export async function purgeCancelledActivities(opts: {
  dryRun: boolean;
  retentionDays?: number;
  /** 只清某一个用户的作废行；不给就是全库（管理员主动发起时才该不传） */
  userId?: string;
  now?: number;
}): Promise<PurgeCancelledResult> {
  const retentionDays = opts.retentionDays ?? CANCELLED_RETENTION_DAYS;
  const cutoff = new Date((opts.now ?? Date.now()) - retentionDays * DAY_MS);

  // 只按 status 圈范围：finished / in_progress 绝不进这个集合
  const scope = opts.userId ? { userId: new Types.ObjectId(opts.userId) } : {};
  const rows = await ActivityModel.aggregate<{ _id: Types.ObjectId; pts: number; dist: number }>([
    { $match: { ...scope, status: 'cancelled', updatedAt: { $lt: cutoff } } },
    { $project: { pts: { $size: { $ifNull: ['$trackPoints', []] } }, dist: { $ifNull: ['$distance', 0] } } },
  ]);

  const doomed = rows
    .filter((r) => !(r.pts >= MIN_EFFECTIVE_POINTS && r.dist >= MIN_EFFECTIVE_DISTANCE_M))
    .map((r) => r._id);

  const keptRecent = await ActivityModel.countDocuments({ ...scope, status: 'cancelled', updatedAt: { $gte: cutoff } });

  let deleted = 0;
  if (!opts.dryRun && doomed.length) {
    const res = await ActivityModel.deleteMany({ ...scope, _id: { $in: doomed } });
    deleted = res.deletedCount ?? 0;
  }

  return {
    dryRun: opts.dryRun,
    retentionDays,
    scanned: rows.length,
    wouldDelete: doomed.length,
    deleted,
    keptRescuable: rows.length - doomed.length,
    keptRecent,
    sampleIds: doomed.slice(0, 20).map(String),
  };
}
