import { Types } from 'mongoose';
import { WerunDayModel } from '../models/werun-day.model.js';
import { bjDateStr } from '../utils/bj-time.js';
import { AppError } from '../utils/app-error.js';

/**
 * 报告页步数聚合（运动报告 / 年度报告 / 统计页最佳记录共用）：
 * - from/to 与 /overview 同口径：[from, to) 的 epoch ms；不传 = 全部时间；
 * - 日期一律东八区自然日；日均按有同步记录的天数；
 * - months 按月零填充（年报告固定 1–12 月），bestMonth 取月合计最大（并列取最早）。
 */
const DAY_MS = 86_400_000;

export interface WerunReportOverview {
  totalStep: number;
  avgStep: number;
  bestDate: string;
  bestStep: number;
  syncedDays: number;
  days: number;
}

export interface WerunReportMonth {
  /** 东八区月份 'YYYY-MM' */
  month: string;
  step: number;
}

export interface WerunReport {
  startDate: string;
  endDate: string;
  overview: WerunReportOverview;
  months: WerunReportMonth[];
  /** 月合计最大的月份；没有任何步数时为 null */
  bestMonth: WerunReportMonth | null;
}

function dateMs(date: string): number {
  return Date.parse(`${date}T00:00:00+08:00`);
}

function monthKey(date: string): string {
  return date.slice(0, 7);
}

function nextMonthKey(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** 从起始月到结束月的完整月份骨架（含首尾） */
function monthSkeleton(startDate: string, endDate: string): WerunReportMonth[] {
  const out: WerunReportMonth[] = [];
  const last = monthKey(endDate);
  for (let key = monthKey(startDate); key <= last; key = nextMonthKey(key)) {
    out.push({ month: key, step: 0 });
  }
  return out;
}

export async function werunReport(
  userId: string,
  from?: number,
  to?: number,
): Promise<WerunReport> {
  if (!Types.ObjectId.isValid(userId)) throw new AppError(400, '无效的用户 ID');
  if (from != null && !Number.isFinite(from)) throw new AppError(400, '时间范围无效');
  if (to != null && !Number.isFinite(to)) throw new AppError(400, '时间范围无效');
  if ((from == null) !== (to == null)) throw new AppError(400, '时间范围无效');
  if (from != null && to != null && to <= from) throw new AppError(400, '时间范围无效');

  let startDate = from != null ? bjDateStr(from) : '';
  // 与 /overview 一致，to 是排他的：减 1ms 落到窗口内最后一天
  let endDate = to != null ? bjDateStr(to - 1) : '';
  const filter: Record<string, unknown> = { userId: new Types.ObjectId(userId) };
  if (startDate && endDate) filter.date = { $gte: startDate, $lte: endDate };

  const rows = await WerunDayModel.find(filter)
    .select({ date: 1, step: 1 })
    .sort({ date: 1 })
    .lean();

  // 全部时间：窗口取数据首尾；无记录直接返回空态
  if (!startDate || !endDate) {
    if (!rows.length) {
      return {
        startDate: bjDateStr(Date.now()),
        endDate: bjDateStr(Date.now()),
        overview: { totalStep: 0, avgStep: 0, bestDate: '', bestStep: 0, syncedDays: 0, days: 0 },
        months: [],
        bestMonth: null,
      };
    }
    startDate = rows[0].date;
    endDate = rows[rows.length - 1].date;
  }

  const months = monthSkeleton(startDate, endDate);
  const byMonth = new Map(months.map((m) => [m.month, m]));
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
    const bucket = byMonth.get(monthKey(r.date));
    if (bucket) bucket.step += step;
  }

  let bestMonth: WerunReportMonth | null = null;
  for (const m of months) {
    if (m.step > 0 && (!bestMonth || m.step > bestMonth.step)) bestMonth = m;
  }

  const syncedDays = rows.length;
  return {
    startDate,
    endDate,
    overview: {
      totalStep,
      avgStep: syncedDays > 0 ? Math.round(totalStep / syncedDays) : 0,
      bestDate,
      bestStep,
      syncedDays,
      days: Math.round((dateMs(endDate) - dateMs(startDate)) / DAY_MS) + 1,
    },
    months,
    bestMonth,
  };
}
