import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcStats } from '../src/utils/pace.js';

/** 构造轨迹点（lat 每 0.0002° ≈ 22m，保证距离有效） */
const pts = (alts: (number | null)[], pauseGaps: number[] = []) =>
  alts.map((altitude, i) => ({
    lat: 30 + i * 0.0002,
    lng: 120,
    altitude,
    pauseGap: pauseGaps.includes(i),
    timestamp: (i + 1) * 5000,
  }));

test('爬升：缓坡连续上升可持续累计（旧单步死区会整体漏计）', () => {
  const r = calcStats(pts(Array.from({ length: 20 }, (_, i) => 100 + i * 0.5)), {
    type: 'hiking',
    durationSec: 100,
  });
  assert.ok(r.elevationGain >= 6 && r.elevationGain <= 10, `缓坡 +10m 应计入大部分，实际 ${r.elevationGain}`);
});

test('爬升：零均值噪声上下抵消，不累计', () => {
  const alts: number[] = [];
  for (let i = 0; i < 12; i++) alts.push(i % 2 === 0 ? 100 : 105);
  const r = calcStats(pts(alts), { type: 'hiking', durationSec: 60 });
  assert.equal(r.elevationGain, 0);
});

test('爬升：暂停恢复点（pauseGap）海拔漂移不参与差值', () => {
  // 第 5 个点是暂停恢复点：漂移 +30m 应重置爬升状态而非计入
  const alts = [100, 100.5, 101, 101.5, 131.5, 132, 132.5];
  const r = calcStats(pts(alts, [4]), { type: 'hiking', durationSec: 60 });
  assert.ok(r.elevationGain < 1, `暂停漂移不应计入，实际 ${r.elevationGain}`);
});

test('海拔：minAltitude/maxAltitude 取原始点极值', () => {
  const r = calcStats(pts([100.4, null, 102.6, 99.2, 105.8]), { type: 'hiking', durationSec: 20 });
  assert.equal(r.minAltitude, 99);
  assert.equal(r.maxAltitude, 106);
});

test('海拔：无海拔点时 min/max 为 null', () => {
  const r = calcStats(pts([null, null]), { type: 'walking', durationSec: 60 });
  assert.equal(r.minAltitude, null);
  assert.equal(r.maxAltitude, null);
});
