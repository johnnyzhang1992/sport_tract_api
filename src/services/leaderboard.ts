/**
 * 运动榜（决策：运动排行榜 tab）
 * - regions：全平台点亮地图（所有用户 finished 轨迹，直接聚合落库的 provinces/startCity 字段）
 * - ranking：按 运动类型 > 省份 排行（按总距离），TOP10 昵称模糊化且不暴露 userId；
 *   当前用户返回真实昵称与真实排名（可能在 TOP10 之外）
 */
import { ActivityModel } from '../models/activity.model.js';
import { UserModel } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { ACTIVITY_TYPES } from '../config/constants.js';

export interface RegionProvince {
  name: string;
  /** 轨迹条数（跨省轨迹在每个途经省各计 1 次） */
  count: number;
  /** 点亮用户数（去重） */
  users: number;
}

export interface RegionCity {
  name: string;
  province: string;
  count: number;
  users: number;
}

export interface RegionsResult {
  provinces: RegionProvince[];
  cities: RegionCity[];
  totalUsers: number;
}

export interface RankRow {
  rank: number;
  /** 昵称（TOP10 已模糊化） */
  name: string;
  distanceKm: number;
  /** 轨迹条数 */
  count: number;
}

export interface LeaderboardResult {
  type: string;
  province: string; // '全国' 或省份名
  /** 参与人数（有该类型轨迹的用户数） */
  players: number;
  top: RankRow[];
  /** 当前用户真实排名；无轨迹为 null */
  me: RankRow | null;
}

/** 模糊昵称：保留首字符（按 Unicode 码点，兼容 emoji），其余以 * 代替（至多 2 个） */
export function maskNick(nick: string): string {
  const chars = Array.from((nick || '').trim());
  if (chars.length === 0) return '运动用户';
  if (chars.length === 1) return chars[0] + '**';
  return chars[0] + '*'.repeat(Math.min(2, chars.length - 1));
}

/** 全平台点亮统计（60s 内存缓存：聚合只读历史，短窗口内允许略旧） */
let regionsCache: { at: number; data: RegionsResult } | null = null;

export async function leaderboardRegions(): Promise<RegionsResult> {
  if (regionsCache && Date.now() - regionsCache.at < 60_000) return regionsCache.data;

  const [provAgg, cityAgg, userAgg] = await Promise.all([
    ActivityModel.aggregate([
      { $match: { status: 'finished' } },
      { $unwind: '$provinces' },
      { $group: { _id: '$provinces', count: { $sum: 1 }, users: { $addToSet: '$userId' } } },
      { $project: { _id: 0, name: '$_id', count: 1, users: { $size: '$users' } } },
      { $sort: { count: -1 } },
    ]),
    ActivityModel.aggregate([
      { $match: { status: 'finished', startCity: { $ne: '' } } },
      {
        $group: {
          _id: { city: '$startCity', province: '$startProvince' },
          count: { $sum: 1 },
          users: { $addToSet: '$userId' },
        },
      },
      {
        $project: {
          _id: 0,
          name: '$_id.city',
          province: '$_id.province',
          count: 1,
          users: { $size: '$users' },
        },
      },
      { $sort: { count: -1 } },
    ]),
    ActivityModel.distinct('userId', { status: 'finished' }),
  ]);

  const data: RegionsResult = {
    provinces: provAgg,
    cities: cityAgg,
    totalUsers: userAgg.length,
  };
  regionsCache = { at: Date.now(), data };
  return data;
}

export async function leaderboard(
  userId: string,
  type: string,
  province = '全国',
): Promise<LeaderboardResult> {
  if (!ACTIVITY_TYPES.includes(type as never)) {
    throw new AppError(400, '运动类型不合法');
  }

  const match: Record<string, unknown> = { status: 'finished', type };
  if (province && province !== '全国') match.provinces = province; // 命中多键索引 { userId, provinces }

  // 全量分组后内存排序：同时拿到 TOP10 和当前用户名次（量级小，无需 $rank）
  const rows = await ActivityModel.aggregate<{
    _id: unknown;
    distance: number;
    count: number;
  }>([
    { $match: match },
    { $group: { _id: '$userId', distance: { $sum: '$distance' }, count: { $sum: 1 } } },
    { $sort: { distance: -1 } },
  ]);

  const myIdx = rows.findIndex((r) => String(r._id) === String(userId));
  const topRows = rows.slice(0, 10);
  const meRow = myIdx >= 0 ? rows[myIdx] : null;

  const involvedIds = new Set<string>([
    ...topRows.map((r) => String(r._id)),
    ...(meRow ? [String(meRow._id)] : []),
  ]);
  const users = await UserModel.find({ _id: { $in: [...involvedIds] } })
    .select({ nickname: 1 })
    .lean();
  const nickById = new Map(users.map((u) => [String(u._id), u.nickname || '']));

  const toRow = (r: { _id: unknown; distance: number; count: number }, rank: number, real: boolean): RankRow => ({
    rank,
    name: real ? nickById.get(String(r._id)) || '运动用户' : maskNick(nickById.get(String(r._id))),
    distanceKm: Math.round((r.distance / 1000) * 100) / 100,
    count: r.count,
  });

  return {
    type,
    province: province || '全国',
    players: rows.length,
    top: topRows.map((r, i) => toRow(r, i + 1, false)),
    me: meRow ? toRow(meRow, myIdx + 1, true) : null,
  };
}
