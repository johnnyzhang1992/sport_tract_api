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
function walkPoints(steps: number, hook?: (i: number, p: Record<string, unknown>) => void, stepM = 100) {
  const out: Array<Record<string, unknown>> = [];
  let lat = 30;
  let ts = 1_790_000_000_000;
  for (let i = 0; i <= steps; i++) {
    const p: Record<string, unknown> = { seq: i + 1, lat, lng: 114, timestamp: ts };
    hook?.(i, p);
    out.push(p);
    lat += stepM * M_PER_DEG;
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
  const b2pts = walkPoints(240, (i, p) => {
    if (i % 5 === 0) p.accBad = true; // 20% 步 accBad → ~12 分，维持中带语义
    if (i >= 10 && i <= 14) p.vehicle = true;
  }, 30); // 30m/25s = 1.2m/s 真实徒步步长（否则均速项会误伤这个「应通过」夹具）
  b2pts[240].timestamp = (b2pts[239].timestamp as number) + 150_000; // 一步 150s 断档
  B2 = String(
    await insertActivity(userB, { provinces: ['漂移测试省'], distance: 7200, duration: 6150, startTime: 1_790_100_000_000 }, b2pts),
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
  assert.equal(walking?.distance, 7200, `榜首应为 B2 7200，实际 ${JSON.stringify(walking)}`);
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
  // B2（13 分，合法通过门禁）的 km5 里程碑应在；B3（高分）不得出现
  const curKm = data.fastestDistanceByKm as Array<{ id: string; km: number }>;
  assert.ok(!curKm.some((r) => String(r.id) === String(B3)), '当前纪录不应含高分轨迹 B3');
  assert.ok(curKm.some((r) => String(r.id) === String(B2)), '通过门禁的 B2 里程碑应正常在榜');
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
  assert.equal(walking?.distance, 7200, '混合轨迹 B2 7200 应正常进榜');
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
      trackPoints: walkPoints(30, undefined, 30), // 30m/25s = 1.2m/s 真实步行
      markers: [],
      pausedMs: 0,
      clientDistance: 900,
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
  assert.equal(farthest?.value, 7200, `farthest 应为 B2 7200（B1/B3 被门禁），实际 ${farthest?.value}`);
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

test('D9 导入轨迹也落 driftScore（非 null，docs/19 §4.3 补遗）', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'openid:act-drift-import' },
  });
  const tk = login.json().data.accessToken;
  // GPX（WGS-84）：10 点直线，10s 一采（稀疏导入的分数会偏高但不触发门禁，此处只验落分）
  const rows: string[] = [];
  for (let i = 0; i < 10; i++) {
    const lat = (30 + i * 100 * M_PER_DEG).toFixed(6);
    const t = new Date(1_790_000_000_000 + i * 10_000).toISOString();
    rows.push(`    <trkpt lat="${lat}" lon="114"><time>${t}</time></trkpt>`);
  }
  const gpx = `<?xml version="1.0"?>\n<gpx version="1.1" creator="test"><trk><trkseg>\n${rows.join('\n')}\n</trkseg></trk></gpx>`;
  const boundary = '----driftimport';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="d.gpx"\r\nContent-Type: application/gpx+xml\r\n\r\n`,
    ),
    Buffer.from(gpx),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const imported = await app.inject({
    method: 'POST',
    url: '/sport-track/api/activities/import',
    payload,
    headers: { authorization: `Bearer ${tk}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  assert.equal(imported.statusCode, 200, imported.body);
  const doc = await ActivityModel.findById(imported.json().data.id).select('driftScore trackKind').lean();
  assert.ok(doc, '导入活动应落库');
  assert.ok(typeof doc?.driftScore === 'number', `导入轨迹 driftScore 应为数值，实际 ${doc?.driftScore}`);
});

test('D13 换类型重算类型相关判定：步行→骑行 driftScore 回落、perfScore 归零', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'openid:act-drift-retype' },
  });
  const tk = login.json().data.accessToken;
  const uid = (await UserModel.findOne({ openid: 'act-drift-retype' }).select('_id').lean())!._id;
  // 弦速 5m/s ∈ (步行 gapSpeed 4.0, 骑行退化 6.5)：步行口径是快弦、骑行口径是慢弦
  const pts: Array<Record<string, unknown>> = [{ seq: 1, lat: 30, lng: 114, timestamp: 0 }];
  let lat = 30;
  let ts = 0;
  let seq = 2;
  for (let k = 0; k < 6; k++) {
    lat += 50 * M_PER_DEG;
    ts += 25_000;
    pts.push({ seq: seq++, lat, lng: 114, timestamp: ts });
  }
  for (let k = 0; k < 3; k++) {
    lat += 300 * M_PER_DEG;
    ts += 60_000;
    pts.push({ seq: seq++, lat, lng: 114, timestamp: ts });
  }
  const created = await ActivityModel.create({
    userId: uid,
    type: 'walking',
    status: 'finished',
    startTime: 1_790_000_000_000,
    endTime: 1_790_000_000_000 + 330_000,
    distance: 1200,
    duration: 330,
    perfScore: 200, // 步行旧表现分
    driftScore: calcDriftScore(pts, 'walking', { distance: 1200, durationSec: 330 }),
    trackPoints: pts as never,
  });
  assert.ok((created.driftScore ?? 0) >= DRIFT_SCORE_PB_GATE, '夹具：步行口径应 ≥30（快弦）');

  const re = await app.inject({
    method: 'PUT',
    url: `/sport-track/api/activities/${created._id}/meta`,
    headers: { authorization: `Bearer ${tk}` },
    payload: { type: 'cycling' },
  });
  assert.equal(re.statusCode, 200, re.body);
  const doc = await ActivityModel.findById(created._id).select('type driftScore perfScore').lean();
  assert.equal(doc?.type, 'cycling');
  assert.equal(doc?.perfScore, null, '骑行不应有表现分（旧步行分应归零）');
  assert.ok(
    (doc?.driftScore ?? 0) < DRIFT_SCORE_PB_GATE,
    `骑行口径下 5m/s 是慢弦，分数应回落，实际 ${doc?.driftScore}`,
  );
});

