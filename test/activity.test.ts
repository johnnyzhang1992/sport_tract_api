import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { LoginLogModel } from '../src/models/login-log.model.js';

let app: FastifyInstance;
let tokenA = '';
let tokenB = '';
let activityId = '';

// 固定“当前时间”，保证活动落在今日区间（overview/trend 断言依赖）
const TEST_NOW = Date.now();

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  // 清理测试数据
  const users = await UserModel.find({ openid: /^mock_openid_/ }).select('_id');
  const ids = users.map((u) => u._id);
  await ActivityModel.deleteMany({ userId: { $in: ids } });
  await LoginLogModel.deleteMany({ userId: { $in: ids } });
  await UserModel.deleteMany({ openid: /^mock_openid_/ });

  // 两个测试用户：A 是活动所有者，B 用于越权测试
  tokenA = (await login('m2-user-a')).accessToken;
  tokenB = (await login('m2-user-b')).accessToken;
});

after(async () => {
  await app.close();
});

async function login(code: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code },
  });
  return res.json().data;
}

async function req(
  method: string,
  url: string,
  opts: { body?: Record<string, unknown> | undefined; token?: string } = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: method as 'GET',
    url,
    payload: opts.body,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
  });
}

const P = (seq: number, lat: number, lng: number, altitude?: number) => ({
  seq,
  lat,
  lng,
  altitude: altitude ?? null,
  speed: null,
  timestamp: TEST_NOW - 50000 + seq * 10000,
});

test('创建进行中活动', async () => {
  const res = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'running', startTime: TEST_NOW - 60000 },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.activity.status, 'in_progress');
  activityId = body.data.activityId;
  assert.ok(activityId);
});

test('增量上传轨迹点，返回 lastPointSeq', async () => {
  const res = await req('POST', `/sport-track/api/activities/${activityId}/points`, {
    token: tokenA,
    body: { points: [P(1, 31.2304, 121.4737), P(2, 31.2305, 121.4738), P(3, 31.2306, 121.4739)] },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.data.lastPointSeq, 3);
  assert.equal(body.data.added, 3);
});

test('幂等去重：重复 seq 不重复追加', async () => {
  // 重传 1-3 + 新增 4-5
  const res = await req('POST', `/sport-track/api/activities/${activityId}/points`, {
    token: tokenA,
    body: { points: [P(1, 31.2304, 121.4737), P(3, 31.2306, 121.4739), P(4, 31.2307, 121.474), P(5, 31.2308, 121.4741)] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.lastPointSeq, 5);
  assert.equal(res.json().data.added, 2); // 只新增 4、5
});

test('新增打点', async () => {
  const res = await req('POST', `/sport-track/api/activities/${activityId}/markers`, {
    token: tokenA,
    body: {
      id: 'm1',
      lat: 31.2305,
      lng: 121.4738,
      timestamp: 1700000002000,
      type: 'checkpoint',
      note: '补给点',
      address: '上海市黄浦区',
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.marker.id, 'm1');
});

test('finish 对账：以 final 包为准重算指标', async () => {
  const res = await req('PUT', `/sport-track/api/activities/${activityId}/finish`, {
    token: tokenA,
    body: {
      trackPoints: [
        // 间隔 ~0.001° ≈ 111m，总距 ~444m > 200m（配速有效）
        P(1, 31.2304, 121.4737, 10),
        P(2, 31.2314, 121.4738, 12),
        P(3, 31.2324, 121.4739, 11),
        P(4, 31.2334, 121.474, 15),
        P(5, 31.2344, 121.4741, 18),
      ],
      markers: [{ id: 'm1', lat: 31.2305, lng: 121.4738, timestamp: 1700000002000, type: 'checkpoint', note: '补给点', photoUrl: '', address: '上海市黄浦区' }],
      startAddress: '起点',
      endAddress: '终点',
      pausedMs: 10000,
      endTime: TEST_NOW,
      weightKg: 65,
    },
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.status, 'finished');
  assert.equal(data.lastPointSeq, 5);
  assert.ok(data.activity.distance > 0, '距离应 > 0');
  assert.ok(data.activity.duration > 0, '时长应 > 0');
  assert.ok(data.activity.avgPace > 0, '配速应 > 0');
  assert.ok(data.activity.elevationGain >= 0);
  assert.ok(data.activity.calories > 0, '卡路里应 > 0');
  assert.equal(data.activity.markers.length, 1);
});

test('finish endTime：以最后一个轨迹点的上报时间为准，忽略传入 endTime', async () => {
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'running', startTime: TEST_NOW - 60000 },
  });
  const id = created.json().data.activityId;
  const lastTs = TEST_NOW - 20000; // 中断于 20s 前，finish 迟报
  const res = await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenA,
    body: {
      trackPoints: [
        { seq: 1, lat: 31.2304, lng: 121.4737, altitude: null, speed: null, timestamp: TEST_NOW - 40000 },
        { seq: 2, lat: 31.2314, lng: 121.4738, altitude: null, speed: null, timestamp: lastTs },
      ],
      endTime: TEST_NOW + 3600 * 1000, // 迟报 1 小时
      pausedMs: 0,
    },
  });
  assert.equal(res.statusCode, 200);
  const act = res.json().data.activity;
  assert.equal(act.endTime, lastTs, 'endTime 应取最后轨迹点时间');
  assert.equal(act.duration, 40, '时长 = (最后点 - startTime) / 1000');
});

test('总时长：含暂停的墙钟时长（= 运动时长 + 暂停时长）', async () => {
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'running', startTime: TEST_NOW - 60000 },
  });
  const id = created.json().data.activityId;
  const res = await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenA,
    body: {
      trackPoints: [
        { seq: 1, lat: 31.2304, lng: 121.4737, altitude: null, speed: null, timestamp: TEST_NOW - 50000 },
        { seq: 2, lat: 31.2314, lng: 121.4738, altitude: null, speed: null, timestamp: TEST_NOW - 30000 },
        { seq: 3, lat: 31.2324, lng: 121.4739, altitude: null, speed: null, timestamp: TEST_NOW },
      ],
      endTime: TEST_NOW,
      pausedMs: 10000, // 中途暂停 10s
    },
  });
  assert.equal(res.statusCode, 200);
  const act = res.json().data.activity;
  assert.equal(act.endTime, TEST_NOW);
  assert.equal(act.duration, 50, '运动时长 = 墙钟 60s − 暂停 10s');
  assert.equal(act.totalDuration, 60, '总时长 = endTime − startTime（含暂停）');
});

