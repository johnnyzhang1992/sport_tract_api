import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTrajectory } from '../src/utils/trajectory-clean.js';

/** 构造正常步行轨迹：间隔 3s，速度 ~1.5m/s（向东走） */
function walkTrack(n = 20): Array<{ lat: number; lng: number; timestamp: number }> {
  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push({ lat: 30.5 + i * 0.00004, lng: 114.4 + i * 0.00004, timestamp: i * 3000 });
  }
  return pts;
}

test('尖刺点剔除：短时高速来回跳', () => {
  const pts = walkTrack();
  // 在中间插入尖刺：跳东 21m（1.3s）再跳回（模拟 15m/s 抖动）
  const spike = {
    lat: 30.5 + 5 * 0.00004 + 0.00019, // 东偏 ~21m
    lng: 114.4 + 5 * 0.00004,
    timestamp: 5 * 3000 + 1300,
  };
  const withSpike = [...pts.slice(0, 6), spike, ...pts.slice(6)];
  const cleaned = cleanTrajectory(withSpike);
  assert.equal(cleaned.length, pts.length, '应剔除 1 个尖刺点');
  // 剔除的是尖刺点（位置不在结果中）
  assert.ok(!cleaned.some((p) => p.timestamp === spike.timestamp), '尖刺点应被移除');
});

test('孤立离群点剔除：单点大跳（数十米级）', () => {
  const pts = walkTrack();
  // 插入孤立点：向南偏 ~50m
  const outlier = {
    lat: 30.5 + 5 * 0.00004 - 0.00045, // 南偏 ~50m
    lng: 114.4 + 5 * 0.00004,
    timestamp: 5 * 3000 + 1500,
  };
  const withOutlier = [...pts.slice(0, 6), outlier, ...pts.slice(6)];
  const cleaned = cleanTrajectory(withOutlier);
  assert.equal(cleaned.length, pts.length, '应剔除 1 个孤立点');
  assert.ok(!cleaned.some((p) => p.timestamp === outlier.timestamp));
});

test('正常轨迹不受影响（不误杀）', () => {
  const pts = walkTrack(30);
  const cleaned = cleanTrajectory(pts);
  assert.equal(cleaned.length, pts.length, '正常轨迹应全部保留');
});

test('真实骑行转弯不误杀：速度 8m/s 直角转弯', () => {
  // 骑行：先向东 8m/s，直角转弯向北 8m/s
  const pts = [];
  for (let i = 0; i < 12; i++) {
    pts.push({ lat: 30.5, lng: 114.4 + i * 0.000072, timestamp: i * 1000 });
  }
  for (let i = 1; i <= 10; i++) {
    pts.push({ lat: 30.5 + i * 0.000072, lng: 114.4 + 11 * 0.000072, timestamp: (11 + i) * 1000 });
  }
  const cleaned = cleanTrajectory(pts);
  // 转弯点（第 11 个点）速度 8m/s，局部中位也 8m/s → 比值 1 < 4，不误杀
  assert.equal(cleaned.length, pts.length, '骑行转弯点应保留');
});

test('边界：短轨迹/空数组安全', () => {
  assert.deepEqual(cleanTrajectory([]), []);
  const two = [{ lat: 30.5, lng: 114.4, timestamp: 0 }, { lat: 30.51, lng: 114.41, timestamp: 1000 }];
  assert.deepEqual(cleanTrajectory(two), two);
});

test('起点跳点剔除：起点 GPS 未收敛（首段 29m，其余 ~5m）', () => {
  const pts = walkTrack(15);
  // 起点在东北 29m 处（GPS 未收敛），点1 起为正常轨迹
  const shifted = [
    { lat: 30.5 + 0.00026, lng: 114.4 - 0.0001, timestamp: -1000 },
    ...pts.map((p) => ({ ...p, timestamp: p.timestamp + 1000 })),
  ];
  const cleaned = cleanTrajectory(shifted);
  assert.equal(cleaned.length, pts.length, '起点跳点应被剔除，其余保留');
  assert.ok(!cleaned.some((p) => Math.abs(p.lat - 30.50026) < 1e-6 && Math.abs(p.lng - 114.3999) < 1e-6), '跳点起点不在结果中');
});

test('尾点跳点剔除：结束时 GPS 漂移', () => {
  const pts = walkTrack(15);
  const tail = { lat: 30.5 + 14 * 0.00004 + 0.0003, lng: 114.4 + 14 * 0.00004, timestamp: 14 * 3000 + 500 };
  const withTail = [...pts.slice(0, 14), tail];
  const cleaned = cleanTrajectory(withTail);
  assert.equal(cleaned.length, 14, '尾跳点应被剔除');
});

