import { Types } from 'mongoose';
import { WerunDayModel } from '../models/werun-day.model.js';
import { bjDateStr } from '../utils/bj-time.js';
import { AppError } from '../utils/app-error.js';

/** 个人步数统计可选窗口（自然日，含今天） */
export const WERUN_STATS_RANGES = [7, 30, 180, 365] as const;
export type WerunStatsRange = (typeof WERUN_STATS_RANGES)[number];

const DAY_MS = 86_400_000;

/**
 * 明细分页的最大 skip（行数）。range=all 的 total 会随使用年限增长，
 * `skip((page-1)*pageSize)` 传个 page=100000 就是一次几十万行的空转——
 * 超过这个量直接 400 让调用方缩小范围，而不是让服务端替它数跳过。
 * 5000 行 ÷ 默认 20 条/页 = 250 页，远超正常翻动深度。
 */
export const WERUN_DAYS_MAX_SKIP = 5000;

export interface WerunStatsOverview {
  totalStep: number;
  /** 日均＝合计 ÷ 有同步记录的天数（不是除以窗口天数，避免没同步的日子把均值拉低） */
  avgStep: number;
  bestDate: string;
  bestStep: number;
  syncedDays: number;
  /** 窗口自然日数（7/30/180/365） */
  days: number;
}

export interface WerunTrendBucket {
  /** 桶起点（东八区 YYYY-MM-DD） */
  startDate: string;
  /** 桶终点（含，东八区 YYYY-MM-DD） */
  endDate: string;
  label: string;
  step: number;
}

export interface WerunStatsResult {
  range: WerunStatsRange;
  startDate: string;
  endDate: string;
  /** 7/30 日按日；180 按周；365 按月 */
  bucket: 'day' | 'week' | 'month';
  overview: WerunStatsOverview;
  trend: WerunTrendBucket[];
  /** compare=1 时下发：紧邻当前窗口之前的同长度窗口 */
  prevOverview?: WerunStatsOverview & { startDate: string; endDate: string };
}

export interface WerunDayRow {
  date: string;
  step: number;
  /** 周几：周日/周一/… */
  weekday: string;
}

