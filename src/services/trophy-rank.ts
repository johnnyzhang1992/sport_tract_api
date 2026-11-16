/**
 * 里程碑徽章「第 N 位迹路者」排名（2026-11-16）：
 * 某座徽章全站第几个**人**解锁——按「首次解锁日」升序，同一天解锁的人**并列同名次**
 * （国际名次口径：两人都是第 3 位，下一位是第 5 位，不存在第 4 位）。
 *
 * 为什么按日期而不是绝对时刻：徽章解锁时刻本身就是「天」粒度的——距离/时长纪录、连续天数、
 * 合环、完美周都落在某个自然日，累计里程/时长/次数也只能落到快照的日粒度。
 * 同一批人共用一个日期，天然并列，名次也稳定可复算（重算不会因为查询顺序抖动）。
 *
 * 口径必须与 `getPlanSummary` 一致（同一用户在详情半屏里看到的「已解锁」和「第 N 位」不能打架）：
 *   - 同 `computeTrophyEarns`：同一人同一 key 只占一个名次，以**最早**那次满足的日期为准
 *   - 完美周只认 daily 快照（周计划已下线，存量 weekly 快照不能冒充）
 *
 * 本模块的日期计算是纯函数（单测直接喂数据），数据库读取收在 `collectUnlockDates` 一处。
 */
import { Types } from 'mongoose';
import { ExercisePlanPeriodModel } from '../models/exercise-plan-period.model.js';
import { ActivityModel } from '../models/activity.model.js';
import {
  unlockDatesOf,
  type BadgeDailyRow,
  type BadgeEarnInput,
  type BadgeRangeRow,
} from './badge-earn.js';

// 解锁日期算法是唯一实现（badge-earn.ts），这里只负责「全站聚合 + 排名」
export { unlockDatesOf };
export type RankInput = BadgeEarnInput;
export type RankDailyRow = BadgeDailyRow;
export type RankRangeRow = BadgeRangeRow;

/** 名次项：某用户在某座徽章上的首次解锁日 */
export interface RankEntry {
  uid: string;
  date: string;
}

/** 单用户的名次表：key → { rank, total } */
export type RankTable = Record<string, { rank: number; total: number }>;

/**
 * **唯一实现**：给定「key → (uid, 解锁日) 列表」，算出每个用户的 key → { rank, total }。
 *
 * 规则：rank = 首次解锁日**严格早于**自己的人 + 1（同一天并列同名次，下一位跳号）；
 * total = 解锁该 key 的总人数。
 *
 * 线上（loadTrophyRanks 全站一次算完）与单测（buildRankTable 单用户视角）都走这里，
 * 避免「两份实现改一处漏一处，测试却一直绿」。
 */
export function rankTableOf(datesByKey: ReadonlyMap<string, readonly RankEntry[]>): Map<string, RankTable> {
  const out = new Map<string, RankTable>();
  for (const [key, entries] of datesByKey) {
    const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const total = sorted.length;
    for (let i = 0; i < sorted.length; ) {
      const day = sorted[i].date;
      const rank = i + 1; // 并列：同一天解锁的人共用这个名次
      let j = i;
      while (j < sorted.length && sorted[j].date === day) {
        const uid = sorted[j].uid;
        const t = out.get(uid) ?? {};
        t[key] = { rank, total };
        out.set(uid, t);
        j += 1;
      }
      i = j;
    }
  }
  return out;
}

/**
 * 单用户视角的便捷包装（单测与「只想算自己名次」的调用方用）：
 * 把 mine + others 合成为条目表，复用 rankTableOf —— 这里是唯一算法出处。
 */
