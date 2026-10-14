import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcPerfScore } from '../src/utils/perf-score.js';
import { detectCrs } from '../src/utils/crs-detect.js';
import { classifyTrackKind, type TrackKindSignals } from '../src/utils/track-kind.js';

/** ── 表现分 ───────────────────────────────────────────────────────── */

test('表现分：TrailCraft 平地锚点回归（92km/186m 爬升/12.75h → ~361 中等）', () => {
  // v1 口径不含下降项（TrailCraft 含下降/150 为 ~366），无下降时约 361
  const r = calcPerfScore('running', 92_000, 186, 12.75 * 3600);
  assert.ok(r, '有效输入应产出结果');
  assert.ok(Math.abs(r.score - 361) <= 2, `平地锚点应 ~361，实际 ${r.score}`);
  assert.equal(r.level, '中等');
});

test('表现分：UTMB 级 effort 落精英级且远离 1000 封顶', () => {
  // 2025 UTMB 男子：174km/10000m 爬升/19:19
  const r = calcPerfScore('running', 174_000, 10_000, 19.32 * 3600);
  assert.ok(r);
  assert.equal(r.level, '精英级');
  assert.ok(r.score > 680 && r.score < 850, `UTMB 级应在 680-850，实际 ${r.score}`);
});

test('表现分：不适用类型与数据不足', () => {
  assert.equal(calcPerfScore('cycling', 50_000, 500, 3600), null, '骑行不适用');
  assert.equal(calcPerfScore('swimming', 3_000, 0, 3_600), null, '游泳不适用');
  assert.equal(calcPerfScore('running', 800, 10, 600), null, '距离 <1km 不算');
  assert.equal(calcPerfScore('running', 5_000, 50, 120), null, '时长 <5min 不算');
  assert.equal(calcPerfScore('running', 0, 0, 0), null);
});

/** ── 坐标系识别 ───────────────────────────────────────────────────── */

test('坐标系识别：国际设备 / 国内 App / 百度系', () => {
  assert.equal(detectCrs({ creator: 'Garmin Connect', fileName: 'a.gpx' }).crs, 'wgs84');
  assert.equal(detectCrs({ fileName: '2026-10-01_coros_run.gpx' }).crs, 'wgs84');
  assert.equal(detectCrs({ fileName: '两步路_周末徒步.kml' }).crs, 'gcj02');
  assert.equal(detectCrs({ creator: 'Keep', fileName: 'a.gpx' }).crs, 'gcj02');
  assert.equal(detectCrs({ fileName: 'baidu_export.kml' }).crs, 'bd09');
});

test('坐标系识别：字母边界防误匹配 + unknown 兜底', () => {
  // "apple" 不应作为子串匹配 "Snapple Fitness"（会误判成 wgs84 高置信）
  assert.equal(detectCrs({ creator: 'Snapple Fitness' }).confidence, 'unknown');
  // 带下划线/数字的文件名也能匹配（\b 会在这里失效）
  assert.equal(detectCrs({ fileName: 'foooooot_12345.kml' }).crs, 'gcj02');
  assert.equal(detectCrs({ fileName: 'track-2026.gpx' }).confidence, 'unknown');
  assert.equal(detectCrs({ fileName: 'track-2026.gpx' }).crs, 'wgs84', 'unknown 兜底按 WGS-84');
});

/** ── 实跑/规划判别 ────────────────────────────────────────────────── */

const DEG_PER_M = 180 / (Math.PI * 6371000);
const pt = (m: number, ts: number) => ({ lat: m * DEG_PER_M, lng: 0, timestamp: ts });

test('实跑判别：无时间戳 → planned（规划路线）', () => {
  const pts = Array.from({ length: 100 }, (_, i) => ({ lat: i * DEG_PER_M * 20, lng: 0, timestamp: 0 }));
  const r = classifyTrackKind(pts, undefined, { hasTime: false });
  assert.equal(r.kind, 'planned');
});

test('实跑判别：正常变速采样 → recorded', () => {
  // 5km，5 m/s ± 抖动：每 10m 一点，间隔约 2s 带随机抖动
  const pts = [];
  let ts = 1_000_000;
  for (let m = 0; m <= 5_000; m += 10) {
    pts.push(pt(m, ts));
    ts += 2000 + Math.round(Math.sin(m) * 300) + (m % 50);
  }
  const r = classifyTrackKind(pts);
  assert.equal(r.kind, 'recorded');
  assert.equal(r.signals.speedPlausible, true);
});

test('实跑判别：完全均匀的采样间隔 → uncertain（合成时间轴红旗）', () => {
  const pts = Array.from({ length: 500 }, (_, i) => pt(i * 10, i * 2000)); // 精确 2s
  const r = classifyTrackKind(pts);
  assert.equal(r.kind, 'uncertain');
  assert.equal((r.signals as TrackKindSignals).intervalUniform, true);
});

test('实跑判别：速度超出人类区间 → uncertain', () => {
  // 5km 在 100s 内跑完 = 50 m/s
  const pts = Array.from({ length: 101 }, (_, i) => pt(i * 50, i * 1000));
  const r = classifyTrackKind(pts);
  assert.equal(r.kind, 'uncertain');
  assert.equal(r.signals.speedPlausible, false);
});
