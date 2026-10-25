import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSigninCells, windowStartKey, shiftDateKey, WINDOW_DAYS } from '../src/utils/points-window.js';

const T = '2026-10-25'; // 今天
const back = (n: number) => shiftDateKey(T, -n);

/** 造一段连续已签：[from..to] 相对今天的天数偏移，streakDay 从 startAt 递增 */
function run(fromBack: number, toBack: number, startAt = 1) {
  const out: { dateKey: string; streakDay: number }[] = [];
  for (let b = fromBack; b >= toBack; b -= 1) out.push({ dateKey: back(b), streakDay: startAt + (fromBack - b) });
  return out;
}
const at = (cells: ReturnType<typeof planSigninCells>, key: string) =>
  cells.find((c) => c.dateKey === key);

test('MW1 用户算例：20-23 签、19/24 漏 → 起点前移到 19，19 与 24 都是补签格', () => {
  const cells = planSigninCells([...run(5, 2)], T); // 20=1,21=2,22=3,23=4
  assert.equal(cells.length, WINDOW_DAYS);
  assert.equal(cells[0].dateKey, back(6)); // 19
  assert.equal(cells.map((c) => c.state).join(','), 'makeup,signed,signed,signed,signed,makeup,today');
  assert.equal(at(cells, T)!.reward, 1, '今天未签且昨天漏 → 今天格 1 分');
  assert.equal(at(cells, T)!.streakDay, 1);
  assert.equal(at(cells, back(6))!.reward, 1, '19 补上后自己排第 1');
  assert.equal(at(cells, back(6))!.todayRewardAfter, 1, '只补 19 补不上 24 的断口，今天仍 1 分');
  assert.equal(at(cells, back(1))!.todayRewardAfter, 6, '补 24 → 24=5、今天=6');
});

test('MW2 昨天签了、窗口左缘空着两天：那两天也算可补（Ruling 2026-10-25 的代价）', () => {
  const cells = planSigninCells([...run(4, 1)], T); // 21..24 已签（昨天签了）
  assert.equal(cells[0].dateKey, back(6), '起点被 19 的可补格拽到窗口左缘');
  assert.equal(cells.map((c) => c.state).join(','), 'makeup,makeup,signed,signed,signed,signed,today');
  assert.equal(at(cells, back(6))!.reward, 1, '19 左边窗口内没行 → 自己第 1 天');
  assert.equal(at(cells, back(6))!.todayRewardAfter, 5, '只补 19 接不上 21 的链（20 还空着）→ 今天仍 5 分');
  assert.equal(at(cells, back(5))!.todayRewardAfter, 6, '补 20 接上 21..24 → 今天第 6 天');
  assert.equal(at(cells, T)!.reward, 5, '今天未签但昨天签了 → 本周期第 5 天');
});

test('MW3 连漏 2 天：两格都可补，段长只算 2（不含今天）', () => {
  const cells = planSigninCells([...run(6, 3)], T); // 19..22 签（streakDay 1..4），23/24 漏
  const makeup = cells.filter((c) => c.state === 'makeup').map((c) => c.dateKey);
  assert.deepEqual(makeup, [back(2), back(1)], '23/24 同属一个长度 2 的未签段，两格都可补');
  assert.equal(at(cells, back(2))!.reward, 5, '23 补上接在 22 之后 → 第 5 天');
  assert.equal(at(cells, back(1))!.reward, 1, '24 单独补时 23 还没签 → 自己起新段第 1 天');
  assert.equal(at(cells, back(1))!.todayRewardAfter, 2, '只补 24 时今天只能到第 2 天');
});

test('MW4 连漏 3 天：一格都不可补，起点不前移', () => {
  const cells = planSigninCells([...run(6, 4)], T); // 19..21 签，22/23/24 漏
  assert.equal(cells.filter((c) => c.state === 'makeup').length, 0);
  assert.equal(cells.filter((c) => c.state === 'missed').length, 3);
  assert.equal(cells[0].dateKey, back(6), '窗口左界兜住，仍显示 19');
});

test('MW5 全新用户（窗口内无已签日）：没有补签格，今天在第 1 格', () => {
  const cells = planSigninCells([], T);
  assert.equal(cells.filter((c) => c.state === 'makeup').length, 0);
  assert.equal(cells[0].dateKey, T);
  assert.equal(cells[0].state, 'today');
  assert.equal(cells[6].state, 'future');
  assert.equal(cells[6].reward, 7, '未来格按连续签下去预测');
});

test('MW6 长连签 10 天：起点被今天-6 兜住，分值随位置递增后封顶 7', () => {
  const cells = planSigninCells([...run(9, 0)], T); // 16..25 全签，今天 streakDay=10
  assert.equal(cells[0].dateKey, back(6), '16-18 出窗，起点落在 19');
  assert.ok(cells.every((c) => c.state === 'signed'));
  assert.deepEqual(cells.map((c) => c.reward), [4, 5, 6, 7, 7, 7, 7], '19 是第 4 天，第 7 天起封顶');
  assert.deepEqual(cells.map((c) => c.streakDay), [4, 5, 6, 7, 8, 9, 10], 'streakDay 保留绝对天数');
});

test('MW7 段长只数窗口内：左界截到今天-6，窗口外的行不参与判定', () => {
  // 断签已久：窗口内只有 10-20 一行
  const dormant: { dateKey: string; streakDay: number }[] = [{ dateKey: back(5), streakDay: 1 }];
  const cells = planSigninCells(dormant, T);
  assert.equal(at(cells, back(6))!.state, 'makeup', '19 左侧出窗即停 → 段长 1，可补（Ruling 有意付的代价）');
  assert.equal(at(cells, back(5))!.state, 'signed');
  assert.equal(cells.filter((c) => c.state === 'missed').length, 4, '21..24 同属长度 4 的段（今天不计入）→ 都不可补');
  assert.equal(cells.filter((c) => c.state === 'makeup').length, 1, '只有 19 可补');
  // 窗口外多出来的行不得改变任何一格：证明判定真的没往窗口外读
  const withOutside = planSigninCells([...dormant, { dateKey: back(9), streakDay: 1 }], T);
  assert.deepEqual(withOutside, cells, '10-16 在窗外，读不读都一样');
});

test('MW8 windowStartKey 是今天-6', () => {
  assert.equal(windowStartKey(T), back(6));
  assert.equal(windowStartKey('2026-01-03'), '2025-12-28');
});
