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
  total: { count: number; distance: number; duration: number; elevationGain: number; calories: number };
}

/** 概览聚合：今日 / 本周（自然周）/ 本月 / 累计（决策 F18） */
export async function overview(userId: ObjectIdLike): Promise<OverviewResult> {
  const finished: Record<string, any> = { userId: toObjectId(userId), status: 'finished' };

  const [today, week, month, total] = await Promise.all([
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
    ActivityModel.aggregate([{ $match: finished }, ...sumAgg]),
  ]);

  return {
    today: toSection(today),
    week: toSection(week),
    month: toSection(month),
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
  days: number;
  data: TrendDay[];
}

/** 趋势聚合：近 7 / 30 天距离与时长（决策 F19） */
export async function trend(userId: ObjectIdLike, days: 7 | 30): Promise<TrendResult> {
  const { start, end } = dayRange(days - 1);

  const rows = await ActivityModel.aggregate([
    {
      $match: {
        userId: toObjectId(userId),
        status: 'finished',
        startTime: { $gte: start, $lt: end },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: { format: '%Y-%m-%d', date: { $toDate: '$startTime' } },
        },
        distance: { $sum: '$distance' },
        duration: { $sum: '$duration' },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  // 补齐无数据的日期（前端画图需要连续日期）
  const map = new Map<string, TrendDay>();
  for (const r of rows) {
    map.set(r._id, { date: r._id, distance: r.distance, duration: r.duration, count: r.count });
  }
  const data: TrendDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end - (i + 1) * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    data.push(map.get(key) ?? { date: key, distance: 0, duration: 0, count: 0 });
  }

  return { days, data };
}
