import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { LoginLogModel } from '../src/models/login-log.model.js';

const ADMIN_USER = 'test_admin_edit';
const ADMIN_PASS = 'admin_pass_123';

let app: FastifyInstance;
let adminToken = '';
let userToken = '';
let userId = '';

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  // 独立测试 admin（重复跑覆盖密码）
  const existing = await AdminModel.findOne({ username: ADMIN_USER });
  if (existing) {
    existing.passwordHash = await hashPassword(ADMIN_PASS);
    await existing.save();
  } else {
    await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  }
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/login',
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  adminToken = login.json().data.token;
  assert.ok(adminToken);

  // 清理旧数据 + mock 登录测试用户
  const pre = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'mock_openid_admin_edit' },
  });
  userId = pre.json().data.user.id;
  userToken = pre.json().data.accessToken;
  await ActivityModel.deleteMany({ userId });
  await LoginLogModel.deleteMany({ userId });
  await UserModel.deleteOne({ _id: userId });
  const fresh = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'mock_openid_admin_edit' },
  });
  userId = fresh.json().data.user.id;
  userToken = fresh.json().data.accessToken;
});

after(async () => {
  if (userId) {
    await UserModel.deleteOne({ _id: userId }).catch(() => {});
    await ActivityModel.deleteMany({ userId }).catch(() => {});
    await LoginLogModel.deleteMany({ userId }).catch(() => {});
  }
  await AdminModel.deleteOne({ username: ADMIN_USER }).catch(() => {});
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

/** 创建一条 finished 活动（真实轨迹点，距离达标，绕过 finish 守卫） */
async function createFinished(): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/sport-track/api/activities',
    headers: { authorization: `Bearer ${userToken}` },
    payload: { type: 'running', startTime: Date.now() - 60000 },
  });
  assert.equal(created.statusCode, 200);
  const id = created.json().data.activityId;
  const P = (seq: number) => ({
    seq,
    lat: 31.2304 + seq * 0.001,
    lng: 121.4737,
    altitude: null,
    speed: null,
    timestamp: Date.now() - 50000 + seq * 10000,
  });
  const fin = await app.inject({
    method: 'PUT',
    url: `/sport-track/api/activities/${id}/finish`,
    headers: { authorization: `Bearer ${userToken}` },
    payload: { trackPoints: [P(1), P(2), P(3)], endTime: Date.now(), pausedMs: 0 },
  });
  assert.equal(fin.statusCode, 200);
  assert.equal(fin.json().data.status, 'finished');
  return String(id);
}

const adminReq = (method: string, url: string, body?: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  app.inject({
    method: method as 'GET',
    url,
    payload: body,
    headers: { authorization: `Bearer ${adminToken}` },
  });

test('改状态：无管理员凭证 → 401', async () => {
  const id = await createFinished();
  const res = await app.inject({
    method: 'PUT',
    url: `/sport-track/api/admin/activities/${id}/status`,
    payload: { status: 'cancelled' },
  });
  assert.equal(res.statusCode, 401);
  await ActivityModel.deleteOne({ _id: id });
});

test('改状态：普通用户 token → 401', async () => {
  const id = await createFinished();
  const res = await app.inject({
    method: 'PUT',
    url: `/sport-track/api/admin/activities/${id}/status`,
    payload: { status: 'cancelled' },
    headers: { authorization: `Bearer ${userToken}` },
  });
  assert.equal(res.statusCode, 401);
  await ActivityModel.deleteOne({ _id: id });
});

test('改状态：finished → cancelled，足迹缓存置脏且用户列表不再出现', async () => {
  const id = await createFinished();
  await UserModel.updateOne({ _id: userId }, { $set: { footprintDirty: false } });

  const res = await adminReq('PUT', `/sport-track/api/admin/activities/${id}/status`, { status: 'cancelled' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.status, 'cancelled');
  assert.equal(res.json().data.changed, true);

  const act = await ActivityModel.findById(id).lean();
  assert.equal(act?.status, 'cancelled', '状态应为 cancelled');
  assert.equal(act?.trackPoints?.length, 3, '轨迹点应保留（只是状态不可见）');

  const user = await UserModel.findById(userId).lean();
  assert.equal(user?.footprintDirty, true, '足迹缓存应置脏');

  // 用户端列表（只查 finished）不应出现
  const list = await app.inject({
    method: 'GET',
    url: '/sport-track/api/activities?pageSize=100',
    headers: { authorization: `Bearer ${userToken}` },
  });
  const item = list.json().data.items.find((i: { _id: string }) => String(i._id) === id);
  assert.ok(!item, '作废后不应出现在用户列表');
  await ActivityModel.deleteOne({ _id: id });
});

test('改状态：cancelled → finished 可恢复', async () => {
  const id = await createFinished();
  await adminReq('PUT', `/sport-track/api/admin/activities/${id}/status`, { status: 'cancelled' });
  const res = await adminReq('PUT', `/sport-track/api/admin/activities/${id}/status`, { status: 'finished' });
  assert.equal(res.statusCode, 200);
  const act = await ActivityModel.findById(id).lean();
  assert.equal(act?.status, 'finished');
  await ActivityModel.deleteOne({ _id: id });
});

test('改状态：重复设置同状态 → changed=false 幂等', async () => {
  const id = await createFinished();
  const res = await adminReq('PUT', `/sport-track/api/admin/activities/${id}/status`, { status: 'finished' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.changed, false);
  await ActivityModel.deleteOne({ _id: id });
});

test('改状态：非法 status 值 → 400', async () => {
  const id = await createFinished();
  const res = await adminReq('PUT', `/sport-track/api/admin/activities/${id}/status`, { status: 'deleted' });
  assert.equal(res.statusCode, 400);
  await ActivityModel.deleteOne({ _id: id });
});

test('改状态：不存在的轨迹 → 404', async () => {
  const res = await adminReq('PUT', '/sport-track/api/admin/activities/000000000000000000000000/status', {
    status: 'cancelled',
  });
  assert.equal(res.statusCode, 404);
});

test('备注：设置/更新/清空，用户列表返回 note', async () => {
  const res1 = await adminReq('PUT', `/sport-track/api/admin/users/${userId}/note`, { note: '内测用户' });
  assert.equal(res1.statusCode, 200);
  assert.equal(res1.json().data.note, '内测用户');

  const list = await adminReq('GET', `/sport-track/api/admin/users?keyword=${encodeURIComponent('内测')}`);
  assert.equal(list.statusCode, 200);
  const item = list.json().data.items.find((i: { id: string }) => i.id === userId);
  assert.ok(item, '备注搜索应命中');
  assert.equal(item.note, '内测用户');

  // 清空
  const res2 = await adminReq('PUT', `/sport-track/api/admin/users/${userId}/note`, { note: '' });
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.json().data.note, '');
});

test('备注：超过 200 字 → 400', async () => {
  const res = await adminReq('PUT', `/sport-track/api/admin/users/${userId}/note`, { note: 'a'.repeat(201) });
  assert.equal(res.statusCode, 400);
});

test('备注：不存在的用户 → 404', async () => {
  const res = await adminReq('PUT', '/sport-track/api/admin/users/000000000000000000000000/note', { note: 'x' });
  assert.equal(res.statusCode, 404);
});
