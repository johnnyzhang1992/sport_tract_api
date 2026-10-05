/**
 * 东八区（Asia/Shanghai 无夏令时，固定 +08:00）时间边界工具。
 *
 * 线上容器跑在 UTC（Dockerfile / docker-compose 都没设 TZ），任何直接读「服务器本地时区」
 * 的写法都会差 8 小时：`new Date().toLocaleDateString('en-CA')`、`setHours(0,0,0,0)`、
 * `getFullYear()/getMonth()/getDate()` 在东八区 00:00–08:00 之间拿到的还是昨天。
 *
 * 统一做法：把时刻挪 +8h，再按 UTC 读分量 —— 得到的就是东八区的墙上时间，
 * 与服务器时区无关。统计/榜单的时间档一律走这里。
 */
export const BJ_OFFSET_MS = 8 * 3600000;
const DAY_MS = 86400000;

/** 该时刻所在东八日的 0 点（epoch ms） */
export function bjDayStart(ms: number): number {
  const b = new Date(ms + BJ_OFFSET_MS);
  return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - BJ_OFFSET_MS;
}

/** 东八区「今日」0 点 */
export function bjToday0(now: number = Date.now()): number {
  return bjDayStart(now);
}

/** 该时刻所在东八月的 1 日 0 点（传上月 0 点 − 1ms 即得上月起点） */
export function bjMonthStart(ms: number): number {
  const b = new Date(ms + BJ_OFFSET_MS);
  return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 1) - BJ_OFFSET_MS;
}

/** 该时刻所在东八年的 1 月 1 日 0 点 */
export function bjYearStart(ms: number): number {
  const b = new Date(ms + BJ_OFFSET_MS);
  return Date.UTC(b.getUTCFullYear(), 0, 1) - BJ_OFFSET_MS;
}

/** 该时刻所在东八周的周一 0 点（ISO 周） */
export function bjIsoWeekStart(ms: number): number {
  const b = new Date(ms + BJ_OFFSET_MS);
  const dow = (b.getUTCDay() + 6) % 7; // 周一 = 0
  return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() - dow) - BJ_OFFSET_MS;
}

/** 东八区日期串（YYYY-MM-DD） */
export function bjDateStr(ms: number): string {
  return new Date(ms + BJ_OFFSET_MS).toISOString().slice(0, 10);
}

/** 东八区的年/月分量（月为 1–12） */
export function bjYearMonth(ms: number): { y: number; m: number } {
  const b = new Date(ms + BJ_OFFSET_MS);
  return { y: b.getUTCFullYear(), m: b.getUTCMonth() + 1 };
}

/**
 * ISO-8601 周标签（YYYY-Www），与 MongoDB 的 %G-W%V 同口径：
 * 以「该日所在周的周四」决定所属年份与周号。
 */
export function bjIsoWeekLabel(ms: number): string {
  const day = new Date(ms + BJ_OFFSET_MS);
  const dow = (day.getUTCDay() + 6) % 7; // 周一 = 0
  const thu = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - dow + 3));
  const jan4 = new Date(Date.UTC(thu.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thu.getTime() - jan4.getTime()) / DAY_MS - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${thu.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
