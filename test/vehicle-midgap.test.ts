import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { markVehicle, GAP_TIGHTEN_MIN_SEC } from '../src/utils/vehicle.js';
import { TYPE_CONFIGS } from '../src/utils/trajectory-clean.js';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { LoginLogModel } from '../src/models/login-log.model.js';
import type { TrackPointLike } from '../src/utils/pace.js';

/**
 * 中短断档速度收紧（三级阶梯中档：30 < dt ≤ 120，设计 docs/19 §3.1-3.2）
 *
 * 盲区：地铁进出站 30-120s 丢信号后一步跳几百米，速度落在现行单步判据
 * （minHighSpeed）与类型上限（maxAbsSpeed）之间的空档——如步行 60s 跳 400m = 6.7m/s，
 * 双标都够不着，假距离全额入账。收紧到 gapSpeed（人无法持续 30s+，车载远超）。
 */

const M_PER_DEG = 180 / (Math.PI * 6371000);

interface Step {
  sec: number;
  mps: number;
  gapJump?: boolean;
  pauseGap?: boolean;
  altitude?: number;
}

/** 轨迹构造：沿经线推进，每步 {sec, mps}，可带 gapJump/pauseGap 标记 */
function buildTrack(steps: Step[], startTs = 1_790_000_000_000) {
  let lat = 30;
  let ts = startTs;
  const pts: TrackPointLike[] = [{ lat, lng: 114, timestamp: ts }];
  for (const s of steps) {
    lat += (s.mps * s.sec) / 111_194.9;
    ts += s.sec * 1000;
    pts.push({
      lat,
      lng: 114,
      timestamp: ts,
      ...(s.altitude != null ? { altitude: s.altitude } : {}),
      ...(s.gapJump ? { gapJump: true } : {}),
      ...(s.pauseGap ? { pauseGap: true } : {}),
    } as TrackPointLike);
  }
  return pts;
}

const walk = { sec: 5, mps: 1.4 };

test('M1 步行 60s 断档 400m（6.7m/s > gapSpeed 4）：标 vehicle，vehicleM 含 400m', () => {
  const pts = buildTrack([walk, walk, { sec: 60, mps: 400 / 60, gapJump: true }, walk, walk]);
  const r = markVehicle(pts, 'walking');
  assert.equal(r.points[3].vehicle, true, '断档落点应标 vehicle');
  assert.ok(r.vehicleM >= 399, `vehicleM 应含跳变位移，实际 ${r.vehicleM}`);
  assert.ok(r.vehicleMs >= 59_000, `vehicleMs 应含 60s，实际 ${r.vehicleMs}`);
});

test('M2 步行 60s 断档 200m（3.3m/s < 4）：不标', () => {
  const pts = buildTrack([walk, walk, { sec: 60, mps: 200 / 60, gapJump: true }, walk, walk]);
  const r = markVehicle(pts, 'walking');
  assert.equal(r.points[3].vehicle, undefined);
});

test('M3 跑步 45s 断档 250m（5.6m/s < 6.5）：不标（真实穿越隧道保留）', () => {
  const pts = buildTrack([
    { sec: 10, mps: 3.5 },
    { sec: 10, mps: 3.5 },
    { sec: 45, mps: 250 / 45, gapJump: true },
    { sec: 10, mps: 3.5 },
    { sec: 10, mps: 3.5 },
  ]);
  const r = markVehicle(pts, 'running');
  assert.equal(r.points[3].vehicle, undefined);
});

test('M4 跑步 45s 断档 400m（8.9m/s > 6.5）：标', () => {
  const pts = buildTrack([
    { sec: 10, mps: 3.5 },
    { sec: 10, mps: 3.5 },
    { sec: 45, mps: 400 / 45, gapJump: true },
    { sec: 10, mps: 3.5 },
    { sec: 10, mps: 3.5 },
  ]);
  const r = markVehicle(pts, 'running');
  assert.equal(r.points[3].vehicle, true);
});

