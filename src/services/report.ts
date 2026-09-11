/**
 * 运动报告「日期汇总」后端聚合（决策：报告页日期分桶从前端移到后端）
 * - 周 → 按天（周一~周日；当前周只到今天）
 * - 月 → 按自然周（周一为界，跨月不裁：首尾周包含相邻月份天数）
 * - 年 → 按月（当前年只到当前月）
 * - 全部 → 按半年（H1/H2）
 * 时间口径统一东八区（Asia/Shanghai 无夏令时，固定 +08:00），与其它统计接口一致。
 */
import { Types } from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import type { OverviewRange } from './overview.js';

const DAY = 86400000;
const BJ = 8 * 3600000;

export interface DateSummaryRow {
  key: string;
  label: string;
  count: number;
  distance: number; // 米
  duration: number; // 秒
  calories: number;
}

export interface DateSummary {
  title: string; // 粒度文案：按天/按周/按月/按半年
  label: string; // 列头文案：日期/周/月份/半年
  rows: DateSummaryRow[];
}

interface Bucket extends DateSummaryRow {}

/** 东八区某时刻所在“天”的 0 点（epoch ms） */
function bjDayStart(ms: number): number {
  return Math.floor((ms + BJ) / DAY) * DAY - BJ;
}

/** 东八区日期分量（dow：周一 = 0） */
function bjParts(ms: number): { y: number; m: number; d: number; dow: number } {
  const t = new Date(ms + BJ);
  return {
    y: t.getUTCFullYear(),
    m: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    dow: (t.getUTCDay() + 6) % 7,
  };
}

/** 东八区某年某月 1 日 0 点（m 允许溢出，如 13 = 次年 1 月） */
function bjMonthStart(y: number, m: number): number {
  return Date.UTC(y, m - 1, 1) - BJ;
}

const p2 = (n: number) => String(n).padStart(2, '0');
const dateKeyOf = (y: number, m: number, d: number) => `${y}-${p2(m)}-${p2(d)}`;
const md = (m: number, d: number) => `${p2(m)}${p2(d)}`;

/** 生成桶骨架（含补零的完整时间线）+ 聚合查询区间 */
async function buildBuckets(
  userId: string,
  range: OverviewRange,
  from: number | null,
  to: number | null,
): Promise<{ title: string; label: string; buckets: Bucket[]; rangeStart: number; rangeEnd: number }> {
  const now = Date.now();
  const today0 = bjDayStart(now);
  const buckets: Bucket[] = [];
  const add = (key: string, label: string) =>
    buckets.push({ key, label, count: 0, distance: 0, duration: 0, calories: 0 });

  if (range === 'week') {
    // 自然周；当前周只到今天（未来日期必无数据）
    const start = bjDayStart(from ?? now - 6 * DAY);
    const end = Math.min(to ?? now + DAY, today0 + DAY);
    for (let t = start; t < end; t += DAY) {
      const { y, m, d } = bjParts(t);
      add(dateKeyOf(y, m, d), `${m}/${d}`);
    }
    return { title: '按天', label: '日期', buckets, rangeStart: start, rangeEnd: end };
  }

  if (range === 'month') {
    // 月内自然周：首周从该月 1 日所在周的周一算起，末周延伸到末日的周日（跨月就跨）
    const base = bjDayStart(from ?? now - 29 * DAY);
    const firstMonday = base - bjParts(base).dow * DAY;
    const lastDay = to != null ? to - 1 : now;
    const lastMondayLimit = Math.min(bjDayStart(lastDay), today0); // 当前月不生成未来周
    for (let mon = firstMonday; mon <= lastMondayLimit; mon += 7 * DAY) {
      const s = bjParts(mon);
      const e = bjParts(mon + 6 * DAY);
      const label =
        s.y === e.y
          ? `${md(s.m, s.d)}-${md(e.m, e.d)}周`
          : `${s.y}${md(s.m, s.d)}-${e.y}${md(e.m, e.d)}周`;
      add(String(mon), label);
    }
    return { title: '按周', label: '周', buckets, rangeStart: firstMonday, rangeEnd: lastMondayLimit + 7 * DAY };
  }

  if (range === 'year') {
    const base = bjDayStart(from ?? now - 364 * DAY);
    const { y } = bjParts(base);
    const lastDay = to != null ? to - 1 : now;
    const last = bjParts(Math.min(lastDay, today0)); // 当前年只到当前月
    for (let m = 1; m <= 12; m++) {
      if (bjMonthStart(y, m) > bjMonthStart(last.y, last.m)) break;
      add(`${y}-${p2(m)}`, `${m}月`);
    }
    const rangeEnd = Math.min(bjMonthStart(y + 1, 1), today0 + DAY);
    return { title: '按月', label: '月份', buckets, rangeStart: bjMonthStart(y, 1), rangeEnd };
  }

  // all：从最早轨迹所在半年到当前半年
  const first = await ActivityModel.findOne({ userId: new Types.ObjectId(userId), status: 'finished' })
    .sort({ startTime: 1 })
    .select('startTime')
    .lean();
  if (!first) return { title: '按半年', label: '半年', buckets: [], rangeStart: now, rangeEnd: now };
  const sp = bjParts(first.startTime as number);
  const np = bjParts(now);
  const nowHalf = np.m <= 6 ? 1 : 2;
  for (let y = sp.y, h = sp.m <= 6 ? 1 : 2; y < np.y || (y === np.y && h <= nowHalf); ) {
    add(`${y}-H${h}`, `${y} ${h === 1 ? '上半年' : '下半年'}`);
    h += 1;
    if (h > 2) {
      h = 1;
      y += 1;
    }
  }
  return {
    title: '按半年',
    label: '半年',
    buckets,
    rangeStart: bjMonthStart(sp.y, sp.m <= 6 ? 1 : 7),
    rangeEnd: now + 1,
  };
}

