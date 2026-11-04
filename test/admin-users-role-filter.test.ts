import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';

let app: FastifyInstance;
let adminToken = '';

const ADMIN_USER = 'admin_urole_test';
const ADMIN_PASS = 'test123456';

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  // 清理历史测试数据
  const users = await UserModel.find({ openid: /^admrol_openid/ }).select('_id');
  await UserModel.deleteMany({ _id: { $in: users.map((u) => u._id) } });
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });

  // 种子数据：2 个普通用户 + 1 个管理员角色用户
  await UserModel.create({ openid: 'admrol_openid-u1', nickname: '角色筛选普通甲' });
  await UserModel.create({ openid: 'admrol_openid-u2', nickname: '角色筛选普通乙' });
  await UserModel.create({ openid: 'admrol_openid-a1', nickname: '角色筛选管理员', role: 'admin' });

  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/login',
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  adminToken = res.json().data.token;
  assert.ok(adminToken, '管理员登录应成功');
});

after(async () => {
  await UserModel.deleteMany({ openid: /^admrol_openid/ });
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await app.close();
});

function listUsers(query = '') {
  return app.inject({
    method: 'GET',
    url: `/sport-track/api/admin/users${query}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
}

test('role=admin 只出管理员，role=user 只出普通用户', async () => {
  const admins = (await (await listUsers('?role=admin')).json()).data.items;
  assert.ok(admins.length >= 1, '种子里有 1 个管理员，至少应命中它');
  assert.ok(admins.every((u: { role: string }) => u.role === 'admin'), `越权混入非管理员：${admins.map((u: { role: string }) => u.role)}`);

  const normals = (await (await listUsers('?role=user')).json()).data.items;
  assert.ok(normals.length >= 2, '种子里有 2 个普通用户');
  assert.ok(normals.every((u: { role: string }) => u.role === 'user'), `越权混入管理员：${normals.map((u: { role: string }) => u.role)}`);
});

test('不传 role 不过滤：库里两种角色都能出现', async () => {
  const items = (await (await listUsers()).json()).data.items;
  assert.ok(items.some((u: { role: string }) => u.role === 'admin'), '不筛选应包含管理员');
  assert.ok(items.some((u: { role: string }) => u.role === 'user'), '不筛选应包含普通用户');
});

test('白名单外的 role 值当没传，返回空列表会误导成「没有管理员」', async () => {
  const items = (await (await listUsers('?role=superuser')).json()).data.items;
  assert.ok(items.some((u: { role: string }) => u.role === 'admin'));
  assert.ok(items.some((u: { role: string }) => u.role === 'user'));
});

test('role 与 keyword 组合生效：按昵称搜管理员只出那一个', async () => {
  const res = await listUsers(`?role=admin&keyword=${encodeURIComponent('角色筛选')}`);
  assert.equal(res.statusCode, 200);
  const items = res.json().data.items;
  assert.equal(items.length, 1, '两个普通用户 nickname 也含「角色筛选」，但 role 已先卡掉');
  assert.equal(items[0].nickname, '角色筛选管理员');
});
