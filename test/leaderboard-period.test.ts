/**
 * 榜单历史周期（2026-11-05）：周/月/年榜必须能看过去的期，窗口两端都夹住。
 *
 * 覆盖：
 * - LP-1 periodWindowOf：周/月/年的窗口与文案（周一是键、月末跨年边界）
 * - LP-2 periodWindowFromKey：合法键反解窗口；非法形态 400（周键必须是周一）
 * - LP-3 adjacentPeriodKeys：上一期恒有；下一期在未来时为 null
 * - LP-4 leaderboard：给定 periodKey 只统计该窗口内的轨迹（历史期不串进后续数据）
 *
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/leaderboard-period.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { ActivityModel } from '../src/models/activity.model.js';
import { config } from '../src/config/index.js';
import { MIN_PLAUSIBLE_PACE_SEC_PER_KM } from '../src/config/constants.js';
import {
  adjacentPeriodKeys,
  leaderboard,
  periodWindowFromKey,
  periodWindowOf,
} from '../src/services/leaderboard.js';

const DAY = 86_400_000;
const BJ = 8 * 3600_000;
const bjMid = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) - BJ;

const seededUsers: Types.ObjectId[] = [];
function mkUser() {
  const u = new Types.ObjectId();
  seededUsers.push(u);
  return u;
}

async function mkRun(userId: Types.ObjectId, distance: number, startTime: number) {
  await ActivityModel.create({
    userId, type: 'running', status: 'finished', startTime, distance,
    avgPace: MIN_PLAUSIBLE_PACE_SEC_PER_KM + 100,
  });
}

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
});

after(async () => {
  await ActivityModel.deleteMany({ userId: { $in: seededUsers } });
  await mongoose.disconnect().catch(() => {});
});

test('LP-1 periodWindowOf：周/月/年窗口与文案', () => {
  const anchor = bjMid(2026, 11, 5); // 周四
  const week = periodWindowOf('week', anchor)!;
  assert.equal(week.periodKey, '2026-11-02', '周一为键');
  assert.equal(week.startMs, bjMid(2026, 11, 2));
  assert.equal(week.endMs, bjMid(2026, 11, 9));
  assert.equal(week.text, '2026/11/02 至 11/08', '区间文案到周日（11/02 周一 ~ 11/08 周日）');

  const month = periodWindowOf('month', anchor)!;
  assert.equal(month.periodKey, '2026-11');
  assert.equal(month.endMs, bjMid(2026, 12, 1), '月窗口跨到次月 1 日 0 点');
  assert.equal(month.text, '2026年11月');

  const year = periodWindowOf('year', anchor)!;
  assert.equal(year.periodKey, '2026');
  assert.equal(year.endMs, bjMid(2027, 1, 1));

  assert.equal(periodWindowOf('all', anchor), null, '总榜没有期');
});

test('LP-2 periodWindowFromKey：合法键反解；周键必须周一，非法形态 400', () => {
  assert.deepEqual(periodWindowFromKey('week', '2026-10-26')!.periodKey, '2026-10-26');
  assert.deepEqual(periodWindowFromKey('month', '2026-10')!.periodKey, '2026-10');
  assert.deepEqual(periodWindowFromKey('year', '2026')!.periodKey, '2026');
  assert.equal(periodWindowFromKey('week', ''), null, '空键＝当前期（由调用方回落）');

  for (const [period, key] of [
    ['week', '2026-10-27'], // 周二
    ['week', '2026-13-01'],
    ['month', '2026-1'], // 必须两位
    ['month', '2026-13'],
    ['year', '26'],
  ] as const) {
    assert.throws(() => periodWindowFromKey(period, key), /周期键/, `${period}/${key} 应 400`);
  }
});

test('LP-3 adjacentPeriodKeys：上一期恒有；本期未结束时没有下一期', () => {
  const win = periodWindowFromKey('week', '2026-10-26')!;
  // 站在 2026-11-05 看 10/27 那一周：前后都有
  const both = adjacentPeriodKeys('week', win, bjMid(2026, 11, 5));
  assert.equal(both.prevPeriodKey, '2026-10-19');
  assert.equal(both.nextPeriodKey, '2026-11-02');

  // 站在 11/02 周一（当期还没结束）看本期：没有下一期
  const current = periodWindowFromKey('week', '2026-11-02')!;
  const only = adjacentPeriodKeys('week', current, bjMid(2026, 11, 5));
  assert.equal(only.nextPeriodKey, null, '本期未结束 ⇒ 无下一期');
  assert.equal(only.prevPeriodKey, '2026-10-26');
});

test('LP-4 leaderboard：给定历史 periodKey 只统计该窗口内的轨迹', async () => {
  const wk1Start = bjMid(2026, 3, 2); // 2031 之外另用 2026-03 的周，避开真实数据
  const u1 = mkUser();
  const u2 = mkUser();
  await mkRun(u1, 10_000, wk1Start + DAY); // 本周（历史期）里
  await mkRun(u2, 99_000, wk1Start + 8 * DAY); // 下一周：绝不能被算进历史期

  const res = await leaderboard(null, 'running', '全国', 'week', {
    periodKey: '2026-03-02', limit: 50, now: bjMid(2026, 5, 1),
  });
  assert.equal(res.window?.periodKey, '2026-03-02');
  assert.equal(res.window?.text, '2026/03/02 至 03/08');
  assert.equal(res.top.length, 1, '历史期只该有 1 人（下一周那条被窗口上界挡住）');
  assert.equal(res.top[0].distanceKm, 10);
  assert.equal(res.prevPeriodKey, '2026-02-23');
  assert.equal(res.nextPeriodKey, '2026-03-09');
});
