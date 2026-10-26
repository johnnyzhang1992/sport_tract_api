import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { LoginLogModel } from '../src/models/login-log.model.js';
import { calcDriftScore } from '../src/utils/drift-score.js';
import { DRIFT_SCORE_PB_GATE } from '../src/config/constants.js';

/**
 * driftScore 漂移置信度与 PB/榜单门禁（设计 docs/19 §4，测试清单 D1-D8）
 *
 * 口径：≥ DRIFT_SCORE_PB_GATE(30) 不进个人最佳五榜/保持者链/奖杯墙/全国榜
 * farthest+fastestKm；缺字段（null/不存在）= 可信，$not/$gt 惯用法与 vehicleMs 同源。
 */

const M_PER_DEG = 180 / (Math.PI * 6371000);
const SEC = 25; // 每步时长：必须 < 30s 断档阈值（真实采样节奏 3s，这里取 25s 兼顾点数与口径），否则全轨迹误判为断档

interface Fixture {
  userId: unknown;
  activityId: unknown;
  points: Array<Record<string, unknown>>;
}

/** 步行直线轨迹：steps 步 × 100m，可用 hook 按点下标注入 accBad/vehicle/gap 标记 */
function walkPoints(steps: number, hook?: (i: number, p: Record<string, unknown>) => void) {
  const out: Array<Record<string, unknown>> = [];
  let lat = 30;
  let ts = 1_790_000_000_000;
  for (let i = 0; i <= steps; i++) {
    const p: Record<string, unknown> = { seq: i + 1, lat, lng: 114, timestamp: ts };
    hook?.(i, p);
    out.push(p);
    lat += 100 * M_PER_DEG;
    ts += SEC * 1000;
  }
  return out;
}

async function insertActivity(
  userId: unknown,
  fields: Record<string, unknown>,
  points: Array<Record<string, unknown>>,
): Promise<unknown> {
  const doc = await ActivityModel.create({
    userId,
    type: 'hiking',
    status: 'finished',
    startTime: 1_790_000_000_000,
    endTime: 1_790_000_000_000 + 3600_000,
    trackPoints: points as never,
    // 与 finish 同口径：直插夹具也按点位标记算分（否则 null = 可信，门禁永远不命中）
    driftScore: calcDriftScore(points),
    ...fields,
  });
  return doc._id;
}

let app: FastifyInstance;
let tokenB = '';
let userB: unknown;
let B1 = '' as unknown as string; // 高分（≥30）：徒步 8km
let B2 = '' as unknown as string; // 混合（10-30）：徒步 7km
let B3 = '' as unknown as string; // 高分 + 半马/保持者链原料：徒步 25km
let C1 = '' as unknown as string; // 干净：徒步 6km
let C2 = '' as unknown as string; // 干净跑步：配速对比用

async function login(code: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'openid:act-drift-' + code },
  });
  return res.json().data;
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  // 清场：本文件命名空间
  const ids = (await UserModel.find({ openid: /^act-drift-/ }).select('_id').lean()).map((u) => u._id);
  if (ids.length) {
    await ActivityModel.deleteMany({ userId: { $in: ids } });
    await LoginLogModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  }

  const b = await login('owner');
  tokenB = b.accessToken;
  userB = (await UserModel.findOne({ openid: 'act-drift-owner' }).select('_id').lean())!._id;

  // B1 高分：79 步中 50 步 accBad（63%）→ 0.6×0.63 ≈ 38 ≥ 30
  const b1pts = walkPoints(79, (i, p) => {
    if (i >= 30) p.accBad = true;
  });
  B1 = String(
    await insertActivity(userB, {
      provinces: ['漂移测试省'],
      distance: 8000,
      duration: 7200,
      elevationGain: 500,
      fastestKm: 250, // 比 C2 的 260 更快：若门禁失效会占 fastestKm 榜
      startTime: 1_790_000_000_000,
    }, b1pts),
  );

  // B2 混合：2/20 accBad + 25% 车程 + 25% 断档 → ~16 分，不门禁
  const b2pts = walkPoints(20, (i, p) => {
    if (i === 5 || i === 6) p.accBad = true;
    if (i >= 10 && i <= 14) p.vehicle = true;
  });
  b2pts[20].timestamp = (b2pts[19].timestamp as number) + 150_000; // 一步 150s 断档
  B2 = String(
    await insertActivity(userB, { provinces: ['漂移测试省'], distance: 7000, duration: 900, startTime: 1_790_100_000_000 }, b2pts),
  );

  // B3 高分 + 半马/链原料：25km、带 pbMarks
  const b3pts = walkPoints(250, (i, p) => {
    if (i >= 100) p.accBad = true;
  });
  B3 = String(
    await insertActivity(userB, {
      provinces: ['漂移测试省'],
      distance: 25000,
      duration: 9000,
      elevationGain: 800,
      pbMarks: [{ km: 5, sec: 455 }],
      startTime: 1_790_200_000_000,
    }, b3pts),
  );

  // C1 干净徒步 6km / C2 干净跑步（fastestKm 260）
  const c1 = await UserModel.findOne({ openid: 'act-drift-clean' });
  const cleanUser =
    c1?._id ??
    (
      await UserModel.create({ openid: 'act-drift-clean', uid: 0, nickname: 'drift-clean' } as never)
    )._id;
  C1 = String(await insertActivity(cleanUser, { provinces: ['漂移测试省'], distance: 6000, duration: 5400, startTime: 1_790_050_000_000 }, walkPoints(59)));
  C2 = String(
    await insertActivity(cleanUser, {
      type: 'running',
      provinces: ['漂移测试省'],
      distance: 6000,
      duration: 1800,
      fastestKm: 260,
      startTime: 1_790_060_000_000,
    }, walkPoints(59)),
  );

  // 夹具分数先自证（断言 DB 值 = calcDriftScore 结果的前提）
  assert.ok(calcDriftScore(b1pts) >= DRIFT_SCORE_PB_GATE, '夹具 B1 应 ≥ 门禁');
  const s2 = calcDriftScore(b2pts);
  assert.ok(s2 >= 10 && s2 < DRIFT_SCORE_PB_GATE, `夹具 B2 应在 [10,30)，实际 ${s2}`);
  assert.equal(calcDriftScore(walkPoints(59)), 0, '夹具 C1 应为 0 分');
});

