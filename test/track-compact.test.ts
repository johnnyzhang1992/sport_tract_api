import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactTrackPoints, normalizeTrackPoints } from '../src/utils/track-compact.js';
import { cleanTrajectory } from '../src/utils/trajectory-clean.js';
import { cleanAltitudeSpikes } from '../src/utils/altitude-clean.js';
import { smoothTrackSmart } from '../src/utils/smooth.js';
import { haversineDistance } from '../src/utils/pace.js';

const START = 1790425000000;

/** 构造管线输出的点（绝对时间戳、全字段；步行步长 4.5m/3s ≈ 1.5m/s） */
function pipelinePoints(n = 50) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push({
      seq: i + 1,
      lat: 30.5 + i * 0.0000405,
      lng: 114.4 + i * 0.0000405,
      altitude: 36 + (i % 5) * 0.4,
      speed: 1.5 + (i % 3) * 0.2,
      accuracy: 12,
      timestamp: START + i * 3000,
      ...(i === 10 ? { pauseGap: true } : {}),
      ...(i === 20 ? { still: true } : {}),
      ...(i === 30 ? { vehicle: true } : {}),
      ...(i === 40 ? { gapJump: true } : {}),
    });
  }
  return pts;
}

test('紧凑化：字段瘦身 + 相对时间 + 稀疏布尔', () => {
  const pts = pipelinePoints();
  const compact = compactTrackPoints(pts, START);

  assert.equal(compact.length, pts.length);
  // 坐标 7 位小数
  assert.equal(compact[0].lat, Number((30.5).toFixed(7)));
  // 相对时间（首点 ts=0）
  assert.equal(compact[0].timestamp, 0);
  assert.equal(compact[30].timestamp, 30 * 3000);
  // speed 保留（1 位小数）
  assert.equal(compact[1].speed, 1.7);
  // 稀疏布尔：false 不写字段，true 写入
  assert.ok(!('pauseGap' in compact[0]));
  assert.equal(compact[10].pauseGap, true);
  assert.equal(compact[20].still, true);
  assert.equal(compact[30].vehicle, true);
  assert.ok(!('vehicle' in compact[0]));
  assert.equal(compact[40].gapJump, true, '断档连线标记也要稀疏写入');
  assert.ok(!('gapJump' in compact[0]));
  // 无 altitude/accuracy 的点省略字段
  const bare = compactTrackPoints([{ seq: 1, lat: 30.5, lng: 114.4, timestamp: START + 5000 }], START);
  assert.ok(!('altitude' in bare[0]) && !('accuracy' in bare[0]) && !('speed' in bare[0]));
});

test('往返：管线点 → 紧凑 → 归一化，与原点等价（时间可还原）', () => {
  const pts = pipelinePoints(40);
  // 先过一遍管线（平滑改坐标），模拟真实流转
  const smoothed = smoothTrackSmart(cleanTrajectory(cleanAltitudeSpikes(pts), {}, 'walking'), 5, haversineDistance);
  const compact = compactTrackPoints(smoothed, START);
  const restored = normalizeTrackPoints(compact as unknown as Array<Record<string, unknown>>, START);

  assert.equal(restored.length, smoothed.length);
  for (let i = 0; i < restored.length; i++) {
    assert.equal(restored[i].timestamp, smoothed[i].timestamp, `点${i} 时间戳应还原`);
    assert.ok(Math.abs(restored[i].lat - smoothed[i].lat) < 1e-7, `点${i} 纬度 7 位内一致`);
    assert.equal(restored[i].pauseGap, smoothed[i].pauseGap === true);
    assert.equal(restored[i].vehicle, smoothed[i].vehicle === true);
    assert.equal(restored[i].gapJump, smoothed[i].gapJump === true);
  }
});

test('紧凑点直接进纠偏管线：dt 差值不受相对时间影响', () => {
  const pts = pipelinePoints(30);
  const compact = compactTrackPoints(pts, START);
  // 同一批点：绝对时间戳 vs 相对时间戳，清洗结果应完全一致（规则只用 dt 差值）
  const fromAbs = cleanTrajectory(cleanAltitudeSpikes(pts), {}, 'walking');
  const fromRel = cleanTrajectory(cleanAltitudeSpikes(compact as never as typeof pts), {}, 'walking');
  assert.equal(fromRel.length, fromAbs.length);
  for (let i = 0; i < fromAbs.length; i++) {
    assert.equal(fromRel[i].lat.toFixed(7), fromAbs[i].lat.toFixed(7), `点${i} 位置一致`);
  }
});

test('旧格式点（绝对时间戳）走 normalize 原样透传', () => {
  const legacy = [
    { seq: 1, lat: 30.5, lng: 114.4, altitude: 36.7, speed: 1.7, accuracy: 14, pauseGap: false, still: false, vehicle: false, timestamp: START },
  ];
  const restored = normalizeTrackPoints(legacy as unknown as Array<Record<string, unknown>>, START - 5000);
  assert.equal(restored[0].timestamp, START, '绝对时间戳原样（不受 startTime 干扰）');
  assert.equal(restored[0].speed, 1.7);
  assert.equal(restored[0].pauseGap, false);
});

test('收益：紧凑格式显著小于旧格式', () => {
  const pts = pipelinePoints(100);
  const compact = compactTrackPoints(pts, START);
  const sizeOf = (arr: unknown[]) => JSON.stringify(arr).length;
  const oldSize = sizeOf(pts.map((p) => ({ ...p, pauseGap: false, still: false, vehicle: false })));
  const newSize = sizeOf(compact);
  const ratio = newSize / oldSize;
  assert.ok(ratio < 0.75, `紧凑格式应 ≤ 旧格式 75%（实际 ${(ratio * 100).toFixed(1)}%）`);
});
