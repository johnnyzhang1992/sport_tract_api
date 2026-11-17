/**
 * 徽章解锁日期计算（2026-11-16 配置化）：**唯一实现**。
 *
 * 为什么单独一个文件：同一个「哪天解锁」口径原来在 exercise-plan.ts（computeTrophyEarns）
 * 和 trophy-rank.ts（unlockDatesOf）各写了一遍，加徽章时必须两处同步，漏一处就会出现
 * 「徽章显示已解锁但没有名次」的矛盾卡面。现在两边都调这里。
 *
 * 口径约定（docs/21）：
 *   - 日期一律是东八区自然日 'YYYY-MM-DD'
 *   - 同一座徽章多次满足时取**最早**那天（顺带保证名次稳定可复算）
 *   - 完美周只认 daily 快照（周计划已下线，存量 weekly 快照不参与）
 */
import { bjDateStr } from '../utils/bj-time.js';
import {
  BADGE_DEFS,
  MILESTONES,
  RATIO_TIERS,
  type BadgeMetric,
} from '../config/badge-config.js';

const DAY_MS = 86_400_000;

export interface BadgeDailyRow {
  /** 东八区自然日 YYYY-MM-DD */
  date: string;
  distanceM: number;
  durationSec: number;
  count: number;
}

export interface BadgeRangeRow {
  /** 周期类型：daily=每天、weekly=每周 */
  period: string;
  /** daily 快照的周期键（该日 YYYY-MM-DD） */
  periodKey: string;
  /** 窗口结束时刻（= 本期最后一天 24:00 的 epoch ms） */
  windowEnd: number;
  allAchieved: boolean;
  targets: { distanceM: number; durationMin: number; count: number };
  progress: { distanceM: number; durationSec: number; count: number };
}

export interface BadgeEarnInput {
  /** 全部已完成运动按东八区自然日汇总，日期升序 */
  days: BadgeDailyRow[];
  /**
   * 分运动类型的每日汇总（分类型徽章用）：type → 按日期升序的行。
   *
   * ⚠️ **必填**（2026-11-17 从可选改必填）：分运动类型徽章有 80 座，解锁日期只能从这里算。
   * 之前是可选字段，名次那边漏传过一次 → 80 座徽章「已解锁但没有第 N 位」，编译期毫无提示。
   * 现在漏传会直接编译失败；确实没有类型数据时传 `{}`。
   */
  typeDays: Record<string, BadgeDailyRow[]>;
  /** daily 周期快照 */
  dailyRows: BadgeRangeRow[];
  /** 全部周期快照（原 8 倍数里程碑用） */
  periodRows: BadgeRangeRow[];
}

/** 某座徽章的获得记录：次数 + 首次获取日期 */
export interface BadgeEarn {
  earnedCount: number;
  earnDate: string;
}

