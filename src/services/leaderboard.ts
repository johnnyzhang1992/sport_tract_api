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
import type { ActivityType } from '../config/constants.js';
import { getSignedUrl } from './oss.js';

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
  /** 注册用户总数（users 集合，口径：注册即可，不要求有轨迹） */
  totalUsers: number;
}

export interface RankRow {
  rank: number;
  /** 昵称（完整展示） */
  name: string;
  /** 性别：0 未知 1 男 2 女 */
  gender: number;
  /** 头像（OSS 签名 URL，可能为空） */
  avatarUrl: string;
  /** 预设头像 key（avatarUrl 为空时生效，前端映射本地资源） */
  avatarPreset: string;
  distanceKm: number;
  /** 轨迹条数 */
  count: number;
  /** 用户 id（仅管理端 includeUserId 时下发，用户端不暴露） */
  userId?: string;
}

/** 本榜最佳指标键 */
export type BestMetricKey = 'farthest' | 'longest' | 'fastestKm' | 'fastestAvg' | 'maxClimb';

export interface BestRow {
  key: BestMetricKey;
  /** 原始值：距离/爬升 米，时长/配速 秒；fastestAvg 为 km/h（后端直接回均速） */
  value: number;
  /** 纪录保持者昵称 */
  name: string;
  gender: number;
  avatarUrl: string;
  avatarPreset: string;
}

/** 各运动类型的本榜最佳指标（顺序即展示顺序；所有类型都有距离/时长，耐力类加专项指标） */
const BEST_METRICS: Record<string, BestMetricKey[]> = {
  walking: ['farthest', 'longest'],
  running: ['farthest', 'longest', 'fastestKm'],
  hiking: ['farthest', 'longest', 'maxClimb'],
  mountaineering: ['farthest', 'longest', 'maxClimb'],
  cycling: ['farthest', 'longest', 'fastestAvg'],
  swimming: ['farthest', 'longest'],
  skiing: ['farthest', 'longest'],
  rowing: ['farthest', 'longest'],
};

/** 指标 → 活动字段与排序方向（dir=1 越小越好，如配速） */
const BEST_METRIC_SPEC: Record<BestMetricKey, { field: string; dir: 1 | -1 }> = {
  farthest: { field: 'distance', dir: -1 }, // 米
  longest: { field: 'duration', dir: -1 }, // 秒
  fastestKm: { field: 'fastestKm', dir: 1 }, // 秒/公里
  fastestAvg: { field: 'avgPace', dir: 1 }, // 秒/公里（全程均速）
  maxClimb: { field: 'elevationGain', dir: -1 }, // 米
};

export interface LeaderboardResult {
  type: string;
  province: string; // '全国' 或省份名
  /** 榜单周期：week/month/year/all */
  period: string;
  /** 参与人数（有该类型轨迹的用户数） */
  players: number;
  top: RankRow[];
  /** 当前用户真实排名；无轨迹为 null */
  me: RankRow | null;
  /** 本榜最佳：当前 类型/省份/周期 筛选下的单项纪录（按类型的指标集） */
  best: BestRow[];
}

const LEADERBOARD_PERIODS = ['week', 'month', 'year', 'all'] as const;
export type LeaderboardPeriod = (typeof LEADERBOARD_PERIODS)[number];