/** 某天（东八区日期串）应归入的桶 key，与 buildBuckets 生成的 key 对齐 */
function bucketKeyForDay(range: OverviewRange, dateStr: string): string {
  if (range === 'week') return dateStr;
  if (range === 'month') {
    const [y, m, d] = dateStr.split('-').map(Number);
    const t = Date.UTC(y, m - 1, d) - BJ;
    return String(t - bjParts(t).dow * DAY);
  }
  if (range === 'year') return dateStr.slice(0, 7);
  const [y, m] = dateStr.split('-').map(Number);
  return `${y}-H${m <= 6 ? 1 : 2}`;
}

/**
 * 日期汇总聚合：按 range 粒度分桶当前用户 finished 轨迹
 * period（epoch ms）为报告页精确周期；缺省时按 range 滑动窗口兜底。
 */
export async function buildDateSummary(
  userId: string,
  range: OverviewRange,
  period?: { from: number; to: number },
): Promise<DateSummary> {
  const { title, label, buckets, rangeStart, rangeEnd } = await buildBuckets(
    userId,
    range,
    period?.from ?? null,
    period?.to ?? null,
  );
  if (buckets.length === 0) return { title, label, rows: [] };

  // 按东八区自然日聚合一次，再在内存里折叠到周/月/半年桶（避免按桶重复查库）
  const rows = await ActivityModel.aggregate<{
    _id: string;
    count: number;
    distance: number;
    duration: number;
    calories: number;
  }>([
    {
      $match: {
        userId: new Types.ObjectId(userId),
        status: 'finished',
        startTime: { $gte: rangeStart, $lt: rangeEnd },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: { $toDate: '$startTime' }, timezone: '+08:00' } },
        count: { $sum: 1 },
        distance: { $sum: '$distance' },
        duration: { $sum: '$duration' },
        calories: { $sum: '$calories' },
      },
    },
  ]);

  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const r of rows) {
    const b = byKey.get(bucketKeyForDay(range, r._id));
    if (!b) continue;
    b.count += r.count;
    b.distance += r.distance || 0;
    b.duration += r.duration || 0;
    b.calories += r.calories || 0;
  }
  return { title, label, rows: buckets };
}
