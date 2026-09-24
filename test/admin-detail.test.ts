import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';

let app: FastifyInstance;
let adminToken = '';
let userId = '';
let activityId = '';

const ADMIN_USER = 'admin_detail_test';
const ADMIN_PASS = 'test123456';

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  // 清理历史测试数据
  const users = await UserModel.find({ openid: /^admdet_openid/ }).select('_id');
  const ids = users.map((u) => u._id);
  await ActivityModel.deleteMany({ userId: { $in: ids } });
  await UserModel.deleteMany({ openid: /^admdet_openid/ });

  // 独立测试管理员（避免依赖库里已有管理员的密码）
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });

  // 种子数据：一个用户 + 一条已完成轨迹（带轨迹点与打点）
  const user = await UserModel.create({ openid: 'admdet_openid-u1', nickname: '管理详情测试' });
  userId = String(user._id);
  const now = Date.now();
  const act = await ActivityModel.create({
    userId: user._id,
    type: 'running',
    status: 'finished',
    startTime: now - 3600000,
    endTime: now - 1800000,
    duration: 1800,
    distance: 5000,
    avgPace: 360,
    fastestKm: 340,
    calories: 300,
    elevationGain: 20,
    provinces: ['北京市'],
    startProvince: '北京市',
    startCity: '北京市',
    trackPoints: [
      { seq: 1, lat: 39.9042, lng: 116.4074, altitude: 40, speed: 3, timestamp: now - 3600000 },
      { seq: 2, lat: 39.9092, lng: 116.4124, altitude: 42, speed: 3, timestamp: now - 2700000 },
      { seq: 3, lat: 39.9142, lng: 116.4174, altitude: 45, speed: 3, timestamp: now - 1800000 },
    ],
    markers: [
      {
        id: 'm1',
        lat: 39.9092,
        lng: 116.4124,
        timestamp: now - 2700000,
        type: 'photo',
        note: '测试打点',
        photoUrl: 'https://example.com/a.jpg',
        photos: ['https://example.com/a.jpg'],
        address: '',
      },
    ],
  });
  activityId = String(act._id);

  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/login',
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  adminToken = res.json().data.token;
  assert.ok(adminToken, '管理员登录应成功');
});

after(async () => {
  await ActivityModel.deleteMany({ userId });
  await UserModel.deleteMany({ openid: /^admdet_openid/ });
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await app.close();
});

function req(url: string, withToken = true) {
  return app.inject({
    method: 'GET',
    url,
    headers: withToken ? { authorization: `Bearer ${adminToken}` } : {},
  });
}

test('用户详情：返回资料、概况、个人最佳、点亮城市', async () => {
  const res = await req(`/sport-track/api/admin/users/${userId}`);
  assert.equal(res.statusCode, 200);
  const d = res.json().data;
  assert.equal(d.user.nickname, '管理详情测试');
  assert.equal(d.activityCount, 1);
  // 概况：累计应包含这条轨迹
  assert.equal(d.overview.total.count, 1);
  assert.equal(d.overview.total.distance, 5000);
  // 个人最佳：跑步应出现在各维度
  assert.equal(d.best.maxDistanceByType[0].type, 'running');
  assert.equal(d.best.minPaceByType[0].fastestKm, 340);
  // 点亮城市：结构完整
  assert.ok(Array.isArray(d.footprint.provinces));
  assert.ok(Array.isArray(d.footprint.cities));
  assert.ok(d.footprint.provinceCount >= 0);
});

test('用户详情：无效或不存在的用户返回 404', async () => {
  assert.equal((await req('/sport-track/api/admin/users/not-an-id')).statusCode, 404);
  assert.equal(
    (await req('/sport-track/api/admin/users/000000000000000000000000')).statusCode,
    404,
  );
});

test('登录历史/登录概况：非法 userId 同样 404，不冒 500（这两个接口此前无闸门）', async () => {
  for (const url of [
    '/sport-track/api/admin/users/not-an-id/login-logs',
    '/sport-track/api/admin/users/not-an-id/login-stats',
  ]) {
    const res = await req(url);
    assert.equal(res.statusCode, 404, `${url} 应 404，实际 ${res.statusCode}：${res.body}`);
    assert.equal(res.json().message, '用户不存在');
  }
  // 合法 id 的正常形态不受影响
  assert.equal((await req(`/sport-track/api/admin/users/${userId}/login-logs`)).statusCode, 200);
  assert.equal((await req(`/sport-track/api/admin/users/${userId}/login-stats`)).statusCode, 200);
});