test('静止剔除：停留 ≥60s 的时段从运动时长里剔掉，standstillMs 与点标记入库', async () => {
  // 用独立用户：创建接口有「同一用户 1 小时最多 10 条」防刷，别占用 tokenA 的额度
  const tokenS = (await login('m2-standstill')).accessToken;
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenS,
    body: { type: 'hiking', startTime: TEST_NOW - 270000 },
  });
  const id = created.json().data.activityId;
  const LAT0 = 31.23;
  const STEP_DEG = 0.000135; // ≈15m/点，5s 一采 ≈3 m/s，正常行进
  const points: Array<Record<string, unknown>> = [];
  let seq = 0;
  let ts = TEST_NOW - 270000;
  for (let k = 0; k <= 16; k++) {
    points.push({ seq: ++seq, lat: LAT0 + STEP_DEG * k, lng: 121.4737, altitude: null, speed: null, timestamp: ts });
    ts += 5000;
  }
  const latEnd = LAT0 + STEP_DEG * 16;
  for (let k = 1; k <= 16; k++) {
    // 到终点后原地站住，16 个点跨 80s
    points.push({ seq: ++seq, lat: latEnd, lng: 121.4737, altitude: null, speed: null, timestamp: ts });
    ts += 5000;
  }

  const res = await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenS,
    body: { trackPoints: points, endTime: ts, pausedMs: 0 },
  });
  assert.equal(res.statusCode, 200);
  const act = res.json().data.activity;
  assert.equal(act.totalDuration, 160, '总时长 = 墙钟（含静止）');
  // 80s 而不是 75s：跑动段最后一个点就落在终点位置上，静止段从它开始算（人一到达就在原地不动了）
  assert.equal(act.standstillMs, 80000, '静止 80s 应入库');
  assert.equal(act.duration, 80, '运动时长 = 墙钟 160s − 静止 80s');
  const stillPts = (act.trackPoints as Array<{ still?: boolean }>).filter((p) => p.still === true);
  assert.ok(stillPts.length >= 3, '静止时段的点应带 still 标记落库');
});

test('静止剔除：只停 55s 不足门槛 → 不剔（1 分钟内的短停照算）', async () => {
  const tokenS = (await login('m2-standstill')).accessToken;
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenS,
    body: { type: 'hiking', startTime: TEST_NOW - 240000 },
  });
  const id = created.json().data.activityId;
  const LAT0 = 31.23;
  const STEP_DEG = 0.000135;
  const points: Array<Record<string, unknown>> = [];
  let seq = 0;
  let ts = TEST_NOW - 240000;
  for (let k = 0; k <= 16; k++) {
    points.push({ seq: ++seq, lat: LAT0 + STEP_DEG * k, lng: 121.4737, altitude: null, speed: null, timestamp: ts });
    ts += 5000;
  }
  const latEnd = LAT0 + STEP_DEG * 16;
  for (let k = 1; k <= 11; k++) {
    points.push({ seq: ++seq, lat: latEnd, lng: 121.4737, altitude: null, speed: null, timestamp: ts });
    ts += 5000; // 只跨 55s
  }

  const res = await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenS,
    body: { trackPoints: points, endTime: ts, pausedMs: 0 },
  });
  assert.equal(res.statusCode, 200);
  const act = res.json().data.activity;
  assert.equal(act.standstillMs, 0);
  assert.equal(act.duration, act.totalDuration, '不足门槛时不剔，运动时长 = 墙钟');
});

test('总时长：列表/详情接口同样下发（含旧数据 pausedMs 缺失）', async () => {
  const detail = await req('GET', `/sport-track/api/activities/${activityId}`, { token: tokenA });
  assert.equal(detail.statusCode, 200);
  const act = detail.json().data;
  assert.equal(typeof act.totalDuration, 'number');
  assert.ok(act.totalDuration >= act.duration, '总时长不小于运动时长');
});

test('finish：空轨迹点 → 自动作废（点数过少），endTime 回退传入 endTime', async () => {
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'walking', startTime: TEST_NOW - 30000 },
  });
  const id = created.json().data.activityId;
  const res = await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenA,
    body: { trackPoints: [], endTime: TEST_NOW },
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.status, 'cancelled', '空轨迹应自动作废');
  assert.equal(data.reason, 'TOO_FEW_POINTS');
  assert.equal(data.activity.endTime, TEST_NOW, '作废时 endTime 仍应回退传入 endTime');
});

test('finish：点数过少（<3，即使距离达标）→ 自动作废，不进列表', async () => {
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'running', startTime: TEST_NOW - 30000 },
  });
  const id = created.json().data.activityId;
  // 2 个点相距 ~111m：距离达标但只有 2 点（GPS 长时间丢点会画出假直线）→ 作废
  const res = await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenA,
    body: {
      trackPoints: [P(1, 31.2304, 121.4737), P(2, 31.2314, 121.4737)],
      endTime: TEST_NOW,
      pausedMs: 0,
    },
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.status, 'cancelled', '点数 < 3 应自动作废');
  assert.equal(data.reason, 'TOO_FEW_POINTS');
  // 列表（只查 finished）不应出现
  const list = await req('GET', '/sport-track/api/activities?pageSize=100', { token: tokenA });
  const item = list.json().data.items.find((i: { _id: string }) => String(i._id) === id);
  assert.ok(!item, '作废活动不应出现在用户列表');
  // 重复 finish → 幂等返回作废结果（不报 409）
  const retry = await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenA,
    body: {
      trackPoints: [P(1, 31.2304, 121.4737), P(2, 31.2314, 121.4737)],
      endTime: TEST_NOW,
      pausedMs: 0,
    },
  });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().data.status, 'cancelled');
  await ActivityModel.deleteOne({ _id: id });
});

test('finish：点数多但距离过短（原地不动）→ 自动作废，不进列表', async () => {
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'running', startTime: TEST_NOW - 60000 },
  });
  const id = created.json().data.activityId;
  // 6 个点在 ~1m 范围内抖动（站 50s 的采点节奏）：点数达标但重算距离 ≈ 0 → 作废
  const jitter = [0, 0.000005, -0.000005, 0.000008, -0.000008, 0.000003];
  const res = await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenA,
    body: {
      trackPoints: jitter.map((d, i) => P(i + 1, 31.2304 + d, 121.4737 + d)),
      endTime: TEST_NOW,
      pausedMs: 0,
    },
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.status, 'cancelled', '距离 < 10m 应自动作废');
  assert.equal(data.reason, 'DISTANCE_TOO_SHORT');
  const list = await req('GET', '/sport-track/api/activities?pageSize=100', { token: tokenA });
  const item = list.json().data.items.find((i: { _id: string }) => String(i._id) === id);
  assert.ok(!item, '作废活动不应出现在用户列表');
  await ActivityModel.deleteOne({ _id: id });
});

