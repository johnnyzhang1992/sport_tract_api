/**
 * 里程碑徽章「第 N 位迹路者」排名（2026-11-16）：纯函数口径。
 * 运行：node --import tsx --test test/trophy-rank.test.ts
 *
 * 覆盖：
 *   - 解锁日期口径（破纪录/最坚持/合环/累计/完美周/原 8 倍数里程碑）
 *   - 排名并列（同一天解锁同名次、下一名跳号）
 *   - 全站人数（total）与未解锁（rank=0）
 *   - weekly 快照不算完美周/合环（周计划已下线）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  unlockDatesOf,
  buildRankTable,
  rankTableOf,
  type RankInput,
  type RankDailyRow,
  type RankRangeRow,
} from '../src/services/trophy-rank.js';

function day(date: string, distanceM: number, durationSec: number, count = 1): RankDailyRow {
  return { date, distanceM, durationSec, count };
}

function snap(date: string, achieved: boolean, period = 'daily', ratio = 2): RankRangeRow {
  const windowStart = Date.parse(`${date}T00:00:00+08:00`);
  return {
    period,
    periodKey: date,
    windowEnd: windowStart + 86_400_000,
    allAchieved: achieved,
    targets: { distanceM: 1000, durationMin: 30, count: 1 },
    progress: { distanceM: 1000 * ratio, durationSec: 1800 * ratio, count: Math.max(1, Math.round(ratio)) },
  };
}

function emptyInput(): RankInput {
  return { days: [], typeDays: {}, dailyRows: [], periodRows: [] };
}

test('TR1 破纪录：第 N 次刷新的那天解除，100 档取第 100 天', () => {
  const days: RankDailyRow[] = [];
  for (let i = 1; i <= 120; i++) {
    const d = new Date(Date.UTC(2026, 0, 1) - 8 * 3600_000 + (i - 1) * 86_400_000);
    const date = new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
    days.push(day(date, 1000 + i, 600 + i)); // 每天新高
  }
  const r = unlockDatesOf({ ...emptyInput(), days });
  const d100 = new Date(Date.UTC(2026, 0, 100) - 8 * 3600_000 + 8 * 3600_000).toISOString().slice(0, 10);
  assert.equal(r['rec-dist-100'], d100);
  assert.equal(r['rec-dur-100'], d100);
  assert.equal(r['streak-100'], d100, '第 100 天连续 100 天');
  assert.equal(r['rec-dist-365'], undefined, '只有 120 次破纪录，365 档未解锁');
});

test('TR3 累计里程：跨过 100km 的那天（同日多笔累加）', () => {
  const r = unlockDatesOf({
    ...emptyInput(),
    days: [day('2026-01-01', 60_000, 3600), day('2026-01-02', 50_000, 3600)],
  });
  assert.equal(r['total-dist-100'], '2026-01-02');
  assert.equal(r['total-dur-10'], undefined, '累计 2 小时，10 小时档未解锁');
});

test('TR4 合环：第 N 个三项全达成日快照', () => {
  const daily = [snap('2026-01-01', true), snap('2026-01-02', false), snap('2026-01-03', true)];
  const r = unlockDatesOf({ ...emptyInput(), dailyRows: daily });
  assert.equal(r['ring-100'], undefined, '只合上 2 个环');
});

test('TR5 完美周：七天齐全才计；weekly 快照不算（周计划已下线）', () => {
  // 2026-01-05 是周一 → 01-05..01-11 一整周
  const week = ['05', '06', '07', '08', '09', '10', '11'].map((d) => snap(`2026-01-${d}`, true));
  const r = unlockDatesOf({ ...emptyInput(), dailyRows: week });
  assert.equal(r['perfect-week-all'], '2026-01-11', '合格周最后一天');
  assert.equal(r['perfect-week-distance'], '2026-01-11');

  const weeklyOnly = [snap('2026-01-05', true, 'weekly')];
  const r2 = unlockDatesOf({ ...emptyInput(), dailyRows: weeklyOnly });
  assert.equal(r2['perfect-week-all'], undefined, 'weekly 快照不能冒充完美周');
  assert.equal(r2['ring-100'], undefined, 'weekly 快照不算合环');
});

test('TR6 原 8 倍数里程碑：按周期最后一天解锁', () => {
  const p = snap('2026-01-01', true, 'daily', 5);
  const r = unlockDatesOf({ ...emptyInput(), periodRows: [p] });
  assert.equal(r.first, '2026-01-01');
  assert.equal(r['x2'], '2026-01-01');
  assert.equal(r['x5'], '2026-01-01');
  assert.equal(r.week, undefined, '需 7 次达成');
});

test('TR7 排名：同一天解锁并列同名次，下一位跳号（3,3,5）', () => {
  const table = buildRankTable(
    { 'rec-dist-100': '2026-03-10' }, // 我：第 3 位（两个人在 03-10 之前）
    [
      { 'rec-dist-100': '2026-03-01' },
      { 'rec-dist-100': '2026-03-05' },
      { 'rec-dist-100': '2026-03-10' }, // 与我同一天 → 并列第 3
      { 'rec-dist-100': '2026-04-01' }, // 第 5 位
    ],
  );
  assert.deepEqual(table['rec-dist-100'], { rank: 3, total: 5 });
});

test('TR8 当天只有我一个解锁 → 第 1 位', () => {
  const table = buildRankTable({ 'streak-365': '2026-03-01' }, [{ 'streak-365': '2026-03-02' }]);
  assert.deepEqual(table['streak-365'], { rank: 1, total: 2 });
});

test('TR9 未解锁 rank=0，但 total 仍给出（详情半屏不显示名次）', () => {
  const table = buildRankTable({}, [{ 'total-dist-100': '2026-01-01' }, { 'total-dist-100': '2026-01-02' }]);
  assert.deepEqual(table['total-dist-100'], { rank: 0, total: 2 });
});

test('TR10 日期相同但顺序不同不影响名次（稳定可复算）', () => {
  const others = [
    { ring: '2026-02-02' },
    { ring: '2026-02-01' },
    { ring: '2026-02-02' },
  ];
  const a = buildRankTable({ ring: '2026-02-02' }, others);
  const b = buildRankTable({ ring: '2026-02-02' }, [...others].reverse());
  assert.deepEqual(a.ring, b.ring);
  assert.deepEqual(a.ring, { rank: 2, total: 4 });
});

test('TR11 空输入不炸：全空返回空表', () => {
  assert.deepEqual(unlockDatesOf(emptyInput()), {});
  assert.deepEqual(buildRankTable({}, []), {});
});

test('TR12 rankTotal 包含本人（我解锁后总人数 +1）', () => {
  const withMe = buildRankTable({ x2: '2026-01-01' }, [{ x2: '2026-01-01' }]);
  assert.deepEqual(withMe.x2, { rank: 1, total: 2 });
});
/* ── 单一实现守卫（2026-11-16）：线上 loadTrophyRanks 与单测视角 buildRankTable 必须同口径 ── */

