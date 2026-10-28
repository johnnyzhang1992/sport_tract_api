/**
 * 广告位：管理端 CRUD + 公开 /ads（小程序按 key 取 unit-id）。
 * 只断言本用例自己造的行（key 前缀 t_ads_），不假设库里没有别的广告位。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AdSlotModel } from '../src/models/ad-slot.model.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';

let app: FastifyInstance;
let token = '';

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await AdSlotModel.deleteMany({ key: /^t_ads_/ });
  await AdminModel.deleteMany({ username: 't-ads-admin' });
  await AdminModel.create({ username: 't-ads-admin', passwordHash: await hashPassword('t-ads-pass') });
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/login',
    payload: { username: 't-ads-admin', password: 't-ads-pass' },
  });
  token = login.json().data.token;
});

after(async () => {
  await AdSlotModel.deleteMany({ key: /^t_ads_/ });
  await AdminModel.deleteMany({ username: 't-ads-admin' });
  await app.close();
});

const adminReq = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path = '', payload?: unknown, auth = token) =>
  app.inject({
    method,
    url: `/sport-track/api/admin/ads${path}`,
    payload: payload as never,
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
  });
const publicList = async () => {
  const res = await app.inject({ method: 'GET', url: '/sport-track/api/ads' });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.items as { key: string; unitId: string }[];
};
const shape = (over: Record<string, unknown> = {}) => ({
  name: '首页底部', unitId: 'adunit-eb146f52cea54541', active: true, sortOrder: 0, ...over,
});

test('AD-1 公开列表只下发在架广告位，只有 key/unitId，按 sortOrder 排', async (t) => {
  t.after(() => AdSlotModel.deleteMany({ key: /^t_ads_/ }));
  const a = await adminReq('POST', '', shape({ key: 't_ads_a', sortOrder: 2 }));
  const b = await adminReq('POST', '', shape({ key: 't_ads_b', sortOrder: 1 }));
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(b.statusCode, 200, b.body);

  const items = (await publicList()).filter((x) => x.key.startsWith('t_ads_'));
  assert.deepEqual(items.map((x) => x.key), ['t_ads_b', 't_ads_a'], 'sortOrder 小的在前');
  assert.deepEqual(Object.keys(items[0]).sort(), ['key', 'unitId'], '公开接口只给这两个字段');
  assert.equal(items[0].unitId, 'adunit-eb146f52cea54541');
});

test('AD-2 新建校验：key/名称/单元 id/active/sortOrder 非法都 400 并点名', async () => {
  const bad = [
    [shape({ key: 'BadKey' }), /key 需小写字母开头/],
    [shape({ key: 't_ads_x', name: '' }), /名称需 1–20 字/],
    [shape({ key: 't_ads_x', unitId: 'not-a-unit' }), /广告单元 ID 格式不对/],
    [shape({ key: 't_ads_x', active: 'yes' }), /active 只能是 true 或 false/],
    [shape({ key: 't_ads_x', sortOrder: 1.5 }), /sortOrder 必须是整数/],
  ] as const;
  for (const [payload, re] of bad) {
    const res = await adminReq('POST', '', payload);
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)} → ${res.body}`);
    assert.match(res.json().message, re);
  }
  assert.equal(await AdSlotModel.countDocuments({ key: 't_ads_x' }), 0, '校验失败不能落行');
});

test('AD-3 key 重复 400；创建后 kind 固定 template', async (t) => {
  t.after(() => AdSlotModel.deleteMany({ key: /^t_ads_/ }));
  const first = await adminReq('POST', '', shape({ key: 't_ads_dup' }));
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().data.kind, 'template');
  const again = await adminReq('POST', '', shape({ key: 't_ads_dup' }));
  assert.equal(again.statusCode, 400);
  assert.match(again.json().message, /已存在/);
  assert.equal(await AdSlotModel.countDocuments({ key: 't_ads_dup' }), 1);
});

test('AD-4 更新：下架后公开列表消失；key 不可改；不存在 404', async (t) => {
  t.after(() => AdSlotModel.deleteMany({ key: /^t_ads_/ }));
  const created = await adminReq('POST', '', shape({ key: 't_ads_upd' }));
  const id = created.json().data.id as string;

  const off = await adminReq('PUT', `/${id}`, shape({ key: 't_ads_upd', name: '改个名', active: false }));
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().data.active, false);
  assert.equal(off.json().data.name, '改个名');
  assert.ok(!(await publicList()).some((x) => x.key === 't_ads_upd'), '下架后公开列表不该再有它');

  const rename = await adminReq('PUT', `/${id}`, shape({ key: 't_ads_other' }));
  assert.equal(rename.statusCode, 400);
  assert.match(rename.json().message, /key 不可修改/);

  const missing = await adminReq('PUT', '/6b0000000000000000000000', shape());
  assert.equal(missing.statusCode, 404);
});

test('AD-5 删除：删后公开列表与二次删除都 404', async (t) => {
  t.after(() => AdSlotModel.deleteMany({ key: /^t_ads_/ }));
  const created = await adminReq('POST', '', shape({ key: 't_ads_del' }));
  const id = created.json().data.id as string;
  const del = await adminReq('DELETE', `/${id}`);
  assert.equal(del.statusCode, 200, del.body);
  assert.ok(!(await publicList()).some((x) => x.key === 't_ads_del'));
  assert.equal((await adminReq('DELETE', `/${id}`)).statusCode, 404);
});

test('AD-6 管理端四个接口未登录一律 401', async () => {
  for (const [method, path] of [['GET', ''], ['POST', ''], ['PUT', '/6b0000000000000000000000'], ['DELETE', '/6b0000000000000000000000']] as const) {
    const res = await adminReq(method, path, method === 'DELETE' ? undefined : shape({ key: 't_ads_x' }), '');
    assert.equal(res.statusCode, 401, `${method} ${path} 应 401，实际 ${res.statusCode}`);
  }
});
