import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcPbMarks, type TrackPointLike } from '../src/utils/pace.js';

/**
 * 距离里程碑 PB（calcPbMarks）单测：5/10/15…公里每 5km 一项到达用时
 * 断点规则与 calcFastestKm 同款：暂停恢复点（pauseGap）/>60s 断档/车速段（vehicle）
 * 跨越的距离与时间都不计；静止段（still）照计时间
 */

/** 与 haversine 同源：纯纬度递增，保证两点实测距离 = 传入米数 */
const DEG_PER_M = 180 / (Math.PI * 6371000);
const pt = (m: number, ts: number, extra: Partial<TrackPointLike> = {}): TrackPointLike => ({
  lat: m * DEG_PER_M,
  lng: 0,
  timestamp: ts,
  ...extra,
});

/** 沿直线匀速走 totalM 米，每 stepM 打一个点，每点间隔 secPerStep 秒（timestamp 为毫秒） */
function walk(totalM: number, stepM: number, secPerStep: number, startM = 0, startTs = 0): TrackPointLike[] {
  const out: TrackPointLike[] = [];
  for (let m = startM; m <= startM + totalM + 1e-6; m += stepM) {
    out.push(pt(m, startTs + Math.round(((m - startM) / stepM) * secPerStep * 1000)));
  }
  return out;
}

test('不足 5km：无里程碑（不得用部分距离外推）', () => {
  assert.deepEqual(calcPbMarks(walk(4900, 100, 30)), []);
  assert.deepEqual(calcPbMarks([]), []);
  assert.deepEqual(calcPbMarks([pt(0, 0)]), []);
});

test('恰好 5km：一个里程碑，用时 = 匀速耗时', () => {
  // 300 s/km 匀速 → 5km = 1500s
  assert.deepEqual(calcPbMarks(walk(5000, 100, 30)), [{ km: 5, sec: 1500 }]);
});

test('每 5km 一个记录：10.5km → 两个里程碑', () => {
  assert.deepEqual(calcPbMarks(walk(10500, 100, 30)), [
    { km: 5, sec: 1500 },
    { km: 10, sec: 3000 },
  ]);
});

test('里程碑时刻按距离比例插值（跨越点不在整数 5km 上）', () => {
  // 步长 105m：5km 落在第 47.619 步，用时 47.619 × 30s ≈ 1428.6s
  const marks = calcPbMarks(walk(5040, 105, 30));
  assert.equal(marks.length, 1);
  assert.equal(marks[0].km, 5);
  assert.ok(Math.abs(marks[0].sec - 1428.6) <= 1, `插值用时应为 ~1429s，实际 ${marks[0].sec}`);
});

test('pauseGap：跨暂停的位移/时间不计，暂停前的里程碑照常产出', () => {
  // 跑完 5km（1500s）后暂停瞬移到 6km：km5 照记，且不产生任何额外里程碑
  const pts = walk(5000, 100, 30);
  const last = pts[pts.length - 1];
  pts.push(pt(6000, (last.timestamp ?? 0) + 5000, { pauseGap: true }));
  assert.deepEqual(calcPbMarks(pts), [{ km: 5, sec: 1500 }]);
});

test('still：静止休息照计进里程碑用时（跑 5km 中途站 40s 就是慢 40s）', () => {
  const pts = walk(2500, 100, 30); // 前 2.5km / 750s
  let ts = (pts[pts.length - 1].timestamp ?? 0) + 0;
  for (let k = 0; k < 8; k++) {
    pts.push({ ...pt(2500, ts), still: true }); // 站 40s
    ts += 5000;
  }
  for (let m = 2600; m <= 5000; m += 100) {
    ts += 30000;
    pts.push(pt(m, ts)); // 后 2.5km / 750s
  }
  assert.deepEqual(calcPbMarks(pts), [{ km: 5, sec: 1540 }]);
});

test('vehicle：车速段跨越里程碑时不产出假纪录', () => {
  // 真跑 5km（1500s）后坐车从 5.1km 到 6km：车速段位移/时间不计，不产生新里程碑
  const run = walk(5000, 100, 30);
  const car = walk(900, 100, 20, 5100, 1510000).map((p) => ({ ...p, vehicle: true }));
  assert.deepEqual(calcPbMarks([...run, ...car]), [{ km: 5, sec: 1500 }]);
});