export interface WerunDayListResult {
  /** 'all' = 全部同步记录（明细页不跟时间档走） */
  range: WerunStatsRange | 'all';
  startDate: string;
  endDate: string;
  items: WerunDayRow[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function dateMs(date: string): number {
  return Date.parse(`${date}T00:00:00+08:00`);
}

function addDays(date: string, n: number): string {
  return bjDateStr(dateMs(date) + n * DAY_MS);
}

/** 'YYYY-MM-DD' → 0=周日 … 6=周六（用 UTC 分量算，与机器时区无关） */
function weekdayIndex(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 周几文案（'周日'…）：每日明细与 CSV 导出共用同一口径 */
export function werunWeekday(date: string): string {
  return WEEKDAYS[weekdayIndex(date)];
}

function mmdd(date: string): string {
  return date.slice(5).replace('-', '/');
}

function bucketOf(range: WerunStatsRange): 'day' | 'week' | 'month' {
  if (range === 180) return 'week';
  if (range === 365) return 'month';
  return 'day';
}

/** 自然日窗口：含今天，向前 range-1 天 */
export function werunRangeWindow(range: WerunStatsRange, now = Date.now()): { startDate: string; endDate: string } {
  const endDate = bjDateStr(now);
  return { startDate: addDays(endDate, -(range - 1)), endDate };
}

async function loadRows(userId: string, startDate: string, endDate: string) {
  return WerunDayModel.find({
    userId: new Types.ObjectId(userId),
    date: { $gte: startDate, $lte: endDate },
  })
    .select({ date: 1, step: 1 })
    .sort({ date: 1 })
    .lean();
}

function buildTrend(
  startDate: string,
  endDate: string,
  stepByDate: Map<string, number>,
  bucket: 'day' | 'week' | 'month',
): WerunTrendBucket[] {
  if (bucket === 'day') {
    const out: WerunTrendBucket[] = [];
    for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
      out.push({ startDate: d, endDate: d, label: mmdd(d), step: stepByDate.get(d) ?? 0 });
    }
    return out;
  }

  const out: WerunTrendBucket[] = [];
  const index = new Map<string, WerunTrendBucket>();
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
    let key: string;
    let label: string;
    if (bucket === 'week') {
      // ISO 周（周一为首日）：窗口从周中开始时，首桶只含窗口内的那几天
      key = addDays(d, -((weekdayIndex(d) + 6) % 7));
      label = mmdd(key);
    } else {
      key = d.slice(0, 7);
      label = key.replace('-', '/');
    }
    let cur = index.get(key);
    if (!cur) {
      cur = { startDate: d, endDate: d, label, step: 0 };
      index.set(key, cur);
      out.push(cur);
    }
    cur.endDate = d;
    cur.step += stepByDate.get(d) ?? 0;
  }
  return out;
}

/** 一个窗口的概况（不足一天也算一个自然日；日均按有记录天数） */
async function overviewFor(userId: string, startDate: string, endDate: string, days: number): Promise<WerunStatsOverview> {
  const rows = await loadRows(userId, startDate, endDate);
  let totalStep = 0;
  let bestDate = '';
  let bestStep = 0;
  for (const r of rows) {
    const step = Number(r.step) || 0;
    totalStep += step;
    if (step > bestStep) {
      bestStep = step;
      bestDate = r.date;
    }
  }
  const syncedDays = rows.length;
  return {
    totalStep,
    avgStep: syncedDays > 0 ? Math.round(totalStep / syncedDays) : 0,
    bestDate,
    bestStep,
    syncedDays,
    days,
  };
}

/** 个人步数概况 + 趋势（缺失日期在趋势里补 0；明细只列有记录的天） */
export async function werunStats(
  userId: string,
  range: WerunStatsRange,
  now = Date.now(),
  compare = false,
): Promise<WerunStatsResult> {
  const { startDate, endDate } = werunRangeWindow(range, now);
  const rows = await loadRows(userId, startDate, endDate);

  let totalStep = 0;
  let bestDate = '';
  let bestStep = 0;
  const stepByDate = new Map<string, number>();
  for (const r of rows) {
    const step = Number(r.step) || 0;
    totalStep += step;
    stepByDate.set(r.date, step);
    if (step > bestStep) {
      bestStep = step;
      bestDate = r.date;
    }
  }
  const syncedDays = rows.length;
  const result: WerunStatsResult = {
    range,
    startDate,
    endDate,
    bucket: bucketOf(range),
    overview: {
      totalStep,
      avgStep: syncedDays > 0 ? Math.round(totalStep / syncedDays) : 0,
      bestDate,
      bestStep,
      syncedDays,
      days: range,
    },
    trend: buildTrend(startDate, endDate, stepByDate, bucketOf(range)),
  };
  if (compare) {
    // 前一个同长度窗口：紧邻当前窗口之前（当前窗口含今天）
    const prevEndDate = addDays(startDate, -1);
    const prevStartDate = addDays(prevEndDate, -(range - 1));
    result.prevOverview = {
      ...(await overviewFor(userId, prevStartDate, prevEndDate, range)),
      startDate: prevStartDate,
      endDate: prevEndDate,
    };
  }
  return result;
}

/** 每日明细分页：按日期倒序，只返回有同步记录的天；range='all' 不限日期 */
export async function werunDayList(
  userId: string,
  range: WerunStatsRange | 'all',
  page: number,
  pageSize: number,
  now = Date.now(),
): Promise<WerunDayListResult> {
  const skip = (page - 1) * pageSize;
  if (skip > WERUN_DAYS_MAX_SKIP) {
    throw new AppError(
      400,
      `翻页过深（第 ${page} 页，需跳过 ${skip} 行，上限 ${WERUN_DAYS_MAX_SKIP} 行）：请改用时间档或缩小范围`,
    );
  }
  const filter: Record<string, unknown> = { userId: new Types.ObjectId(userId) };
  let startDate = '';
  let endDate = '';
  if (range !== 'all') {
    const window = werunRangeWindow(range, now);
    startDate = window.startDate;
    endDate = window.endDate;
    filter.date = { $gte: startDate, $lte: endDate };
  }
  const [total, rows] = await Promise.all([
    WerunDayModel.countDocuments(filter),
    WerunDayModel.find(filter)
      .select({ date: 1, step: 1 })
      .sort({ date: -1 })
      .skip(skip)
      .limit(pageSize)
      .lean(),
  ]);
  if (range === 'all') {
    // 全量档的起止日期＝**整个数据集**的首尾，不是当前页的首尾——否则同一个请求换个
    // pageSize 返回的 startDate/endDate 就变了，调用方没法把它当「数据范围」用。
    // 两条走 {userId,date} 索引的极轻查询（只取日期、各 limit 1）。
    const [first, last] = await Promise.all([
      WerunDayModel.findOne(filter).select({ date: 1 }).sort({ date: 1 }).lean(),
      WerunDayModel.findOne(filter).select({ date: 1 }).sort({ date: -1 }).lean(),
    ]);
    startDate = first?.date ? String(first.date) : '';
    endDate = last?.date ? String(last.date) : '';
  }
  return {
    range,
    startDate,
    endDate,
    items: rows.map((r) => ({ date: r.date, step: Number(r.step) || 0, weekday: werunWeekday(r.date) })),
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  };
}