/** 相邻两个自然日相差天数 */
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00+08:00`) - Date.parse(`${a}T00:00:00+08:00`)) / DAY_MS);
}

/** 自然周键（东八区周一）：'YYYY-MM-DD'；非法日期返回空串 */
function weekKeyOfDate(dateStr: string): string {
  const ms = Date.parse(`${dateStr}T00:00:00+08:00`);
  if (!Number.isFinite(ms)) return '';
  const dow = new Date(ms + 8 * 3600_000).getUTCDay(); // 0=周日（北京日历口径）
  const monday = ms - ((dow + 6) % 7) * DAY_MS;
  return new Date(monday + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 周期三项最弱一项的完成倍数（目标为 0 的项不参与） */
export function minRatioOf(
  progress: { distanceM: number; durationSec: number; count: number },
  targets: { distanceM: number; durationMin: number; count: number },
): number {
  const ratios: number[] = [];
  if (targets.distanceM > 0) ratios.push(progress.distanceM / targets.distanceM);
  if (targets.durationMin > 0) ratios.push(progress.durationSec / (targets.durationMin * 60));
  if (targets.count > 0) ratios.push(progress.count / targets.count);
  return ratios.length ? Math.min(...ratios) : 0;
}

/** 倍数 → 档位（只归最高档，不向低档重复计数） */
export function tierOf(ratio: number): number {
  let tier = 0;
  for (const t of RATIO_TIERS) if (ratio >= t) tier = t;
  return tier;
}

/** 完美周计数（含首次获取日期） */
export interface PerfectWeekStats {
  all: number;
  distance: number;
  duration: number;
  count: number;
  firstAllEnd: string;
  firstDistanceEnd: string;
  firstDurationEnd: string;
  firstCountEnd: string;
}

/** 完美周统计：只认 daily 快照，一个自然周七天齐全才算 */
export function perfectWeekCounts(dailyRows: BadgeRangeRow[]): PerfectWeekStats {
  interface WeekAcc {
    days: number;
    all: number;
    distance: number;
    duration: number;
    count: number;
  }
  const weeks = new Map<string, WeekAcc>();
  for (const r of dailyRows) {
    if (r.period === 'weekly') continue; // 周计划已下线，存量 weekly 快照不冒充完美周
    const wk = weekKeyOfDate(r.periodKey);
    if (!wk) continue;
    const acc = weeks.get(wk) ?? { days: 0, all: 0, distance: 0, duration: 0, count: 0 };
    acc.days += 1;
    if (r.allAchieved) acc.all += 1;
    if (r.targets.distanceM > 0 && r.progress.distanceM >= r.targets.distanceM) acc.distance += 1;
    if (r.targets.durationMin > 0 && r.progress.durationSec >= r.targets.durationMin * 60) acc.duration += 1;
    if (r.targets.count > 0 && r.progress.count >= r.targets.count) acc.count += 1;
    weeks.set(wk, acc);
  }
  let all = 0;
  let distance = 0;
  let duration = 0;
  let count = 0;
  let firstAllEnd = '';
  let firstDistanceEnd = '';
  let firstDurationEnd = '';
  let firstCountEnd = '';
  for (const [wk, acc] of weeks.entries()) {
    if (acc.days !== 7) continue; // 快照不足七天（计划周内建立/取消）不算完美周
    const end = bjDateStr(Date.parse(`${wk}T00:00:00+08:00`) + 6 * DAY_MS); // 周日
    if (acc.all === 7) {
      all += 1;
      if (!firstAllEnd || end < firstAllEnd) firstAllEnd = end;
    }
    if (acc.distance === 7) {
      distance += 1;
      if (!firstDistanceEnd || end < firstDistanceEnd) firstDistanceEnd = end;
    }
    if (acc.duration === 7) {
      duration += 1;
      if (!firstDurationEnd || end < firstDurationEnd) firstDurationEnd = end;
    }
    if (acc.count === 7) {
      count += 1;
      if (!firstCountEnd || end < firstCountEnd) firstCountEnd = end;
    }
  }
  return { all, distance, duration, count, firstAllEnd, firstDistanceEnd, firstDurationEnd, firstCountEnd };
}

/** 破纪录次数 + 每次破纪录的日期（逐日扫描新高） */
/**
 * 每座徽章的获得记录（获得次数 + 首次获取日期）。**唯一实现**，供：
 *   - getPlanSummary：卡面三态（获得一次=日期 / 多次=次数 / 未获得=进度条）
 *   - trophy-rank：全站「第 N 位迹路者」排名
 *
 * 各 unlockKind 的口径：
 *   streak     连续天数第一次达到 N 的那一天
 *   rings      第 N 个三项全达成日快照的日期
 *   cumulative 累计量第一次跨过阈值的那天
 *   perfectWeek 首个合格自然周的最后一天（可重复获得 → earnedCount = 合格周数）
 *   milestone  计数跨过门槛那个周期的最后一天
 */
export function computeBadgeEarns(input: BadgeEarnInput): Record<string, BadgeEarn> {
  const earns: Record<string, BadgeEarn> = {};
  const mark = (key: string, date: string) => {
    if (!date) return;
    const prev = earns[key];
    if (!prev || date < prev.earnDate) earns[key] = { earnedCount: prev ? prev.earnedCount : 1, earnDate: date };
  };
  /** 可重复获得的系列：次数 = 满足次数，日期 = 最早那次 */
  const markRepeatable = (key: string, count: number, date: string) => {
    if (count <= 0) return;
    earns[key] = { earnedCount: count, earnDate: date || '' };
  };

  const days = [...input.days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const dailyRows = input.dailyRows
    .filter((r) => r.periodKey)
    .sort((a, b) => a.windowEnd - b.windowEnd);

  // ── 预计算各指标的时间序列 ──

  const streakDates: Record<number, string> = {};
  {
    let run = 0;
    let prev = '';
    for (const d of days) {
      run = prev && dayDiff(prev, d.date) === 1 ? run + 1 : 1;
      if (!streakDates[run]) streakDates[run] = d.date;
      prev = d.date;
    }
  }

  const ringDates: Record<number, string> = {};
  {
    let rings = 0;
    for (const r of dailyRows) {
      if (r.period === 'weekly') continue;
      if (!r.allAchieved) continue;
      rings += 1;
      if (!ringDates[rings]) ringDates[rings] = r.periodKey;
    }
  }

  const kmDates: Record<number, string> = {};
  const hourDates: Record<number, string> = {};
  {
    let cumDist = 0;
    let cumDur = 0;
    for (const d of days) {
      const prevDist = cumDist;
      const prevDur = cumDur;
      cumDist += d.distanceM;
      cumDur += d.durationSec;
      // 跨过阈值：前一日不足、今日达到（记录所有跨过的整数公里/小时）
      for (let km = Math.floor(prevDist / 1000) + 1; km <= Math.floor(cumDist / 1000); km += 1) {
        if (!kmDates[km]) kmDates[km] = d.date;
      }
      for (let h = Math.floor(prevDur / 3600) + 1; h <= Math.floor(cumDur / 3600); h += 1) {
        if (!hourDates[h]) hourDates[h] = d.date;
      }
    }
  }

  const perfect = perfectWeekCounts(dailyRows);

  /** 某运动类型某指标的累计阈值达成日期（km / 小时 / 次数三种口径） */
  const typeThresholdDates = (type: string, metric: BadgeMetric): Record<number, string> => {
    const rows = (input.typeDays && input.typeDays[type]) || [];
    const out: Record<number, string> = {};
    let cumDist = 0;
    let cumDur = 0;
    let cumCount = 0;
    for (const d of rows) {
      const prevDist = cumDist;
      const prevDur = cumDur;
      const prevCount = cumCount;
      cumDist += d.distanceM;
      cumDur += d.durationSec;
      cumCount += Math.max(0, Math.floor(d.count));
      if (metric === 'typeDistanceKm') {
        for (let km = Math.floor(prevDist / 1000) + 1; km <= Math.floor(cumDist / 1000); km += 1) {
          if (!out[km]) out[km] = d.date;
        }
      } else if (metric === 'typeDurationHour') {
        for (let h = Math.floor(prevDur / 3600) + 1; h <= Math.floor(cumDur / 3600); h += 1) {
          if (!out[h]) out[h] = d.date;
        }
      } else if (metric === 'typeCount') {
        for (let n = prevCount + 1; n <= cumCount; n += 1) {
          if (!out[n]) out[n] = d.date;
        }
      }
    }
    return out;
  };
  /** 分类型阈值日期缓存（同类型同指标只算一次） */
  const typeCache = new Map<string, Record<number, string>>();
  const typeDates = (type: string, metric: BadgeMetric) => {
    const ck = `${type}:${metric}`;
    let v = typeCache.get(ck);
    if (!v) {
      v = typeThresholdDates(type, metric);
      typeCache.set(ck, v);
    }
    return v;
  };

  // ── 普通系列：由配置驱动，按 unlockKind 取日期 ──
  for (const def of BADGE_DEFS) {
    const t = def.tier;
    let date = '';
    switch (def.earnKind) {
      case 'streak':
        date = streakDates[t] || '';
        break;
      case 'rings':
        date = ringDates[t] || '';
        break;
      case 'cumulative':
        date = (def.metric === 'totalDistanceKm' ? kmDates[t] : hourDates[t]) || '';
        break;
      case 'typeCumulative': {
        const type = def.activityType;
        if (!type) break;
        const table = typeDates(type, def.metric);
        date = table[t] || '';
        break;
      }
      case 'perfectWeek': {
        const map: Record<BadgeMetric, { n: number; first: string }> = {
          perfectWeekAll: { n: perfect.all, first: perfect.firstAllEnd },
          perfectWeekDistance: { n: perfect.distance, first: perfect.firstDistanceEnd },
          perfectWeekDuration: { n: perfect.duration, first: perfect.firstDurationEnd },
          perfectWeekCount: { n: perfect.count, first: perfect.firstCountEnd },
          streakBest: { n: 0, first: '' },
          ringsClosed: { n: 0, first: '' },
          totalDistanceKm: { n: 0, first: '' },
          totalDurationHour: { n: 0, first: '' },
          achieved: { n: 0, first: '' },
          typeDistanceKm: { n: 0, first: '' },
          typeDurationHour: { n: 0, first: '' },
          typeCount: { n: 0, first: '' },
        };
        const v = map[def.metric];
        markRepeatable(def.key, v.n, v.first);
        continue; // 次数与日期都已写好，跳过下方统一赋值
      }
      case 'milestone':
        break; // 由 MILESTONES 单独处理
    }
    if (date) mark(def.key, date);
  }

  // ── 原 8 倍数里程碑：计数跨过 need 的那个周期的最后一天 ──
  const periodRows = [...input.periodRows].sort((a, b) => a.windowEnd - b.windowEnd);
  let achieved = 0;
  const ratioCount: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of periodRows) {
    const tier = tierOf(minRatioOf(r.progress, r.targets));
    if (tier > 0) ratioCount[tier] += 1;
    if (r.allAchieved) achieved += 1;
    const end = bjDateStr(r.windowEnd - 1); // windowEnd 是「下一期 0 点」，减 1ms 取本期最后一天
    for (const def of MILESTONES) {
      if (earns[def.key]) continue;
      // 计数口径必须与里程碑 cur 完全一致（累计：500% 的期也算完成了 200%），
      // 否则会出现「徽章已解锁但没有获得日期」的自相矛盾卡面
      const counter = def.ratio >= 2
        ? RATIO_TIERS.filter((x) => x >= def.ratio).reduce((acc, x) => acc + (ratioCount[x] || 0), 0)
        : achieved;
      if (counter >= def.times) mark(def.key, end);
    }
  }

  return earns;
}

/** 徽章解锁日期表（key → 首次解锁日）：排名用 */
export function unlockDatesOf(input: BadgeEarnInput): Record<string, string> {
  const earns = computeBadgeEarns(input);
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(earns)) {
    if (v.earnDate) out[key] = v.earnDate;
  }
  return out;
}
