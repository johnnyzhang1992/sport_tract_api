import { Types } from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import { locateRegion } from './region.js';
import { calcFastestKm, calcPbMarks } from '../utils/pace.js';
import { calcPerfScore } from '../utils/perf-score.js';
import { calcDriftScore } from '../utils/drift-score.js';
import { streakDays } from '../utils/campaign-streak.js';
import { ACTIVITY_TYPES, MIN_PLAUSIBLE_PACE_SEC_PER_KM, DRIFT_SCORE_PB_GATE } from '../config/constants.js';
import { AppError } from '../utils/app-error.js';
import {
  bjDayStart,
  bjToday0,
  bjMonthStart,
  bjYearStart,
  bjDateStr,
  bjIsoWeekStart,
  bjIsoWeekLabel,
  bjYearMonth,
} from '../utils/bj-time.js';

type ObjectIdLike = Types.ObjectId | string;

/** 半马/全马标称距离（米） */
const HALF_MARATHON_M = 21097.5;
const FULL_MARATHON_M = 42195;
/** 配速类运动：里程成绩按「跑步配速下限」判合理性；其余类型（骑行/滑雪等）只挡物理不可能 */
const PACE_LIKE_TYPES = new Set(['running', 'walking', 'hiking', 'mountaineering']);
const MIN_ABSOLUTE_MARK_PACE_SEC_PER_KM = 20;

/** 里程成绩是否物理可信：配速类 ≥130s/km（人类极限），其余 ≥20s/km（≈300km/h，只挡脏数据） */
function plausibleMark(type: string, km: number, sec: number): boolean {
  const floor = PACE_LIKE_TYPES.has(type) ? MIN_PLAUSIBLE_PACE_SEC_PER_KM : MIN_ABSOLUTE_MARK_PACE_SEC_PER_KM;
  return sec >= km * floor;
}

/** 转 ObjectId（aggregate $match 不做类型转换） */
function toObjectId(id: ObjectIdLike): Types.ObjectId {
  return typeof id === 'string' ? new Types.ObjectId(id) : id;
}

export interface StatusCount {
  status: string;
  count: number;
}

export interface TypeStat {
  type: string;
  count: number;
  distance: number;
  duration: number;
}

interface Section {
  count: number;
  distance: number;
  duration: number;
  elevationGain: number;
  calories: number;
  byStatus: StatusCount[]; // 各状态轨迹数（finished/in_progress/cancelled）
  finishRate: number; // 完成率 %（1 位小数；无轨迹为 0）
  byType: TypeStat[]; // 各运动类型轨迹数/距离/时长（仅 finished，按轨迹数降序）
  /** 活跃天数：东八区自然日去重（仅累计段下发，避免每档都多跑一次聚合） */
  activeDays?: number;
  /** 当前连续运动天数（今天没动从昨天起算，仅累计段） */
  streakCurrent?: number;
  /** 历史最长连续运动天数（仅累计段） */
  streakLongest?: number;
}

export interface OverviewResult {
  today: Section;
  week: Section;
  month: Section;
  year: Section;
  total: Section;
  prevWeek: Section; // 上周（近 7 天窗口的前 7 天）
  prevMonth: Section; // 上月（自然月）
}