test('finish 落库省市：写入经过的省与起点城市', async () => {
  // 轨迹从上海(31.25,121.1)跨到苏州(31.30,121.1)，跨两省 ~5.5km
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'walking', startTime: TEST_NOW - 60000 },
  });
  const id = created.json().data.activityId;
  const pts = [
    { seq: 1, lat: 31.25, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW - 50000 },
    { seq: 2, lat: 31.26, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW - 40000 },
    { seq: 3, lat: 31.27, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW - 30000 },
    { seq: 4, lat: 31.28, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW - 20000 },
    { seq: 5, lat: 31.29, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW - 10000 },
    { seq: 6, lat: 31.3, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW },
  ];
  const res = await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenA,
    body: { trackPoints: pts, endTime: TEST_NOW, pausedMs: 0 },
  });
  assert.equal(res.statusCode, 200);
  const act = res.json().data.activity;
  assert.deepEqual(act.provinces, ['上海市', '江苏省'], '应记录经过的省（按出现顺序）');
  assert.equal(act.startProvince, '上海市');
  assert.equal(act.startCity, '上海市');
  await ActivityModel.deleteOne({ _id: id });
});

test('列表按省筛选：?province= 只返回该省轨迹', async () => {
  // 前置：构造一条上海轨迹 + 一条跨省轨迹（上海→江苏）
  const sh = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'running', startTime: TEST_NOW - 60000 },
  });
  const shId = sh.json().data.activityId;
  await req('PUT', `/sport-track/api/activities/${shId}/finish`, {
    token: tokenA,
    body: {
      trackPoints: [
        { seq: 1, lat: 31.25, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW - 20000 },
        { seq: 2, lat: 31.26, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW - 10000 },
        { seq: 3, lat: 31.27, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW },
      ],
      endTime: TEST_NOW,
      pausedMs: 0,
    },
  });
  const cross = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'walking', startTime: TEST_NOW - 60000 },
  });
  const crossProvinceId = cross.json().data.activityId;
  await req('PUT', `/sport-track/api/activities/${crossProvinceId}/finish`, {
    token: tokenA,
    body: {
      trackPoints: [
        { seq: 1, lat: 31.25, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW - 50000 },
        { seq: 2, lat: 31.26, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW - 40000 },
        { seq: 3, lat: 31.27, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW - 30000 },
        { seq: 4, lat: 31.28, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW - 20000 },
        { seq: 5, lat: 31.29, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW - 10000 },
        { seq: 6, lat: 31.3, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW },
      ],
      endTime: TEST_NOW,
      pausedMs: 0,
    },
  });

  // 按省筛选：上海市 → 两条都命中（上海轨迹 + 跨省轨迹起点在上海）
  const bySh = await req('GET', '/sport-track/api/activities?province=上海市&pageSize=100', { token: tokenA });
  assert.equal(bySh.statusCode, 200);
  const shIds = bySh.json().data.items.map((i: { _id: string }) => String(i._id));
  assert.ok(shIds.includes(shId), '上海轨迹应命中');
  assert.ok(shIds.includes(crossProvinceId), '跨省轨迹（含上海）应命中');

  // 按省筛选：江苏省 → 只有跨省轨迹
  const byJs = await req('GET', '/sport-track/api/activities?province=江苏省&pageSize=100', { token: tokenA });
  assert.equal(byJs.statusCode, 200);
  const jsIds = byJs.json().data.items.map((i: { _id: string }) => String(i._id));
  assert.ok(jsIds.includes(crossProvinceId), '跨省轨迹应命中江苏省');
  assert.ok(!jsIds.includes(shId), '纯上海轨迹不应命中江苏省');

  // 省份 + 月份组合筛选
  const month = new Date(TEST_NOW).toISOString().slice(0, 7);
  const byShMonth = await req('GET', `/sport-track/api/activities?province=上海市&month=${month}&pageSize=100`, { token: tokenA });
  assert.equal(byShMonth.statusCode, 200);
  assert.ok(byShMonth.json().data.items.some((i: { _id: string }) => String(i._id) === crossProvinceId));

  // 列表条目带省市字段
  const item = bySh.json().data.items.find((i: { _id: string }) => String(i._id) === crossProvinceId);
  assert.ok(item.provinces.includes('江苏省'));
  assert.equal(item.startCity, '上海市');

  // 清理
  await ActivityModel.deleteOne({ _id: shId });
  await ActivityModel.deleteOne({ _id: crossProvinceId });
});

test('finish 后禁止再上传轨迹点 → 409', async () => {
  const res = await req('POST', `/sport-track/api/activities/${activityId}/points`, {
    token: tokenA,
    body: { points: [P(6, 31.2309, 121.4742)] },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().data.code, 'ACTIVITY_FINISHED');
});

test('重复 finish → 幂等返回', async () => {
  const res = await req('PUT', `/sport-track/api/activities/${activityId}/finish`, {
    token: tokenA,
    body: { trackPoints: [P(1, 31.2304, 121.4737)] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.status, 'finished');
});

test('空轨迹点直接结束 → 自动作废不保存', async () => {
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'walking', startTime: TEST_NOW - 30000 },
  });
  const id = created.json().data.activityId;

  const res = await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenA,
    body: { trackPoints: [], endTime: TEST_NOW },
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.status, 'cancelled');
  assert.equal(data.lastPointSeq, 0);
  await ActivityModel.deleteOne({ _id: id });
});

test('分享查看：B 用户读取 A 的 finished 主活动 → 200 + isOwner=false', async () => {
  const res = await req('GET', `/sport-track/api/activities/${activityId}`, { token: tokenB });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.isOwner, false);
});

test('分享查看：B 用户读 A 的 finished 轨迹 → 200 + isOwner=false（只读）', async () => {
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'running', startTime: TEST_NOW - 60000 },
  });
  const id = created.json().data.activityId;
  await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenA,
    body: {
      trackPoints: [
        { seq: 1, lat: 31.25, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW - 20000 },
        { seq: 2, lat: 31.26, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW - 10000 },
        { seq: 3, lat: 31.27, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW },
      ],
      endTime: TEST_NOW,
      pausedMs: 0,
    },
  });

  // 本人读 → isOwner=true
  const mine = await req('GET', `/sport-track/api/activities/${id}`, { token: tokenA });
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.json().data.isOwner, true);

  // B 读 → 200 + isOwner=false（可看轨迹数据）
  const shared = await req('GET', `/sport-track/api/activities/${id}`, { token: tokenB });
  assert.equal(shared.statusCode, 200);
  const data = shared.json().data;
  assert.equal(data.isOwner, false);
  assert.equal(data.trackPoints.length, 3, '非本人也应能读到完整轨迹点');
  assert.equal(data.markers.length, 0);

  // B 仍不能写（编辑接口 404，保持 owner 隔离）
  const meta = await req('PUT', `/sport-track/api/activities/${id}/meta`, {
    token: tokenB,
    body: { note: 'hack' },
  });
  assert.equal(meta.statusCode, 404, '非本人编辑应 404');

  await ActivityModel.deleteOne({ _id: id });
});

