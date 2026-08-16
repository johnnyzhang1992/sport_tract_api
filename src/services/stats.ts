import { Types } from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';

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

export interface OverviewResult {
  today: { count: number; distance: number; duration: number; elevationGain: number; calories: number };
  week: { count: number; distance: number; duration: number; elevationGain: number; calories: number };
  month: { count: number; distance: number; duration: number; elevationGain: number; calories: number };
  year: { count: number; distance: number; duration: number; elevationGain: number; calories: number };
  total: { count: number; distance: number; duration: number; elevationGain: number; calories: number };
}

/** 概览聚合：今日 / 本周（自然周）/ 本月 / 累计（决策 F18） */
export async function overview(userId: ObjectIdLike): Promise<OverviewResult> {
  const finished: Record<string, any> = { userId: toObjectId(userId), status: 'finished' };

  const [today, week, month, year, total] = await Promise.all([
    ActivityModel.aggregate([
      { $match: { ...finished, startTime: { $gte: dayStart(Date.now()) } } },
      ...sumAgg,
    ]),
    ActivityModel.aggregate([
      { $match: { ...finished, startTime: { $gte: dayRange(6).start } } },
      ...sumAgg,
    ]),
    ActivityModel.aggregate([
      {
        $match: {
          ...finished,
          startTime: {
            $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime(),
          },
        },
      },
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
  ]);

  return {
    today: toSection(today),
    week: toSection(week),
    month: toSection(month),
    year: toSection(year),
    total: toSection(total),
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

/** 个人最佳纪录（PR）：最远距离/最快配速/最长时长/最大爬升 + 对应轨迹信息 */
export async function bestRecords(userId: ObjectIdLike) {
  const base = { userId: toObjectId(userId), status: 'finished' };
  const select = '_id type startTime distance avgPace duration elevationGain';
  const [maxDist, minPace, maxDur, maxElev] = await Promise.all([
    ActivityModel.find(base).sort({ distance: -1 }).limit(1).select(select).lean(),
    ActivityModel.find({ ...base, avgPace: { $gt: 0 } }).sort({ avgPace: 1 }).limit(1).select(select).lean(),
    ActivityModel.find(base).sort({ duration: -1 }).limit(1).select(select).lean(),
    ActivityModel.find(base).sort({ elevationGain: -1 }).limit(1).select(select).lean(),
  ]);
  const fmt = (a: Record<string, any> | undefined) =>
    a
      ? {
          id: String(a._id),
          type: a.type,
          startTime: a.startTime,
          distance: a.distance ?? 0,
          avgPace: a.avgPace ?? null,
          duration: a.duration ?? 0,
          elevationGain: a.elevationGain ?? 0,
        }
      : null;
  return {
    maxDistance: fmt(maxDist[0]),
    minPace: fmt(minPace[0]), // avgPace 秒/公里
    maxDuration: fmt(maxDur[0]),
    maxElevation: fmt(maxElev[0]),
  };
}
