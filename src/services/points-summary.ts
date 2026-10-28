/**
 * 积分页两张新卡的取数：过期提醒 + 连签百分位。
 * 口径都在 `utils/points-domain.js` 的纯函数里，这里只负责读库——
 * 共享库里全用户分布随时在变，把数值断言留给纯函数用例，集成用例只断"读对了吗"。
 */
import { Types } from 'mongoose';
import { POINTS } from '../config/points.js';
import { PointLotModel, PointSigninModel } from '../models/point.model.js';
import { UserModel } from '../models/user.model.js';
import { bjDateStr } from '../utils/bj-time.js';
import { previousDateKey, expiringNotice, streakPercentile, type ExpiringNotice } from '../utils/points-domain.js';

export interface StreakPopulation {
  /** 分母：全部注册用户（没签过到的人有效连签算 0，2026-10-28 用户拍板按全量算） */
  totalUsers: number;
  /** 本人当前连签：今天有行取今天，否则昨天有行取昨天，再往前归 0（与 getSigninState 同口径） */
  mine: number;
  /** 链还活着的人的连签值（今天或昨天有签到行） */
  activeStreaks: number[];
}

export async function streakPopulation(userId: string, now = Date.now()): Promise<StreakPopulation> {
  const todayKey = bjDateStr(now);
  const yKey = previousDateKey(todayKey);
  // 只读这两天窗口就够：断链的人有效连签必为 0，不必回全表找他们
  const [rows, totalUsers] = await Promise.all([
    PointSigninModel.find({ dateKey: { $in: [todayKey, yKey] } })
      .select({ userId: 1, dateKey: 1, streakDay: 1 }).lean(),
    UserModel.countDocuments({}),
  ]);
  const byUser = new Map<string, { today?: number; yesterday?: number }>();
  for (const r of rows) {
    const slot = byUser.get(String(r.userId)) ?? {};
    if (r.dateKey === todayKey) slot.today = r.streakDay;
    else slot.yesterday = r.streakDay;
    byUser.set(String(r.userId), slot);
  }
  const activeStreaks = [...byUser.values()]
    .map((v) => v.today ?? v.yesterday ?? 0)
    .filter((s) => s >= 1);
  const own = byUser.get(String(userId));
  return { totalUsers, mine: own ? (own.today ?? own.yesterday ?? 0) : 0, activeStreaks };
}

/** 百分位一步到位：读库 + 纯函数算 */
export async function streakPercentileOf(userId: string, now = Date.now()): Promise<number> {
  const p = await streakPopulation(userId, now);
  return streakPercentile({ totalUsers: p.totalUsers, activeStreaks: p.activeStreaks, mine: p.mine });
}

/**
 * 最早到期批次的提醒。聚合里先按 expireAt 分组再取最小一组：
 * 一个人可能有几十上百个批次，全部拉回内存求和没必要，但"同一天到期的要合并成一个数"必须成立。
 */
export async function expiringOf(userId: string, now = Date.now()): Promise<ExpiringNotice | null> {
  const [head] = await PointLotModel.aggregate<{ _id: number; points: number }>([
    // aggregate 的 $match 不走 Mongoose 类型转换，userId 要手动转（同 points-cards.ts 口径）
    { $match: { userId: new Types.ObjectId(userId), remaining: { $gt: 0 }, expireAt: { $gt: now } } },
    { $group: { _id: '$expireAt', points: { $sum: '$remaining' } } },
    { $sort: { _id: 1 } },
    { $limit: 1 },
  ]);
  if (!head) return null;
  return expiringNotice([{ remaining: head.points, expireAt: head._id }], now, POINTS.EXPIRE_NOTICE_DAYS);
}
