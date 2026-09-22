import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { FootprintRecordModel } from '../src/models/footprint-record.model.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { config, isOssConfigured } from '../src/config/index.js';

/**
 * 管理端图片 URL 下发口径：bucket 私有，裸链直连实测 403，凡是要给 <img> 用的地址都得签名
 * - /admin/users/:id 头像
 * - /admin/activities 列表的 photoCount（跨 markers 去重）+ coverPhoto（缩略图）
 * - /admin/footprint-records 列表的 coverPhoto
 * 外部 URL（微信头像等）签名逻辑原样放行，但计数照算。
 */

const ADMIN_USER = 'admin_imgurl';
const ADMIN_PASS = 'test123456';
const OSS = `${config.oss.endpoint.replace(/\/$/, '')}/${config.oss.baseDir}/imgurl-test`;
const P1 = `${OSS}/p1.png`;
const P2 = `${OSS}/p2.png`;
const P3 = `${OSS}/p3.png`;
const EXT = 'https://wx.qlogo.cn/mmopen/xxx/132';

let app: FastifyInstance;
let adminToken = '';
let userId = '';
let actWithPhotos = '';
let actNoPhotos = '';
let fpWithPhoto = '';

// 未配置 OSS 时 getSignedUrl 原样返回（本地裸跑测试不该红），断言跟着分叉
const expectSigned = (got: string, bare: string) => {
  if (isOssConfigured()) {
    assert.ok(got.startsWith(`${bare}?`), `应是 ${bare} 的签名链，实际 ${got}`);
    assert.match(got, /[?&]Signature=/, '签名链要带 Signature');
  } else {
    assert.equal(got, bare, 'OSS 未配置时原样返回裸链');
  }
};

async function req(method: string, url: string, payload?: unknown) {
  return await app.inject({
    method: method as 'GET',
    url,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: payload as Record<string, unknown> | undefined,
  });
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  await AdminModel.deleteOne({ username: ADMIN_USER });
  await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/login',
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  adminToken = login.json().data.token;
  assert.ok(adminToken, '管理员登录应成功');

  await clean();
  const now = Date.now();
  const user = await UserModel.create({
    openid: 'imgurl_openid-u1',
    nickname: '图片链路测试',
    avatarUrl: `${OSS}/avatar.png`,
  });
  userId = String(user._id);

  const a1 = await ActivityModel.create({
    userId: user._id,
    type: 'running',
    status: 'finished',
    startTime: now - 3600000,
    endTime: now - 1800000,
    duration: 1800,
    distance: 5000,
    // m1：photos 两图，photoUrl 与 photos[0] 同图（不能重复计数）
    // m2：老数据只有 photoUrl → 算 1 张
    // m3：跨 marker 重复图 p2 去重 + 外链图也要计数
    markers: [
      { id: 'm1', lat: 39.9, lng: 116.4, timestamp: now - 3000000, type: 'photo', photos: [P1, P2], photoUrl: P1 },
      { id: 'm2', lat: 39.9, lng: 116.4, timestamp: now - 2900000, type: 'photo', photos: [], photoUrl: P3 },
      { id: 'm3', lat: 39.9, lng: 116.4, timestamp: now - 2800000, type: 'photo', photos: [P2, EXT], photoUrl: '' },
    ],
  });
  actWithPhotos = String(a1._id);
  const a2 = await ActivityModel.create({
    userId: user._id,
    type: 'walking',
    status: 'finished',
    startTime: now - 1800000,
    endTime: now - 1700000,
    duration: 100,
    distance: 100,
  });
  actNoPhotos = String(a2._id);

  const fp = await FootprintRecordModel.create({
    userId: user._id,
    title: '图片链路测试-有图',
    visitDate: '2026-09-01',
    location: { name: '测试地点', address: '测试地址', province: '测试省戊', city: '测试市戊', latitude: 1, longitude: 2 },
    photos: [P2, EXT],
  });
  fpWithPhoto = String(fp._id);
});

async function clean() {
  const users = await UserModel.find({ openid: /^imgurl_openid/ }).select('_id');
  const ids = users.map((u) => String(u._id));
  await ActivityModel.deleteMany({ userId: { $in: ids } });
  await FootprintRecordModel.deleteMany({ userId: { $in: ids } });
  await UserModel.deleteMany({ openid: /^imgurl_openid/ });
}

after(async () => {
  await clean();
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await app.close();
});

test('用户详情头像签名下发：私有桶裸链 403，管理端必须给签名地址', async () => {
  const res = await req('GET', `/sport-track/api/admin/users/${userId}`);
  assert.equal(res.statusCode, 200, res.body);
  expectSigned(res.json().data.user.avatarUrl, `${OSS}/avatar.png`);
});

test('轨迹列表：photoCount 跨 markers 去重（photoUrl 与 photos[0] 同图不双计），外链图也计数', async () => {
  const res = await req('GET', `/sport-track/api/admin/activities?page=1&pageSize=50&userId=${userId}`);
  assert.equal(res.statusCode, 200, res.body);
  const items = res.json().data.items as Array<{ id: string; photoCount: number; coverPhoto: string }>;
  const withPhotos = items.find((i) => i.id === actWithPhotos);
  const noPhotos = items.find((i) => i.id === actNoPhotos);
  assert.ok(withPhotos && noPhotos, '两条种子轨迹都应在列表里');
  assert.equal(withPhotos.photoCount, 4, 'p1 p2 p3 外链 共 4 张');
  expectSigned(withPhotos.coverPhoto, P1);
  assert.equal(noPhotos.photoCount, 0);
  assert.equal(noPhotos.coverPhoto, '');
});

test('足迹列表：coverPhoto 给签名首图，无图记录给空串', async () => {
  const res = await req('GET', `/sport-track/api/admin/footprint-records?page=1&pageSize=50&userId=${userId}`);
  assert.equal(res.statusCode, 200, res.body);
  const items = res.json().data.items as Array<{
    id: string;
    photoCount: number;
    coverPhoto: string;
    photos?: string[];
  }>;
  assert.equal(items.length, 1);
  assert.equal(items[0].photoCount, 2);
  expectSigned(items[0].coverPhoto, P2);
  assert.ok(!items[0].photos, '列表仍不下发照片数组，只给首图');
});

test('新字段不吃鉴权：列表与详情的未登录请求照样 401', async () => {
  for (const url of [
    '/sport-track/api/admin/activities',
    '/sport-track/api/admin/footprint-records',
    `/sport-track/api/admin/users/${userId}`,
  ]) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 401, url);
  }
});