// ==================== accuracy 精度因子（方案 12） ====================
// 场景要点（盲区的真实形态）：嘈杂轨迹步长 60m/5s（med≈10.3m/s → 现行离群阈值 max(25, 60×5)≈52m），
// 偏移 60m 的点现行规则阈值刚好够不到（acc=65 × 1.0 = 65 > 60 → accuracy 规则剔除；
// 现行规则 4 的 distLine 60.4 > 51.7 也会剔除——不构成区分，改用 acc=75：75×1.0=75 > 偏移 80？
// 最终场景：偏移 80m（0.00072°）> acc=75×1.0=75 → accuracy 剔除；现行规则同样剔除（80>51.7）——
// 区分度场景改由「偏移 60m、acc=75」表达：60 ≤ 75×1.0 → accuracy 保留；现行 60.4 > 51.7 剔除？——
// 见下方两组断言：以「有/无 accuracy 字段」的行为差异为准

/** 构造嘈杂骑行轨迹：步长 60m（0.00054°），间隔 5s（12 m/s ≈ 43km/h 公路骑行） */
function rideTrack(n = 12): Array<{ lat: number; lng: number; timestamp: number }> {
  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push({ lat: 30.5, lng: 114.4 + i * 0.00054, timestamp: i * 5000 });
  }
  return pts;
}

/** 嘈杂轨迹上中段插入点的基准：a=base[6]、c=base[7]，中点 lng = 114.4 + 6.5×0.00054 */
const MID_LNG = 114.4 + 6.5 * 0.00054;
const MID_LAT = 30.5;
const T_INSERT = 6 * 5000 + 2500; // 32500，base[6](30000) 与 base[7](35000) 之间

test('差精度点横向偏 51m：现行规则保留（阈值 51.7 被嘈杂步长抬高），accuracy 规则剔除', () => {
  const base = rideTrack(12);
  const drifted = {
    lat: MID_LAT + 0.00046, // 51.2m：> acc×1.0(50) → accuracy 剔；≤ 现行 outlierTh(51.7) → 现行不剔
    lng: MID_LNG,
    accuracy: 50,
    timestamp: T_INSERT,
  };
  const withDrift = [...base.slice(0, 7), drifted, ...base.slice(7)];
  const cleaned = cleanTrajectory(withDrift, {}, 'cycling');
  assert.equal(cleaned.length, withDrift.length - 1, '差精度漂移点应被 accuracy 规则剔除');
  assert.ok(!cleaned.some((p) => Math.abs(p.lat - drifted.lat) < 1e-9), '漂移点不在结果中');
});

test('差精度点小偏移（22m < accuracy×factor）：保留', () => {
  const base = rideTrack(12);
  const mild = {
    lat: MID_LAT + 0.0002, // 22.2m < 50
    lng: MID_LNG,
    accuracy: 50,
    timestamp: T_INSERT,
  };
  const withMild = [...base.slice(0, 7), mild, ...base.slice(7)];
  const cleaned = cleanTrajectory(withMild, {}, 'cycling');
  assert.equal(cleaned.length, withMild.length, '偏移在 accuracy 容忍内的点应保留');
});

test('好精度点（acc<50）同样偏 51m：不触发 accuracy 规则，行为与无 accuracy 一致', () => {
  const base = rideTrack(12);
  const goodAcc = {
    lat: MID_LAT + 0.00046,
    lng: MID_LNG,
    accuracy: 10,
    timestamp: T_INSERT,
  };
  const withGood = [...base.slice(0, 7), goodAcc, ...base.slice(7)];
  const cleaned = cleanTrajectory(withGood, {}, 'cycling');
  const noAcc = withGood.map((p) => {
    const { accuracy: _acc, ...rest } = p as typeof p & Record<string, unknown>;
    return rest;
  });
  assert.equal(
    cleaned.length,
    cleanTrajectory(noAcc, {}, 'cycling').length,
    '好精度点行为与无 accuracy 时完全一致',
  );
});

test('无 accuracy 字段的点：行为与旧版完全一致', () => {
  const base = rideTrack(12);
  // 22m 偏移（现行规则与 accuracy 规则都不触发）：无 accuracy 字段 → 与旧版行为一致，保留
  const drifted = { lat: MID_LAT + 0.0002, lng: MID_LNG, timestamp: T_INSERT };
  const withDrift = [...base.slice(0, 7), drifted, ...base.slice(7)];
  const cleaned = cleanTrajectory(withDrift, {}, 'cycling');
  assert.equal(cleaned.length, withDrift.length, '无 accuracy 的漂移点不被剔除（与旧版行为一致）');
});

