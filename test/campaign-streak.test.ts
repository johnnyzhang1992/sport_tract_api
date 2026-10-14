import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streakDays } from '../src/utils/campaign-streak.js';

// 冻结在「今天」= 东八区 2026-10-14 12:00
const TODAY = Date.UTC(2026, 9, 14, 4, 0, 0);

test('CS1 今天没动不算断：10-12、10-13 → 2', () => {
  assert.equal(streakDays(['2026-10-12', '2026-10-13'], TODAY), 2);
});

test('CS2 今天也动了：10-12、10-13、10-14 → 3', () => {
  assert.equal(streakDays(['2026-10-12', '2026-10-13', '2026-10-14'], TODAY), 3);
});

test('CS3 中间断了：10-12、10-14 → 1', () => {
  assert.equal(streakDays(['2026-10-12', '2026-10-14'], TODAY), 1);
});

test('CS4 空集合 → 0', () => {
  assert.equal(streakDays([], TODAY), 0);
});

test('CS5 今天和昨天都没有 → 0（不许越过两个空日往前数）', () => {
  assert.equal(streakDays(['2026-10-12'], TODAY), 0);
});

test('CS6 跨月连续：09-30、10-01 → 从今天(10-14)往前不在集合 → 0', () => {
  assert.equal(streakDays(['2026-09-30', '2026-10-01'], TODAY), 0);
});
