import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  markStandstill,
  STANDSTILL_RADIUS_M,
  STANDSTILL_MIN_SEC,
  STANDSTILL_MIN_POINTS,
} from '../src/utils/standstill.js';

/**
 * 静止时段检测（自动暂停口径）单测
 *
 * 口径：停留点（stay point）检测——以某点为锚向后扩展，与锚点距离 ≤ 10m 且不跨手动暂停/断档；
 * 扩展时长 ≥ 60s 且点数 ≥ 3 才判为静止，这些点打 still 标记、时长计入 standstillMs。
 *
 * 为什么 ≥3 个点：实测 899 点那条轨迹里 16 段「停留」有 14 段只有 2 个点（两点相隔 40–120s），
 * 那不是检测到静止，是这段时间没采到点——凭它删时间等于猜。
 *
 * 为什么门槛是 60s 而不是华为的 10s：手机 GPS 只有坐标没有加速度计，「站住不动在漂」与
 * 「0.2 m/s 缓挪」的点序列同构，只能用「多长的静止才算休息」表达产品口径。dev 库 9.31km 徒步
 * 实测代价：30s/15m 扣 3281s（63 段，占墙钟 29%，平均每 3 分钟一段，明显偏大）；
 * 60s/10m → 1105s（8 段），且跑步/散步的短停不再被扣。见下方三条门槛/半径用例。
 */

/** 纯纬度递增：lat = m * DEG_PER_M 时，两点实测距离 = 传入米数 */
const DEG_PER_M = 180 / (Math.PI * 6371000);
const pt = (m: number, ts: number, extra: Record<string, unknown> = {}) => ({
  lat: m * DEG_PER_M,
  lng: 0,
  timestamp: ts,
  ...extra,
});

/** 在原地停留 totalSec 秒，每 stepSec 一个点，抖动幅度 jitterM（往返两点之间） */
function stay(totalSec: number, stepSec = 5, jitterM = 3) {
  const out = [];
  for (let t = 0; t <= totalSec; t += stepSec) out.push(pt(t % (stepSec * 2) === 0 ? 0 : jitterM, t * 1000));
  return out;
}

/** 沿直线匀速 mps 米/秒走 totalSec 秒，每 stepSec 一个点 */
function move(mps: number, totalSec: number, stepSec = 2, startM = 0, startTs = 0) {
  const out = [];
  for (let t = 0; t <= totalSec; t += stepSec) {
    out.push(pt(startM + mps * t, startTs + t * 1000));
  }
  return out;
}

test('够门槛：停留 70s、15 个点、抖动 3m → 判静止，点打 still、时长入库', () => {
  const pts = stay(70);
  const r = markStandstill(pts);
  assert.equal(r.standstillMs, 70000);
  assert.equal(r.spans, 1);
  assert.ok(r.points.every((p) => p.still === true), '段内每个点都应带 still');
  assert.equal(r.points.length, pts.length, '不改点数，只加标记');
});

test('不足门槛：只停 50s → 不判（本轮把门槛 30s 提到 60s 的依据）', () => {
  const r = markStandstill(stay(50));
  assert.equal(r.standstillMs, 0);
  assert.ok(r.points.every((p) => p.still !== true));
});

test('恰好达到门槛（60s）→ 判；差 10s → 不判（边界含等号）', () => {
  assert.equal(markStandstill(stay(STANDSTILL_MIN_SEC, 5)).standstillMs, STANDSTILL_MIN_SEC * 1000);
  assert.equal(markStandstill(stay(STANDSTILL_MIN_SEC - 10, 5)).standstillMs, 0);
});

test('点数 < 3：两点相隔 70s 落在半径内 → 不判（没采到点 ≠ 静止）', () => {
  const pts = [pt(0, 0), pt(2, 70000)];
  const r = markStandstill(pts);
  assert.equal(r.standstillMs, 0, '只有 2 个点没有证据，不能凭它删时间');
  assert.equal(r.points.length, 2);
  assert.ok(pts.length >= STANDSTILL_MIN_POINTS - 1);
});

test('半径 10m：抖动 12m 已出圈 → 不判（半径收紧的代价，钉住防止被无声改回）', () => {
  const r = markStandstill(stay(120, 5, 12));
  assert.equal(r.standstillMs, 0);
});

test('超出半径：匀速直线行进不判（半径就是几何判据）', () => {
  const r = markStandstill(move(4, 600)); // 4 m/s，2s 一采 → 8m/步，两步就出圈
  assert.equal(r.standstillMs, 0);
});

test('连续运动零误伤：匀速 2.4 m/s 跑 20 分钟 → 0s', () => {
  const r = markStandstill(move(2.4, 1200));
  assert.equal(r.standstillMs, 0);
  assert.equal(r.spans, 0);
});

test('慢走（1.2 m/s）也不判：10m 圈 9s 就出，够不到 60s 门槛', () => {
  assert.equal(markStandstill(move(1.2, 600, 3)).standstillMs, 0);
});

test('不跨手动暂停：暂停两侧各停 50s，合计 100s 也不合并成一段', () => {
  const pts = [...stay(50), ...stay(50).map((p, i) => ({ ...p, timestamp: p.timestamp + 70000, pauseGap: i === 0 }))];
  const r = markStandstill(pts);
  assert.equal(r.standstillMs, 0, '两侧各 50s 都不足门槛，且不得跨暂停合并');
});

