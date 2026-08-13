import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';

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
    url: '/api/auth/login',
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
  timestamp: 1700000000000 + seq * 10000,
});

test('创建进行中活动', async () => {
  const res = await req('POST', '/api/activities', {
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
  const res = await req('POST', `/api/activities/${activityId}/points`, {
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
  const res = await req('POST', `/api/activities/${activityId}/points`, {
    token: tokenA,
    body: { points: [P(1, 31.2304, 121.4737), P(3, 31.2306, 121.4739), P(4, 31.2307, 121.474), P(5, 31.2308, 121.4741)] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.lastPointSeq, 5);
  assert.equal(res.json().data.added, 2); // 只新增 4、5
});

test('新增打点', async () => {
  const res = await req('POST', `/api/activities/${activityId}/markers`, {
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
  const res = await req('PUT', `/api/activities/${activityId}/finish`, {
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

test('finish 后禁止再上传轨迹点 → 409', async () => {
  const res = await req('POST', `/api/activities/${activityId}/points`, {
    token: tokenA,
    body: { points: [P(6, 31.2309, 121.4742)] },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().data.code, 'ACTIVITY_FINISHED');
});

test('重复 finish → 幂等返回', async () => {
  const res = await req('PUT', `/api/activities/${activityId}/finish`, {
    token: tokenA,
    body: { trackPoints: [P(1, 31.2304, 121.4737)] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.status, 'finished');
});

test('空轨迹点直接结束（随时可结束）', async () => {
  const created = await req('POST', '/api/activities', {
    token: tokenA,
    body: { type: 'walking', startTime: TEST_NOW - 30000 },
  });
  const id = created.json().data.activityId;

  const res = await req('PUT', `/api/activities/${id}/finish`, {
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

test('越权：B 用户访问 A 的活动 → 404', async () => {
  const res = await req('GET', `/api/activities/${activityId}`, { token: tokenB });
  assert.equal(res.statusCode, 404);
});

test('活动列表：包含统计字段，不含完整点集', async () => {
  const res = await req('GET', '/api/activities?page=1&pageSize=10', { token: tokenA });
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

test('活动详情：返回完整轨迹点与打点', async () => {
  const res = await req('GET', `/api/activities/${activityId}`, { token: tokenA });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.trackPoints.length, 5);
  assert.equal(data.markers.length, 1);
  assert.equal(data.distance, data.distance);
});

test('GPX 导出', async () => {
  const res = await req('GET', `/api/activities/${activityId}/gpx`, { token: tokenA });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /application\/gpx\+xml/);
  const xml = res.body;
  assert.match(xml, /<gpx/);
  assert.match(xml, /<trkpt lat="31\.2304"/);
  assert.match(xml, /<wpt lat="31\.2305"/);
});

test('统计 overview：今日/本周/本月/累计', async () => {
  const res = await req('GET', '/api/stats/overview', { token: tokenA });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  for (const key of ['today', 'week', 'month', 'total']) {
    assert.ok(data[key].count >= 1);
    assert.ok(data[key].distance > 0);
  }
});

test('统计 trend：近 7 天数据', async () => {
  const res = await req('GET', '/api/stats/trend?days=7', { token: tokenA });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.days, 7);
  assert.equal(data.data.length, 7);
  assert.ok(data.data.some((d: { distance: number }) => d.distance > 0));
});

test('创建活动缺 type → 400', async () => {
  const res = await req('POST', '/api/activities', {
    token: tokenA,
    body: { startTime: 1700000000000 },
  });
  assert.equal(res.statusCode, 400);
});

test('列表返回轨迹缩略预览点（≤60 点均匀采样）', async () => {
  const list = await req('GET', '/api/activities?page=1&pageSize=20', { token: tokenA });
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
  const created = await req('POST', '/api/activities', {
    token: tokenA,
    body: { type: 'walking', startTime: 1700000000000 },
  });
  const id = created.json().data.activityId;

  const res = await req('PUT', `/api/activities/${id}/cancel`, { token: tokenA });
  assert.equal(res.statusCode, 200);

  // cancelled 不在列表（列表只返回 finished）
  const list = await req('GET', '/api/activities', { token: tokenA });
  assert.ok(!list.json().data.items.some((i: { id: string }) => i.id === id));
});

test('删除活动', async () => {
  const created = await req('POST', '/api/activities', {
    token: tokenA,
    body: { type: 'walking', startTime: 1700000000000 },
  });
  const id = created.json().data.activityId;
  // finish 它使其进入列表
  await req('PUT', `/api/activities/${id}/finish`, {
    token: tokenA,
    body: { trackPoints: [P(1, 31.0, 121.0)] },
  });

  const del = await req('DELETE', `/api/activities/${id}`, { token: tokenA });
  assert.equal(del.statusCode, 200);

  const detail = await req('GET', `/api/activities/${id}`, { token: tokenA });
  assert.equal(detail.statusCode, 404);
});

// ==================== M3：打点管理（编辑/删除） ====================
// 注意：这些测试依赖前面 finish 对账测试写入的 marker m1

test('编辑打点：更新备注与类型', async () => {
  const res = await req('PUT', `/api/activities/${activityId}/markers/m1`, {
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
  const res = await req('PUT', `/api/activities/${activityId}/markers/m1`, {
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
  const res = await req('PUT', `/api/activities/${activityId}/markers/nope`, {
    token: tokenA,
    body: { note: 'x' },
  });
  assert.equal(res.statusCode, 404);
});

test('编辑打点非法 type → 400', async () => {
  const res = await req('PUT', `/api/activities/${activityId}/markers/m1`, {
    token: tokenA,
    body: { type: 'invalid-type' },
  });
  assert.equal(res.statusCode, 400);
});

test('越权编辑打点 → 404', async () => {
  const res = await req('PUT', `/api/activities/${activityId}/markers/m1`, {
    token: tokenB,
    body: { note: 'hack' },
  });
  assert.equal(res.statusCode, 404);
});

test('删除打点', async () => {
  const res = await req('DELETE', `/api/activities/${activityId}/markers/m1`, { token: tokenA });
  assert.equal(res.statusCode, 200);

  const detail = await req('GET', `/api/activities/${activityId}`, { token: tokenA });
  assert.equal(detail.json().data.markers.length, 0);
});

test('删除不存在的打点 → 404', async () => {
  const res = await req('DELETE', `/api/activities/${activityId}/markers/m1`, { token: tokenA });
  assert.equal(res.statusCode, 404);
});

test('轨迹平滑：抖动点被滑动平均修正，端点保持', async () => {
  const created = await req('POST', '/api/activities', {
    token: tokenA,
    body: { type: 'walking', startTime: TEST_NOW - 60000 },
  });
  const id = created.json().data.activityId;

  // 5 个点：直线 31.2304→31.2344，中间点故意抖动（31.2420 偏离 ~850m）
  const res = await req('PUT', `/api/activities/${id}/finish`, {
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
  const created = await req('POST', '/api/activities', {
    token: tokenA,
    body: { type: 'hiking', startTime: TEST_NOW - 60000 },
  });
  const id = created.json().data.activityId;

  await req('POST', `/api/activities/${id}/markers`, {
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
  await req('PUT', `/api/activities/${id}/finish`, {
    token: tokenA,
    body: {
      trackPoints: [{ seq: 1, lat: 31.2, lng: 121.4, altitude: null, speed: null, timestamp: TEST_NOW }],
    },
  });

  const del = await req('DELETE', `/api/activities/${id}`, { token: tokenA });
  assert.equal(del.statusCode, 200);

  const detail = await req('GET', `/api/activities/${id}`, { token: tokenA });
  assert.equal(detail.statusCode, 404);
});

// ==================== 海拔尖刺清洗 ====================

test('海拔尖刺清洗：短时间跳变且方向反转 → 置 null', async () => {
  const created = await req('POST', '/api/activities', {
    token: tokenA,
    body: { type: 'walking', startTime: TEST_NOW - 60000 },
  });
  const id = created.json().data.activityId;

  const base = TEST_NOW - 50000;
  // 海拔：38 → 25(尖刺) → 38，时间间隔 10s
  const res = await req('PUT', `/api/activities/${id}/finish`, {
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
  const created = await req('POST', '/api/activities', {
    token: tokenA,
    body: { type: 'hiking', startTime: TEST_NOW - 60000 },
  });
  const id = created.json().data.activityId;

  const base = TEST_NOW - 50000;
  // 缓慢爬升：每 10s 升 2m（0.2 m/s，正常）
  const res = await req('PUT', `/api/activities/${id}/finish`, {
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
