/**
 * 运动榜上榜通知定时投递（board-onthelist-job）：
 * - 上周/上月单元的 periodKey 与窗口右界（含跨年 1 月）；
 * - 东八闸门：周一/1 号 09:00 起才投；其余时刻整轮跳过；
 * - done-set：同单元当轮只聚合一次；投递抛错回滚重试。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/board-onthelist-job.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  lastWeekUnit, lastMonthUnit, tickOnTheListJob, runOnTheListUnit,
  onthelistJobDeps, resetOnTheListJobStateForTest,
} from '../src/services/board-onthelist-job.js';

const DAY = 86_400_000;
// 2026-11-09 是周一；09:30 东八 = 01:30 UTC
const MON_NOON = Date.UTC(2026, 10, 9, 1, 30, 0);
const MON_EARLY = Date.UTC(2026, 10, 9, 0, 59, 0); // 周一 08:59 东八
const TUE_NOON = Date.UTC(2026, 10, 10, 2, 0, 0); // 周二 10:00 东八
const FIRST_930 = Date.UTC(2026, 11, 1, 1, 30, 0); // 2026-12-01（周二）09:30 东八
const FIRST_EARLY = Date.UTC(2026, 11, 1, 0, 59, 0); // 1 号 08:59 东八

let calls: Array<{ period: string; periodKey: string; endMs: number; now: number }> = [];

beforeEach(() => {
  calls = [];
  resetOnTheListJobStateForTest();
  onthelistJobDeps.notify = async (period, periodKey, endMs, now) => {
    calls.push({ period, periodKey, endMs, now });
    return { notified: 1 };
  };
});

test('BJ-1 上周周榜单元：periodKey = 上周一日期串，右界 = 本周一 00:00 东八', () => {
  const u = lastWeekUnit(MON_NOON);
  assert.equal(u.period, 'week');
  assert.equal(u.periodKey, '2026-11-02');
  assert.equal(u.endMs, Date.UTC(2026, 10, 8, 16, 0, 0), '本周一 00:00 东八');

  // 周中任意时刻口径不变
  const mid = lastWeekUnit(Date.UTC(2026, 10, 12, 4, 0, 0)); // 周四 12:00 东八
  assert.equal(mid.periodKey, '2026-11-02');
  assert.equal(mid.endMs, Date.UTC(2026, 10, 8, 16, 0, 0));
});

test('BJ-2 上月月榜单元：periodKey = 上月 YYYY-MM，右界 = 本月 1 日 00:00 东八；跨年 1 月归上一年 12 月', () => {
  const u = lastMonthUnit(MON_NOON); // 11 月 → 上月 2026-10
  assert.equal(u.period, 'month');
  assert.equal(u.periodKey, '2026-10');
  assert.equal(u.endMs, Date.UTC(2026, 9, 31, 16, 0, 0), '2026-11-01 00:00 东八 = 10-31T16:00Z');

  const jan = lastMonthUnit(Date.UTC(2027, 0, 15, 4, 0, 0)); // 2027-01 → 上月 2026-12
  assert.equal(jan.periodKey, '2026-12');
  assert.equal(jan.endMs, Date.UTC(2026, 11, 31, 16, 0, 0), '2027-01-01 00:00 东八');
});

test('BJ-3 闸门：周一 09:00 起投周榜；08:59/周二不发；1 号 09:00 起投月榜', async () => {
  await tickOnTheListJob(MON_EARLY);
  assert.equal(calls.length, 0, '周一 08:59 不发');

  await tickOnTheListJob(MON_NOON);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].period, 'week');
  assert.equal(calls[0].periodKey, '2026-11-02');

  await tickOnTheListJob(TUE_NOON);
  assert.equal(calls.length, 1, '周二其余时刻不发周榜（done 已占）');

  await tickOnTheListJob(FIRST_EARLY);
  assert.equal(calls.length, 1, '1 号 08:59 不发');

  await tickOnTheListJob(FIRST_930);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].period, 'month');
  assert.equal(calls[1].periodKey, '2026-11', '12 月 1 日发的是 11 月榜');
});

test('BJ-4 done-set：同单元重复 tick 只聚合一次；失败回滚下一 tick 重试', async () => {
  const u = lastWeekUnit(MON_NOON);
  const first = await runOnTheListUnit(u, MON_NOON);
  assert.equal(first, 1);
  const again = await runOnTheListUnit(u, MON_NOON);
  assert.equal(again, -1, '已占 done 不再聚合');
  assert.equal(calls.length, 1);

  onthelistJobDeps.notify = async () => {
    throw new Error('boom');
  };
  resetOnTheListJobStateForTest();
  const failed = await runOnTheListUnit(u, MON_NOON);
  assert.equal(failed, 0, '吞错不抛');
  const retry = await runOnTheListUnit(u, MON_NOON);
  assert.equal(retry, 0, '失败回滚 done，重试仍走到 notify');
});
