import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';

/**
 * 管理端积分域鉴权闸门（spec §9 PT-15，Task 9 用例）。
 *
 * 为什么逐条列路由而不是抽查：这一域的路由分散在五个「积分管理 · …」段落里，
 * 任何一条漏挂 `onRequest: [adminAuth]` 都会变成公开接口；清单本身由 PT-15a 拿
 * Fastify 运行期路由表对数，加了路由忘了进清单会直接红。
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
 * + Task 8 道具概况/名单 2 条 + 实物批次订单 3 条 + Task 10 榜单发放台账 2 条 = 20 条）。
 * 路径里的 id 用固定 24 位 hex：鉴权闸门在参数校验之前，但用合法形态能保证
 * 「没有 401 时也不会因为 400 而误判」。
 * 清单全不全由下面 PT-15a 拿运行期路由表对数，不靠人记得住。
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
  // 实物批次：订单列表 / 发货 / 代确认
  ['GET', `${BASE}/points/orders`],
  ['PATCH', `${BASE}/points/orders/${UID}/ship`],
  ['PATCH', `${BASE}/points/orders/${UID}/complete`],
  // Task 10：榜单发放台账（列表 + 撤回）
  ['GET', `${BASE}/points/board-settlements`],
  ['POST', `${BASE}/points/board-settlements/${UID}/revoke`],
  ['GET', `${BASE}/points/board-switch`],
  ['POST', `${BASE}/points/board-switch`],
];

/** printRoutes 的一行 → { 缩进层数, 路径段, 方法（去 HEAD） }；不匹配的行（空行、根 `/`）跳过 */
function routeLine(line: string): { depth: number; seg: string; methods: string[] } | null {
  const m = /^((?:[│ ]{4})*)(?:[├└]── )(.*?) \(([^)]+)\)$/.exec(line);
  if (!m) return null;
  return {
    depth: m[1].length / 4,
    seg: m[2],
    methods: m[3].split(',').map((s) => s.trim()).filter((s) => s !== 'HEAD' && s !== 'OPTIONS'),
  };
}

/**
 * 数出运行期真实注册的「管理端积分域」路由（method + 完整路径）。
 * 树形输出里顶层给全路径、子节点只给增量段（`/image`，或 `-regions` 这种不带斜杠的后缀），
 * 按缩进层拼回父路径即可。
 */
function registeredAdminPointsRoutes(tree: string): string[] {
  const prefix = `${BASE}/points`;
  const stack: string[] = [];
  const found: string[] = [];
  for (const raw of tree.split('\n')) {
    const node = routeLine(raw);
    if (!node) continue;
    stack[node.depth] = node.seg;
    const full = stack.slice(0, node.depth + 1).join('');
    for (const method of node.methods) {
      if (full.startsWith(prefix)) found.push(`${method} ${full}`);
    }
  }
  return found;
}

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

test('PT-15 路由清单覆盖本域全部管理端路由（漏一条等于漏一道闸门）', () => {
  // 同一个 method+path 重复列会让计数虚高、实际漏测
  assert.equal(new Set(POINTS_ADMIN_ROUTES.map(([m, u]) => `${m} ${u}`)).size, POINTS_ADMIN_ROUTES.length,
    '清单里不许有重复路由');
});

test('PT-15a 清单与运行期路由表逐条对得上（新增路由忘了进清单，这里要红）', () => {
  // 只断言 `length === 18` 拦不住「加了路由忘了加用例」——改测试的人会连数字一起改掉。
  // 拿 Fastify 实际注册的路由表当基准，两边做集合差，缺哪条就点名哪条。
  const registered = new Set(registeredAdminPointsRoutes(app.printRoutes({ commonPrefix: false })));
  // 清单里的路径参数用固定 24 位 hex 实值（要走得到鉴权闸门后面的参数校验），
  // 路由表里是 `:id` —— 对数前把 hex 段还原成占位符
  const listed = new Set(POINTS_ADMIN_ROUTES.map(([m, u]) =>
    `${m} ${u.split('?')[0].replace(/\/[a-f\d]{24}(?=\/|$)/gi, '/:id')}`));
  const missing = [...registered].filter((r) => !listed.has(r));
  const ghost = [...listed].filter((r) => !registered.has(r));
  assert.deepEqual(missing, [], `这些已注册的路由没有鉴权用例：${missing.join('、')}`);
  assert.deepEqual(ghost, [], `清单里有这些不存在的路由（改名或删掉了没同步）：${ghost.join('、')}`);
  assert.equal(registered.size, POINTS_ADMIN_ROUTES.length, '对数：清单条数必须等于注册条数');
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
    [`${BASE}/points/orders`, 200],
    [`${BASE}/points/board-settlements`, 200],
    [`${BASE}/points/board-switch`, 200],
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
