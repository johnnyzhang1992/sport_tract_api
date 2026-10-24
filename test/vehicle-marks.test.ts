import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { LoginLogModel } from '../src/models/login-log.model.js';
import { markVehicle } from '../src/utils/vehicle.js';
import { cleanTrajectory } from '../src/utils/trajectory-clean.js';
import { compactTrackPoints, normalizeTrackPoints } from '../src/utils/track-compact.js';
import type { TrackPointLike } from '../src/utils/pace.js';

/**
 * 端上异常点标记保留（决策：超速/精度差点不丢弃，标记供统计/纠偏/渲染使用）的服务端口径：
 * - markVehicle 与端上预标记取并集（孤立超速步不清除，时长/位移照算）
 * - cleanTrajectory 保护已标记点（剔除会让被剔位移重新计入距离，标记语义失效）
 * - compact/normalize 对 accBad 稀疏透传
 * - finish：坐车步不计入重算距离、不触发 IMPOSSIBLE_SPEED 作废、标记随 DTO 下发
 */

// ---------- markVehicle：端上预标记并集 ----------

test('markVehicle：端上预标记的孤立超速步保留，时长/位移照算', () => {
  const pts: TrackPointLike[] = [
    { lat: 30, lng: 114, timestamp: 0 },
    { lat: 30.00009, lng: 114, timestamp: 3000 }, // ~10m 正常步
    // 预标记超速步：10m/3s 服务端持续判据判不出，靠端上标记
    { lat: 30.00018, lng: 114, timestamp: 6000, vehicle: true },
    { lat: 30.00027, lng: 114, timestamp: 9000 },
  ];
  const r = markVehicle(pts, 'walking');
  assert.equal(r.points[2].vehicle, true, '预标记不清除');
  assert.equal(r.spans, 1);
  assert.equal(r.vehicleMs, 3000);
  assert.ok(r.vehicleM > 9 && r.vehicleM < 11, `vehicleM=${r.vehicleM}`);
});

test('markVehicle：检测段与端上预标记取并集', () => {
  const pts: TrackPointLike[] = [];
  let lat = 30;
  let ts = 0;
  pts.push({ lat, lng: 114, timestamp: ts });
  const leg = (mps: number, sec: number) => {
    const steps = Math.round(sec / 2);
    for (let i = 0; i < steps; i++) {
      lat += (mps * 2) / 111_194.9;
      ts += 2000;
      pts.push({ lat, lng: 114, timestamp: ts });
    }
  };
  leg(1.5, 30);
  leg(8, 90); // 服务端持续判据判出的车速段
  leg(1.5, 30);
  pts[5].vehicle = true; // 正常段里的孤立预标记
  const r = markVehicle(pts, 'walking');
  assert.equal(r.points[5].vehicle, true);
  assert.ok(r.spans >= 2, `spans=${r.spans}`);
  assert.ok(r.vehicleMs > 90_000, `预标记步的时长也要计入，vehicleMs=${r.vehicleMs}`);
});

// ---------- cleanTrajectory：标记点保护 ----------

test('cleanTrajectory：端上标记的 vehicle 点不被清洗剔除', () => {
  const pts = Array.from({ length: 20 }, (_, i) => ({
    lat: 30.5 + i * 0.00004,
    lng: 114.4 + i * 0.00004,
    timestamp: i * 3000,
  }));
  // 同款孤立离群点（无标记时会被剔除），带上端上 vehicle 标记
  const outlier = {
    lat: 30.5 + 5 * 0.00004 - 0.00045,
    lng: 114.4 + 5 * 0.00004,
    timestamp: 5 * 3000 + 1500,
    vehicle: true,
  };
  const withOutlier = [...pts.slice(0, 6), outlier, ...pts.slice(6)];
  const cleaned = cleanTrajectory(withOutlier);
  assert.equal(cleaned.length, withOutlier.length, '标记点受保护不剔除');
  assert.ok(cleaned.some((p) => p.timestamp === outlier.timestamp));
});

// ---------- compact / normalize：accBad 透传 ----------

