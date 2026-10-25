import { BJ_OFFSET_MS } from './bj-time.js';

export function rewardForStreakDay(streakDay: number): number {
  return Math.min(Math.max(Math.trunc(streakDay), 1), 7);
}

export function expireAtFor(earnedAt: number): number {
  const d = new Date(earnedAt + BJ_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear() + 1, 11, 31, 23, 59, 59, 999) - BJ_OFFSET_MS;
}

export function previousDateKey(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 86400000).toISOString().slice(0, 10);
}