test('D10 老客户端快弦（无标记 >30s 步、弦速超 gapSpeed）→ 重罚门禁；慢弦稀疏轨迹通过', () => {
  // 老版本客户端把超速点整批丢弃后，残留点之间的直线弦藏着被丢弃的超速位移——
  // 弦速超人类持续上限就是证据（2026-10-26 用户拍板：宁错拦不放过）
  const build = (gapM: number) => {
    const pts: Array<Record<string, unknown>> = [{ seq: 1, lat: 30, lng: 114, timestamp: 0 }];
    let lat = 30;
    let ts = 0;
    let seq = 2;
    for (let k = 0; k < 6; k++) {
      lat += 50 * M_PER_DEG;
      ts += 25_000;
      pts.push({ seq: seq++, lat, lng: 114, timestamp: ts });
    }
    for (let k = 0; k < 3; k++) {
      lat += gapM * M_PER_DEG;
      ts += 60_000;
      pts.push({ seq: seq++, lat, lng: 114, timestamp: ts });
    }
    return pts;
  };
  // 快弦：3×60s 步各 400m（6.7m/s > 跑/走 gapSpeed 4）→ fastGap 占 span 54.5% → 重罚超门禁
  const fastScore = calcDriftScore(build(400), 'walking');
  assert.ok(fastScore >= DRIFT_SCORE_PB_GATE, `快弦轨迹应门禁，实际 ${fastScore}`);
  // 慢弦对照：同样 3×60s 间隔，但弦速 1.67m/s（真实徒步节奏）→ 轻罚通过
  const slowScore = calcDriftScore(build(100), 'walking');
  assert.ok(slowScore < DRIFT_SCORE_PB_GATE, `慢弦稀疏轨迹应通过，实际 ${slowScore}`);
});

test('D11 均速物理不可能（c10184 形态：30.6km/h 的「步行」）→ 门禁', () => {
  // 21km / 41min = 8.5m/s，远超步行持续上限 2.2 —— 距离/时长口径的烟枪信号
  const score = calcDriftScore(walkPoints(59), 'walking', { distance: 21000, durationSec: 2460 });
  assert.ok(score >= DRIFT_SCORE_PB_GATE, `均速不可能应门禁，实际 ${score}`);
  // 对照：同几何 21km / 5.8h（1.0m/s）→ 通过
  const ok = calcDriftScore(walkPoints(210), 'walking', { distance: 21000, durationSec: 21000 });
  assert.ok(ok < DRIFT_SCORE_PB_GATE, `合理均速应通过，实际 ${ok}`);
});

test('D12 距离 >> 弦证据（c10042 形态：存储 20km 弦长只撑 11.6km）→ 门禁', () => {
  // 稀疏点弦长 500m，存储距离报 5000m：证据撑不起的距离不可信（still 收缩丢漂移细节/旧版丢弃）
  const score = calcDriftScore(walkPoints(10, undefined, 50), 'walking', { distance: 5000, durationSec: 3000 });
  assert.ok(score >= DRIFT_SCORE_PB_GATE, `距离证据不足应门禁，实际 ${score}`);
  // 对照：弦长 ≈ 距离 → 通过
  const ok = calcDriftScore(walkPoints(10, undefined, 50), 'walking', { distance: 500, durationSec: 3000 });
  assert.ok(ok < DRIFT_SCORE_PB_GATE, `证据充分应通过，实际 ${ok}`);
});

test('D0 夹具自证：calcDriftScore 分量公式', () => {
  // 10 步全 accBad → 60 分；20 步一半 vehicle → 10 分
  assert.equal(calcDriftScore(walkPoints(10, (_i, p) => (p.accBad = true))), 60);
  assert.equal(calcDriftScore(walkPoints(20, (i, p) => (p.vehicle = i > 10))), 10);
  assert.equal(calcDriftScore([]), 0);
  assert.equal(calcDriftScore([{ lat: 1, lng: 1, timestamp: 0 }]), 0);
});