test('分享查看：非本人读取未完成（in_progress）轨迹 → 404', async () => {
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'running', startTime: TEST_NOW - 60000 },
  });
  const id = created.json().data.activityId;
  // 不 finish，保持 in_progress
  const res = await req('GET', `/sport-track/api/activities/${id}`, { token: tokenB });
  assert.equal(res.statusCode, 404, '非本人不可见未完成轨迹');
  await ActivityModel.deleteOne({ _id: id });
});

test('分享查看：未登录（游客）读 finished 轨迹 → 200 + isOwner=false', async () => {
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'hiking', startTime: TEST_NOW - 60000 },
  });
  const id = created.json().data.activityId;
  await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenA,
    body: {
      trackPoints: [
        { seq: 1, lat: 31.25, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW - 20000 },
        { seq: 2, lat: 31.26, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW - 10000 },
        { seq: 3, lat: 31.27, lng: 121.1, altitude: null, speed: null, timestamp: TEST_NOW },
      ],
      endTime: TEST_NOW,
      pausedMs: 0,
    },
  });

  // 不带 token（游客）读取 → 200 + isOwner=false + 完整轨迹点
  const guest = await req('GET', `/sport-track/api/activities/${id}`);
  assert.equal(guest.statusCode, 200);
  const data = guest.json().data;
  assert.equal(data.isOwner, false);
  assert.equal(data.trackPoints.length, 3);

  // 游客读 in_progress → 404
  const created2 = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'running', startTime: TEST_NOW - 60000 },
  });
  const id2 = created2.json().data.activityId;
  const guest2 = await req('GET', `/sport-track/api/activities/${id2}`);
  assert.equal(guest2.statusCode, 404, '游客不可见未完成轨迹');
  await ActivityModel.deleteOne({ _id: id2 });

  await ActivityModel.deleteOne({ _id: id });
});

test('活动列表：包含统计字段，不含完整点集', async () => {
  const res = await req('GET', '/sport-track/api/activities?page=1&pageSize=10', { token: tokenA });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.ok(data.total >= 1);
  // 按 id 定位主活动（列表按 startTime 倒序，主活动不一定在首位；聚合返回 _id）
  const item = data.items.find((i: { _id: string }) => String(i._id) === activityId);
  assert.ok(item, '列表包含主活动');
  assert.equal(item.pointsCount, 5);
  assert.equal(item.markerCount, 1);
  assert.ok(item.firstPoint);
  assert.equal(item.trackPoints, undefined); // 列表不返回完整点集
});

test('best 惰性补算：历史轨迹无 fastestKm 自动补齐', async () => {
  // 创建并 finish 一条轨迹，然后删除 fastestKm（模拟历史数据）
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'running', startTime: TEST_NOW - 60000 },
  });
  const id = created.json().data.activityId;
  // 上传轨迹点（2 段 1km，每段 5 间隔 20s/10s → 最快 50s/km）并 finish
  const pts = [];
  const d1 = 1000 / 111000;
  let ts = TEST_NOW - 60000;
  const baseLat = 31;
  for (let i = 0; i <= 5; i++) pts.push({ seq: i + 1, lat: baseLat + (d1 * i) / 5, lng: 121, altitude: null, speed: null, timestamp: ts + i * 20000 });
  const b2 = pts[pts.length - 1];
  for (let i = 1; i <= 5; i++) pts.push({ seq: pts.length + 1, lat: b2.lat + (d1 * i) / 5, lng: 121, altitude: null, speed: null, timestamp: b2.timestamp + i * 10000 });
  await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenA,
    body: { trackPoints: pts, endTime: TEST_NOW, pausedMs: 0 },
  });
  // P() 是固定 timestamp——用真实时间点重算 fastestKm 后删字段模拟历史
  await ActivityModel.updateOne({ _id: id }, { $set: { fastestKm: null } }, { timestamps: false });
  const before = await ActivityModel.findById(id).lean();
  assert.equal(before?.fastestKm, null);
  // 调 best → 触发补算
  const res = await req('GET', '/sport-track/api/stats/best', { token: tokenA });
  assert.equal(res.statusCode, 200);
  const after = await ActivityModel.findById(id).lean();
  assert.ok(after?.fastestKm !== null, 'fastestKm 被补算');
  await ActivityModel.deleteOne({ _id: id });
});

test('列表惰性清理：超时空活动（无轨迹点）作废 cancelled', async () => {
  // 创建 in_progress 活动（startTime 25 小时前），无轨迹点
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'walking', startTime: Date.now() - 25 * 3600 * 1000 },
  });
  const id = created.json().data.activityId;
  // 模拟异常退出：updatedAt 置为 25 小时前（无更新）
  await ActivityModel.updateOne({ _id: id }, { $set: { updatedAt: new Date(Date.now() - 25 * 3600 * 1000) } }, { timestamps: false });
  // 调列表 → 触发惰性清理
  await req('GET', '/sport-track/api/activities?page=1&pageSize=10', { token: tokenA });
  const act = await ActivityModel.findById(id).lean();
  assert.equal(act?.status, 'cancelled', '空活动无数据可保留，应作废');
  await ActivityModel.deleteOne({ _id: id });
});

test('列表惰性清理：超时且有轨迹点 → 自动 finish 保留数据', async () => {
  // 创建 in_progress 活动并上传 3 个轨迹点（最后点时间 = TEST_NOW - 20000）
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'running', startTime: TEST_NOW - 50000 },
  });
  const id = created.json().data.activityId;
  await req('POST', `/sport-track/api/activities/${id}/points`, {
    token: tokenA,
    body: { points: [P(1, 31.2304, 121.4737), P(2, 31.2305, 121.4738), P(3, 31.2306, 121.4739)] },
  });
  // 模拟异常退出：updatedAt 置为 25 小时前（无更新）
  await ActivityModel.updateOne({ _id: id }, { $set: { updatedAt: new Date(Date.now() - 25 * 3600 * 1000) } }, { timestamps: false });
  // 调列表 → 触发惰性清理
  const list = await req('GET', '/sport-track/api/activities?pageSize=100', { token: tokenA });
  assert.equal(list.statusCode, 200);
  const act = await ActivityModel.findById(id).lean();
  assert.equal(act?.status, 'finished', '有轨迹点应自动 finish 保留数据');
  assert.equal(act?.endTime, TEST_NOW - 20000, 'endTime 应取最后轨迹点上报时间');
  assert.equal(act?.duration, 30, '时长 = (最后点 - startTime) / 1000');
  assert.ok((act?.distance ?? 0) > 0, '距离应被重算 > 0');
  assert.ok(act?.trackPoints.length === 3, '轨迹点应保留');
  // 出现在用户列表（用户端只查 finished）
  const item = list.json().data.items.find((i: { _id: string }) => String(i._id) === id);
  assert.ok(item, '自动 finish 的活动应出现在用户列表');
  assert.ok(item.distance > 0);
  await ActivityModel.deleteOne({ _id: id });
});