test('M5 dt=30s 整边界（跑步 10m/s）：不走新档，仍由现行单步判据标（回归）', () => {
  assert.equal(GAP_TIGHTEN_MIN_SEC, 30);
  // 300m/30s = 10m/s = 跑步 minHighSpeed：现行单步规则命中
  const pts = buildTrack([
    { sec: 10, mps: 3.5 },
    { sec: 30, mps: 10, gapJump: true },
    { sec: 10, mps: 3.5 },
  ]);
  const r = markVehicle(pts, 'running');
  assert.equal(r.points[2].vehicle, true, '10m/s ≥ minHighSpeed(10)，现行单步规则应标');
});

test('M6 骑行 60s 断档 800m（13.3m/s）：不标（gapSpeed 不配置 = 豁免）', () => {
  assert.equal(TYPE_CONFIGS.cycling.gapSpeed, undefined, '骑行必须保持豁免');
  const pts = buildTrack([
    { sec: 10, mps: 8 },
    { sec: 60, mps: 800 / 60, gapJump: true },
    { sec: 10, mps: 8 },
  ]);
  const r = markVehicle(pts, 'cycling');
  assert.equal(r.points[2].vehicle, undefined, '骑行断档跳变不应被标（下坡/巡航合法速度重叠）');
});

test('M7 dt=121s 巨步弦：步行类上限已提到跑步级（6.5m/s）——10m/s 标、3m/s 不标', () => {
  // 3m/s = 10.8km/h 是慢跑速度，「步行」类目允许跑步速度（2026-10-26 用户拍板）→ 不标
  const jog = buildTrack([walk, walk, { sec: 121, mps: 3, gapJump: true }, walk]);
  assert.equal(markVehicle(jog, 'walking').points[3].vehicle, undefined, '慢跑速度不算被运载');

  // 10m/s = 36km/h 超过步行类上限 → 标
  const carried = buildTrack([walk, walk, { sec: 121, mps: 10, gapJump: true }, walk]);
  const r = markVehicle(carried, 'walking');
  assert.equal(r.points[3].vehicle, true, '>120s 且弦速超上限应标');
  assert.ok(r.vehicleMs >= 121_000);
});

test('M8 pauseGap 恢复首点 + 60s 断档跳变：不标（暂停时长已由 pausedMs 扣过，防双扣）', () => {
  const pts = buildTrack([walk, walk, { sec: 60, mps: 400 / 60, pauseGap: true }, walk, walk]);
  const r = markVehicle(pts, 'walking');
  assert.equal(r.points[3].vehicle, undefined);
});

test('M10 游泳 40s 断档 150m（3.75m/s > 3.0）：标（游泳配置了 gapSpeed，虽不在 VEHICLE_TYPES）', () => {
  const pts = buildTrack([
    { sec: 10, mps: 1.5 },
    { sec: 40, mps: 150 / 40, gapJump: true },
    { sec: 10, mps: 1.5 },
  ]);
  const r = markVehicle(pts, 'swimming');
  assert.equal(r.points[2].vehicle, true);
});

// ── M9 e2e：finish 落库口径（距离不含跳变、时长扣 vehicleMs、vehicleNotice 非空） ──

let app: FastifyInstance;
let token = '';
const NS = 'openid:act-midgap-';

async function purge() {
  const ids = (
    await UserModel.find({ openid: /^act-midgap-/ }).select('_id').lean()
  ).map((u) => u._id);
  if (!ids.length) return;
  await ActivityModel.deleteMany({ userId: { $in: ids } });
  await LoginLogModel.deleteMany({ userId: { $in: ids } });
  await UserModel.deleteMany({ _id: { $in: ids } });
}

test('M9 setup：起服务 + 登录', async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await purge();
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: NS + 'user' },
  });
  token = res.json().data.accessToken;
});

test('M21 巨步弦：骑行整体豁免（不扣数据），步行按类型上限判定', () => {
  // 产品决策 2026-10-26：骑行不区分自行车/摩托车，距离与时长一律不扣，进榜交给 driftScore
  const legit = buildTrack([{ sec: 358, mps: 3805 / 358 }]);
  assert.equal(markVehicle(legit, 'cycling').vehicleMs, 0, '合法高速骑行不标');

  const moto = buildTrack([{ sec: 300, mps: 20 }]);
  const r2 = markVehicle(moto, 'cycling');
  assert.equal(r2.points[1].vehicle, undefined, '摩托车骑行也不扣数据（骑行豁免）');
  assert.equal(r2.vehicleMs, 0);

  // 步行：同为 10m/s 超 2.2 上限 → 标（同一几何按类型判定不同结果）
  const walkCar = buildTrack([{ sec: 300, mps: 10 }]);
  assert.equal(markVehicle(walkCar, 'walking').points[1].vehicle, true);
});

