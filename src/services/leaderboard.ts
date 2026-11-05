/**
 * 运动榜（决策：运动排行榜 tab）
 * - regions：全平台点亮地图（所有用户 finished 轨迹，直接聚合落库的 provinces/startCity 字段）
 * - ranking：按 运动类型 > 省份 排行（按总距离），TOP10 昵称模糊化且不暴露 userId；
 *   当前用户返回真实昵称与真实排名（可能在 TOP10 之外）
 */
import { ActivityModel } from '../models/activity.model.js';
import { UserModel } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { ACTIVITY_TYPES, MIN_PLAUSIBLE_PACE_SEC_PER_KM, DRIFT_SCORE_PB_GATE } from '../config/constants.js';
import type { ActivityType } from '../config/constants.js';
import { getAvatarUrl } from './oss.js';
import { activeMemberUserIds } from './entitlements.js';
import { bjDateStr, bjIsoWeekStart, bjMonthStart, bjYearStart } from '../utils/bj-time.js';

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
  /** 运动时长合计（秒）：筛选范围内 Σ duration，与活动榜/运动时长同源 */
  durationSec: number;
  /** 加权平均配速（秒/公里）= Σduration ÷ Σdistance，取整；无可信距离时为 null */
  paceSecPerKm: number | null;
  /** 公开 UID（榜单用户点开资料用；不是 openid） */
  uid: number;
  /** 此刻是否为付费会员（头像徽标用；不含积分免广告卡） */
  memberActive: boolean;
  /** 用户 id（仅管理端 includeUserId 时下发，用户端不暴露） */
  userId?: string;
}

/** 本榜最佳指标键 */
export type BestMetricKey = 'farthest' | 'longest' | 'fastestKm' | 'fastestAvg' | 'maxClimb';

export interface BestRow {
  key: BestMetricKey;
  /** 原始值：距离/爬升 米，时长/配速 秒；fastestAvg 为 km/h（后端直接回均速） */
  value: number;
  /** 该纪录的运动时长（秒）：只有 longest 类条目需要展示，0/缺失则不下发 */
  durationSec?: number;
  /** 纪录保持者昵称 */
  name: string;
  gender: number;
  avatarUrl: string;
  avatarPreset: string;
  /** 此刻是否为付费会员（头像徽标用） */
  memberActive: boolean;
}

/** 各运动类型的本榜最佳指标（顺序即展示顺序；所有类型都有距离/时长，耐力类加专项指标） */
const BEST_METRICS: Record<string, BestMetricKey[]> = {
  walking: ['farthest'],
  running: ['farthest', 'fastestKm'],
  hiking: ['farthest', 'maxClimb'],
  mountaineering: ['farthest', 'maxClimb'],
  cycling: ['farthest', 'fastestAvg'],
  swimming: ['farthest'],
  skiing: ['farthest'],
  rowing: ['farthest'],
};

/**
 * 要求「整条轨迹没检出疑似搭车」的指标。搭车段会把距离/配速刷成不可信值，
 * 这类轨迹不该占纪录（哪怕指标已剔除过 vehicleM）。
 * 判据用 $not/$gt 而不是 $lte:0——缺 vehicleMs 字段的老文档是"没搭车"，$lte 会把它们全排掉。
 */
const NO_VEHICLE_METRICS: ReadonlySet<BestMetricKey> = new Set(['farthest', 'fastestKm']);

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
  /** 当前展示的期（all 为 null）。历史周期入口新增（2026-11-05） */
  window: PeriodWindow | null;
  /** 翻页键：上一期恒有，下一期在未来时为 null */
  prevPeriodKey: string | null;
  nextPeriodKey: string | null;
}

const LEADERBOARD_PERIODS = ['week', 'month', 'year', 'all'] as const;
export type LeaderboardPeriod = (typeof LEADERBOARD_PERIODS)[number];

/** 周期 → 起始时间戳（毫秒；东八区自然周从周一、自然月、自然年；all 不限） */
export function periodStartMs(period: LeaderboardPeriod, now = new Date()): number | null {
  if (period === 'all') return null;
  const ms = now.getTime();
  if (period === 'week') return bjIsoWeekStart(ms);
  if (period === 'month') return bjMonthStart(ms);
  return bjYearStart(ms);
}

/**
 * 周期窗口（2026-11-05 新增：榜单支持看历史周期）。
 * 一个「期」= [startMs, endMs) 的东八区自然区间，periodKey 沿用积分榜单那套规范：
 * week=`周一的日期`（YYYY-MM-DD）、month=`YYYY-MM`、year=`YYYY`；all 无窗口（null）。
 */
