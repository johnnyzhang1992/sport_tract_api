import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simplifyTracks, gridHeat, type LatLng } from '../src/utils/simplify.js';

/** 构造一条折线轨迹（沿路径带弯） */
function makeTrack(step = 0.001): LatLng[] {
  const pts: LatLng[] = [];
  for (let i = 0; i < 200; i++) {
    // 先向东 100 步，再直角转弯向北 100 步
    if (i < 100) {
      pts.push({ lat: 31.23, lng: 121.47 + i * step });
    } else {
      pts.push({ lat: 31.23 + (i - 100) * step, lng: 121.47 + 100 * step });
    }
  }
  return pts;
}

test('DP 抽稀：点数大幅下降且保留首尾与形状拐点', () => {
  const track = makeTrack();
  const result = simplifyTracks([track], { maxPoints: 3000, maxPerTrack: 50 });
  assert.equal(result.length, 1);
  const pts = result[0];
  assert.ok(pts.length <= 50, `应 ≤50 点，实际 ${pts.length}`);
  assert.ok(pts.length >= 2);
  // 首尾保留
  assert.deepEqual(pts[0], track[0]);
  assert.deepEqual(pts[pts.length - 1], track[track.length - 1]);
  // 拐点（90° 转弯处）应保留：找最接近 (31.23, 121.47+100*step) 的点
  const corner = { lat: 31.23, lng: 121.47 + 100 * 0.001 };
  const closest = pts.reduce((best, p) => {
    const d = Math.hypot(p.lat - corner.lat, p.lng - corner.lng);
    return d < best.d ? { d, p } : best;
  }, { d: Infinity, p: null as LatLng | null });
  assert.ok(closest.d < 0.002, `拐点应被保留（最近距离 ${closest.d.toFixed(4)}）`);
});

test('全局预算：多条轨迹总点数不超过预算，每条至少 2 点', () => {
  const tracks = Array.from({ length: 10 }, (_, i) => makeTrack(0.001 + i * 0.0001));
  const result = simplifyTracks(tracks, { maxPoints: 100, maxPerTrack: 100 });
  const total = result.reduce((s, t) => s + t.length, 0);
  assert.ok(total <= 100, `总点数 ${total} 应 ≤ 100`);
  for (const t of result) {
    assert.ok(t.length >= 2, '每条至少 2 点');
  }
});

test('热力网格：多点汇聚同一网格时权重高，结果 ≤ maxCells 且 0~1 归一化', () => {
  // 10 条轨迹都经过同一片区 → 该网格 weight 应为 1
  const base = makeTrack();
  const tracks = Array.from({ length: 10 }, () => base);
  const heat = gridHeat(tracks, 150, 50);
  assert.ok(heat.length > 0 && heat.length <= 50);
  const max = heat.reduce((s, h) => Math.max(s, h.weight), 0);
  assert.equal(max, 1, '最高权重应为 1');
  for (const h of heat) {
    assert.ok(h.weight >= 0 && h.weight <= 1);
  }
});

test('空轨迹/单点：安全返回', () => {
  assert.deepEqual(simplifyTracks([], {}), []);
  const single = simplifyTracks([[{ lat: 31, lng: 121 }]], {});
  assert.deepEqual(single, [[{ lat: 31, lng: 121 }]]);
  assert.deepEqual(gridHeat([], 150, 50), []);
});