test('列表惰性清理：超时但点数过少/距离过短 → 自动作废', async () => {
  // 原地不动产生的一堆漂移点：点数达标但重算距离 ≈ 0 → 不应保留为 finished
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'walking', startTime: TEST_NOW - 50000 },
  });
  const id = created.json().data.activityId;
  const jitter = [0, 0.000004, -0.000004, 0.000006];
  await req('POST', `/sport-track/api/activities/${id}/points`, {
    token: tokenA,
    body: { points: jitter.map((d, i) => P(i + 1, 31.2304 + d, 121.4737 + d)) },
  });
  await ActivityModel.updateOne(
    { _id: id },
    { $set: { updatedAt: new Date(Date.now() - 25 * 3600 * 1000) } },
    { timestamps: false },
  );
  const list = await req('GET', '/sport-track/api/activities?pageSize=100', { token: tokenA });
  assert.equal(list.statusCode, 200);
  const act = await ActivityModel.findById(id).lean();
  assert.equal(act?.status, 'cancelled', '重算距离过短应自动作废');
  const item = list.json().data.items.find((i: { _id: string }) => String(i._id) === id);
  assert.ok(!item, '作废活动不应出现在用户列表');
  await ActivityModel.deleteOne({ _id: id });
});

test('列表 previewPoints：暂停断点（pauseGap）不被均匀采样丢失', async () => {
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'walking', startTime: TEST_NOW - 60000 },
  });
  const id = created.json().data.activityId;
  // 201 个点直线，seq=101（中段）标 pauseGap：均匀采样 60 点大概率不含它
  const pts = [];
  for (let i = 1; i <= 201; i++) pts.push(P(i, 31.2304 + i * 0.0001, 121.4737));
  (pts[100] as { pauseGap?: boolean }).pauseGap = true;
  await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenA,
    body: { trackPoints: pts, endTime: TEST_NOW, pausedMs: 0 },
  });
  const list = await req('GET', '/sport-track/api/activities?pageSize=100', { token: tokenA });
  const item = list.json().data.items.find((i: { _id: string }) => String(i._id) === id);
  assert.ok(item, 'finished 活动应在列表');
  const pp = item.previewPoints;
  assert.ok(pp.length >= 60 && pp.length <= 70, `预览点数异常: ${pp.length}`);
  const gaps = pp.filter((p: { pauseGap?: boolean }) => p.pauseGap === true);
  assert.equal(gaps.length, 1, '暂停断点应保留且不重复');
  assert.ok(gaps[0].lat > 31.234 && gaps[0].lat < 31.252, '断点坐标应来自轨迹中段原点');
  assert.ok(!('seq' in pp[0]), '响应不应暴露内部 seq 字段');
  await ActivityModel.deleteOne({ _id: id });
});

test('列表 previewPoints：空轨迹不产生 (0,0) 填充点', async () => {
  // 注：finish 现在会作废空轨迹（点数守卫），这里直接在库内造 finished 空轨迹
  //（覆盖列表聚合对异常存量数据的防御分支）
  const mine = await ActivityModel.findById(activityId).select('userId').lean();
  const doc = await ActivityModel.create({
    userId: mine!.userId,
    type: 'walking',
    status: 'finished',
    startTime: TEST_NOW - 30000,
    endTime: TEST_NOW,
    duration: 30,
    distance: 0,
    trackPoints: [],
    markers: [],
  });
  const list = await req('GET', '/sport-track/api/activities?pageSize=100', { token: tokenA });
  const item = list.json().data.items.find((i: { _id: string }) => String(i._id) === String(doc._id));
  assert.ok(item, '空轨迹 finished 活动应在列表');
  assert.deepEqual(item.previewPoints, [], '空轨迹预览点应为空数组');
  await ActivityModel.deleteOne({ _id: doc._id });
});

test('活动详情：返回完整轨迹点与打点', async () => {
  const res = await req('GET', `/sport-track/api/activities/${activityId}`, { token: tokenA });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.trackPoints.length, 5);
  assert.equal(data.markers.length, 1);
  assert.equal(data.distance, data.distance);
});

test('GPX 导出：坐标按标准协议 WGS-84 反算（不是库内 GCJ-02 原值）', async () => {
  const res = await req('GET', `/sport-track/api/activities/${activityId}/gpx`, { token: tokenA });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /application\/gpx\+xml/);
  const xml = res.body;
  assert.match(xml, /<gpx/);

  const { gcj02ToWgs84 } = await import('../src/utils/coordinate.js');
  const { haversineDistance } = await import('../src/utils/pace.js');
  const pick = (tag: 'trkpt' | 'wpt', lat: number, lng: number) => {
    const m = xml.match(new RegExp(`<${tag} lat="([-\\d.]+)" lon="([-\\d.]+)"`));
    assert.ok(m, `${tag} 应存在`);
    return { exported: { lat: Number(m![1]), lng: Number(m![2]) }, gcj: { lat, lng } };
  };

  // 轨迹点：导出值 == GCJ→WGS 反算值，且与库内 GCJ 原值差数百米（否则外部工具读到偏位坐标）
  const trk = pick('trkpt', 31.2304, 121.4737);
  assert.ok(
    haversineDistance(trk.exported, gcj02ToWgs84(trk.gcj.lat, trk.gcj.lng)) < 1,
    'trkpt 应为 GCJ-02 反算后的 WGS-84',
  );
  assert.ok(haversineDistance(trk.exported, trk.gcj) > 100, 'trkpt 不能是库内 GCJ-02 原值');

  // 航点同理
  const wpt = pick('wpt', 31.2305, 121.4738);
  assert.ok(haversineDistance(wpt.exported, gcj02ToWgs84(wpt.gcj.lat, wpt.gcj.lng)) < 1, 'wpt 应为 WGS-84');
  assert.ok(haversineDistance(wpt.exported, wpt.gcj) > 100, 'wpt 不能是库内 GCJ-02 原值');
});

