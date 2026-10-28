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

/** 两个 dateKey 相差的自然天数（b - a，可为负）。dateKey 是东八区日期串，按 UTC 零点算即可。 */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

const DAY_MS = 86400000;

export interface ExpiringNotice { points: number; daysLeft: number }

/**
 * 过期提示（积分页「N 积分将在 M 天后过期」）：只看最早到期那一批，同到期日合并求和。
 * 阈值判定留在这里而不是端上——端上只按有值/无值渲染，改阈值不用发版。
 * 天数按整天向下取整：剩 0.4 天就是「0 天后过期」，读起来正是"今天到期"。
 */
export function expiringNotice(
  lots: { remaining: number; expireAt: number }[], now: number, thresholdDays: number,
): ExpiringNotice | null {
  const alive = lots.filter((l) => l.remaining > 0 && l.expireAt > now);
  if (!alive.length) return null;
  const earliest = Math.min(...alive.map((l) => l.expireAt));
  const points = alive.filter((l) => l.expireAt === earliest).reduce((s, l) => s + l.remaining, 0);
  const daysLeft = Math.max(0, Math.floor((earliest - now) / DAY_MS));
  return daysLeft <= thresholdDays ? { points, daysLeft } : null;
}

/**
 * 当前连签天数在全库注册用户里的百分位（「超过 X% 用户」）。
 * 活跃链之外的人有效连签天然是 0：所以 mine=0 时没人被超过，返回 0 而不是「所有零天的人」。
 * 并列不算被超过。脏行（活跃链比注册数还多，例如签到行对应的用户已删）钳到 0，不出负数。
 */
export function streakPercentile(opts: {
  totalUsers: number; activeStreaks: number[]; mine: number;
}): number {
  const { totalUsers, activeStreaks, mine } = opts;
  if (totalUsers <= 0 || mine <= 0) return 0;
  const below = (totalUsers - activeStreaks.length) + activeStreaks.filter((s) => s < mine).length;
  const clamped = Math.min(Math.max(below, 0), totalUsers);
  return Math.floor((clamped * 100) / totalUsers);
}
