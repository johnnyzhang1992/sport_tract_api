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
        P(1, 31.2304, 121.4737, 10),
        P(2, 31.2305, 121.4738, 12),
        P(3, 31.2306, 121.4739, 11),
        P(4, 31.2307, 121.474, 15),
        P(5, 31.2308, 121.4741, 18),
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

test('越权：B 用户访问 A 的活动 → 404', async () => {
  const res = await req('GET', `/api/activities/${activityId}`, { token: tokenB });
  assert.equal(res.statusCode, 404);
});

test('活动列表：包含统计字段，不含完整点集', async () => {
  const res = await req('GET', '/api/activities?page=1&pageSize=10', { token: tokenA });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.total, 1);
  const item = data.items[0];
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