test('起始稳定：开头 GPS 未收敛段（accBad/vehicle 标记）整段剔除，直到第一个可信定位', () => {
  // 模拟冷启动：前 4 点 accuracy 62–161m、坐标甩动 250m+、带 vehicle 标记；
  // 第 5 点 accuracy 21m 恢复可信，之后正常步进
  const pts = [
    { lat: 22.8066555, lng: 108.3044070, timestamp: 0, accuracy: 62, vehicle: true },
    { lat: 22.8060788, lng: 108.3054620, timestamp: 63, accuracy: 161, vehicle: true },
    { lat: 22.8065484, lng: 108.3062031, timestamp: 640, accuracy: 136, vehicle: true },
    { lat: 22.8054460, lng: 108.3063561, timestamp: 651, accuracy: 95, vehicle: true },
    { lat: 22.8063569, lng: 108.3035140, timestamp: 2631, accuracy: 21 },
    { lat: 22.8063800, lng: 108.3034500, timestamp: 4600, accuracy: 15 },
    { lat: 22.8063100, lng: 108.3034800, timestamp: 6600, accuracy: 14 },
  ];
  const cleaned = cleanTrajectory(pts as never, {}, 'running');
  // 前 4 个未收敛点整段剔除，轨迹从第一个可信定位开始
  assert.equal(cleaned.length, 3);
  assert.equal(cleaned[0].lat, 22.8063569, '起点 = 第一个 accuracy<30 的点');
  assert.equal((cleaned[0] as { vehicle?: boolean }).vehicle, undefined, '被剔除点不含 vehicle 语义');
  // 步长合理（不引入新的异常跳点）
  const d = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  for (let i = 1; i < cleaned.length; i++) {
    const step = d(cleaned[i - 1], cleaned[i]);
    assert.ok(step < 30, `清洗后相邻步长应正常（${i}: ${step.toFixed(1)}m）`);
  }
});

test('起始稳定：首点即可信（accuracy < 30）则一个不剔', () => {
  const pts = [
    { lat: 22.8066555, lng: 108.3044070, timestamp: 0, accuracy: 15 },
    { lat: 22.8060788, lng: 108.3054620, timestamp: 600, accuracy: 12 },
    { lat: 22.8065484, lng: 108.3062031, timestamp: 1200, accuracy: 11 },
  ];
  const cleaned = cleanTrajectory(pts as never, {}, 'running');
  assert.equal(cleaned.length, 3, '开头可信时不 trim');
});

test('起始稳定：无 accuracy 字段（旧数据/导入）视为可信，不剔', () => {
  const pts = [
    { lat: 22.8066555, lng: 108.3044070, timestamp: 0 },
    { lat: 22.8060788, lng: 108.3054620, timestamp: 600 },
    { lat: 22.8065484, lng: 108.3062031, timestamp: 1200 },
  ];
  const cleaned = cleanTrajectory(pts as never, {}, 'running');
  assert.equal(cleaned.length, 3, '缺失 accuracy 不触发起始 trim');
});

test('起始稳定：整段都没收敛（全 accuracy ≥ 30）→ 保持原样，不剔到空', () => {
  const pts = [
    { lat: 22.8066555, lng: 108.3044070, timestamp: 0, accuracy: 95, vehicle: true },
    { lat: 22.8060788, lng: 108.3054620, timestamp: 600, accuracy: 161, vehicle: true },
    { lat: 22.8065484, lng: 108.3062031, timestamp: 1200, accuracy: 136, vehicle: true },
  ];
  const cleaned = cleanTrajectory(pts as never, {}, 'running');
  assert.equal(cleaned.length, 3, '无可信定位时不剔除（避免空轨迹）');
});

test('室内/弱信号：全程 accuracy ≥ 30 → 一个点都不剔（真实轨迹不能剔光）', () => {
  // 室内跑步：所有点精度都差（40–120m），但坐标本身是连续可信的行走轨迹
  const pts = Array.from({ length: 20 }, (_, i) => ({
    lat: 22.8066 + i * 0.00002,
    lng: 108.3035 + i * 0.00002,
    timestamp: i * 1000,
    accuracy: 40 + (i % 5) * 20,
  }));
  const cleaned = cleanTrajectory(pts as never, {}, 'running');
  assert.equal(cleaned.length, 20, '室内全程差精度不作起始剔除');
});

test('室内/弱信号：短轨迹（5 点）全程差精度也不剔', () => {
  const pts = Array.from({ length: 5 }, (_, i) => ({
    lat: 22.8066 + i * 0.00002,
    lng: 108.3035,
    timestamp: i * 1000,
    accuracy: 80,
  }));
  const cleaned = cleanTrajectory(pts as never, {}, 'walking');
  assert.equal(cleaned.length, 5);
});

test('起始剔除上限：开头 30 个坏点只剔前 10 个，其余保留', () => {
  // 整条路径连续（每点纬度 +0.00002° ≈ 2.2m/s，正常步行），只是前 30 点精度差
  const all = Array.from({ length: 40 }, (_, i) => ({
    lat: 22.8066 + i * 0.00002,
    lng: 108.3035,
    timestamp: i * 1000,
    accuracy: i < 30 ? 90 : 12,
  }));
  const cleaned = cleanTrajectory(all as never, {}, 'walking');
  assert.equal(cleaned.length, 30, '最多剔 START_TRIM_MAX(10) 个');
  assert.equal(cleaned[0].lat, all[10].lat, '从第 11 个点开始保留（后面 20 个坏精度点是真实轨迹）');
});
