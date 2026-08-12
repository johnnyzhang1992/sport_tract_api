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
  assert.ok(!cleaned.some((p) => p.lat > 30.5 + 0.0002), '跳点起点不在结果中');
});

test('尾点跳点剔除：结束时 GPS 漂移', () => {
  const pts = walkTrack(15);
  const tail = { lat: 30.5 + 14 * 0.00004 + 0.0003, lng: 114.4 + 14 * 0.00004, timestamp: 14 * 3000 + 500 };
  const withTail = [...pts.slice(0, 14), tail];
  const cleaned = cleanTrajectory(withTail);
  assert.equal(cleaned.length, 14, '尾跳点应被剔除');
});
