import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  markVehicle,
  VEHICLE_MIN_SPEED_MPS,
  VEHICLE_MIN_SEC,
  VEHICLE_MIN_STEPS,
  VEHICLE_MAX_SLOW_STEPS,
  VEHICLE_TYPES,
} from '../src/utils/vehicle.js';
import type { TrackPointLike } from '../src/utils/pace.js';

/**
 * 非运动段（疑似乘车）检测单测
 *
 * 判据口径（2026-09-24 与用户拍板）：连续 ≥6.5 m/s（23.4 km/h）保持 ≥60s、≥5 步，
 * 段内允许穿插 ≤2 个慢步（等红灯/让行不足以说明"人又开始动了"）。
 * 阈值是拿线上那条 3'41" 的真实轨迹反推出来的：那段"被运过去"的位移逐步速度在 6.0–7.5 m/s 之间摆动，
 * 严格连续判据只会切出 34s 碎段（见 scripts/tmp-prod-envelope.ts），所以必须容错穿插。
 */

/** 轨迹构造：按「每段速度 + 时长」生成一条直线轨迹 */
function buildTrack(legs: [number, number][], startTs = 1_790_000_000_000, stepSec = 2): TrackPointLike[] {
  let lat = 30;
  let ts = startTs;
  const pts: TrackPointLike[] = [{ lat, lng: 114, timestamp: ts }];
  for (const [mps, sec] of legs) {
    const steps = Math.round(sec / stepSec);
    const dLat = (mps * stepSec) / 111_194.9;
    for (let i = 0; i < steps; i++) {
      lat += dLat;
      ts += stepSec * 1000;
      pts.push({ lat, lng: 114, timestamp: ts });
    }
  }
  return pts;
}

test('车速段：跑步中连续 60s 保持 8 m/s → 判非运动段，时长/位移/点标记一起出', () => {
  const pts = buildTrack([
    [3, 40], // 慢跑
    [8, 60], // 车速段
    [3, 40], // 慢跑
  ]);
  const { points, vehicleMs, vehicleM, spans } = markVehicle(pts, 'running');
  assert.equal(spans, 1);
  assert.equal(vehicleMs, 60_000);
  assert.ok(Math.abs(vehicleM - 480) < 3, `位移应≈480m，实际 ${vehicleM}`);
  assert.equal(points.filter((p) => p.vehicle).length, 30, '车速段 30 步打标');
  // 标记落在正确的区间：慢跑段首尾点不标
  assert.equal(points[0].vehicle, undefined);
  assert.equal(points[points.length - 1].vehicle, undefined);
});

test('只持续 30s 的高速段不判（60s 门槛：冲坡/冲刺下坡不该被当乘车）', () => {
  const { spans, vehicleMs } = markVehicle(
    buildTrack([
      [3, 20],
      [8, 30],
      [3, 20],
    ]),
    'running',
  );
  assert.equal(spans, 0);
  assert.equal(vehicleMs, 0);
});

test('门槛含等号：恰好 60s 且恰好 6.5 m/s → 判；6.4 m/s → 不判', () => {
  const at = markVehicle(buildTrack([[6.5, 60]]), 'running');
  assert.equal(at.spans, 1);
  assert.equal(at.vehicleMs, 60_000);
  assert.equal(markVehicle(buildTrack([[6.4, 60]]), 'running').spans, 0, '低于速度门槛不判');
});

test('段内穿插 ≤2 个慢步（路口等红灯）→ 连成一段，停车那几秒也算非运动', () => {
  const pts = buildTrack([
    [8, 40],
    [0.2, 4], // 2 个慢步
    [8, 40],
  ]);
  const { spans, vehicleMs } = markVehicle(pts, 'running');
  assert.equal(spans, 1, '不合并的话两侧各 40s 都不达标，而这段确实是一趟车');
  assert.equal(vehicleMs, 84_000, '含中间等灯的 4s');
});

test('段内穿插 3 个以上慢步 → 判为人又重新动了，不合并；两侧各 44s 不足门槛就都不判', () => {
  const pts = buildTrack([
    [8, 44],
    [0.2, 6], // 3 个慢步
    [8, 44],
  ]);
  const { spans, vehicleMs } = markVehicle(pts, 'running');
  assert.equal(spans, 0);
  assert.equal(vehicleMs, 0);
});

test('慢步打断但两侧各超 60s → 判两段，中间那段停车不额外算车速', () => {
  const pts = buildTrack([
    [8, 64],
    [0.2, 6],
    [8, 64],
  ]);
  const { spans, vehicleMs } = markVehicle(pts, 'running');
  assert.equal(spans, 2);
  assert.equal(vehicleMs, 128_000);
});

