/**
 * 管理端 keyword 必须按「字面量」搜索，不能当正则用。
 *
 * 为什么要钉住：`admin.routes.ts` 两处把 keyword 原样塞进 `$regex`
 * （用户列表 613 行的昵称/备注、轨迹列表 821 行的昵称），于是
 * ① `.` `*` `+` 这些元字符变成通配，搜 "a.b" 会把 "aXb" 也捞出来；
 * ② 一个未闭合的 `(` 会让 Mongo 抛正则编译错误 → 接口 500；
 * ③ 构造 `(.*)*` 这类回溯模式可以拿一个查询把 Mongo 线程拖死。
 * 同仓的足迹搜索早就有 escapeRegex（services/footprint-record.ts），这里是漏网的两处。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';

const ADMIN_USER = 'test_admin_kw';
const ADMIN_PASS = 'kw_pass_123';
const OPENID_PREFIX = 'test-kw-regex-';

let app: FastifyInstance;
let adminToken = '';

async function makeUser(openid: string, nickname: string) {
  const u = await UserModel.create({ openid: `${OPENID_PREFIX}${openid}`, nickname });
  await ActivityModel.create({ userId: u._id, type: 'running', status: 'finished', startTime: new Date(), distance: 1000, duration: 300 });
  return String(u._id);
}
const get = (url: string) => app.inject({ method: 'GET', url: `/sport-track/api/admin${url}`, headers: { authorization: `Bearer ${adminToken}` } });

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const existing = await AdminModel.findOne({ username: ADMIN_USER });
  if (existing) {
    existing.passwordHash = await hashPassword(ADMIN_PASS);
    await existing.save();
  } else {
    await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  }
  const login = await app.inject({ method: 'POST', url: '/sport-track/api/admin/login', payload: { username: ADMIN_USER, password: ADMIN_PASS } });
  adminToken = login.json().data.token;
  assert.ok(adminToken, '管理员登录应成功');

  await cleanup();
  // 昵称只差一个字符：`.` 当通配时两条都会命中
  await makeUser('dot', '正则.点测试甲');
  await makeUser('x', '正则X点测试甲');
});

async function cleanup() {
  const users = await UserModel.find({ openid: { $regex: `^${OPENID_PREFIX}` } }).select('_id');
  await ActivityModel.deleteMany({ userId: { $in: users.map((u) => u._id) } });
  await UserModel.deleteMany({ openid: { $regex: `^${OPENID_PREFIX}` } });
}

after(async () => {
  await cleanup();
  await app.close();
  await (await import('mongoose')).default.disconnect().catch(() => {});
});

test('用户列表：keyword 里的 . 是字面点号，不是通配符', async () => {
  const res = await get('/users?keyword=' + encodeURIComponent('正则.点测试甲'));
  assert.equal(res.statusCode, 200, res.body);
  const names = (res.json().data.items as { nickname: string }[]).map((x) => x.nickname);
  assert.deepEqual(names, ['正则.点测试甲'], `把 . 当通配会多捞：${JSON.stringify(names)}`);
});

test('轨迹列表：keyword 里的 . 同样是字面点号', async () => {
  const res = await get('/activities?keyword=' + encodeURIComponent('正则.点测试甲'));
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  assert.equal(d.total, 1, `把 . 当通配会命中两个用户的轨迹，实际 total=${d.total}`);
});

test('非法正则字符不再把接口打成 500，而是按字面量搜不到', async () => {
  for (const kw of ['(', ')', '*', '+', '[', '(\\w+', '?']) {
    for (const url of ['/users', '/activities']) {
      const res = await get(`${url}?keyword=` + encodeURIComponent(kw));
      assert.equal(res.statusCode, 200, `${url} keyword=${JSON.stringify(kw)} 应 200，实际 ${res.statusCode}：${res.body.slice(0, 120)}`);
      assert.equal(res.json().data.total, 0, `${url} keyword=${JSON.stringify(kw)} 应搜不到东西`);
    }
  }
});

test('正向不误伤：普通关键词仍能命中（防止改成永远返回 0 条）', async () => {
  const res = await get('/users?keyword=' + encodeURIComponent('正则X点'));
  assert.equal(res.statusCode, 200, res.body);
  const names = (res.json().data.items as { nickname: string }[]).map((x) => x.nickname);
  assert.ok(names.includes('正则X点测试甲'), `普通关键词应命中，实际 ${JSON.stringify(names)}`);
});