export interface PeriodWindow {
  periodKey: string;
  startMs: number;
  endMs: number;
  /** 给用户看的区间文案：周=「2026/10/27 至 11/02」，月=「2026年10月」，年=「2026年」 */
  text: string;
}

const DAY_MS = 86_400_000;

const BJ_MS = 8 * 3600_000;
function bjMid(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d) - BJ_MS;
}

function bjParts(ms: number): { y: number; m: number; d: number } {
  const d = new Date(ms + BJ_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

/** 某周期在「包含 anchorMs 的那一期」的窗口 */
export function periodWindowOf(period: LeaderboardPeriod, anchorMs = Date.now()): PeriodWindow | null {
  if (period === 'all') return null;
  const startMs = periodStartMs(period, new Date(anchorMs)) as number;
  return windowFromStart(period, startMs);
}

function windowFromStart(period: Exclude<LeaderboardPeriod, 'all'>, startMs: number): PeriodWindow {
  if (period === 'week') {
    const endMs = startMs + 7 * DAY_MS;
    const s = bjParts(startMs);
    const e = bjParts(endMs - DAY_MS); // 最后一天（含）
    const md = (p: { m: number; d: number }) => `${String(p.m).padStart(2, '0')}/${String(p.d).padStart(2, '0')}`;
    return {
      periodKey: bjDateStr(startMs),
      startMs,
      endMs,
      text: s.y === e.y ? `${s.y}/${md(s)} 至 ${md(e)}` : `${s.y}/${md(s)} 至 ${e.y}/${md(e)}`,
    };
  }
  if (period === 'month') {
    const p = bjParts(startMs);
    const endMs = bjMid(p.y, p.m + 1, 1);
    return { periodKey: `${p.y}-${String(p.m).padStart(2, '0')}`, startMs, endMs, text: `${p.y}年${p.m}月` };
  }
  const p = bjParts(startMs);
  return { periodKey: String(p.y), startMs, endMs: bjMid(p.y + 1, 1, 1), text: `${p.y}年` };
}

/**
 * 用 periodKey 反解窗口（历史周期入口）。非法形态一律 400——
 * 与「外来 id 藏进 404」口径不同：这里是用户手填/前端算错的查询参数，给明确原因更好排障。
 */
export function periodWindowFromKey(period: LeaderboardPeriod, periodKey: string): PeriodWindow | null {
  if (period === 'all') return null;
  const key = String(periodKey || '').trim();
  if (!key) return null; // 空＝当前期，由调用方回落
  if (period === 'week') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new AppError(400, `周榜周期键应为 YYYY-MM-DD（收到「${key}」）`);
    const start = bjMid(Number(key.slice(0, 4)), Number(key.slice(5, 7)), Number(key.slice(8, 10)));
    if (bjDateStr(start) !== key) throw new AppError(400, `周榜周期键不是合法日期（收到「${key}」）`);
    if (bjIsoWeekStart(start) !== start) throw new AppError(400, `周榜周期键必须是周一（收到「${key}」）`);
    return windowFromStart('week', start);
  }
  if (period === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    if (!m) throw new AppError(400, `月榜周期键应为 YYYY-MM（收到「${key}」）`);
    const month = Number(m[2]);
    if (month < 1 || month > 12) throw new AppError(400, `月榜周期键月份非法（收到「${key}」）`);
    return windowFromStart('month', bjMid(Number(m[1]), month, 1));
  }
  if (!/^\d{4}$/.test(key)) throw new AppError(400, `年榜周期键应为 YYYY（收到「${key}」）`);
  return windowFromStart('year', bjMid(Number(key), 1, 1));
}

/** 相邻期（供前端「上一期 / 下一期」翻页）；下一期在未来时返回 null */
export function adjacentPeriodKeys(
  period: LeaderboardPeriod,
  win: PeriodWindow | null,
  now = Date.now(),
): { prevPeriodKey: string | null; nextPeriodKey: string | null } {
  if (!win) return { prevPeriodKey: null, nextPeriodKey: null };
  const prev = periodWindowOf(period, win.startMs - 1);
  const next = periodWindowOf(period, win.endMs); // endMs 属于下一期
  const nextInFuture = win.endMs > now; // 本期都还没结束 ⇒ 没有下一期
  return {
    prevPeriodKey: prev ? prev.periodKey : null,
    nextPeriodKey: nextInFuture ? null : (next ? next.periodKey : null),
  };
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

export interface TypeCount {
  type: string;
  /** 该类型上榜轨迹数（与榜单同口径：status finished） */
  count: number;
}

/**
 * 运动榜分类 chips 的排序依据：各运动类型在「指定周期」的上榜轨迹数。
 * chips 排序必须与当前选中的周期一致——周榜下按周数据排，总榜下按全量排；
 * 零填充全部类型，前端才能区分「真没人玩」和「接口没返回这项」
 */
export async function leaderboardTypeCounts(
  period: LeaderboardPeriod = 'all',
  opts: { periodKey?: string; now?: number } = {},
): Promise<{ types: TypeCount[]; period: LeaderboardPeriod; window: PeriodWindow | null }> {
  const now = opts.now ?? Date.now();
  const win = opts.periodKey ? periodWindowFromKey(period, opts.periodKey) : periodWindowOf(period, now);
  const match: Record<string, unknown> = { status: 'finished', type: { $in: [...ACTIVITY_TYPES] } };
  if (win) match.startTime = { $gte: win.startMs, $lt: win.endMs };
  const rows = await ActivityModel.aggregate<{ _id: string; n: number }>([
    { $match: match },
    { $group: { _id: '$type', n: { $sum: 1 } } },
  ]);
  const map = new Map(rows.map((r) => [r._id, r.n]));
  return {
    types: ACTIVITY_TYPES.map((type) => ({ type, count: map.get(type) ?? 0 })),
    period,
    window: win,
  };
}

export async function leaderboard(
  /** 当前用户 id（用户端传，用于返回"我的排名"）；管理端传 null */
  userId: string | null,
  type: string,
  province = '全国',
  period: LeaderboardPeriod = 'all',
  opts: { limit?: number; includeUserId?: boolean; periodKey?: string; now?: number } = {},
): Promise<LeaderboardResult> {
  const { limit = 10, includeUserId = false, periodKey, now = Date.now() } = opts;
  if (!ACTIVITY_TYPES.includes(type as never)) {
    throw new AppError(400, '运动类型不合法');
  }
  if (!LEADERBOARD_PERIODS.includes(period)) {
    throw new AppError(400, '榜单周期不合法');
  }

  // 历史周期（2026-11-05）：periodKey 给了就按那一期算，不给就是包含当前时刻的那一期。
  // 窗口必须**两端都夹住**（$gte + $lt）——只夹起点会让「过去的周榜」把后面的数据算进来。
  const win = periodKey
    ? periodWindowFromKey(period, periodKey)
    : periodWindowOf(period, now);

  const match: Record<string, unknown> = { status: 'finished', type };
  if (province && province !== '全国') match.provinces = province; // 命中多键索引 { userId, provinces }
  if (win) match.startTime = { $gte: win.startMs, $lt: win.endMs };

  // 全量分组后内存排序：同时拿到 TOP N 和当前用户名次（量级小，无需 $rank）
  const rows = await ActivityModel.aggregate<{
    _id: unknown;
    distance: number;
    count: number;
    duration: number;
  }>([
    { $match: match },
    {
      $group: {
        _id: '$userId',
        distance: { $sum: '$distance' },
        count: { $sum: 1 },
        // 缺 duration 的老文档 $sum 视为 0（与其它聚合口径一致）
        duration: { $sum: '$duration' },
      },
    },
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
        {
          $match: {
            distance: { $gt: 0 },
            duration: { $gt: 0 },
            // 漂移分门禁对所有榜单指标生效（含均速榜）：详情页对超门禁轨迹会明说
            // 「未计入个人最佳与排行榜」，若这里漏放行就与那句自相矛盾——
            // 实测线上 6ad9eaaf 骑行 62.1km/h（driftScore 100）占着骑行均速榜首。
            driftScore: { $not: { $gt: DRIFT_SCORE_PB_GATE } },
          },
        },
        { $addFields: { speedKmh: { $divide: [{ $multiply: ['$distance', 3.6] }, '$duration'] } } },
        { $sort: { speedKmh: -1 } },
        { $limit: 1 },
        { $project: { userId: 1, speedKmh: 1 } },
      ];
      continue;
    }
    const spec = BEST_METRIC_SPEC[key];
    facet[key] = [
      // 越小越好 = 配速类：低于可信下限的（GPS 漂移、把乘车段算进运动量）不当纪录挂着
      // - driftScore 门禁对**所有**指标生效（docs/19 §4.2）：详情页对超门禁轨迹明说
      //   「未计入个人最佳与排行榜」，任一榜漏放行就自相矛盾；缺字段 = 可信（与 vehicleMs 同惯用法）
      // - vehicleMs 排除仍只对 longest-distance / fastest-km 生效（NO_VEHICLE_METRICS）：
      //   骑行可能是摩托车（产品决策），不因检出车速段就剥骑行纪录
      {
        $match: {
          [spec.field]: { $gt: spec.dir === 1 ? MIN_PLAUSIBLE_PACE_SEC_PER_KM : 0 },
          driftScore: { $not: { $gt: DRIFT_SCORE_PB_GATE } },
          ...(NO_VEHICLE_METRICS.has(key) ? { vehicleMs: { $not: { $gt: 0 } } } : {}),
        },
      },
      { $sort: { [spec.field]: spec.dir } },
      { $limit: 1 },
      // 最长距离要连它的运动时长一起下发（前端同排展示「12.34 km · 1:23:45」）；其它指标不带
      { $project: { userId: 1, [spec.field]: 1, ...(key === 'farthest' ? { duration: 1 } : {}) } },
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
    .select({ uid: 1, nickname: 1, gender: 1, avatarUrl: 1, avatarPreset: 1 })
    .lean();
  const infoById = new Map(
    users.map((u) => [
      String(u._id),
      {
        uid: Number(u.uid) || 0,
        nickname: u.nickname || '',
        gender: u.gender ?? 0,
        avatarUrl: u.avatarUrl ? getAvatarUrl(u.avatarUrl) : '',
        avatarPreset: u.avatarPreset || '',
      },
    ]),
  );
  const memberIds = await activeMemberUserIds([...involvedIds]);

  const toRow = (
    r: { _id: unknown; distance: number; count: number; duration: number },
    rank: number,
  ): RankRow => {
    const info = infoById.get(String(r._id));
    const durationSec = Math.round(r.duration || 0);
    return {
      rank,
      uid: (info && info.uid) || 0,
      name: (info && info.nickname) || '运动用户',
      gender: (info && info.gender) || 0,
      avatarUrl: (info && info.avatarUrl) || '',
      avatarPreset: (info && info.avatarPreset) || '',
      distanceKm: Math.round((r.distance / 1000) * 100) / 100,
      count: r.count,
      durationSec,
      // 按合计距离加权，不是逐条配速平均；缺距离或时长就没可信配速（前端显示「—」）
      paceSecPerKm: r.distance > 0 && durationSec > 0 ? Math.round(durationSec / (r.distance / 1000)) : null,
      memberActive: memberIds.has(String(r._id)),
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
      // 最长距离附带该纪录时长；0/未记录视为没有可信时长，不下发（前端别显示 0:00）
      ...(key === 'farthest' && Number(doc.duration) > 0 ? { durationSec: Number(doc.duration) } : {}),
      name: (info && info.nickname) || '运动用户',
      gender: (info && info.gender) || 0,
      avatarUrl: (info && info.avatarUrl) || '',
      avatarPreset: (info && info.avatarPreset) || '',
      memberActive: memberIds.has(String(doc.userId)),
    };
  });

  const adjacent = adjacentPeriodKeys(period, win, now);
  return {
    type,
    province: province || '全国',
    period,
    players: rows.length,
    top: topRows.map((r, i) => toRow(r, i + 1)),
    me: meRow ? toRow(meRow, myIdx + 1) : null,
    best,
    window: win,
    prevPeriodKey: adjacent.prevPeriodKey,
    nextPeriodKey: adjacent.nextPeriodKey,
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

/**
 * 首页榜摘要的周期选择：按 `periods` 顺序逐个取，**命中即早退**。
 * 为什么是串行而不是四个并行：多数人在周榜就有记录，串行只扫一次；四个并行会把
 * 每次首页加载都变成 4 次全表聚合。最坏（四个周期都不上榜）才走到 4 次，且仍是一个 HTTP 请求。
 */
export async function pickFirstRanked<T>(
  periods: readonly LeaderboardPeriod[],
  fetchRanks: (period: LeaderboardPeriod) => Promise<T[]>,
): Promise<{ period: LeaderboardPeriod | null; ranks: T[] }> {
  for (const period of periods) {
    const ranks = await fetchRanks(period);
    if (ranks.length > 0) return { period, ranks };
  }
  return { period: null, ranks: [] };
}

/**
 * 首页卡片副标题：全国人数之外的「我的榜名次」。
 * 周期回退（周→月→年→总）原先在端上串行打 4 次接口，现在收进一次请求；
 * 选中口径与 `/stats/leaderboard/me?period=xxx` 完全一致（复用同一 service）。
 */
export function homeLeaderboardSummary(
  userId: string,
): Promise<{ period: LeaderboardPeriod | null; ranks: MeRankRow[] }> {
  return pickFirstRanked(LEADERBOARD_PERIODS, async (period) => {
    const res = await leaderboardMe(userId, '全国', period);
    return res.ranks;
  });
}
