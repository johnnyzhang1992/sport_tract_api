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
import { cacheGet, cacheGetMany, cacheSetMany } from './redis.js';
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
    // 脏数据防御：无日期的条目不参与排名（调用方通常已过滤，但 rankTableOf 也可能被直接调用）
    const sorted = entries.filter((e) => !!e && !!e.date)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
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
 * 结果缓存（2026-11-17 改用可插拔缓存层，见 services/redis.ts）
 *
 * 存什么：**全站其他人的解锁日**，按徽章 key 分片存储：
 *     badge:unlock:<徽章key>  →  [{ uid, date }, ...]
 *   - 分片而不是单个大 JSON：一次请求只读当前用户需要的 key（通常几十个），
 *     而全量快照 ~289KB 每次都要反序列化，浪费 CPU 与网络
 *   - 分片也便于单独失效（将来某座徽章口径变了，只需删它那一个 key）
 *
 * TTL 10 分钟；读不到（未配置 Redis / 连接失败 / 未命中）→ 现场算一遍再写回。
 *
 * ⚠️ 为什么缓存里不含本人：用户的解锁日是**实时**算的（getPlanSummary 的 computeBadgeEarns），
 * 若名次也用缓存里的旧快照，用户刚解锁的那座徽章会出现「已解锁但无名次」
 * （实测复现：缓存未过期时新解锁 x2，名次缺失）。现在本人的解锁日每次请求实时合并进来。
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** Redis 里所有徽章解锁日的 key 前缀（带应用前缀，避免与同实例的其它项目撞名） */
export const UNLOCK_KEY_PREFIX = 'st:badge:unlock:';
/** 全站快照「已构建」的时间戳键：多实例共享，避免每个实例各算一遍 */
const SNAPSHOT_AT_KEY = `${UNLOCK_KEY_PREFIX}_at`;
/** 快照包含哪些 key（分片索引） */
const SNAPSHOT_KEYS_KEY = `${UNLOCK_KEY_PREFIX}_keys`;

/** 正在进行的全站聚合：并发请求等同一个结果，避免缓存穿透把 CPU 打满 */
let inflight: Promise<Map<string, RankEntry[]>> | null = null;
/** 内存兜底已由 services/redis.ts 的 memory 层承担，这里只留快照时间戳（跨调用复用） */
let localSnapshotAt = 0;

/** 测试用：清空进程内状态 */
export function __resetTrophyRankCache(): void {
  inflight = null;
  localSnapshotAt = 0;
}

/**
 * 读全站快照（按 key 分片）。
 * 缓存整体过期或缺失时：做一次全站聚合，然后把每个 key 写回缓存。
 * @returns key → 解锁条目列表（**不含本人**的语义由调用方剔除）
 */
async function loadSnapshot(): Promise<Map<string, RankEntry[]>> {
  // 1) 先看快照时间戳是否还在有效期内（一次往返，顺带读分片索引用 MGET 合并成 2 次往返）
  const [atRaw, keys] = await cacheGetMany<number | string[]>([SNAPSHOT_AT_KEY, SNAPSHOT_KEYS_KEY]);
  const at = (atRaw as number | null) ?? localSnapshotAt;
  const fresh = typeof at === 'number' && at > 0 && Date.now() - at < CACHE_TTL_MS;
  const keyList = Array.isArray(keys) ? (keys as string[]) : null;

  if (fresh && keyList) {
    // 2) 命中：**一次 MGET** 读全部徽章分片（原来是逐 key GET，上百座徽章就是上百次往返）
    if (!keyList.length) return new Map(); // 全站确实还没人解锁：直接空表，不要每次重建
    const chunks = await cacheGetMany<RankEntry[]>(keyList.map((k) => `${UNLOCK_KEY_PREFIX}${k}`));
    const out = new Map<string, RankEntry[]>();
    keyList.forEach((k, i) => {
      const v = chunks[i];
      if (v) out.set(k, v);
    });
    // 少部分 key 掉了（TTL 不齐/set 失败）也要能工作：缺的 key 视为无人解锁
    if (out.size > 0) return out;
    // 全部读空 → 落到重建（不把「缓存全丢」误当成「全站没人解锁」）
  }

  // 3) 未命中 → 聚合一次（并发共享同一个 Promise）
  if (!inflight) {
    inflight = buildSnapshot().finally(() => {
      inflight = null; // 成功/失败都清掉，失败后下次请求可重试
    });
  }
  return inflight;
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

/** 全站聚合 + 回写缓存（按 key 分片，**一次 pipeline** 写完） */
async function buildSnapshot(): Promise<Map<string, RankEntry[]>> {
  const all = await collectUnlockDates();
  const byKey = new Map<string, RankEntry[]>();
  for (const [uid, m] of all.entries()) {
    for (const [key, date] of Object.entries(m)) {
      if (!date) continue;
      const arr = byKey.get(key) ?? [];
      arr.push({ uid, date });
      byKey.set(key, arr);
    }
  }
  // 回写：分片 + 索引 + 时间戳一次 pipeline 写完（比逐条 SET 少几十次往返）
  const ttlSec = Math.floor(CACHE_TTL_MS / 1000);
  const now = Date.now();
  const entries: Array<{ key: string; value: unknown; ttlSec: number }> = [
    ...[...byKey.entries()].map(([k, v]) => ({ key: `${UNLOCK_KEY_PREFIX}${k}`, value: v, ttlSec })),
    { key: SNAPSHOT_KEYS_KEY, value: [...byKey.keys()], ttlSec },
    // 时间戳最后写：只有前面的分片都写成功，才值得标记「新鲜」
    { key: SNAPSHOT_AT_KEY, value: now, ttlSec },
  ];
  await cacheSetMany(entries);
  localSnapshotAt = now;
  return byKey;
}

/**
 * 取本人名次表（key → { rank, total }）。未登录返回空表。
 *
 * @param userId 本人
 * @param myDates 本人**实时**算出的「徽章 → 首次解锁日」（来自 computeBadgeEarns，不用缓存值）
 *
 * 算法：把「全站其他人的解锁日（缓存）」与「本人实时解锁日」合并成条目表，
 * 交给唯一实现 rankTableOf（并列同名次，rank = 更早解锁的人数 + 1）。
 * 名次永远与本人当前的解锁状态一致——不会出现「已解锁但没有名次」。
 */
export async function loadTrophyRanks(
  userId: string,
  myDates: Readonly<Record<string, string>>,
): Promise<Record<string, { rank: number; total: number }>> {
  if (!Types.ObjectId.isValid(userId)) return {};

  const snapshot = await loadSnapshot(); // key → 全站条目（含本人历史数据）

  const byKey = new Map<string, RankEntry[]>();
  for (const [key, entries] of snapshot.entries()) {
    // 剔除本人：本人的解锁日以 myDates（实时）为准，避免同一个人被算两次
    const others = entries.filter((e) => e.uid !== userId);
    if (others.length) byKey.set(key, others);
  }
  // 合并本人实时解锁日（最新、最准）
  for (const [key, date] of Object.entries(myDates)) {
    if (!date) continue;
    const arr = byKey.get(key) ?? [];
    arr.push({ uid: userId, date });
    byKey.set(key, arr);
  }

  const table: Record<string, { rank: number; total: number }> = {
    ...(rankTableOf(byKey).get(userId) ?? {}),
  };
  // 未解锁的徽章也要给出 total（「全站已有 N 人获得」）
  for (const [key, entries] of byKey.entries()) {
    if (table[key]) continue;
    table[key] = { rank: 0, total: entries.length };
  }
  return table;
}