test('统计 overview：今日/本周/本月/累计', async () => {
  const res = await req('GET', '/sport-track/api/stats/overview', { token: tokenA });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  for (const key of ['today', 'week', 'month', 'total']) {
    assert.ok(data[key].count >= 1);
    assert.ok(data[key].distance > 0);
  }
});

test('统计 trend：近 7 天（week）数据', async () => {
  const res = await req('GET', '/sport-track/api/stats/trend?type=week', { token: tokenA });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.type, 'week');
  assert.equal(data.data.length, 7);
  assert.ok(data.data.some((d: { distance: number }) => d.distance > 0));
});

test('创建活动缺 type → 400', async () => {
  const res = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { startTime: 1700000000000 },
  });
  assert.equal(res.statusCode, 400);
});

test('列表返回轨迹缩略预览点（≤60 点均匀采样）', async () => {
  const list = await req('GET', '/sport-track/api/activities?page=1&pageSize=20', { token: tokenA });
  assert.equal(list.statusCode, 200);
  const mine = list.json().data.items.find((i: { _id: unknown }) => String(i._id) === activityId);
  assert.ok(mine, 'finished 活动应在列表中');
  const pp = mine.previewPoints;
  assert.ok(Array.isArray(pp));
  assert.ok(pp.length >= 2 && pp.length <= 60, `previewPoints 点数异常: ${pp.length}`);
  assert.equal(typeof pp[0].lat, 'number');
  assert.equal(typeof pp[0].lng, 'number');
  assert.ok(Math.abs(pp[0].lat - 31.2304) < 1e-6, '首点应近似轨迹起点');
});

test('cancel 活动', async () => {
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'walking', startTime: 1700000000000 },
  });
  const id = created.json().data.activityId;

  const res = await req('PUT', `/sport-track/api/activities/${id}/cancel`, { token: tokenA });
  assert.equal(res.statusCode, 200);

  // cancelled 不在列表（列表只返回 finished）
  const list = await req('GET', '/sport-track/api/activities', { token: tokenA });
  assert.ok(!list.json().data.items.some((i: { id: string }) => i.id === id));
});

test('删除活动', async () => {
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'walking', startTime: 1700000000000 },
  });
  const id = created.json().data.activityId;
  // finish 它使其进入列表
  await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenA,
    body: { trackPoints: [P(1, 31.0, 121.0)] },
  });

  const del = await req('DELETE', `/sport-track/api/activities/${id}`, { token: tokenA });
  assert.equal(del.statusCode, 200);

  const detail = await req('GET', `/sport-track/api/activities/${id}`, { token: tokenA });
  assert.equal(detail.statusCode, 404);
});

// ==================== M3：打点管理（编辑/删除） ====================
// 注意：这些测试依赖前面 finish 对账测试写入的 marker m1

test('编辑打点：更新备注与类型', async () => {
  const res = await req('PUT', `/sport-track/api/activities/${activityId}/markers/m1`, {
    token: tokenA,
    body: { note: '补给点(更新)', type: 'rest' },
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.marker.id, 'm1');
  assert.equal(data.marker.note, '补给点(更新)');
  assert.equal(data.marker.type, 'rest');
});

test('编辑打点：仅更新部分字段，未传字段保持不变', async () => {
  const res = await req('PUT', `/sport-track/api/activities/${activityId}/markers/m1`, {
    token: tokenA,
    body: { note: '只改备注' },
  });
  assert.equal(res.statusCode, 200);
  const marker = res.json().data.marker;
  assert.equal(marker.note, '只改备注');
  assert.equal(marker.type, 'rest'); // 上次更新的 type 保留
  assert.equal(marker.lat, 31.2305); // 坐标不可被编辑接口改动
});

test('编辑不存在的打点 → 404', async () => {
  const res = await req('PUT', `/sport-track/api/activities/${activityId}/markers/nope`, {
    token: tokenA,
    body: { note: 'x' },
  });
  assert.equal(res.statusCode, 404);
});

test('编辑打点非法 type → 400', async () => {
  const res = await req('PUT', `/sport-track/api/activities/${activityId}/markers/m1`, {
    token: tokenA,
    body: { type: 'invalid-type' },
  });
  assert.equal(res.statusCode, 400);
});

test('越权编辑打点 → 404', async () => {
  const res = await req('PUT', `/sport-track/api/activities/${activityId}/markers/m1`, {
    token: tokenB,
    body: { note: 'hack' },
  });
  assert.equal(res.statusCode, 404);
});

test('删除打点', async () => {
  const res = await req('DELETE', `/sport-track/api/activities/${activityId}/markers/m1`, { token: tokenA });
  assert.equal(res.statusCode, 200);

  const detail = await req('GET', `/sport-track/api/activities/${activityId}`, { token: tokenA });
  assert.equal(detail.json().data.markers.length, 0);
});

test('删除不存在的打点 → 404', async () => {
  const res = await req('DELETE', `/sport-track/api/activities/${activityId}/markers/m1`, { token: tokenA });
  assert.equal(res.statusCode, 404);
});

test('轨迹平滑：抖动点被滑动平均修正，端点保持', async () => {
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'walking', startTime: TEST_NOW - 60000 },
  });
  const id = created.json().data.activityId;

  // 5 个点：直线 31.2304→31.2344，中间点故意抖动（31.2420 偏离 ~850m）
  const res = await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenA,
    body: {
      trackPoints: [
        { seq: 1, lat: 31.2304, lng: 121.4737, altitude: null, speed: null, timestamp: TEST_NOW - 40000 },
        { seq: 2, lat: 31.2314, lng: 121.4738, altitude: null, speed: null, timestamp: TEST_NOW - 30000 },
        { seq: 3, lat: 31.2420, lng: 121.4739, altitude: null, speed: null, timestamp: TEST_NOW - 20000 }, // 抖动点
        { seq: 4, lat: 31.2334, lng: 121.474, altitude: null, speed: null, timestamp: TEST_NOW - 10000 },
        { seq: 5, lat: 31.2344, lng: 121.4741, altitude: null, speed: null, timestamp: TEST_NOW },
      ],
      endTime: TEST_NOW,
    },
  });
  assert.equal(res.statusCode, 200);
  const pts = res.json().data.activity.trackPoints;
  // 决策更新：850m 级抖动点被轨迹纠偏（cleanTrajectory）直接剔除，而非平滑修正
  assert.equal(pts.length, 4, '抖动点应被剔除');
  // 端点保持原值
  assert.equal(pts[0].lat, 31.2304);
  assert.equal(pts[pts.length - 1].lat, 31.2344);
  // 剔除的是抖动点（31.2420 不在结果中）
  assert.ok(!pts.some((p: { lat: number }) => Math.abs(p.lat - 31.2420) < 0.0001), '850m 级抖动点应被剔除');
});