test('compact/normalize：accBad 稀疏透传（未标记不写字段）', () => {
  const pts = [
    { seq: 1, lat: 30.5, lng: 114.4, timestamp: 1000 },
    { seq: 2, lat: 30.5, lng: 114.4, timestamp: 4000, accBad: true, accuracy: 80 },
    { seq: 3, lat: 30.5, lng: 114.4, timestamp: 7000, vehicle: true },
  ] as never;
  const compact = compactTrackPoints(pts, 0);
  assert.equal(compact[0].accBad, undefined, '未标记不写字段');
  assert.equal(compact[1].accBad, true);
  assert.equal(compact[2].vehicle, true);
  const restored = normalizeTrackPoints(compact as unknown as Array<Record<string, unknown>>, 0);
  assert.ok(!restored[0].accBad, '未标记不下发字段');
  assert.equal(restored[1].accBad, true);
  assert.equal(restored[2].vehicle, true);
});

// ---------- finish 集成：坐车步不计距离、不触发作废 ----------

let app: FastifyInstance;
let token = '';
let activityId = '';

const NOW = Date.now();
const mk = (seq: number, lat: number, extra: Record<string, unknown> = {}) => ({
  seq,
  lat,
  lng: 114.4,
  altitude: null,
  speed: null,
  accuracy: null,
  timestamp: NOW - 60000 + seq * 3000,
  ...extra,
});

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  // 独立 openid 命名空间 + 清残留（残留在会连坐 409）
  const ids = (
    await UserModel.find({ openid: /^openid:vm-user/ }).select('_id').lean()
  ).map((u) => u._id);
  if (ids.length) {
    await ActivityModel.deleteMany({ userId: { $in: ids } });
    await LoginLogModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  }
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'openid:vm-user' },
  });
  token = login.json().data.accessToken;
  const created = await app.inject({
    method: 'POST',
    url: '/sport-track/api/activities',
    headers: { authorization: `Bearer ${token}` },
    payload: { type: 'walking', startTime: NOW - 60000 },
  });
  activityId = created.json().data.activityId;
  assert.ok(activityId);
});

after(async () => {
  const ids = (
    await UserModel.find({ openid: /^openid:vm-user/ }).select('_id').lean()
  ).map((u) => u._id);
  if (ids.length) {
    await ActivityModel.deleteMany({ userId: { $in: ids } });
    await LoginLogModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  }
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

test('finish：端上标记的坐车步不计距离、不触发 IMPOSSIBLE_SPEED 作废', async () => {
  // 5 步坐车（各 ~100m/3s=33m/s，walking 上限 12m/s，端上标 vehicle）+ 3 步正常步行（各 ~5m）。
  // 不跳过坐车步时步速中位数 33>12 → 整条轨迹会被 IMPOSSIBLE_SPEED 作废
  const points = [
    mk(1, 30.5),
    mk(2, 30.5009, { vehicle: true }),
    mk(3, 30.5018, { vehicle: true }),
    mk(4, 30.5027, { vehicle: true }),
    mk(5, 30.5036, { vehicle: true }),
    mk(6, 30.5045, { vehicle: true }),
    mk(7, 30.504545),
    mk(8, 30.50459),
    mk(9, 30.504635),
  ];
  const clientDistance = Math.round(0.000045 * 111_194.9 * 3); // 只算 3 步正常步行 ≈ 15m（> MIN_EFFECTIVE_DISTANCE_M）
  const res = await app.inject({
    method: 'PUT',
    url: `/sport-track/api/activities/${activityId}/finish`,
    headers: { authorization: `Bearer ${token}` },
    payload: { trackPoints: points, clientDistance, pausedMs: 0 },
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.status, 'finished', '中位数守卫应跳过坐车步，不整条作废');
  assert.equal(data.activity.distance, clientDistance, '存储距离与客户端口径一致（不含坐车步）');
  const tp = data.activity.trackPoints as Array<Record<string, unknown>>;
  assert.equal(tp.filter((p) => p.vehicle === true).length, 5, '标记随 DTO 下发');
});
