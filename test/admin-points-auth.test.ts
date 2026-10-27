import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';

/**
 * 管理端积分域鉴权闸门（spec §9 PT-15，Task 9 用例）。
 *
 * 为什么逐条列路由而不是抽查：这一域的 15 条路由分散在四个「积分管理 · …」段落里，
 * 任何一条漏挂 `onRequest: [adminAuth]` 都会变成公开接口。
 *
 * 断言三件事（缺一不可）：
 * 1. 无凭证 → 401/403；
 * 2. **不是 404**：未注册的路由同样回 404，只断状态码会把「路由压根没挂上」当成「鉴权生效」；
 * 3. message 点名凭证/权限 —— 只看状态码分不清是鉴权拦下还是别的 401 分支。
 *
 * 用户凭证用 `app.signAccessToken`（与 /auth/login 签发的是同一枚 token）：管理员验签走
 * `ADMIN_JWT_SECRET`，用户 token 在 adminAuth 里必然失败 → 401「管理员凭证无效或已过期」。
 */
const ADMIN_USER = 'admin_points_auth_t9';
const ADMIN_PASS = 'test123456';
const UID = '64b64b64b64b64b64b64b64b';
const BASE = '/sport-track/api/admin';

/**
 * 本域的全部管理端路由（Task 4 目录 5 条 + Task 5 发放/记录 2 条 + Task 6/7 概况/用户 6 条
 * + Task 8 道具概况/名单 2 条 = 15 条）。
 * 路径里的 id 用固定 24 位 hex：鉴权闸门在参数校验之前，但用合法形态能保证
 * 「没有 401 时也不会因为 400 而误判」。
 */
const POINTS_ADMIN_ROUTES: Array<[string, string]> = [
  // Task 4：道具目录
  ['GET', `${BASE}/points/items`],
  ['POST', `${BASE}/points/items`],
  ['PUT', `${BASE}/points/items/${UID}`],
  ['PATCH', `${BASE}/points/items/${UID}/stock`],
  ['POST', `${BASE}/points/items/image`],
  // Task 5：发放与发放记录
  ['POST', `${BASE}/points/items/${UID}/grant`],
  ['GET', `${BASE}/points/issuances`],
  // Task 6：概况与趋势
  ['GET', `${BASE}/points/overview`],
  ['GET', `${BASE}/points/trend?days=7`],
  // Task 7：用户积分列表与详情
  ['GET', `${BASE}/points/users`],
  ['GET', `${BASE}/points/users/${UID}`],
  ['GET', `${BASE}/points/users/${UID}/records`],
  ['GET', `${BASE}/points/users/${UID}/cards`],
  // Task 8：道具概况与免广告名单
  ['GET', `${BASE}/points/items/overview`],
  ['GET', `${BASE}/points/ad-free/roster`],
];

let app: FastifyInstance;
let adminToken = '';
let userToken = '';

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  const login = await app.inject({
    method: 'POST',
    url: `${BASE}/login`,
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  adminToken = login.json().data.token;
  assert.ok(adminToken, '管理员登录应成功');
  // 普通用户 token：与用户端 /auth/login 同一条签发路径，不是管理员 token
  userToken = app.signAccessToken(String(new Types.ObjectId()));
  assert.ok(userToken, '用户 access token 应能签发');
});

after(async () => {
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await app.close();
});

test('PT-15 路由清单覆盖 15 条（漏一条等于漏一道闸门）', () => {
  assert.equal(POINTS_ADMIN_ROUTES.length, 15, 'Task 4–8 的管理端点路由必须全部列进来');
  // 同一个 method+path 重复列会让计数虚高、实际漏测
  assert.equal(new Set(POINTS_ADMIN_ROUTES.map(([m, u]) => `${m} ${u}`)).size, POINTS_ADMIN_ROUTES.length,
    '清单里不许有重复路由');
});

for (const [method, url] of POINTS_ADMIN_ROUTES) {
  test(`PT-15 ${method} ${url} 无凭证与用户凭证都要被挡`, async () => {
    const anon = await app.inject({ method: method as 'GET', url });
    assert.ok(anon.statusCode === 401 || anon.statusCode === 403,
      `${method} ${url} 匿名应 401/403，实际 ${anon.statusCode}：${anon.body}`);
    assert.notEqual(anon.statusCode, 404, `${method} ${url} 回 404 ＝ 路由没挂上，不是鉴权生效`);
    assert.match(anon.json().message, /管理员|凭证|token|权限/i,
      `${method} ${url} 匿名 message 必须点名凭证/权限：${anon.body}`);

    const asUser = await app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: `Bearer ${userToken}` },
    });
    assert.ok(asUser.statusCode === 401 || asUser.statusCode === 403,
      `${method} ${url} 用户 token 应 401/403，实际 ${asUser.statusCode}：${asUser.body}`);
    assert.notEqual(asUser.statusCode, 404, `${method} ${url} 回 404 ＝ 路由没挂上，不是鉴权生效`);
    assert.match(asUser.json().message, /管理员|凭证|token|权限/i,
      `${method} ${url} 用户 token 的 message 必须点名凭证/权限：${asUser.body}`);
  });
}

test('PT-15b 管理员凭证能过同一条闸门（反证上面的 401 不是路由缺失）', async () => {
  const headers = { authorization: `Bearer ${adminToken}` };
  // 全部 GET 路由都要在管理员凭证下返回 200（带 id 的用幽灵 id：走到 404 也说明路由存在）
  const reads: Array<[string, number]> = [
    [`${BASE}/points/items`, 200],
    [`${BASE}/points/issuances`, 200],
    [`${BASE}/points/overview`, 200],
    [`${BASE}/points/trend?days=7`, 200],
    [`${BASE}/points/users`, 200],
    [`${BASE}/points/items/overview`, 200],
    [`${BASE}/points/ad-free/roster`, 200],
    // 幽灵 id：服务层 404「用户不存在」，证明路由已注册且鉴权已通过
    [`${BASE}/points/users/${UID}`, 404],
    [`${BASE}/points/users/${UID}/records`, 404],
    [`${BASE}/points/users/${UID}/cards`, 404],
  ];
  for (const [url, expected] of reads) {
    const res = await app.inject({ method: 'GET', url, headers });
    assert.equal(res.statusCode, expected, `${url} 管理员凭证下应 ${expected}：${res.body}`);
  }
});
