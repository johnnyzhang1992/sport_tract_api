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

test('still：静止段照计入分段用时（跑 1km 中途停下休息，那一公里就是更慢）', () => {
  // 同一几何两版：中间在 500m 处站 40s。行业口径（Keep/华为的分段）按经过时间算，
  // 把静止时间剔掉会奖励"km 中途停车"——线上那条因此从 3'41" 变成 2'32"，方向是反的。
  const build = (markStill: boolean): TrackPointLike[] => {
    const pts = walk(500, 100, 30); // 0..500m，5 段 × 30s = 150s
    let ts = (pts[pts.length - 1].timestamp ?? 0) + 0;
    for (let k = 0; k < 9; k++) {
      pts.push({ ...pt(500, ts), still: markStill });
      ts += 5000;
    }
    // 继续跑：600..1000m，正常 30s 采样节奏
    let t = (pts[pts.length - 1].timestamp ?? 0) + 30000;
    for (let m = 600; m <= 1000; m += 100) {
      pts.push(pt(m, t));
      t += 30000;
    }
    return pts;
  };
  assert.equal(calcFastestKm(build(false), 'running'), 340, '不打标记时含这 40s');
  assert.equal(calcFastestKm(build(true), 'running'), 340, '打了 still 也照样含——静止照计时间');
});

test('vehicle：车速段的位移与时间一律不计，且断段（"坐车 1km"绝不能成分段配速）', () => {
  // 第 1 个 1km 真跑（400 s/km）；第 2 个 1km 是 12 m/s 的车速段（200 s/km）
  const run = walk(1000, 100, 40);
  const car = walk(900, 100, 20, 1100, 420000).map((p) => ({ ...p, vehicle: true }));
  assert.equal(
    calcFastestKm([...run, ...car], 'running'),
    400,
    '车速段要断段：剩下的真跑段才是最快 1km',
  );
  // 对照：同样几何不打标记时，那段就是刷出来的假 PR
  assert.equal(
    calcFastestKm([...run, ...car.map((p) => ({ ...p, vehicle: undefined }))], 'running'),
    200,
    '不打 vehicle 时车速段会占据最快 1km',
  );
  // 只有车速段时：没有任何真实 1km 可算
  assert.equal(calcFastestKm(car, 'running'), null);
});

test('游泳/骑行无配速', () => {
  assert.equal(calcFastestKm(walk(2000, 100, 30), 'swimming'), null);
  assert.equal(calcFastestKm(walk(2000, 100, 30), 'cycling'), null);
  // 不传 type 时按有配速处理
  assert.equal(typeof calcFastestKm(walk(1000, 100, 30)), 'number');
});