/** 周期 → 起始时间戳（毫秒；自然周从周一、自然月、自然年；all 不限） */
export function periodStartMs(period: LeaderboardPeriod, now = new Date()): number | null {
  if (period === 'all') return null;
  if (period === 'week') {
    const d = new Date(now);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 回到本周周一
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (period === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return new Date(now.getFullYear(), 0, 1).getTime();
}

/** 全平台点亮统计（60s 内存缓存：聚合只读历史，短窗口内允许略旧） */
let regionsCache: { at: number; data: RegionsResult } | null = null;

export async function leaderboardRegions(): Promise<RegionsResult> {
  if (regionsCache && Date.now() - regionsCache.at < 60_000) return regionsCache.data;

  const [provAgg, cityAgg, userCount] = await Promise.all([
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
    // 总数口径：注册用户数（有 finished 轨迹的用户才会点亮省份，但总数只看注册）
    UserModel.countDocuments({}),
  ]);

  const data: RegionsResult = {
    provinces: provAgg,
    cities: cityAgg,
    totalUsers: userCount,
  };
  regionsCache = { at: Date.now(), data };
  return data;
}

export async function leaderboard(
  /** 当前用户 id（用户端传，用于返回"我的排名"）；管理端传 null */
  userId: string | null,
  type: string,
  province = '全国',
  period: LeaderboardPeriod = 'all',
  opts: { limit?: number; includeUserId?: boolean } = {},
): Promise<LeaderboardResult> {
  const { limit = 10, includeUserId = false } = opts;
  if (!ACTIVITY_TYPES.includes(type as never)) {
    throw new AppError(400, '运动类型不合法');
  }
  if (!LEADERBOARD_PERIODS.includes(period)) {
    throw new AppError(400, '榜单周期不合法');
  }

  const match: Record<string, unknown> = { status: 'finished', type };
  if (province && province !== '全国') match.provinces = province; // 命中多键索引 { userId, provinces }
  const startMs = periodStartMs(period);
  if (startMs !== null) match.startTime = { $gte: startMs };

  // 全量分组后内存排序：同时拿到 TOP N 和当前用户名次（量级小，无需 $rank）
  const rows = await ActivityModel.aggregate<{
    _id: unknown;
    distance: number;
    count: number;
  }>([
    { $match: match },
    { $group: { _id: '$userId', distance: { $sum: '$distance' }, count: { $sum: 1 } } },
    { $sort: { distance: -1 } },
  ]);

  const myIdx = userId ? rows.findIndex((r) => String(r._id) === String(userId)) : -1;
  const topRows = rows.slice(0, limit);
  const meRow = myIdx >= 0 ? rows[myIdx] : null;

  // 本榜最佳：$facet 一次查出各指标最优活动（>0 过滤掉无意义零值，如 0 爬升/0 配速）
  type FacetDoc = Record<string, Array<{ userId: unknown } & Record<string, number>>>;
  const facet: Record<string, unknown> = {};
  for (const key of BEST_METRICS[type]) {
    if (key === 'fastestAvg') {
      // 最快均速 = distance/duration（km/h）：骑行/游泳 avgPace 为 null，不能用 avgPace
      facet[key] = [
        { $match: { distance: { $gt: 0 }, duration: { $gt: 0 } } },
        { $addFields: { speedKmh: { $divide: [{ $multiply: ['$distance', 3.6] }, '$duration'] } } },
        { $sort: { speedKmh: -1 } },
        { $limit: 1 },
        { $project: { userId: 1, speedKmh: 1 } },
      ];
      continue;
    }
    const spec = BEST_METRIC_SPEC[key];
    facet[key] = [
      { $match: { [spec.field]: { $gt: 0 } } },
      { $sort: { [spec.field]: spec.dir } },
      { $limit: 1 },
      { $project: { userId: 1, [spec.field]: 1 } },
    ];
  }
  const [facetDoc] = await ActivityModel.aggregate<FacetDoc>([
    { $match: match },
    { $facet: facet as never },
  ]);

  // 本榜最佳中间结果：各指标命中的纪录活动（按类型指标集顺序；无纪录的指标无条目）
  const bestDocs = BEST_METRICS[type]
    .map((key) => ({ key, doc: (facetDoc?.[key] || [])[0] }))
    .filter((b): b is { key: BestMetricKey; doc: { userId: unknown } & Record<string, number> } => !!b.doc);

  const involvedIds = new Set<string>([
    ...topRows.map((r) => String(r._id)),
    ...(meRow ? [String(meRow._id)] : []),
    ...bestDocs.map((b) => String(b.doc.userId)),
  ]);
  const users = await UserModel.find({ _id: { $in: [...involvedIds] } })
    .select({ nickname: 1, gender: 1, avatarUrl: 1, avatarPreset: 1 })
    .lean();
  const infoById = new Map(
    users.map((u) => [
      String(u._id),
      {
        nickname: u.nickname || '',
        gender: u.gender ?? 0,
        avatarUrl: u.avatarUrl ? getSignedUrl(u.avatarUrl) : '',
        avatarPreset: u.avatarPreset || '',
      },
    ]),
  );

  const toRow = (r: { _id: unknown; distance: number; count: number }, rank: number): RankRow => {
    const info = infoById.get(String(r._id));
    return {
      rank,
      name: (info && info.nickname) || '运动用户',
      gender: (info && info.gender) || 0,
      avatarUrl: (info && info.avatarUrl) || '',
      avatarPreset: (info && info.avatarPreset) || '',
      distanceKm: Math.round((r.distance / 1000) * 100) / 100,
      count: r.count,
      ...(includeUserId ? { userId: String(r._id) } : {}),
    };
  };

  // 组装本榜最佳
  const best: BestRow[] = bestDocs.map(({ key, doc }) => {
    const info = infoById.get(String(doc.userId));
    return {
      key,
      // fastestAvg 为 km/h；其余直接取原始字段（米 / 秒 / 秒每公里）
      value: key === 'fastestAvg' ? Number(doc.speedKmh) : Number(doc[BEST_METRIC_SPEC[key].field]),
      name: (info && info.nickname) || '运动用户',
      gender: (info && info.gender) || 0,
      avatarUrl: (info && info.avatarUrl) || '',
      avatarPreset: (info && info.avatarPreset) || '',
    };
  });

  return {
    type,
    province: province || '全国',
    period,
    players: rows.length,
    top: topRows.map((r, i) => toRow(r, i + 1)),
    me: meRow ? toRow(meRow, myIdx + 1) : null,
    best,
  };
}

/** 当前用户在某类型榜的名次行 */
export interface MeRankRow {
  type: ActivityType;
  rank: number;
  distanceKm: number;
  /** 轨迹条数 */
  count: number;
}

export interface LeaderboardMeResult {
  province: string;
  period: string;
  /** 上榜类型的名次（按 rank 升序，同名词次距离远者在前） */
  ranks: MeRankRow[];
  /** 名次最靠前的上榜类型；各类型均未上榜为 null */
  best: MeRankRow | null;
}

/**
 * 当前用户在 指定周期/省份 下各运动类型榜的名次（单次聚合替代逐类型查询）
 * 口径与 leaderboard() 一致：周期内 finished 轨迹总距离降序；全量分组内存排序（量级小）
 */
export async function leaderboardMe(
  userId: string,
  province = '全国',
  period: LeaderboardPeriod = 'week',
): Promise<LeaderboardMeResult> {
  if (!LEADERBOARD_PERIODS.includes(period)) {
    throw new AppError(400, '榜单周期不合法');
  }

  const match: Record<string, unknown> = { status: 'finished' };
  if (province && province !== '全国') match.provinces = province;
  const startMs = periodStartMs(period);
  if (startMs !== null) match.startTime = { $gte: startMs };

  const rows = await ActivityModel.aggregate<{
    _id: { type: string; userId: unknown };
    distance: number;
    count: number;
  }>([
    { $match: match },
    {
      $group: {
        _id: { type: '$type', userId: '$userId' },
        distance: { $sum: '$distance' },
        count: { $sum: 1 },
      },
    },
  ]);

  // 按类型分桶、总距离降序，取当前用户位次
  const byType = new Map<string, Array<{ userId: unknown; distance: number; count: number }>>();
  for (const r of rows) {
    const bucket = byType.get(r._id.type) || [];
    bucket.push({ userId: r._id.userId, distance: r.distance, count: r.count });
    byType.set(r._id.type, bucket);
  }
  const ranks: MeRankRow[] = [];
  for (const [type, bucket] of byType) {
    bucket.sort((a, b) => b.distance - a.distance);
    const idx = bucket.findIndex((r) => String(r.userId) === String(userId));
    if (idx >= 0) {
      ranks.push({
        type: type as ActivityType,
        rank: idx + 1,
        distanceKm: Math.round((bucket[idx].distance / 1000) * 100) / 100,
        count: bucket[idx].count,
      });
    }
  }
  ranks.sort((a, b) => a.rank - b.rank || b.distanceKm - a.distanceKm);

  return {
    province: province || '全国',
    period,
    ranks,
    best: ranks.length > 0 ? ranks[0] : null,
  };
}
