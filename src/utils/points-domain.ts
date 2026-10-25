import { BJ_OFFSET_MS } from './bj-time.js';

export function rewardForStreakDay(streakDay: number): number {
  return Math.min(Math.max(Math.trunc(streakDay), 1), 7);
}

export function expireAtFor(earnedAt: number): number {
  const d = new Date(earnedAt + BJ_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear() + 1, 11, 31, 23, 59, 59, 999) - BJ_OFFSET_MS;
}

/** 东八区日期串按自然日位移（deltaDays 可为负）。不依赖本地时区，纯 UTC 算天数。 */
export function shiftDateKey(dateKey: string, deltaDays: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}

export function previousDateKey(dateKey: string): string {
  return shiftDateKey(dateKey, -1);
}