test('不跨断档：点间隔 >120s 的两段各 70s，按两段算（不许回溯合并成 670s）', () => {
  const block = (ts0: number) => stay(70).map((p) => ({ ...p, timestamp: p.timestamp + ts0 }));
  const r = markStandstill([...block(0), ...block(670000)]);
  assert.equal(r.standstillMs, 140000);
  assert.equal(r.spans, 2);
});

test('多段停留累加；起跑前与到终点后的静止都算', () => {
  // 停留位置与前后行进段都要隔开 >10m，否则静止段会自然延伸进相邻行进段的头几个点
  // （人还没走出圈，这本身是正确行为，只是会让「恰好等于停留本身时长」的断言不成立）
  const phase = (baseM: number, sec: number, ts0: number) =>
    stay(sec, 5, 3).map((p) => ({ ...p, lat: baseM * DEG_PER_M, timestamp: p.timestamp + ts0 }));
  const pts = [
    ...phase(0, 70, 0), // 起跑前站 70s
    ...move(2.4, 300, 2, 500, 70000), // 跑 300s（起点离停留位置 500m）
    ...phase(2000, 75, 370000), // 中途停 75s
    ...move(2.4, 300, 2, 3000, 445000), // 再跑 300s
    ...phase(5000, 65, 745000), // 到终点后站 65s
  ];
  const r = markStandstill(pts);
  assert.equal(r.standstillMs, (70 + 75 + 65) * 1000);
  assert.equal(r.spans, 3);
});

test('still 标记只落在静止段内，行进段的点不受影响', () => {
  const still = stay(70);
  const walk = move(2.4, 300, 2, 800, 70000); // 起点跳到 800m 外
  const r = markStandstill([...still, ...walk]);
  assert.ok(r.points.slice(0, still.length).every((p) => p.still === true));
  assert.ok(r.points.slice(still.length).every((p) => p.still !== true));
});

test('清掉旧的 still 标记：重跑不残留（回填脚本可重跑的前提）', () => {
  const pts = [
    ...stay(70),
    ...move(2.4, 300, 2, 800, 70000).map((p) => ({ ...p, still: true })),
  ];
  const r = markStandstill(pts);
  assert.ok(r.points.slice(0, stay(70).length).every((p) => p.still === true));
  assert.ok(
    r.points.slice(stay(70).length).every((p) => p.still !== true),
    '传入时带的 still 必须被清掉，否则门槛改小后旧标记会留在库里',
  );
});

test('三维判据：原地不动但海拔持续升 12m → 不判（人在爬坡，坐标不出圈但海拔在变）', () => {
  const pts = [];
  for (let t = 0; t <= 70; t += 5) pts.push(pt(0, t * 1000, { altitude: (t / 70) * 12 }));
  assert.equal(markStandstill(pts).standstillMs, 0, '水平不出圈、但净升 12m，属爬坡不是静止');
});

test('三维判据：海拔有 ±4m 噪声、水平抖 3m → 仍判静止（噪声不误杀真休息）', () => {
  const pts = [];
  for (let t = 0; t <= 70; t += 5) {
    const edge = t % 10 === 0;
    pts.push(pt(edge ? 0 : 3, t * 1000, { altitude: edge ? 0 : 4 }));
  }
  assert.equal(markStandstill(pts).standstillMs, 70000, '三维距离 √(3²+4²)=5m < 10m，是休息');
});

test('三维判据：水平 6m + 垂直 8m = 10m 恰好等于半径 → 判（含等号）；水平 7m → 不判', () => {
  const build = (hM: number) => {
    const out = [];
    for (let t = 0; t <= 70; t += 5) {
      const edge = t % 10 === 0;
      out.push(pt(edge ? 0 : hM, t * 1000, { altitude: edge ? 0 : 8 }));
    }
    return out;
  };
  assert.equal(markStandstill(build(6)).standstillMs, 70000);
  assert.equal(markStandstill(build(7)).standstillMs, 0);
});

test('三维判据：海拔缺失（或 null）时退化为水平距离；部分点带海拔时不影响结论', () => {
  assert.equal(markStandstill(stay(70)).standstillMs, 70000, '完全无 altitude 字段 → 水平判据');
  assert.equal(
    markStandstill(stay(70).map((p) => ({ ...p, altitude: null }))).standstillMs,
    70000,
    'altitude 为 null → 水平判据',
  );
  // 部分点带海拔（且两端都有海拔的那一步高度相同）→ 与水平判据同结论
  const partial = stay(70).map((p, i) => (i % 2 === 0 ? { ...p, altitude: 100 } : p));
  assert.equal(markStandstill(partial).standstillMs, 70000);
});

test('空数组 / 单点 / 无时间戳 → 0，且不抛', () => {
  assert.equal(markStandstill([]).standstillMs, 0);
  assert.equal(markStandstill([pt(0, 0)]).standstillMs, 0);
  assert.equal(markStandstill([{ lat: 0, lng: 0 }]).standstillMs, 0);
});

test('已知边界（几何下限）：净速度 < 半径/门槛 ≈ 0.167 m/s 的极慢移动会被判静止', () => {
  // 0.1 m/s 走 600s：10m 圈要 100s 才出，于是每 100s 形成一段 → 被判静止
  const r = markStandstill(move(0.1, 600, 5));
  assert.ok(r.standstillMs > 0, '这是刻意接受的代价：门槛×最慢真实速度必须大于半径，否则一律误伤');
  assert.equal(STANDSTILL_RADIUS_M, 10);
  assert.equal(STANDSTILL_MIN_SEC, 60);
});
