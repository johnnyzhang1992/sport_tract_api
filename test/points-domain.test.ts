import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewardForStreakDay, expireAtFor, previousDateKey, shiftDateKey } from '../src/utils/points-domain.js';

test('PD1 连续第 N 天积分：1–7 递增，第 8 天起封顶 7', () => {
  assert.equal(rewardForStreakDay(1), 1);
  assert.equal(rewardForStreakDay(7), 7);
  assert.equal(rewardForStreakDay(8), 7);
  assert.equal(rewardForStreakDay(30), 7);
});

test('PD2 积分在获得年份的次年 12-31 23:59:59 过期（东八区）', () => {
  const earnedAt = Date.UTC(2026, 4, 15, 4, 0, 0); // 2026-05-15 12:00 BJ
  assert.equal(expireAtFor(earnedAt), Date.UTC(2027, 11, 31, 15, 59, 59, 999));
});

test('PD3 previousDateKey 跨月/跨年', () => {
  assert.equal(previousDateKey('2026-10-01'), '2026-09-30');
  assert.equal(previousDateKey('2026-01-01'), '2025-12-31');
});

test('PD4 shiftDateKey 跨月/跨年/双向位移', () => {
  assert.equal(shiftDateKey('2026-10-25', -6), '2026-10-19');
  assert.equal(shiftDateKey('2026-10-25', -25), '2026-09-30');
  assert.equal(shiftDateKey('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDateKey('2027-01-01', -1), '2026-12-31');
  assert.equal(shiftDateKey('2026-02-28', 2), '2026-03-02'); // 非闰年
  assert.equal(shiftDateKey('2028-02-28', 2), '2028-03-01'); // 闰年
  assert.equal(previousDateKey('2026-10-25'), shiftDateKey('2026-10-25', -1));
});