test('TR13 rankTableOf 是唯一实现：buildRankTable 结果与 rankTableOf 逐项一致', () => {
  const mine = { a: '2026-03-10', b: '2026-01-01' };
  const others = [
    { a: '2026-03-01' },
    { a: '2026-03-10' },
    { b: '2026-02-02' },
    { c: '2026-05-05' },
  ];
  // 用 rankTableOf 直接算（与 loadTrophyRanks 同一条路径）
  const entries = new Map();
  const push = (uid, m) => {
    for (const [k, d] of Object.entries(m)) {
      if (!d) continue;
      const arr = entries.get(k) ?? [];
      arr.push({ uid, date: d });
      entries.set(k, arr);
    }
  };
  push('me', mine);
  others.forEach((m, i) => push(`o${i}`, m));
  const viaCore = rankTableOf(entries).get('me') ?? {};
  const viaWrapper = buildRankTable(mine, others);

  for (const key of ['a', 'b']) {
    assert.deepEqual(viaWrapper[key], viaCore[key], `${key} 名次口径应与 rankTableOf 完全一致`);
  }
  // 文档化的差异：本人没解锁的 key，包装版补 { rank:0, total }（详情半屏要显示「全站 N 人已获得」）；
  // 核心版只含「解锁过的用户」，线上按 uid 取表本来就不会命中未解锁的 key
  assert.deepEqual(viaWrapper.c, { rank: 0, total: 1 }, '未解锁 key 由包装版补 rank=0 + total');
  assert.equal(viaCore.c, undefined, '核心表只记录真正解锁的人');
});
