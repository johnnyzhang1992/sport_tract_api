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
  const users = await UserModel.find({ openid: /^mock_openid_admin-detail/ }).select('_id');
  const ids = users.map((u) => u._id);
  await ActivityModel.deleteMany({ userId: { $in: ids } });
  await UserModel.deleteMany({ openid: /^mock_openid_admin-detail/ });

  // 独立测试管理员（避免依赖库里已有管理员的密码）
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });

  // 种子数据：一个用户 + 一条已完成轨迹（带轨迹点与打点）
  const user = await UserModel.create({ openid: 'mock_openid_admin-detail-u1', nickname: '管理详情测试' });
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
  await UserModel.deleteMany({ openid: /^mock_openid_admin-detail/ });
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
});