test('删除带照片的活动：OSS 未配置时优雅跳过，不影响删除', async () => {
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'hiking', startTime: TEST_NOW - 60000 },
  });
  const id = created.json().data.activityId;

  await req('POST', `/sport-track/api/activities/${id}/markers`, {
    token: tokenA,
    body: {
      id: 'ph1',
      lat: 31.2,
      lng: 121.4,
      timestamp: TEST_NOW,
      type: 'photo',
      photoUrl:
        'https://example-bucket.oss-cn-hangzhou.aliyuncs.com/sport-track/users/000000000000000000000000/photos/a.jpg',
    },
  });
  await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenA,
    body: {
      trackPoints: [{ seq: 1, lat: 31.2, lng: 121.4, altitude: null, speed: null, timestamp: TEST_NOW }],
    },
  });

  const del = await req('DELETE', `/sport-track/api/activities/${id}`, { token: tokenA });
  assert.equal(del.statusCode, 200);

  const detail = await req('GET', `/sport-track/api/activities/${id}`, { token: tokenA });
  assert.equal(detail.statusCode, 404);
});

// ==================== 海拔尖刺清洗 ====================

test('海拔尖刺清洗：短时间跳变且方向反转 → 置 null', async () => {
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'walking', startTime: TEST_NOW - 60000 },
  });
  const id = created.json().data.activityId;

  const base = TEST_NOW - 50000;
  // 海拔：38 → 25(尖刺) → 38，时间间隔 10s
  const res = await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenA,
    body: {
      trackPoints: [
        { seq: 1, lat: 31.2304, lng: 121.4737, altitude: 38, speed: 1, timestamp: base },
        { seq: 2, lat: 31.2314, lng: 121.4738, altitude: 25, speed: 1, timestamp: base + 10000 }, // 尖刺
        { seq: 3, lat: 31.2324, lng: 121.4739, altitude: 38, speed: 1, timestamp: base + 20000 },
        { seq: 4, lat: 31.2334, lng: 121.474, altitude: 39, speed: 1, timestamp: base + 30000 },
        { seq: 5, lat: 31.2344, lng: 121.4741, altitude: 40, speed: 1, timestamp: base + 40000 },
      ],
      endTime: TEST_NOW,
    },
  });
  assert.equal(res.statusCode, 200);
  const pts = res.json().data.activity.trackPoints;
  // 尖刺点海拔被置 null，正常点保留
  assert.equal(pts[1].altitude, null, '尖刺点海拔应为 null');
  assert.equal(pts[0].altitude, 38);
  assert.equal(pts[4].altitude, 40);
  // 经纬度保留
  assert.equal(pts[1].lat, 31.2314);
});

test('海拔尖刺清洗：真实爬坡（速率正常）不被误伤', async () => {
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'hiking', startTime: TEST_NOW - 60000 },
  });
  const id = created.json().data.activityId;

  const base = TEST_NOW - 50000;
  // 缓慢爬升：每 10s 升 2m（0.2 m/s，正常）
  const res = await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenA,
    body: {
      trackPoints: [
        { seq: 1, lat: 30, lng: 120, altitude: 100, speed: 1, timestamp: base },
        { seq: 2, lat: 30.001, lng: 120, altitude: 102, speed: 1, timestamp: base + 10000 },
        { seq: 3, lat: 30.002, lng: 120, altitude: 104, speed: 1, timestamp: base + 20000 },
        { seq: 4, lat: 30.003, lng: 120, altitude: 106, speed: 1, timestamp: base + 30000 },
      ],
      endTime: TEST_NOW,
    },
  });
  assert.equal(res.statusCode, 200);
  const pts = res.json().data.activity.trackPoints;
  assert.equal(pts[1].altitude, 102, '正常爬升海拔应保留');
  assert.equal(pts[3].altitude, 106);
});

test('防刷：1 小时窗口内最多创建 10 条，第 11 条返回 429', async () => {
  const t = (await login('m2-rate-limit')).accessToken;
  for (let i = 0; i < 10; i++) {
    const r = await req('POST', '/sport-track/api/activities', {
      token: t,
      body: { type: 'walking', startTime: 1700000000000 + i * 1000 },
    });
    assert.equal(r.statusCode, 200, `第 ${i + 1} 条应创建成功`);
  }
  const over = await req('POST', '/sport-track/api/activities', {
    token: t,
    body: { type: 'walking', startTime: 1700000000000 + 100000 },
  });
  assert.equal(over.statusCode, 429, '第 11 条应被限流');
});

test('数据隔离：B 用户不能读取/修改 A 用户的轨迹', async () => {
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'walking', startTime: 1700000000000 },
  });
  const id = created.json().data.activityId;
  // B 读 A 的详情 → 404
  const detail = await req('GET', `/sport-track/api/activities/${id}`, { token: tokenB });
  assert.equal(detail.statusCode, 404, 'B 读 A 轨迹应 404');
  // B 改 A 的轨迹 → 404
  const meta = await req('PUT', `/sport-track/api/activities/${id}/meta`, {
    token: tokenB,
    body: { note: '越权修改' },
  });
  assert.equal(meta.statusCode, 404, 'B 改 A 轨迹应 404');
});

// ==================== 非法 id 闸门：非 ObjectId 串不该冒 500 ====================