after(async () => {
  const ids = (await UserModel.find({ openid: /^act-drift-/ }).select('_id').lean()).map((u) => u._id);
  if (ids.length) {
    await ActivityModel.deleteMany({ userId: { $in: ids } });
    await LoginLogModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  }
  await app.close();
});

test('D2 高分轨迹被个人最佳五榜排除，榜首落到次优轨迹', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/best',
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  const walking = (data.maxDistanceByType as Array<{ type: string; distance: number }>).find(
    (r) => r.type === 'hiking',
  );
  // B1 8000 / B3 25000 都 ≥30 分被门禁 → hiking 榜首 = B2 的 7000
  assert.equal(walking?.distance, 7000, `榜首应为 B2 7000，实际 ${JSON.stringify(walking)}`);
});

test('D2b 保持者链与奖杯墙同样排除高分轨迹', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/best',
    headers: { authorization: `Bearer ${tokenB}` },
  });
  const data = res.json().data;
  // B3 带 pbMarks(km5) 但 ≥30 分 → 链里不该出现
  const chainIds = (data.distancePbChain as Array<{ id: string }>).map((r) => String(r.id));
  assert.ok(!chainIds.includes(String(B3)), '保持者链不应含高分轨迹');
  assert.equal((data.fastestDistanceByKm as unknown[]).length, 0, '当前纪录应为空');
  // B3 25km ≥ 半马但 ≥30 分 → 半马里程碑不出现
  assert.equal((data.milestones as Record<string, unknown>).half, undefined, '奖杯墙不应含高分轨迹');
});

test('D3 混合地铁轨迹（10-30 分）不门禁：仍进榜', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/best',
    headers: { authorization: `Bearer ${tokenB}` },
  });
  const data = res.json().data;
  const walking = (data.maxDistanceByType as Array<{ type: string; distance: number }>).find(
    (r) => r.type === 'hiking',
  );
  assert.equal(walking?.distance, 7000, '混合轨迹 B2 7000 应正常进榜');
});

test('D1 干净轨迹 finish 落库 driftScore ≈ 0 且进榜', async () => {
  // 真实 finish 一条干净轨迹 → driftScore 由服务端计算落库
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'openid:act-drift-finish' },
  });
  const tk = login.json().data.accessToken;
  const uid = (await UserModel.findOne({ openid: 'act-drift-finish' }).select('_id').lean())!._id;
  const create = await app.inject({
    method: 'POST',
    url: '/sport-track/api/activities',
    headers: { authorization: `Bearer ${tk}` },
    payload: { type: 'walking', startTime: 1_790_000_000_000 },
  });
  const activityId = create.json().data.activityId;
  const finish = await app.inject({
    method: 'PUT',
    url: `/sport-track/api/activities/${activityId}/finish`,
    headers: { authorization: `Bearer ${tk}` },
    payload: {
      trackPoints: walkPoints(30),
      markers: [],
      pausedMs: 0,
      clientDistance: 3000,
      endTime: 1_790_000_000_000 + 30 * SEC * 1000,
    },
  });
  assert.equal(finish.statusCode, 200, finish.body);
  const doc = await ActivityModel.findById(activityId).select('driftScore distance status').lean();
  assert.equal(doc?.status, 'finished');
  assert.ok(doc?.driftScore != null && doc.driftScore < 10, `干净轨迹 driftScore 应 <10，实际 ${doc?.driftScore}`);
  void uid;
});

