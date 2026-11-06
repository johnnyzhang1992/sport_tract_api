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

  const filter: Record<string, unknown> = { userId: new Types.ObjectId(userId) };
  let startDate = '';
  let endDate = '';
  if (from != null && to != null) {
    startDate = bjDateStr(from);
    // 与 /overview 一致，to 是排他的：减 1ms 落到窗口内最后一天
    endDate = bjDateStr(to - 1);
    filter.date = { $gte: startDate, $lte: endDate };
  }

  /**
   * 聚合取数（2026-11-06 优化）：原先 find() 把该用户全部行拉进内存再循环，
   * 步数按天累积几年后就是几千行/次请求。改成三个聚合：
   *   ① 概况：$group 一次拿 total/syncedDays/首尾日期 + $top 取「步数最大那天」（并列取最早）；
   *   ② 按月：$group by substr(date,1,7)，只有有数据的月出行，零填充骨架在内存里补；
   *   ③ 不再需要「全量行」这一步，内存占用与数据量脱钩。
   * $top 需要 MongoDB ≥ 5.2（线上 8.3、dev 8.0，均满足）。
   */
  const [agg] = await WerunDayModel.aggregate<{
    totalStep: number;
    syncedDays: number;
    minDate: string;
    maxDate: string;
    bestDate: string;
    bestStep: number;
  }>([
    { $match: filter },
    {
      $group: {
        _id: null,
        totalStep: { $sum: '$step' },
        syncedDays: { $sum: 1 },
        minDate: { $min: '$date' },
        maxDate: { $max: '$date' },
        // 并列取**最早**那天（sortBy 次级键 date 升序），与旧实现「按日期升序扫描、> 才替换」一致
        bestDate: { $top: { sortBy: { step: -1, date: 1 }, output: '$date' } },
        bestStep: { $max: '$step' },
      },
    },
  ]);

  const hasWindow = !!(startDate && endDate);
  if (!hasWindow) {
    // 全部时间且一条记录都没有：没有窗口可算，直接给空态
    if (!agg) {
      const today = bjDateStr(Date.now());
      return {
        startDate: today,
        endDate: today,
        overview: { totalStep: 0, avgStep: 0, bestDate: '', bestStep: 0, syncedDays: 0, days: 0 },
        months: [],
        bestMonth: null,
      };
    }
    startDate = String(agg.minDate);
    endDate = String(agg.maxDate);
  }

  // 有窗口但窗口内没记录：仍按窗口长度给零填充月份骨架（days 是窗口天数，不是有数据的天数）
  const monthRows = agg
    ? await WerunDayModel.aggregate<{ _id: string; step: number }>([
      { $match: filter },
      { $group: { _id: { $substrBytes: ['$date', 0, 7] }, step: { $sum: '$step' } } },
    ])
    : [];

  const months = monthSkeleton(startDate, endDate);
  const byMonth = new Map(months.map((m) => [m.month, m]));
  for (const r of monthRows) {
    const bucket = byMonth.get(String(r._id));
    if (bucket) bucket.step += Number(r.step) || 0;
  }

  const totalStep = Number(agg?.totalStep) || 0;
  const bestStep = Number(agg?.bestStep) || 0;
  const bestDate = bestStep > 0 ? String(agg?.bestDate ?? '') : '';

  let bestMonth: WerunReportMonth | null = null;
  for (const m of months) {
    if (m.step > 0 && (!bestMonth || m.step > bestMonth.step)) bestMonth = m;
  }

  const syncedDays = Number(agg?.syncedDays) || 0;
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