test('人类类型才判：running/walking/hiking/mountaineering 四种都判', () => {
  const pts = buildTrack([[8, 60]]);
  for (const type of ['running', 'walking', 'hiking', 'mountaineering']) {
    assert.ok(VEHICLE_TYPES.includes(type), `${type} 应在人类类型清单里`);
    assert.equal(markVehicle(pts, type).spans, 1, `${type} 应判出车速段`);
  }
});

test('骑行/滑雪/划船/游泳一律不判（6.5 m/s 对这些类型是正常速度）', () => {
  const pts = buildTrack([[10, 120]]); // 10 m/s = 36 km/h 骑行很平常
  for (const type of ['cycling', 'skiing', 'rowing', 'swimming']) {
    assert.equal(markVehicle(pts, type).spans, 0, `${type} 不该判车速段`);
  }
  assert.equal(markVehicle(pts, undefined).spans, 0, '类型缺失按不判处理');
});

test('步数门槛：60s 只由 3 次粗采样定位凑成 → 不判（证据不足以删用户的量）', () => {
  const coarse = buildTrack([[12, 60]], 1_790_000_000_000, 20); // 3 步
  assert.equal(markVehicle(coarse, 'running').spans, 0);
  const denser = buildTrack([[12, 60]], 1_790_000_000_000, 10); // 6 步
  assert.equal(markVehicle(denser, 'running').spans, 1);
});

test('采样断档不跨段：单步 300s / 位移 2100m（速度刚好 7 m/s）是丢点不是持续高速', () => {
  const pts = [
    { lat: 30, lng: 114, timestamp: 1_790_000_000_000 },
    { lat: 30.0188859, lng: 114, timestamp: 1_790_000_300_000 }, // ≈2100m / 300s
    { lat: 30.0377718, lng: 114, timestamp: 1_790_000_600_000 },
  ];
  const { spans, vehicleMs } = markVehicle(pts, 'running');
  assert.equal(spans, 0);
  assert.equal(vehicleMs, 0);
});

test('手动暂停处断开：pauseGap 点之前的高速不跨到之后', () => {
  const pts = buildTrack([
    [8, 64],
    [8, 30],
  ]);
  pts[32].pauseGap = true; // 第 64s 处是暂停恢复点
  const { spans, vehicleMs } = markVehicle(pts, 'running');
  assert.equal(spans, 1, '暂停两侧各自成段，不跨暂停连起来');
  // 62s 而非 64s：带 pauseGap 的那个点是"暂停后恢复"的第一个点，它的入段位移跨过了暂停区间，
  // 本身就该断开不算，所以前一段只累计到它之前那一步。
  assert.equal(vehicleMs, 62_000, 'pauseGap 之前那段达标（不含跨暂停的那一步），之后的 30s 不足门槛');
});

test('清掉旧的 vehicle 标记：重跑不残留（回填脚本可重跑的前提）', () => {
  const pts = buildTrack([[8, 60]]).map((p, i) => ({ ...p, vehicle: i < 10 }));
  const first = markVehicle(pts, 'running');
  assert.equal(first.spans, 1);
  // 换成不判的类型重跑，旧标记必须被清空
  const again = markVehicle(first.points, 'cycling');
  assert.equal(again.spans, 0);
  assert.equal(again.points.filter((p) => p.vehicle).length, 0, '旧 vehicle 标记未清除');
});

test('空数组 / 单点 / 缺时间戳 → 0，且不抛', () => {
  assert.equal(markVehicle([], 'running').vehicleMs, 0);
  assert.equal(markVehicle([{ lat: 30, lng: 114, timestamp: 1 }], 'running').spans, 0);
  const noTs = buildTrack([[8, 60]]).map((p) => ({ lat: p.lat, lng: p.lng }));
  const r = markVehicle(noTs as never, 'running');
  assert.equal(r.spans, 0);
  assert.equal(r.vehicleMs, 0);
  assert.equal(r.vehicleM, 0);
});

test('阈值口径：贴着"城市车流"而不是"人类极限"，靠时长+步数+容错穿插三者一起兜误伤', () => {
  assert.equal(VEHICLE_MIN_SPEED_MPS, 6.5); // 23.4 km/h
  assert.equal(VEHICLE_MIN_SEC, 60);
  assert.equal(VEHICLE_MIN_STEPS, 5);
  assert.equal(VEHICLE_MAX_SLOW_STEPS, 2);
  // 6.5 m/s 低于男子 1km 世界纪录均速 7.63 m/s：单看速度会误伤极限冲刺，
  // 所以必须同时满足 ≥60s 与 ≥5 步——人跑不出 60 秒的 23.4 km/h，而车在等灯时会被切散
  assert.ok(VEHICLE_MIN_SPEED_MPS < 7.63, '速度门槛本身不足以排除人类，别把它当唯一判据');
});
