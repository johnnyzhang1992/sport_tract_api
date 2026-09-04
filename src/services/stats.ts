import { Types } from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import { locateRegion } from './region.js';
import { calcFastestKm } from '../utils/pace.js';

type ObjectIdLike = Types.ObjectId | string;

/** 转 ObjectId（aggregate $match 不做类型转换） */
function toObjectId(id: ObjectIdLike): Types.ObjectId {
  return typeof id === 'string' ? new Types.ObjectId(id) : id;
}

/** 时间边界工具 */
function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayRange(daysAgo: number): { start: number; end: number } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 0, 0, 0, 0).getTime();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0).getTime();
  return { start, end };
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

/** 概览聚合：今日 / 本周（近 7 天）/ 本月 / 累计 + 上周期对比（决策 F18） */
export async function overview(userId: ObjectIdLike): Promise<OverviewResult> {
  const finished: Record<string, any> = { userId: toObjectId(userId), status: 'finished' };
  const DAY = 86400000;
  const weekStart = dayRange(6).start; // 本周窗口起点（今天往前 6 天的 0 点）
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

  const [today, week, month, year, total, prevWeek, prevMonth] = await Promise.all([
    ActivityModel.aggregate([
      { $match: { ...finished, startTime: { $gte: dayStart(Date.now()) } } },
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
          startTime: { $gte: new Date(new Date().getFullYear(), 0, 1).getTime() }, // 当年
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
            $gte: new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).getTime(),
            $lt: monthStart,
          },
        },
      },
      ...sumAgg,
    ]),
  ]);

  // 各范围的状态/类型细分（进行中/作废不参与距离/时长口径，仅计数）
  const [exToday, exWeek, exMonth, exYear, exTotal] = await Promise.all(
    [dayStart(Date.now()), weekStart, monthStart, new Date(new Date().getFullYear(), 0, 1).getTime(), null].map(
      (since) => extras(userId, since),
    ),
  );

  return {
    today: { ...toSection(today), ...exToday },
    week: { ...toSection(week), ...exWeek },
    month: { ...toSection(month), ...exMonth },
    year: { ...toSection(year), ...exYear },
    total: { ...toSection(total), ...exTotal },
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

export interface TrendDay {
  date: string; // YYYY-MM-DD
  distance: number;
  duration: number;
  count: number;
}

export interface TrendResult {
  type: string;
  data: TrendDay[];
}

export type TrendType = 'week' | 'month' | 'week6' | 'year' | 'daily365';

/** ISO 年-周 格式（近 6 个月按周聚合） */
function isoWeekKey(d: Date): string {
  // 复制避免修改原日期
  const date = new Date(d.getTime());
  const day = (date.getDay() + 6) % 7; // 周一 = 0
  date.setDate(date.getDate() - day + 3); // 移到周四
  const firstThursday = new Date(date.getFullYear(), 0, 4);
  const firstDay = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDay + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${date.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * 趋势聚合（决策 F19）
 * - week：近 7 天按天（7 条）
 * - month：近 30 天按天（30 条）
 * - week6：近 6 个月按周（≤24 条）
 * - year：近 12 个月按月（12 条）
 * - daily365：近 365 天按天（日历热力图用）
 */
export async function trend(userId: ObjectIdLike, type: TrendType): Promise<TrendResult> {
  const now = Date.now();
  const DAY = 86400000;
  // 注意：activity.startTime 是 Number 时间戳，start 必须也是数字（Date 对象会导致 $gte 类型不匹配）
  const startRaw = new Date(
    type === 'week' ? now - 6 * DAY
    : type === 'month' ? now - 29 * DAY
    : type === 'week6' ? now - 180 * DAY
    : now - 364 * DAY,
  );
  startRaw.setHours(0, 0, 0, 0);
  const start = startRaw.getTime();

  // 聚合粒度：week/month 按天；week6 按周；year 按月
  const format =
    type === 'year' ? '%Y-%m' : type === 'week6' ? '%G-W%V' : '%Y-%m-%d';

  const rows = await ActivityModel.aggregate([
    {
      $match: {
        userId: toObjectId(userId),
        status: 'finished',
        startTime: { $gte: start },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format, date: { $toDate: '$startTime' } } },
        distance: { $sum: '$distance' },
        duration: { $sum: '$duration' },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const map = new Map<string, TrendDay>();
  for (const r of rows) {
    map.set(r._id, { date: r._id, distance: r.distance, duration: r.duration, count: r.count });
  }

  // 补齐连续桶
  const data: TrendDay[] = [];
  if (type === 'year') {
    // 近 12 个月，每月一条
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now - i * 30 * DAY);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      data.push(map.get(key) ?? { date: key, distance: 0, duration: 0, count: 0 });
    }
  } else if (type === 'week6') {
    // 近 6 个月按周（最多 26 周，取最近 24 周）
    const keys: string[] = [];
    const cursor = new Date(start);
    while (cursor.getTime() <= now && keys.length < 26) {
      keys.push(isoWeekKey(cursor));
      cursor.setDate(cursor.getDate() + 7);
    }
    const recent = keys.slice(-24);
    for (const key of recent) {
      data.push(map.get(key) ?? { date: key, distance: 0, duration: 0, count: 0 });
    }
  } else {
    // 近 7 / 30 天 / 365 天按天
    const days = type === 'week' ? 7 : type === 'month' ? 30 : 365;
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * DAY);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      data.push(map.get(key) ?? { date: key, distance: 0, duration: 0, count: 0 });
    }
  }

  return { type, data };
}

/** 个人最佳纪录（PR）：最远距离/最快配速/最长时长/最大爬升 + 对应轨迹信息
 * 最快配速口径：轨迹内最快 1km 分段（fastestKm），非全程平均配速
 */
export async function bestRecords(userId: ObjectIdLike) {
  const base = { userId: toObjectId(userId), status: 'finished' };
  // 惰性补算：fastestKm 新字段上线前完成的历史轨迹无该字段 → 批量补算（每次本用户全量，数据量小）
  const missing = await ActivityModel.find({ ...base, fastestKm: null })
    .select('_id trackPoints')
    .limit(100)
    .lean();
  for (const a of missing) {
    const fk = calcFastestKm(a.trackPoints ?? [], a.type);
    await ActivityModel.updateOne({ _id: a._id }, { $set: { fastestKm: fk } });
  }
  const select = '_id type startTime distance avgPace fastestKm duration elevationGain';
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
        }
      : null;
  const byTypeAgg = (sortField: string, dir: 1 | -1, extraMatch: Record<string, unknown> = {}) =>
    ActivityModel.aggregate([
      { $match: { ...base, ...extraMatch } },
      { $sort: { [sortField]: dir } },
      { $project: { type: 1, startTime: 1, distance: 1, avgPace: 1, fastestKm: 1, duration: 1, elevationGain: 1 } },
      { $group: { _id: '$type', doc: { $first: '$$ROOT' } } },
    ]);
  const [distRows, paceRows, durRows, elevRows] = await Promise.all([
    byTypeAgg('distance', -1),
    byTypeAgg('fastestKm', 1, { fastestKm: { $gt: 0 } }),
    byTypeAgg('duration', -1),
    byTypeAgg('elevationGain', -1),
  ]);
  // 个人最佳按类型分组：各运动类型分别取最佳（不同类型绝对值/配速均不可比）
  type BestRow = { type: string; [k: string]: any };
  const mapByType = (rows: Array<{ _id: string; doc: Record<string, any> }>, sortKey: string, dir: 1 | -1): BestRow[] =>
    rows
      .map((r) => ({ type: r._id, ...fmt(r.doc) }) as BestRow)
      .sort((a, b) => ((a[sortKey] ?? 0) - (b[sortKey] ?? 0)) * dir);
  return {
    maxDistanceByType: mapByType(distRows, 'distance', -1),
    minPaceByType: mapByType(paceRows, 'fastestKm', 1), // 配速升序=最快
    maxDurationByType: mapByType(durRows, 'duration', -1),
    maxElevationByType: mapByType(elevRows, 'elevationGain', -1),
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
  const yearStart = new Date(year, 0, 1).getTime();
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
