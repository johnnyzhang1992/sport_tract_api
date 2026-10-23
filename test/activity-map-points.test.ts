import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';

/**
 * 轨迹列表「地图模式」的抽稀点接口：
 * - 全量 5000 点 → 按 max 预算保形抽稀（默认 1500）
 * - pauseGap / gapJump 断点必留在结果里（地图按标记断线）
 * - 仅本人可读
 */

let app: FastifyInstance;
let token = '';
let userId = '';
const extraIds: string[] = [];
const BASE = Date.UTC(2026, 8, 1, 1, 0, 0);

function makePoints(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    seq: i + 1,
    lat: 30 + Math.sin(i / 80) * 0.01,
    lng: 120 + i * 0.00002,
    altitude: 10,
    speed: 3,
    accuracy: 5,
    timestamp: BASE + i * 1000,
    ...(i === 1000 ? { pauseGap: true } : {}),
    ...(i === 3000 ? { gapJump: true, vehicle: true } : {}),
  }));
}

async function login(code: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code },
  });
  assert.equal(res.statusCode, 200);
  return res.json().data;
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const stale = await UserModel.find({ openid: /mock_openid_map_points/ }).select('_id').lean();
  for (const u of stale) {
    await ActivityModel.deleteMany({ userId: u._id });
    await UserModel.deleteOne({ _id: u._id });
  }
  const me = await login('mock_openid_map_points_me');
  userId = me.user.id;
  token = me.accessToken;
  await ActivityModel.create({
    userId,
    type: 'running',
    status: 'finished',
    startTime: BASE,
    endTime: BASE + 5000 * 1000,
    duration: 5000,
    distance: 5000,
    trackPoints: makePoints(5000),
    markers: [],
  });
});

after(async () => {
  for (const id of [userId, ...extraIds].filter(Boolean)) {
    await ActivityModel.deleteMany({ userId: id }).catch(() => {});
    await UserModel.deleteOne({ _id: id }).catch(() => {});
  }
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

async function myActivityId() {
  const a = await ActivityModel.findOne({ userId }).select('_id').lean();
  return String(a?._id);
}

test('MP1 地图点抽稀：按预算降点，首尾与断点标记必留', async () => {
  const id = await myActivityId();
  const res = await app.inject({
    method: 'GET',
    url: `/sport-track/api/activities/${id}/map-points?max=120`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.total, 5000);
  assert.ok(data.points.length >= 4, '至少保留断段首尾');
  assert.ok(data.points.length <= 130, `预算 120，实际 ${data.points.length}`);

  const all = makePoints(5000);
  assert.equal(data.points[0].lat, all[0].lat);
  assert.equal(data.points[0].lng, all[0].lng);
  assert.equal(data.points[data.points.length - 1].lat, all[4999].lat);
  assert.equal(data.points[data.points.length - 1].lng, all[4999].lng);

  const pause = data.points.find((p: any) => p.pauseGap);
  assert.ok(pause, '暂停恢复点不能丢');
  assert.equal(pause.lat, all[1000].lat);
  assert.equal(pause.lng, all[1000].lng);
  const gap = data.points.find((p: any) => p.gapJump);
  assert.ok(gap, '采样断档点不能丢');
  assert.equal(gap.lat, all[3000].lat);

  const key = (p: any) => `${p.lat},${p.lng}`;
  const origin = new Set(all.map(key));
  for (const p of data.points) assert.ok(origin.has(key(p)), '只能是原点集的子集');
  assert.ok(data.points.every((p: any) => Number.isFinite(p.timestamp)), '时间戳随点下发（配速着色用）');
  assert.equal(data.points[0].timestamp, all[0].timestamp);
  assert.equal(data.points[data.points.length - 1].timestamp, all[4999].timestamp);
  assert.equal(gap.timestamp, all[3000].timestamp);
  assert.equal(gap.vehicle, true, '车速标记随断点保留');
});

test('MP2 默认预算 1500：5000 点压到 1500 以内', async () => {
  const id = await myActivityId();
  const res = await app.inject({
    method: 'GET',
    url: `/sport-track/api/activities/${id}/map-points`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.ok(data.points.length <= 1500, `实际 ${data.points.length}`);
  assert.ok(data.points.length > 500, '1500 预算下不应过度压缩');
});

test('MP3 别人的轨迹读不到（404）', async () => {
  const other = await login('mock_openid_map_points_other');
  extraIds.push(other.user.id);
  const id = await myActivityId();
  const res = await app.inject({
    method: 'GET',
    url: `/sport-track/api/activities/${id}/map-points`,
    headers: { authorization: `Bearer ${other.accessToken}` },
  });
  assert.equal(res.statusCode, 404);
});

test('MP4 非法 id 返回 404，不抛 500', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/activities/not-an-id/map-points',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 404);
});