export function buildRankTable(
  mine: Readonly<Record<string, string>>,
  others: ReadonlyArray<Record<string, string>>,
): RankTable {
  const datesByKey = new Map<string, RankEntry[]>();
  const push = (uid: string, m: Readonly<Record<string, string>>) => {
    for (const [key, date] of Object.entries(m)) {
      if (!date) continue;
      const arr = datesByKey.get(key) ?? [];
      arr.push({ uid, date });
      datesByKey.set(key, arr);
    }
  };
  const ME = '__me__';
  push(ME, mine);
  others.forEach((m, i) => push(`__other_${i}`, m));

  const table: RankTable = { ...(rankTableOf(datesByKey).get(ME) ?? {}) };
  // 本人没解锁的 key 也要给出 total（详情半屏显示「全站 N 人已获得」）
  for (const [key, entries] of datesByKey) {
    if (!table[key]) table[key] = { rank: 0, total: entries.length };
  }
  return table;
}

/**
 * 结果缓存（TTL）：全站人数成千上万时不必每次进页面都重算；无额外写放大。
 *
 * ⚠️ 规模说明（2026-11-16 评估后暂不改）：首次计算 = 全站轨迹按 (userId, 日) 聚合
 * + 读出**全部**周期快照 + 每个用户跑一遍徽章解锁日（O(用户数 × 徽章数)）。
 * 当前全站 1549 条轨迹 ≈ 几十毫秒，可接受。
 * 触发改造的条件（先满足任一再动手）：
 *   - 轨迹总量 > 20 万条（聚合耗时 > 1s，或内存里的按日数组过大）
 *   - 徽章数翻倍（> 250 座），单用户解锁日计算成为瓶颈
 * 届时的做法：把「解锁日」落成物化表 badge_earns（徽章达成时增量写一行），
 * 名次退化为对该表按日期排序查询——`rankTableOf` 的入参结构不用改。
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { at: number; data: Record<string, RankTable> } | null = null;

/** 测试用：清空缓存 */
export function __resetTrophyRankCache(): void {
  cache = null;
}

/**
 * 全站各用户的「徽章 → 首次解锁日」表（一次聚合读取，按用户分组）。
 * 聚合口径：全部 `status=finished` 的轨迹按 (userId, 东八区自然日) 汇总；
 * 周期快照按用户取全部。
 */