/** 概览聚合：今日 / 本周 / 本月 / 本年 / 累计 + 上周期对比（决策 F18）；时间档一律东八区自然周期 */
export async function overview(userId: ObjectIdLike): Promise<OverviewResult> {
  const finished: Record<string, any> = { userId: toObjectId(userId), status: 'finished' };
  const DAY = 86400000;
  const now = Date.now();
  const today0 = bjToday0(now);
  // 「本周」= 自然周（东八区周一 0 点起），不是「今天往前 6 天」的滚动窗口
  const weekStart = bjIsoWeekStart(now);
  const monthStart = bjMonthStart(now); // 东八区本月 1 号 0 点
  const yearStart = bjYearStart(now);
  const prevMonthStart = bjMonthStart(monthStart - 1); // 东八区上月 1 号 0 点

  const [today, week, month, year, total, prevWeek, prevMonth, activeDateRows] = await Promise.all([
    ActivityModel.aggregate([
      { $match: { ...finished, startTime: { $gte: today0 } } },
      ...sumAgg,
    ]),
    ActivityModel.aggregate([
      { $match: { ...finished, startTime: { $gte: weekStart } } },
      ...sumAgg,
    ]),
    ActivityModel.aggregate([
      { $match: { ...finished, startTime: { $gte: monthStart } } },
      ...sumAgg,
    ]),
    ActivityModel.aggregate([
      {
        $match: {
          ...finished,
          startTime: { $gte: yearStart }, // 当年
        },
      },
      ...sumAgg,
    ]),
    ActivityModel.aggregate([{ $match: finished }, ...sumAgg]),
    ActivityModel.aggregate([
      { $match: { ...finished, startTime: { $gte: weekStart - 7 * DAY, $lt: weekStart } } },
      ...sumAgg,
    ]),
    ActivityModel.aggregate([
      {
        $match: {
          ...finished,
          startTime: {
            $gte: prevMonthStart,
            $lt: monthStart,
          },
        },
      },
      ...sumAgg,
    ]),
    // 累计活跃日期：按东八区自然日去重（活跃天数 + 连续天数一次聚合算完）
    ActivityModel.aggregate([
      { $match: finished },
      {
        $group: {
          _id: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: { $toDate: '$startTime' },
              timezone: '+08:00',
            },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);
  const activeDates: string[] = activeDateRows.map((r) => String(r._id));

  // 各范围的状态/类型细分（进行中/作废不参与距离/时长口径，仅计数）
  const [exToday, exWeek, exMonth, exYear, exTotal] = await Promise.all(
    [today0, weekStart, monthStart, yearStart, null].map((since) => extras(userId, since)),
  );

  return {
    today: { ...toSection(today), ...exToday },
    week: { ...toSection(week), ...exWeek },
    month: { ...toSection(month), ...exMonth },
    year: { ...toSection(year), ...exYear },
    total: {
      ...toSection(total),
      ...exTotal,
      activeDays: activeDates.length,
      streakCurrent: streakDays(activeDates, now),
      streakLongest: longestStreak(activeDates),
    },
    prevWeek: toSection(prevWeek),
    prevMonth: toSection(prevMonth),
  };
}

/** 状态细分 + 类型细分（type 细分仅 finished 口径） */
async function extras(
  userId: ObjectIdLike,
  since: number | null,
): Promise<Pick<OverviewResult['today'], 'byStatus' | 'finishRate' | 'byType'>> {
  const match: Record<string, unknown> = { userId: toObjectId(userId) };
  if (since != null) match.startTime = { $gte: since };
  const [statusRows, typeRows] = await Promise.all([
    ActivityModel.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    ActivityModel.aggregate([
      { $match: { ...match, status: 'finished' } },
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 },
          distance: { $sum: '$distance' },
          duration: { $sum: '$duration' },
        },
      },
      { $sort: { count: -1 } },
    ]),
  ]);
  const statusMap = new Map(statusRows.map((r) => [String(r._id), Number(r.count)]));
  const finishedCount = statusMap.get('finished') ?? 0;
  const totalCount = statusRows.reduce((sum: number, r) => sum + Number(r.count), 0);
  return {
    byStatus: ['finished', 'in_progress', 'cancelled'].map((st) => ({
      status: st,
      count: statusMap.get(st) ?? 0,
    })),
    finishRate: totalCount > 0 ? Math.round((finishedCount / totalCount) * 1000) / 10 : 0,
    byType: typeRows.map((r) => ({
      type: String(r._id),
      count: Number(r.count),
      distance: Number(r.distance ?? 0),
      duration: Number(r.duration ?? 0),
    })),
  };
}

const sumAgg = [
  {
    $group: {
      _id: null,
      count: { $sum: 1 },
      distance: { $sum: '$distance' },
      duration: { $sum: '$duration' },
      elevationGain: { $sum: '$elevationGain' },
      calories: { $sum: '$calories' },
    },
  },
] as const;

function toSection(rows: Array<Record<string, any>>): OverviewResult['today'] {
  const r = rows[0];
  return {
    count: r?.count ?? 0,
    distance: r?.distance ?? 0,
    duration: r?.duration ?? 0,
    elevationGain: r?.elevationGain ?? 0,
    calories: r?.calories ?? 0,
    byStatus: [],
    finishRate: 0,
    byType: [],
  };
}

/** 历史最长连续段：dates 为升序 YYYY-MM-DD（东八区自然日），日期差 1 天即连续 */
function longestStreak(dates: string[]): number {
  const DAY = 86400000;
  let best = 0;
  let run = 0;
  let prev = NaN;
  for (const d of dates) {
    const t = Date.parse(`${d}T00:00:00Z`);
    if (!Number.isFinite(t)) continue;
    const day = Math.floor(t / DAY);
    run = day - prev === 1 ? run + 1 : 1;
    prev = day;
    if (run > best) best = run;
  }
  return best;
}

export interface TrendDay {
  date: string; // YYYY-MM-DD
  distance: number;
  duration: number;
  count: number;
  /** 消耗（统计页「消耗」趋势卡按日均，用 sum 不用均值） */
  calories: number;
  /** 静止时长：配速要按 duration - standstillMs 算，否则跨页比详情页偏慢 */
  standstillMs: number;
}

export interface TrendResult {
  type: string;
  data: TrendDay[];
}

export type TrendType = 'week' | 'month' | 'week6' | 'year' | 'daily365';

/**
 * 趋势聚合（决策 F19）—— 桶键与聚合分组都按东八区，否则东八区凌晨的记录会掉进前一天
 * - week：近 7 天按天（7 条）
 * - month：近 30 天按天（30 条）
 * - week6：近 6 个月按周（≤24 条）
 * - year：近 12 个月按月（12 条）
 * - daily365：近 365 天按天（日历热力图用）
 */
export async function trend(
  userId: ObjectIdLike,
  type: TrendType,
  activityType?: string,
): Promise<TrendResult> {
  const now = Date.now();
  const DAY = 86400000;
  // 注意：activity.startTime 是 Number 时间戳，start 必须也是数字（Date 对象会导致 $gte 类型不匹配）
  const backDays = type === 'week' ? 6 : type === 'month' ? 29 : type === 'week6' ? 180 : 364;
  const start = bjDayStart(now - backDays * DAY);

  // 聚合粒度：week/month 按天；week6 按周；year 按月
  const format =
    type === 'year' ? '%Y-%m' : type === 'week6' ? '%G-W%V' : '%Y-%m-%d';

  const rows = await ActivityModel.aggregate([
    {
      $match: {
        userId: toObjectId(userId),
        status: 'finished',
        startTime: { $gte: start },
        ...(activityType ? { type: activityType } : {}),
      },
    },
    {
      $group: {
        _id: { $dateToString: { format, date: { $toDate: '$startTime' }, timezone: '+08:00' } },
        distance: { $sum: '$distance' },
        duration: { $sum: '$duration' },
        count: { $sum: 1 },
        calories: { $sum: '$calories' },
        standstillMs: { $sum: '$standstillMs' },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const map = new Map<string, TrendDay>();
  for (const r of rows) {
    map.set(r._id, {
      date: r._id,
      distance: r.distance,
      duration: r.duration,
      count: r.count,
      calories: r.calories ?? 0,
      standstillMs: r.standstillMs ?? 0,
    });
  }

  // 补齐连续桶（桶键生成与上面的 timezone:'+08:00' 同口径）
  const data: TrendDay[] = [];
  if (type === 'year') {
    // 近 12 个月，每月一条
    for (let i = 11; i >= 0; i--) {
      const { y, m } = bjYearMonth(now - i * 30 * DAY);
      const key = `${y}-${String(m).padStart(2, '0')}`;
      data.push(map.get(key) ?? { date: key, distance: 0, duration: 0, count: 0, calories: 0, standstillMs: 0 });
    }
  } else if (type === 'week6') {
    // 近 6 个月按周（最多 26 周，取最近 24 周）
    const keys: string[] = [];
    for (let t = start; t <= now && keys.length < 26; t += 7 * DAY) {
      keys.push(bjIsoWeekLabel(t));
    }
    const recent = keys.slice(-24);
    for (const key of recent) {
      data.push(map.get(key) ?? { date: key, distance: 0, duration: 0, count: 0, calories: 0, standstillMs: 0 });
    }
  } else {
    // 近 7 / 30 天 / 365 天按天
    const days = type === 'week' ? 7 : type === 'month' ? 30 : 365;
    const today0 = bjToday0(now);
    for (let i = days - 1; i >= 0; i--) {
      const key = bjDateStr(today0 - i * DAY);
      data.push(map.get(key) ?? { date: key, distance: 0, duration: 0, count: 0, calories: 0, standstillMs: 0 });
    }
  }

  return { type, data };
}

/** 个人最佳纪录（PR）：最远距离/最快配速/最长时长/最大爬升 + 对应轨迹信息
 * 最快配速口径：轨迹内最快 1km 分段（fastestKm），非全程平均配速
 */
export async function bestRecords(userId: ObjectIdLike) {
  const base = { userId: toObjectId(userId), status: 'finished' };
  // PB 门禁（设计 docs/19 §4.2）：driftScore 超阈值不进榜；$not/$gt 惯用法缺字段 = 可信
  // （与 vehicleMs 排除集合同一逻辑）；不用进 base —— base 还被惰性补算查询共用，门禁会挡住补算
  const pbGate = { driftScore: { $not: { $gt: DRIFT_SCORE_PB_GATE } } };
  // 惰性补算：fastestKm 新字段上线前完成的历史轨迹无该字段 → 批量补算（每次本用户全量，数据量小）
  // 规划路线（无时间信息，1s 补全会造出假配速）永不补算；同循环顺手补 driftScore（老轨迹 null → 计算）
  const missing = await ActivityModel.find({ ...base, fastestKm: null, trackKind: { $ne: 'planned' } })
    .select('_id trackPoints driftScore')
    .limit(100)
    .lean();
  for (const a of missing) {
    const fk = calcFastestKm(a.trackPoints ?? [], a.type);
    const patch: Record<string, unknown> = { fastestKm: fk };
    if (a.driftScore == null) patch.driftScore = calcDriftScore(a.trackPoints ?? []);
    await ActivityModel.updateOne({ _id: a._id }, { $set: patch });
  }
  // 距离里程碑惰性补算：pbMarks 未落库的历史轨迹（补算后写 []，避免反复扫点）
  const missingMarks = await ActivityModel.find({ ...base, pbMarks: { $exists: false }, trackKind: { $ne: 'planned' } })
    .select('_id trackPoints')
    .limit(50)
    .lean();
  for (const a of missingMarks) {
    await ActivityModel.updateOne({ _id: a._id }, { $set: { pbMarks: calcPbMarks(a.trackPoints ?? []) } });
  }
  // 表现分惰性补算：只需已落库指标（距离/爬升/时长），不扫点
  const missingPerf = await ActivityModel.find({ ...base, perfScore: null, trackKind: { $ne: 'planned' } })
    .select('_id type distance elevationGain duration')
    .limit(100)
    .lean();
  for (const a of missingPerf) {
    const perf = calcPerfScore(a.type, a.distance ?? 0, a.elevationGain ?? 0, a.duration ?? 0);
    // 不适用（骑行游泳/过短）写 0 哨兵避免反复查询；展示侧 >0 才算数
    await ActivityModel.updateOne({ _id: a._id }, { $set: { perfScore: perf ? perf.score : 0 } });
  }
  const select = '_id type startTime distance avgPace fastestKm duration elevationGain perfScore';
  const fmt = (a: Record<string, any> | undefined): Record<string, any> | null =>
    a
      ? {
          id: String(a._id),
          type: a.type,
          startTime: a.startTime,
          distance: a.distance ?? 0,
          avgPace: a.avgPace ?? null,
          fastestKm: a.fastestKm ?? null, // 最快 1km 分段（秒/公里）
          duration: a.duration ?? 0,
          elevationGain: a.elevationGain ?? 0,
          perfScore: a.perfScore ?? null,
        }
      : null;
  const byTypeAgg = (sortField: string, dir: 1 | -1, extraMatch: Record<string, unknown> = {}) =>
    ActivityModel.aggregate([
      { $match: { ...base, ...pbGate, ...extraMatch } },
      { $sort: { [sortField]: dir } },
      {
        $project: {
          type: 1,
          startTime: 1,
          distance: 1,
          avgPace: 1,
          fastestKm: 1,
          duration: 1,
          elevationGain: 1,
          perfScore: 1,
        },
      },
      { $group: { _id: '$type', doc: { $first: '$$ROOT' } } },
    ]);
  const [distRows, paceRows, durRows, elevRows, perfRows, markRows, longRows] = await Promise.all([
    byTypeAgg('distance', -1),
    byTypeAgg('fastestKm', 1, { fastestKm: { $gt: MIN_PLAUSIBLE_PACE_SEC_PER_KM } }),
    byTypeAgg('duration', -1),
    byTypeAgg('elevationGain', -1),
    byTypeAgg('perfScore', -1, { perfScore: { $gt: 0 } }),
    // 距离里程碑保持者链原料：所有 (type, 轨迹, km, 用时, 开始时间)，重放在 JS 侧做
    ActivityModel.aggregate([
      { $match: { ...base, ...pbGate } },
      { $unwind: '$pbMarks' },
      { $match: { 'pbMarks.sec': { $gt: 0 } } },
      { $project: { type: 1, startTime: 1, km: '$pbMarks.km', sec: '$pbMarks.sec' } },
      { $sort: { type: 1, km: 1, startTime: 1, sec: 1 } },
    ]),
    // 半马/全马奖杯原料：距离达标的轨迹（疑似乘车段的不算）
    ActivityModel.find({
      ...base,
      ...pbGate,
      distance: { $gte: HALF_MARATHON_M },
      trackKind: { $ne: 'planned' },
      vehicleMs: { $not: { $gt: 0 } },
    })
      .select('_id type startTime distance duration')
      .lean(),
  ]);
  // 个人最佳按类型分组：各运动类型分别取最佳（不同类型绝对值/配速均不可比）
  type BestRow = { type: string; [k: string]: any };
  const mapByType = (rows: Array<{ _id: string; doc: Record<string, any> }>, sortKey: string, dir: 1 | -1): BestRow[] =>
    rows
      .map((r) => ({ type: r._id, ...fmt(r.doc) }) as BestRow)
      .sort((a, b) => ((a[sortKey] ?? 0) - (b[sortKey] ?? 0)) * dir);

  // 保持者链重放：同 (类型, 公里) 按轨迹时间升序，用时严格更短才换人（同秒并列先到先得）。
  // 「达成即留痕」——曾被刷新的前纪录保持者也留在链里（isCurrent=false + 保持天数），
  // 纠偏重算 pbMarks 后链会按新数据自动重放修正
  const DAY = 86400000;
  const now = Date.now();
  type ChainRow = {
    type: string;
    km: number;
    id: string;
    sec: number;
    startTime: number;
    isCurrent: boolean;
    heldDays: number; // 保持天数：被刷新时刻（或当前时刻）距达成时刻的整天数
  };
  const bestSoFar = new Map<string, ChainRow>();
  const chain: ChainRow[] = [];
  for (const r of markRows) {
    // 脏数据（导入的假时间戳等）会造出「5km 用时 70s」这类纪录：不参与保持者链重放
    if (!plausibleMark(r.type, r.km, r.sec)) continue;
    const key = `${r.type}:${r.km}`;
    const prev = bestSoFar.get(key);
    if (prev && r.sec >= prev.sec) continue;
    if (prev) {
      prev.isCurrent = false;
      prev.heldDays = Math.max(0, Math.floor((r.startTime - prev.startTime) / DAY));
    }
    const row: ChainRow = {
      type: r.type,
      km: r.km,
      id: String(r._id),
      sec: r.sec,
      startTime: r.startTime,
      isCurrent: true,
      heldDays: 0,
    };
    bestSoFar.set(key, row);
    chain.push(row);
  }
  for (const row of bestSoFar.values()) {
    row.heldDays = Math.max(0, Math.floor((now - row.startTime) / DAY));
  }
  chain.sort((a, b) => (a.type === b.type ? a.km - b.km : a.type < b.type ? -1 : 1));

  const maxDistanceByType = mapByType(distRows, 'distance', -1);
  const minPaceByType = mapByType(paceRows, 'fastestKm', 1); // 配速升序=最快
  const maxDurationByType = mapByType(durRows, 'duration', -1);
  const maxElevationByType = mapByType(elevRows, 'elevationGain', -1);
  const maxPerfScoreByType = mapByType(perfRows, 'perfScore', -1); // 最高表现分（按类型）

  // 里程碑奖杯（统计页奖杯墙）：1K 取全局最快 1km 分段；5K/10K 取里程碑当前纪录；
  // 半马/全马取「距离达标轨迹」中最短一条的整条用时（含途中停留，不做外推）
  type Milestone = {
    key: string;
    label: string;
    km: number;
    id: string;
    type: string;
    sec: number;
    startTime: number;
  };
  const milestones: Milestone[] = [];
  const addMilestone = (
    key: string,
    label: string,
    km: number,
    row: { id?: unknown; _id?: unknown; type?: unknown; sec?: unknown; startTime?: unknown } | undefined,
  ) => {
    if (!row) return;
    milestones.push({
      key,
      label,
      km,
      id: String(row.id ?? row._id),
      type: String(row.type),
      sec: Number(row.sec),
      startTime: Number(row.startTime),
    });
  };
  const fastest1k = minPaceByType[0];
  if (fastest1k) addMilestone('1k', '1K', 1, { ...fastest1k, sec: fastest1k.fastestKm });
  const currentAt = (km: number) =>
    chain.filter((r) => r.isCurrent && r.km === km).sort((a, b) => a.sec - b.sec)[0];
  addMilestone('5k', '5K', 5, currentAt(5));
  addMilestone('10k', '10K', 10, currentAt(10));
  const shortestOver = (minM: number) =>
    longRows
      .filter((r) => Number(r.distance ?? 0) >= minM)
      // 整条轨迹用时同样要过物理校验（距离 km × 该类型配速下限）
      .filter((r) => {
        const km = Number(r.distance ?? 0) / 1000;
        const floor = PACE_LIKE_TYPES.has(String(r.type))
          ? MIN_PLAUSIBLE_PACE_SEC_PER_KM
          : MIN_ABSOLUTE_MARK_PACE_SEC_PER_KM;
        return Number(r.duration ?? 0) >= km * floor;
      })
      .sort((a, b) => Number(a.duration ?? 0) - Number(b.duration ?? 0))[0];
  const half = shortestOver(HALF_MARATHON_M);
  if (half) addMilestone('half', '半马', 21.0975, { id: half._id, type: half.type, sec: half.duration, startTime: half.startTime });
  const full = shortestOver(FULL_MARATHON_M);
  if (full) addMilestone('full', '全马', 42.195, { id: full._id, type: full.type, sec: full.duration, startTime: full.startTime });

  return {
    maxDistanceByType,
    minPaceByType,
    maxDurationByType,
    maxElevationByType,
    maxPerfScoreByType,
    // 距离里程碑当前纪录（口径与旧版一致：每 类型+公里 全局最快一条）
    fastestDistanceByKm: chain
      .filter((r) => r.isCurrent)
      .map(({ type, km, id, sec, startTime }) => ({ type, km, id, sec, startTime })),
    // 距离里程碑保持者链（含已被刷新的前纪录，列表/详情徽章「曾保持」用）
    distancePbChain: chain,
    milestones,
  };
}

export interface DistancePercentile {
  usersTotal: number; // 有 finished 成绩的用户数
  betterThan: number; // 累计距离严格少于我的用户数
  percentile: number; // 超越全站百分比（0-100 整数）
  myDistance: number; // 我的累计距离（米）
}

/** 平台累计距离分位：一次全站聚合后与本人在 JS 侧比较 */
export async function distancePercentile(userId: ObjectIdLike): Promise<DistancePercentile> {
  const rows = await ActivityModel.aggregate<{ _id: Types.ObjectId; distance: number }>([
    { $match: { status: 'finished' } },
    { $group: { _id: '$userId', distance: { $sum: '$distance' } } },
  ]);
  const mine = rows.find((r) => String(r._id) === String(userId))?.distance ?? 0;
  const usersTotal = rows.length;
  const betterThan = rows.filter((r) => r.distance < mine).length;
  return {
    usersTotal,
    betterThan,
    percentile: usersTotal > 0 ? Math.floor((betterThan / usersTotal) * 100) : 0,
    myDistance: mine,
  };
}

export interface MilestoneItem {
  name: string;
  province?: string;
  firstAt: number; // 首次点亮/尝试时间
  countInYear?: number; // 该类型今年轨迹数（仅 newTypes）
}

export interface YearMilestonesResult {
  year: number;
  newProvinces: MilestoneItem[];
  newCities: MilestoneItem[];
  newTypes: MilestoneItem[];
}

/**
 * 年度里程碑：今年首次点亮的省份/城市、首次尝试的运动类型
 * 遍历用户 finished 轨迹（按 startTime 升序），采样点离线逆地理记录省/市首次出现时间
 */
export async function yearMilestones(
  userId: ObjectIdLike,
  year: number,
): Promise<YearMilestonesResult> {
  // 年份边界按东八区（元旦 0 点），取年中某刻换算避免月/日歧义
  const yearStart = bjYearStart(Date.UTC(year, 6, 1));
  const docs = await ActivityModel.find({ userId: toObjectId(userId), status: 'finished' })
    .select({ startTime: 1, type: 1, 'trackPoints.lat': 1, 'trackPoints.lng': 1 })
    .sort({ startTime: 1 })
    .lean();

  const provFirst = new Map<string, number>();
  const cityFirst = new Map<string, { province: string; firstAt: number }>();
  const typeFirst = new Map<string, number>();
  const typeYearCount = new Map<string, number>();

  for (const act of docs) {
    const st = Number(act.startTime ?? 0);
    const type = String(act.type ?? '');
    if (type && !typeFirst.has(type)) typeFirst.set(type, st);
    if (st >= yearStart && type) typeYearCount.set(type, (typeYearCount.get(type) ?? 0) + 1);

    const pts = (act.trackPoints ?? []) as Array<{ lat?: number; lng?: number }>;
    if (pts.length < 2) continue;
    // 采样与足迹口径一致：首、尾、25%、50%、75%
    const idxs = new Set<number>([0, pts.length - 1]);
    for (const r of [0.25, 0.5, 0.75]) idxs.add(Math.floor(pts.length * r));
    const seenProv = new Set<string>();
    const seenCity = new Set<string>();
    for (const i of idxs) {
      const p = pts[i];
      if (!p || !Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lng))) continue;
      const d = locateRegion(Number(p.lat), Number(p.lng));
      if (!d) continue;
      const prov = d.province || '未知';
      const city = d.city || prov;
      if (!seenProv.has(prov)) {
        seenProv.add(prov);
        if (!provFirst.has(prov)) provFirst.set(prov, st);
      }
      if (!seenCity.has(city)) {
        seenCity.add(city);
        if (!cityFirst.has(city)) cityFirst.set(city, { province: prov, firstAt: st });
      }
    }
  }

  const inYear = (t: number | undefined) => t != null && t >= yearStart;
  const byFirst = (a: { firstAt: number }, b: { firstAt: number }) => a.firstAt - b.firstAt;
  return {
    year,
    newProvinces: [...provFirst]
      .filter(([, t]) => inYear(t))
      .map(([name, t]) => ({ name, firstAt: t }))
      .sort(byFirst),
    newCities: [...cityFirst]
      .filter(([, v]) => inYear(v.firstAt))
      .map(([name, v]) => ({ name, province: v.province, firstAt: v.firstAt }))
      .sort(byFirst),
    newTypes: [...typeFirst]
      .filter(([name, t]) => inYear(t))
      .map(([name, t]) => ({ name, firstAt: t, countInYear: typeYearCount.get(name) ?? 0 }))
      .sort(byFirst),
  };
}

/** 按月聚合行：某运动类型单月的全量汇总 */
export interface ActivityMonthlyRow {
  year: number;
  month: number;
  /** 轨迹条数 */
  count: number;
  /** 总距离（米） */
  distance: number;
  /** 总时长（秒） */
  duration: number;
  /** 总千卡 */
  calories: number;
}

export interface ActivityMonthlyResult {
  type: string;
  /** 按月倒序 */
  months: ActivityMonthlyRow[];
}

/**
 * 当前用户某运动类型的按月全量聚合（轨迹列表月度统计用）
 * 口径：finished 轨迹；月份按 Asia/Shanghai 切分（前端分组同口径，产品面向国内）
 */
export async function activityMonthly(userId: ObjectIdLike, type: string): Promise<ActivityMonthlyResult> {
  if (!ACTIVITY_TYPES.includes(type as never)) {
    throw new AppError(400, '运动类型不合法');
  }
  const months = await ActivityModel.aggregate<ActivityMonthlyRow>(monthlyPipeline(userId, { type }));
  return { type, months };
}

/** 月度聚合共用管道：baseMatch 需含业务筛选（userId/status 在此统一补齐） */
function monthlyPipeline(userId: ObjectIdLike, baseMatch: Record<string, unknown>) {
  return [
    { $match: { ...baseMatch, userId: toObjectId(userId), status: 'finished' } },
    {
      $group: {
        _id: {
          year: { $year: { date: { $toDate: '$startTime' }, timezone: 'Asia/Shanghai' } },
          month: { $month: { date: { $toDate: '$startTime' }, timezone: 'Asia/Shanghai' } },
        },
        count: { $sum: 1 },
        distance: { $sum: '$distance' },
        duration: { $sum: '$duration' },
        calories: { $sum: '$calories' },
      },
    },
    { $sort: { '_id.year': -1, '_id.month': -1 } as Record<string, 1 | -1> },
    {
      $project: {
        _id: 0,
        year: '$_id.year',
        month: '$_id.month',
        count: 1,
        distance: 1,
        duration: 1,
        calories: 1,
      },
    },
  ];
}

/**
 * 列表接口附带：页内出现月份的全量聚合（轨迹列表月度统计，避免前端额外拉全量月份）
 * - type 必传（统计块仅在选中类型时展示）；province 可选（与列表浏览范围同口径）
 * - wanted 为 'year-month' 集合，仅返回命中的月份
 */
export async function monthlyAggForMonths(
  userId: ObjectIdLike,
  type: string,
  province: string | undefined,
  wanted: Set<string>,
): Promise<ActivityMonthlyRow[]> {
  const baseMatch: Record<string, unknown> = { type };
  if (province) baseMatch.provinces = province;
  const rows = await ActivityModel.aggregate<ActivityMonthlyRow>(monthlyPipeline(userId, baseMatch));
  return rows.filter((r) => wanted.has(`${r.year}-${r.month}`));
}