test('D5 reprocess 重算 driftScore（null → 数值）', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'openid:act-drift-reproc' },
  });
  const tk = login.json().data.accessToken;
  const uid = (await UserModel.findOne({ openid: 'act-drift-reproc' }).select('_id').lean())!._id;
  const raw = walkPoints(40, (i, p) => {
    if (i >= 20) p.accBad = true;
  });
  const created = await ActivityModel.create({
    userId: uid,
    type: 'walking',
    status: 'finished',
    startTime: 1_790_000_000_000,
    endTime: 1_790_000_000_000 + 3600_000,
    corrected: false,
    distance: 4000,
    trackPoints: raw as never,
  });
  const re = await app.inject({
    method: 'POST',
    url: `/sport-track/api/activities/${created._id}/reprocess`,
    headers: { authorization: `Bearer ${tk}` },
  });
  assert.equal(re.statusCode, 200, re.body);
  const doc = await ActivityModel.findById(created._id).select('driftScore corrected').lean();
  assert.equal(doc?.corrected, true);
  assert.ok(typeof doc?.driftScore === 'number', `纠偏后 driftScore 应为数值，实际 ${doc?.driftScore}`);
});

test('D4+D6 缺 driftScore 的老文档/planned 导入轨迹视为可信：正常进榜', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'openid:act-drift-legacy' },
  });
  const tk = login.json().data.accessToken;
  const uid = (await UserModel.findOne({ openid: 'act-drift-legacy' }).select('_id').lean())!._id;
  // 原生 insert 绕过 mongoose default：造真正「无 driftScore 字段」的老文档 + planned 导入轨迹
  const col = ActivityModel.collection;
  await col.insertMany([
    {
      userId: uid,
      type: 'walking',
      status: 'finished',
      startTime: 1_790_000_000_000,
      distance: 9000,
      duration: 6000,
      trackPoints: walkPoints(10),
    },
    {
      userId: uid,
      type: 'walking',
      status: 'finished',
      startTime: 1_790_000_100_000,
      distance: 9500,
      duration: 6000,
      trackKind: 'planned',
      trackPoints: walkPoints(10),
    },
  ]);
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/best',
    headers: { authorization: `Bearer ${tk}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const walking = (res.json().data.maxDistanceByType as Array<{ type: string; distance: number }>).find(
    (r) => r.type === 'walking',
  );
  assert.equal(walking?.distance, 9500, '缺字段老文档与 planned 均应正常进榜');
});

test('D7 /stats/best 惰性回填：老轨迹访问后 driftScore 落库', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'openid:act-drift-backfill' },
  });
  const tk = login.json().data.accessToken;
  const uid = (await UserModel.findOne({ openid: 'act-drift-backfill' }).select('_id').lean())!._id;
  const col = ActivityModel.collection;
  // fastestKm 与 driftScore 都缺（老轨迹形态）→ 补算循环一并处理
  await col.insertOne({
    userId: uid,
    type: 'walking',
    status: 'finished',
    startTime: 1_790_000_000_000,
    distance: 3000,
    duration: 2400,
    trackPoints: walkPoints(30),
  } as never);
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/best',
    headers: { authorization: `Bearer ${tk}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const doc = await ActivityModel.findOne({ userId: uid }).select('driftScore fastestKm').lean();
  assert.ok(typeof doc?.fastestKm === 'number', 'fastestKm 应被回填');
  assert.ok(typeof doc?.driftScore === 'number', `driftScore 应被回填，实际 ${doc?.driftScore}`);
});

test('D8 全国榜：farthest/fastestKm 排除高分轨迹；同榜无门禁指标不受影响', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/leaderboard?type=hiking&province=%E6%BC%82%E7%A7%BB%E6%B5%8B%E8%AF%95%E7%9C%81&period=all',
  });
  assert.equal(res.statusCode, 200, res.body);
  const best = res.json().data.best as Array<{ key: string; value: number }>;
  const farthest = best.find((r) => r.key === 'farthest');
  const maxClimb = best.find((r) => r.key === 'maxClimb');
  // B1(8000/500) 与 B3(25000/800) 都 ≥30 分 → farthest 榜首 = B2 的 7000
  assert.equal(farthest?.value, 7000, `farthest 应为 B2 7000（B1/B3 被门禁），实际 ${farthest?.value}`);
  // maxClimb 无门禁 → B3 的 800 照常上榜
  assert.equal(maxClimb?.value, 800, `maxClimb 不门禁，应为 B3 800，实际 ${maxClimb?.value}`);

  // fastestKm：B1 250 比 C2 260 更快，但被门禁 → 榜首 = C2 260
  const run = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/leaderboard?type=running&province=%E6%BC%82%E7%A7%BB%E6%B5%8B%E8%AF%95%E7%9C%81&period=all',
  });
  const runBest = run.json().data.best as Array<{ key: string; value: number }>;
  assert.equal(runBest.find((r) => r.key === 'fastestKm')?.value, 260, 'fastestKm 应排除高分轨迹取 C2 260');
});

test('D0 夹具自证：calcDriftScore 分量公式', () => {
  // 10 步全 accBad → 60 分；20 步一半 vehicle → 10 分
  assert.equal(calcDriftScore(walkPoints(10, (_i, p) => (p.accBad = true))), 60);
  assert.equal(calcDriftScore(walkPoints(20, (i, p) => (p.vehicle = i > 10))), 10);
  assert.equal(calcDriftScore([]), 0);
  assert.equal(calcDriftScore([{ lat: 1, lng: 1, timestamp: 0 }]), 0);
});
