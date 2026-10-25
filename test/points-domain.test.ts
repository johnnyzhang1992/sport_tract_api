import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewardForStreakDay, expireAtFor, previousDateKey } from '../src/utils/points-domain.js';

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
