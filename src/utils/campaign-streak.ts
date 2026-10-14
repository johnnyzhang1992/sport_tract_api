import { bjDateStr } from './bj-time.js';

const DAY_MS = 86400000;

/**
 * 连续运动天数（决策 §2-5）：给定「有运动的日期集合」（YYYY-MM-DD，东八区自然日），
 * 从今天往前逐日数连续段；今天还没动不算断，从昨天起算。
 * 东八区无夏令时，直接减 24h 再取日期是安全的。
 */
export function streakDays(activeDates: Iterable<string>, now = Date.now()): number {
  const set = new Set(activeDates);
  let cursor = set.has(bjDateStr(now)) ? now : now - DAY_MS;
  let streak = 0;
  while (set.has(bjDateStr(cursor))) {
    streak += 1;
    cursor -= DAY_MS;
  }
  return streak;
}
