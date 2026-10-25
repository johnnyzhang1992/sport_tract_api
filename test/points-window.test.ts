import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSigninCells, windowStartKey, shiftDateKey, WINDOW_DAYS, type SignedRow } from '../src/utils/points-window.js';

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

test('MW9 连签从窗口外带进来：段首按库存值当锚，不按窗口里有行的天数', () => {
  // 19 没行（窗口左界），20 的行记着第 4 天 —— 这人 10-17 就开始签了，只是前面出窗
  const cells = planSigninCells([
    { dateKey: back(5), streakDay: 4 }, { dateKey: back(4), streakDay: 5 },
    { dateKey: back(3), streakDay: 6 }, { dateKey: back(2), streakDay: 7 },
  ], T);
  assert.equal(cells.map((c) => c.state).join(','), 'makeup,signed,signed,signed,signed,makeup,today');
  assert.equal(at(cells, back(1))!.streakDay, 8, '24 接在 23（第 7 天）之后 → 第 8 天');
  assert.equal(at(cells, back(1))!.reward, 7, '第 8 天仍封顶 7 分');
  assert.equal(at(cells, back(1))!.todayRewardAfter, 7, '补 24 之后今天是第 9 天，照样 7 分');
  assert.equal(at(cells, T)!.streakDay, 1, '24 还空着 → 今天签是新链第 1 天');
  assert.equal(at(cells, back(6))!.streakDay, 1, '19 左边是断口 → 自己第 1 天，不受右边长链影响');
  assert.equal(at(cells, back(6))!.todayRewardAfter, 1, '只补 19 接不上 24 的断口');
});

test('MW10 signed 格分值恒为名义分：行上带的实发 points 不参与（Ruling 2026-10-25 改回名义分）', () => {
  // 22 曾被每日上限截断（名义 3 实拿 1）、24 是崩溃夹缝留下的 points:0。
  // 补差是按今天入账的聚合流水（makeup_topup），摊不回每天的 points，格子必须报名义规则分，
  // 否则每次补签重排都让被补的那一天少报（spec §5.1：钱的真相在积分明细页）。
  // 服务层投影已不读 points，这里**故意**把 points 塞进行里，钉死 planSigninCells 对实发值免疫。
  const rows = [
    { dateKey: back(3), streakDay: 3, points: 1 },
    { dateKey: back(2), streakDay: 4 },
    { dateKey: back(1), streakDay: 5, points: 0 },
  ] as unknown as SignedRow[];
  const cells = planSigninCells(rows, T);
  assert.equal(at(cells, back(3))!.reward, 3, '行里有实发 points=1 也报名义 min(3,7)，不被截断值改写');
  assert.equal(at(cells, back(2))!.reward, 4, '没带 points 的行同样按 min(streakDay,7)');
  assert.equal(at(cells, back(1))!.reward, 5, 'points:0 的夹缝行也报名义 5，实际分去明细页看');
  assert.deepEqual(
    [at(cells, back(3))!.streakDay, at(cells, back(2))!.streakDay, at(cells, back(1))!.streakDay],
    [3, 4, 5], 'streakDay 照库存值下发');
  assert.equal(at(cells, T)!.reward, 6, 'today 格是「签了能拿几分」，仍是名义值');
});