async function collectUnlockDates(): Promise<Map<string, Record<string, string>>> {
  const [dayAgg, typeAgg, periodDocs] = await Promise.all([
    ActivityModel.aggregate<{
      _id: { userId: Types.ObjectId; date: string };
      distanceM: number;
      durationSec: number;
      count: number;
    }>([
      { $match: { status: 'finished' } },
      {
        $group: {
          _id: {
            userId: '$userId',
            date: { $dateToString: { format: '%Y-%m-%d', date: { $toDate: '$startTime' }, timezone: '+08:00' } },
          },
          distanceM: { $sum: { $ifNull: ['$distance', 0] } },
          durationSec: { $sum: { $ifNull: ['$duration', 0] } },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.date': 1 } },
      { $project: { _id: 1, distanceM: 1, durationSec: 1, count: 1 } },
    ]),
    // 分运动类型的每日汇总（分类型徽章解锁日期用；缺这份数据 → 分类型徽章永远没有名次）
    ActivityModel.aggregate<{
      _id: { userId: Types.ObjectId; type: string; date: string };
      distanceM: number;
      durationSec: number;
      count: number;
    }>([
      { $match: { status: 'finished' } },
      {
        $group: {
          _id: {
            userId: '$userId',
            type: '$type',
            date: { $dateToString: { format: '%Y-%m-%d', date: { $toDate: '$startTime' }, timezone: '+08:00' } },
          },
          distanceM: { $sum: { $ifNull: ['$distance', 0] } },
          durationSec: { $sum: { $ifNull: ['$duration', 0] } },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.date': 1 } },
    ]),
    ExercisePlanPeriodModel.find({})
      .select({ userId: 1, period: 1, periodKey: 1, windowEnd: 1, targets: 1, progress: 1, allAchieved: 1 })
      .lean(),
  ]);

  const daysByUser = new Map<string, RankDailyRow[]>();
  for (const r of dayAgg) {
    const uid = String(r._id.userId);
    const arr = daysByUser.get(uid) ?? [];
    arr.push({ date: r._id.date, distanceM: r.distanceM, durationSec: r.durationSec, count: r.count });
    daysByUser.set(uid, arr);
  }

  const typeDaysByUser = new Map<string, Record<string, RankDailyRow[]>>();
  for (const r of typeAgg) {
    const uid = String(r._id.userId);
    const type = String(r._id.type || '');
    if (!type) continue;
    const perUser = typeDaysByUser.get(uid) ?? {};
    const arr = perUser[type] ?? [];
    arr.push({ date: r._id.date, distanceM: r.distanceM, durationSec: r.durationSec, count: r.count });
    perUser[type] = arr;
    typeDaysByUser.set(uid, perUser);
  }

  const periodsByUser = new Map<string, RankRangeRow[]>();
  for (const p of periodDocs) {
    const uid = String(p.userId);
    const row: RankRangeRow = {
      period: String(p.period || 'daily'),
      periodKey: String(p.periodKey || ''),
      windowEnd: Number(p.windowEnd) || 0,
      allAchieved: !!p.allAchieved,
      targets: {
        distanceM: Number(p.targets?.distanceM) || 0,
        durationMin: Number(p.targets?.durationMin) || 0,
        count: Number(p.targets?.count) || 0,
      },
      progress: {
        distanceM: Number(p.progress?.distanceM) || 0,
        durationSec: Number(p.progress?.durationSec) || 0,
        count: Number(p.progress?.count) || 0,
      },
    };
    const arr = periodsByUser.get(uid) ?? [];
    arr.push(row);
    periodsByUser.set(uid, arr);
  }

  const users = new Set<string>([...daysByUser.keys(), ...periodsByUser.keys(), ...typeDaysByUser.keys()]);
  const out = new Map<string, Record<string, string>>();
  for (const uid of users) {
    const rows = periodsByUser.get(uid) ?? [];
    out.set(
      uid,
      unlockDatesOf({
        days: daysByUser.get(uid) ?? [],
        // 完美周/合环只认每日快照（周计划已下线，weekly 快照不参与名次）——见 unlockDatesOf 里的过滤
        dailyRows: rows,
        periodRows: rows,
        // 分运动类型徽章（walk-*/run-*/hike-*/ride-*/climb-*）的解锁日期依赖这份数据；
        // 漏传会让 80 座分类型徽章「已解锁但没有名次」（2026-11-17 修复）
        typeDays: typeDaysByUser.get(uid) ?? {}, // 必填：没有分类型数据时给空表（编译期强制传）
      }),
    );
  }
  return out;
}

/**
 * 取本人名次表（key → { rank, total }）。未登录/无数据返回空表。
 * 第一次调用做一次全站聚合，之后 10 分钟内复用缓存。
 *
 * 算法：每个 key 把全站「(解锁日, 用户)」按日期排序一次，扫一遍把同一天的人写成同一个名次
 * （并列同名次，名次 = 此前已排列的人数 + 1），复杂度 O(key 数 × 人数 log 人数)。
 */
export async function loadTrophyRanks(userId: string): Promise<Record<string, { rank: number; total: number }>> {
  if (!Types.ObjectId.isValid(userId)) return {};
  if (!cache || Date.now() - cache.at > CACHE_TTL_MS) {
    const all = await collectUnlockDates();
    // 反转成「key → (uid, 解锁日)」，再交给唯一实现的 rankTableOf（并列同名次规则只有一份）
    const byKey = new Map<string, RankEntry[]>();
    for (const [uid, m] of all.entries()) {
      for (const [key, date] of Object.entries(m)) {
        if (!date) continue;
        const arr = byKey.get(key) ?? [];
        arr.push({ uid, date });
        byKey.set(key, arr);
      }
    }
    const perUser = rankTableOf(byKey);
    const data: Record<string, RankTable> = {};
    for (const [uid, table] of perUser) data[uid] = table;
    cache = { at: Date.now(), data };
  }
  return cache.data[userId] ?? {};
}