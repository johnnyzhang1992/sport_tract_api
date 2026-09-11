import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcFastestKm, type TrackPointLike } from '../src/utils/pace.js';

/**
 * 最快配速（fastestKm）单测：
 * - 必须跑满 1km 才计入；不足 1km 返回 null（不能用短距离外推成 1km 配速）
 * - 暂停恢复点（pauseGap）/ 点间隔 >60s 的断档不跨段（旧实现把距离计入、时间置 0，会刷出假 PR）
 * - 尾段不足 1km 剔除
 * - 游泳/骑行无配速概念
 */

/** 与 haversine 同源：纯纬度递增，保证两点实测距离 = 传入米数 */
const DEG_PER_M = 180 / (Math.PI * 6371000);
const pt = (m: number, ts: number, pauseGap = false): TrackPointLike => ({
  lat: m * DEG_PER_M,
  lng: 0,
  timestamp: ts,
  pauseGap,
});

/** 沿直线匀速走 totalM 米，每 stepM 打一个点，每点间隔 secPerStep 秒（timestamp 为毫秒） */
function walk(totalM: number, stepM: number, secPerStep: number, startM = 0, startTs = 0, pause = false): TrackPointLike[] {
  const out: TrackPointLike[] = [];
  for (let m = startM; m <= startM + totalM + 1e-6; m += stepM) {
    out.push(pt(m, startTs + Math.round(((m - startM) / stepM) * secPerStep * 1000), pause && m === startM));
  }
  return out;
}

test('不足 1km：返回 null（不得外推成 1km 配速）', () => {
  assert.equal(calcFastestKm(walk(900, 100, 30), 'running'), null);
  assert.equal(calcFastestKm(walk(999, 100, 30), 'running'), null);
  assert.equal(calcFastestKm([], 'running'), null);
  assert.equal(calcFastestKm([pt(0, 0)], 'running'), null);
});

test('恰好 1km：按实际配速计入', () => {
  // 10 段 × 100m，每段 30s → 1000m / 300s = 300 s/km
  const fk = calcFastestKm(walk(1000, 100, 30), 'running');
  assert.equal(fk, 300);
});

test('多段取最快；尾段不足 1km 剔除', () => {
  // 第 1 个 1km：每段 40s（400 s/km）；第 2 个 1km：每段 24s（240 s/km）；尾段 500m 不计
  const pts: TrackPointLike[] = [];
  let ts = 0;
  for (let m = 0; m <= 1000; m += 100) {
    pts.push(pt(m, ts));
    ts += m < 1000 ? 40000 : 0;
  }
  for (let m = 1100; m <= 2000; m += 100) {
    ts += 24000;
    pts.push(pt(m, ts));
  }
  for (let m = 2100; m <= 2600; m += 100) {
    ts += 30000;
    pts.push(pt(m, ts));
  }
  assert.equal(calcFastestKm(pts, 'running'), 240);
});

test('pauseGap：跨暂停的距离/时间不计，不产生假 PR', () => {
  // 先正常跑完 1km（300 s/km）
  const pts = walk(1000, 100, 30);
  const last = pts[pts.length - 1];
  // 暂停后瞬移到 3km 处（跨 2km），若被计入会得到 2.5 s/km 的荒谬配速
  pts.push(pt(3000, (last.timestamp ?? 0) + 5000, true));
  assert.equal(calcFastestKm(pts, 'running'), 300);
});

test('点间隔 >60s：视为断档，同样不跨段', () => {
  const pts = walk(1000, 100, 30);
  const last = pts[pts.length - 1];
  pts.push(pt(3000, (last.timestamp ?? 0) + 120000)); // 120s 无点，未带 pauseGap
  assert.equal(calcFastestKm(pts, 'running'), 300);
});

test('游泳/骑行无配速', () => {
  assert.equal(calcFastestKm(walk(2000, 100, 30), 'swimming'), null);
  assert.equal(calcFastestKm(walk(2000, 100, 30), 'cycling'), null);
  // 不传 type 时按有配速处理
  assert.equal(typeof calcFastestKm(walk(1000, 100, 30)), 'number');
});