test('非法 id：11 条活动路由传非 ObjectId 串一律 404「活动不存在」，不再 500 泄露 CastError 文案', async () => {
  const BAD = 'not-an-objectid';
  const base = '/sport-track/api/activities';
  // 请求体都按各接口 schema 给合法值：闸门若写在 body 校验之后，400 会先于 404 把断言带偏
  const cases: Array<[string, string, Record<string, unknown> | undefined]> = [
    ['GET', `${base}/${BAD}`, undefined],
    ['GET', `${base}/${BAD}/gpx`, undefined],
    ['POST', `${base}/${BAD}/points`, { points: [P(1, 31.2305, 121.4737)] }],
    ['POST', `${base}/${BAD}/markers`, { id: 'm1', lat: 31.2305, lng: 121.4737, timestamp: Date.now() }],
    ['PUT', `${base}/${BAD}/markers/m1`, { note: 'x' }],
    ['DELETE', `${base}/${BAD}/markers/m1`, undefined],
    ['PUT', `${base}/${BAD}/finish`, { trackPoints: [] }],
    ['PUT', `${base}/${BAD}/cancel`, undefined],
    ['POST', `${base}/${BAD}/reprocess`, undefined],
    ['PUT', `${base}/${BAD}/meta`, { note: 'x' }],
    ['DELETE', `${base}/${BAD}`, undefined],
  ];
  for (const [method, url, body] of cases) {
    const res = await req(method, url, { token: tokenA, body });
    assert.equal(res.statusCode, 404, `${method} ${url} 应 404，实际 ${res.statusCode}：${res.body}`);
    assert.equal(res.json().message, '活动不存在', `${method} ${url} 应给资源级文案`);
  }

  // 形态合法但不存在的 id（24 位 hex）行为不变：同样 404，不能被误判成 400
  const GHOST = 'ffffffffffffffffffffffff';
  assert.equal((await req('GET', `${base}/${GHOST}`, { token: tokenA })).statusCode, 404);
  assert.equal((await req('DELETE', `${base}/${GHOST}`, { token: tokenA })).statusCode, 404);
  // 写类接口被闸门拦下后不得留下任何副作用（探针本身也得用合法形态的 id，否则它自己就抛 CastError）
  assert.equal(await ActivityModel.countDocuments({ _id: GHOST }), 0);
});

test('导入轨迹：与 finish 共用口径——静止时段同样剔除，standstillMs 与 still 标记入库', async () => {
  // 独立用户：导入也算新增，会占用「同一用户 1 小时最多 10 条」的额度
  const tokenI = (await login('m2-import')).accessToken;

  // GPX（WGS-84）：走 200m（20s 一采）→ 原地站 80s → 再走 200m
  const LAT0 = 31.23;
  const D = (m: number) => LAT0 + m / 111320;
  const rows: string[] = [];
  let ts = TEST_NOW - 600000;
  const iso = (t: number) => new Date(t).toISOString();
  for (let m = 0; m <= 200; m += 20) rows.push(`    <trkpt lat="${D(m)}" lon="114.4"><time>${iso(ts)}</time></trkpt>`), (ts += 20000);
  // 原地站 100s（带 3m 抖动，否则导入的「<1m 重复点合并」会把这段点吃掉）
  for (let k = 1; k <= 6; k++)
    rows.push(`    <trkpt lat="${D(200 + (k % 2 === 0 ? 3 : 0))}" lon="114.4"><time>${iso(ts)}</time></trkpt>`), (ts += 20000);
  for (let m = 20; m <= 200; m += 20) rows.push(`    <trkpt lat="${D(200 + m)}" lon="114.4"><time>${iso(ts)}</time></trkpt>`), (ts += 20000);
  const gpx = `<?xml version="1.0"?>\n<gpx version="1.1" creator="test"><trk><trkseg>\n${rows.join('\n')}\n</trkseg></trk></gpx>`;

  const boundary = '----sporttracktest';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="t.gpx"\r\nContent-Type: application/gpx+xml\r\n\r\n`,
    ),
    Buffer.from(gpx),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const imported = await app.inject({
    method: 'POST',
    url: '/sport-track/api/activities/import',
    payload,
    headers: { authorization: `Bearer ${tokenI}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  assert.equal(imported.statusCode, 200, imported.body);
  const id = imported.json().data.id;
  assert.ok(id, '导入应返回活动 id');

  const detail = await req('GET', `/sport-track/api/activities/${id}`, { token: tokenI });
  assert.equal(detail.statusCode, 200);
  const act = detail.json().data;
  const wall = Math.round((act.endTime - act.startTime) / 1000);
  assert.ok(act.standstillMs >= 60000, `导入轨迹的静止时段应入库，实际 ${act.standstillMs}ms`);
  assert.equal(
    act.duration + Math.round(act.standstillMs / 1000),
    wall,
    '口径自洽：运动时长 + 静止 = 墙钟（导入没有手动暂停）',
  );
  assert.equal(act.duration, imported.json().data.duration, '导入接口返回的 duration 应是净时长');
  const stillPts = (act.trackPoints as Array<{ still?: boolean }>).filter((p) => p.still === true);
  assert.ok(stillPts.length >= 3, '静止时段的点应带 still 标记落库');
});

test('导出 GPX → 再导入：经纬度往返一致（GPX 标准是 WGS-84，导出必须反算 GCJ-02）', async () => {
  const tokenR = (await login('m2-gpx-roundtrip')).accessToken;

  // 造一条活动：武汉附近 5 个点，每点间隔 ~110m（避免导入的去重合并）
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenR,
    body: { type: 'running', startTime: TEST_NOW - 300000 },
  });
  const id = created.json().data.activityId;
  const LAT0 = 30.507991;
  const pts = Array.from({ length: 6 }, (_, i) => ({
    seq: i + 1,
    lat: LAT0 + i * 0.001,
    lng: 114.486967 + i * 0.001,
    altitude: 30 + i,
    speed: null,
    timestamp: TEST_NOW - 300000 + i * 20000,
  }));
  const fin = await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenR,
    body: { trackPoints: pts, endTime: pts[pts.length - 1].timestamp, pausedMs: 0 },
  });
  assert.equal(fin.statusCode, 200);

  // 导出 → 把文件原样再导入（模拟「手机端导出 → 开发者工具导入」）
  const exported = await req('GET', `/sport-track/api/activities/${id}/gpx`, { token: tokenR });
  assert.equal(exported.statusCode, 200);
  const gpx = exported.body;

  const boundary = '----sporttrackroundtrip';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="roundtrip.gpx"\r\nContent-Type: application/gpx+xml\r\n\r\n`,
    ),
    Buffer.from(gpx),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const imported = await app.inject({
    method: 'POST',
    url: '/sport-track/api/activities/import',
    payload,
    headers: { authorization: `Bearer ${tokenR}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  assert.equal(imported.statusCode, 200, imported.body);

  const back = (await req('GET', `/sport-track/api/activities/${imported.json().data.id}`, { token: tokenR })).json().data;
  const { haversineDistance } = await import('../src/utils/pace.js');
  const d0 = haversineDistance(pts[0], back.trackPoints[0]);
  const dLast = haversineDistance(pts[pts.length - 1], back.trackPoints[back.trackPoints.length - 1]);
  assert.ok(d0 < 1, `首点往返偏移应 <1m，实际 ${d0.toFixed(1)}m（导出没按 WGS-84 反算就会偏数百米）`);
  assert.ok(dLast < 1, `末点往返偏移应 <1m，实际 ${dLast.toFixed(1)}m`);
  assert.ok(Math.abs(back.distance - fin.json().data.activity.distance) < 1, '距离也应一致');
});