test('M22 骑行不做速度追责：密集 + 长断档混合轨迹不产生 vehicle 标记（产品决策 2026-10-26）', () => {
  // 复现线上 192279：P50=4s 密集段里夹着 358s 长断档 + 几步 GPS 跳点
  const steps: Array<{ sec: number; mps: number }> = [];
  for (let k = 0; k < 20; k++) steps.push({ sec: 4, mps: 2.7 }); // 正常骑行 4s/步
  steps.push({ sec: 358, mps: 10.6 }); // 长断档（合法高速骑行）
  for (let k = 0; k < 20; k++) steps.push({ sec: 4, mps: 2.7 });
  const r = markVehicle(buildTrack(steps), 'cycling');
  assert.equal(r.vehicleMs, 0, `稀疏采样+长断档不应产生 vehicleMs，实际 ${r.vehicleMs}`);
});

// ── M18 老版本客户端兼容：无 gapTighten/无 vehicle 标记 + clientDistance 全量虚高 ──
// 兼容契约：finish 必须 200 正常落库（不得 4xx/5xx），行为与线上现状一致
//（地铁段距离入账——服务端 markVehicle 不在 finish 跑，等纠偏修）；driftScore 服务端计算
test('M18 老版本客户端 finish：无标记+虚高 clientDistance 仍正常落库，driftScore 服务端计', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: NS + 'legacy' },
  });
  const tk = login.json().data.accessToken;
  const create = await app.inject({
    method: 'POST',
    url: '/sport-track/api/activities',
    headers: { authorization: `Bearer ${tk}` },
    payload: { type: 'walking', startTime: 1_790_000_000_000 },
  });
  const activityId = create.json().data.activityId;

  // 老版本形态：地铁段不标任何东西，clientDistance 报含地铁段的全量距离
  const steps: Array<Record<string, unknown>> = [];
  let lat = 30;
  let ts = 1_790_000_000_000;
  let seq = 0;
  const push = (sec: number, mps: number) => {
    const n = Math.max(1, Math.round(sec / 3));
    for (let k = 1; k <= n; k++) {
      lat += (mps * (sec / n)) / 111_194.9;
      ts += (sec / n) * 1000;
      steps.push({ seq: ++seq, lat, lng: 114, timestamp: ts, altitude: null, speed: null, accuracy: 10 });
    }
  };
  push(300, 1.4);
  for (let g = 0; g < 3; g++) {
    push(60, 400 / 60); // 无标记地铁段（老版本客户端不识别）
    push(120, 1.4);
  }
  const inflated = Math.round(750 + 3 * 400); // 老客户端口径：含全部地铁段

  const finish = await app.inject({
    method: 'PUT',
    url: `/sport-track/api/activities/${activityId}/finish`,
    headers: { authorization: `Bearer ${tk}` },
    payload: { trackPoints: steps, markers: [], pausedMs: 0, clientDistance: inflated, endTime: ts },
  });
  assert.equal(finish.statusCode, 200, finish.body);
  const act = finish.json().data.activity;
  assert.equal(act.status, 'finished', '老客户端轨迹必须正常落库（不因无标记被拒）');
  // 行为与线上现状一致：服务端 finish 不跑 markVehicle，虚高距离照旧入账（纠偏才修）
  assert.ok(act.distance > 1500, `老客户端口径保留（含地铁段），实际 ${act.distance}`);
  // driftScore 服务端计算：无标记快弦占比高 → 分数高 → 未来被门禁拦在榜外（防灌水对所有版本生效）
  assert.ok(typeof act.driftScore === 'number', 'driftScore 应服务端计算');

  // 换类型/纠偏等既有接口对老客户端轨迹照常可用
  const meta = await app.inject({
    method: 'PUT',
    url: `/sport-track/api/activities/${activityId}/meta`,
    headers: { authorization: `Bearer ${tk}` },
    payload: { type: 'cycling' },
  });
  assert.equal(meta.statusCode, 200, meta.body);
});

test('M9 teardown', async () => {
  await purge();
  await app.close();
});
