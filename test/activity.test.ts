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

test('finish endTime：空轨迹点回退传入 endTime', async () => {
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
  assert.equal(res.json().data.activity.endTime, TEST_NOW, '无点时应回退传入 endTime');
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

test('空轨迹点直接结束（随时可结束）', async () => {
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
  assert.equal(data.status, 'finished');
  assert.equal(data.lastPointSeq, 0);
  assert.equal(data.activity.distance, 0);
  assert.equal(data.activity.trackPoints.length, 0);
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
  const created = await req('POST', '/sport-track/api/activities', {
    token: tokenA,
    body: { type: 'walking', startTime: TEST_NOW - 30000 },
  });
  const id = created.json().data.activityId;
  await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    token: tokenA,
    body: { trackPoints: [], endTime: TEST_NOW },
  });
  const list = await req('GET', '/sport-track/api/activities?pageSize=100', { token: tokenA });
  const item = list.json().data.items.find((i: { _id: string }) => String(i._id) === id);
  assert.ok(item, '空轨迹 finished 活动应在列表');
  assert.deepEqual(item.previewPoints, [], '空轨迹预览点应为空数组');
  await ActivityModel.deleteOne({ _id: id });
});

test('活动详情：返回完整轨迹点与打点', async () => {
  const res = await req('GET', `/sport-track/api/activities/${activityId}`, { token: tokenA });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.trackPoints.length, 5);
  assert.equal(data.markers.length, 1);
  assert.equal(data.distance, data.distance);
});

test('GPX 导出', async () => {
  const res = await req('GET', `/sport-track/api/activities/${activityId}/gpx`, { token: tokenA });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /application\/gpx\+xml/);
  const xml = res.body;
  assert.match(xml, /<gpx/);
  assert.match(xml, /<trkpt lat="31\.2304"/);
  assert.match(xml, /<wpt lat="31\.2305"/);
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