test('旧数据重算：maxId 游标非法直接 400（空结果时它会回落进 new ObjectId 抛 500），合法游标照常跑', async () => {
  const post = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/sport-track/api/admin/activities/recompute-elevation',
      headers: { authorization: `Bearer ${adminToken}` },
      payload,
    });
  const bad = await post({ maxId: 'not-an-id', dryRun: true });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.ok(bad.json().message.includes('maxId'), `文案要点名是哪个参数：${bad.json().message}`);
  const ok = await post({ maxId: '000000000000000000000000', limit: 1, dryRun: true });
  assert.equal(ok.statusCode, 200, ok.body);
});

test('轨迹详情：返回完整字段、用户昵称与打点', async () => {
  const res = await req(`/sport-track/api/admin/activities/${activityId}`);
  assert.equal(res.statusCode, 200);
  const d = res.json().data;
  assert.equal(d.userNickname, '管理详情测试');
  assert.equal(d.userId, userId);
  assert.equal(d.status, 'finished');
  assert.equal(d.pointsCount, 3);
  assert.equal(d.trackPoints.length, 3);
  assert.equal(d.markers.length, 1);
  assert.equal(d.markers[0].note, '测试打点');
  assert.equal(d.startCity, '北京市');
});

test('轨迹详情：不存在的轨迹返回 404', async () => {
  assert.equal((await req('/sport-track/api/admin/activities/000000000000000000000000')).statusCode, 404);
  assert.equal((await req('/sport-track/api/admin/activities/bad-id')).statusCode, 404);
});

test('未携带管理员凭证返回 401', async () => {
  assert.equal((await req(`/sport-track/api/admin/users/${userId}`, false)).statusCode, 401);
  assert.equal((await req(`/sport-track/api/admin/activities/${activityId}`, false)).statusCode, 401);
  // 导出接口也是管理员数据出口，同样不能裸奔
  assert.equal((await req(`/sport-track/api/admin/activities/${activityId}/gpx`, false)).statusCode, 401);
});

test('管理员导出 GPX：坐标按 WGS-84 反算，且含全部轨迹点与打点', async () => {
  const res = await req(`/sport-track/api/admin/activities/${activityId}/gpx`);
  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers['content-type']), /application\/gpx\+xml/);
  assert.match(String(res.headers['content-disposition']), /attachment; filename="activity-/);
  const xml = res.body;
  // 导出保真：车速段照导（剔除只作用在入库指标上），删点会让"导出→再导入"真的丢数据
  assert.equal((xml.match(/<trkpt/g) ?? []).length, 3, '导出的 trkpt 数应等于库内轨迹点数');
  assert.equal((xml.match(/<wpt/g) ?? []).length, 1, '打点应作为航点导出');

  const { gcj02ToWgs84 } = await import('../src/utils/coordinate.js');
  const { haversineDistance } = await import('../src/utils/pace.js');
  const m = xml.match(/<trkpt lat="([-\d.]+)" lon="([-\d.]+)"/);
  assert.ok(m, '应有轨迹点');
  const got = { lat: Number(m![1]), lng: Number(m![2]) };
  const gcj = { lat: 39.9042, lng: 116.4074 };
  const wgs = gcj02ToWgs84(gcj.lat, gcj.lng);
  assert.ok(
    haversineDistance(wgs, got) < 1,
    `导出坐标应是 WGS-84 反算值，实际偏差 ${haversineDistance(wgs, got).toFixed(1)}m`,
  );
  assert.ok(
    haversineDistance(gcj, got) > 300,
    '导出坐标与库内 GCJ-02 原值几乎相同 = 漏转，每次导出→导入会平移数百米',
  );
});

test('管理员导出 GPX：无轨迹点 400 / 非法与不存在 id 404', async () => {
  assert.equal((await req('/sport-track/api/admin/activities/not-an-id/gpx')).statusCode, 404);
  assert.equal((await req('/sport-track/api/admin/activities/000000000000000000000000/gpx')).statusCode, 404);
  const empty = await ActivityModel.create({
    userId,
    type: 'running',
    status: 'finished',
    startTime: Date.now() - 60000,
    endTime: Date.now(),
    duration: 60,
    distance: 0,
    trackPoints: [],
    markers: [],
  });
  const res = await req(`/sport-track/api/admin/activities/${empty._id}/gpx`);
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /没有轨迹点/);
  await ActivityModel.deleteOne({ _id: empty._id });
});
