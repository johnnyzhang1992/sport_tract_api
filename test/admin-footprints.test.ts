import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { UserModel } from '../src/models/user.model.js';
import { FootprintRecordModel } from '../src/models/footprint-record.model.js';

/**
 * 管理后台「足迹管理」列表接口回归：/admin/footprint-records（分页 + 筛选 + 用户信息回填）
 *
 * 直连 dev 库（沿用本仓库既有做法：buildApp + inject，不 mock mongoose）。库里已有真实足迹，
 * 所以「总数/排序」这类全量断言一律带 keyword=足迹管理回归 把结果集锁在种子数据内；
 * 省市也用 测试省X 这类唯一值，避免被既有数据（如 浙江省 29 条）污染。
 * 种子用 insertMany(..., { timestamps: false }) 显式写 createdAt —— 否则 mongoose 会把它覆盖成
 * 当前时间，「按创建时间倒序」这条断言就只是碰巧通过。
 */
const ADMIN_USER = 'test_admin_footprints';
const ADMIN_PASS = 'admin_pass_123';
const MZ = '足迹管理回归'; // 种子唯一标识：昵称、标题都带它，用于把断言锁在种子集内

let app: FastifyInstance;
let adminToken = '';
let uidA = '';
let uidB = '';

async function ensureAdmin() {
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
  assert.ok(adminToken, '管理员登录应拿到 token');
}

function req(path: string, token: string = adminToken) {
  return app.inject({
    method: 'GET',
    url: `/sport-track/api/admin/footprint-records${path}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const data = (path: string) => req(path).then((r) => r.json().data);
const titles = (d: any) => d.items.map((x: any) => x.title);

const loc = (name: string, province: string, city: string) => ({
  name,
  address: `${province}${city}`,
  province,
  city,
  latitude: 30,
  longitude: 120,
});

const fpDoc = (userId: string, over: Record<string, unknown> = {}) => ({
  userId: new Types.ObjectId(userId),
  visitDate: '2026-01-01',
  title: `${MZ}-?`,
  people: [],
  description: '',
  location: loc('某地', '测试省丁', '测试市丁'),
  photos: [],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await ensureAdmin();

  await FootprintRecordModel.deleteMany({ title: new RegExp(`^${MZ}`) });
  await UserModel.deleteMany({ nickname: new RegExp(`^${MZ}`) });
  const a = await UserModel.create({ nickname: `${MZ}甲`, uid: 91001, openid: `fpadmin_${MZ}a` });
  const b = await UserModel.create({ nickname: `${MZ}乙`, uid: 91002, openid: `fpadmin_${MZ}b` });
  uidA = String(a._id);
  uidB = String(b._id);

  await FootprintRecordModel.insertMany(
    [
      fpDoc(uidA, {
        title: `${MZ}-A1`,
        visitDate: '2026-09-20',
        createdAt: new Date('2026-09-20T01:00:00Z'),
        location: loc('西湖', '测试省甲', '测试市甲'),
        photos: ['https://example.com/a1-1.jpg', 'https://example.com/a1-2.jpg'],
      }),
      fpDoc(uidA, {
        title: `${MZ}-A2`,
        visitDate: '2026-08-15',
        createdAt: new Date('2026-09-10T01:00:00Z'),
        location: loc('丽江古城', '测试省乙', '测试市乙'),
      }),
      // 省市缺失 + 单图 + 同行 2 人：验证空省市不被筛选误吞、列表仍能渲染
      fpDoc(uidA, {
        title: `${MZ}-A3`,
        visitDate: '2025-12-01',
        createdAt: new Date('2026-01-05T01:00:00Z'),
        location: { name: '未知地点', address: '', province: '', city: '', latitude: 1.5, longitude: 2.5 },
        photos: ['https://example.com/a3.jpg'],
        people: ['张三', '李四'],
        description: '同行两人',
      }),
      fpDoc(uidB, {
        title: `${MZ}-B1`,
        visitDate: '2026-09-21',
        createdAt: new Date('2026-09-21T01:00:00Z'),
        location: loc('故宫', '测试省丙', '测试市丙'),
        photos: ['https://example.com/b1-1.jpg', 'https://example.com/b1-2.jpg', 'https://example.com/b1-3.jpg'],
      }),
    ],
    { timestamps: false },
  );
});

after(async () => {
  await FootprintRecordModel.deleteMany({ title: new RegExp(`^${MZ}`) });
  await UserModel.deleteMany({ nickname: new RegExp(`^${MZ}`) });
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

test('F1 列表：按 createdAt 倒序分页，项内回填昵称/UID/省市/照片数', async () => {
  const d = await data(`?keyword=${MZ}`);
  assert.equal(d.total, 4);
  assert.equal(d.page, 1);
  assert.equal(d.pageSize, 20);
  assert.deepEqual(
    titles(d),
    [`${MZ}-B1`, `${MZ}-A1`, `${MZ}-A2`, `${MZ}-A3`],
    '创建时间倒序（不是到访时间：A3 到访 2025-12 却排最后，因为它最早创建）',
  );
  const first = d.items[0];
  assert.equal(first.userId, uidB);
  assert.equal(first.userNickname, `${MZ}乙`);
  assert.equal(first.userUid, '91002', 'UID 与用户列表同口径（字符串）');
  assert.equal(first.province, '测试省丙');
  assert.equal(first.city, '测试市丙');
  assert.equal(first.visitDate, '2026-09-21');
  assert.equal(first.photoCount, 3);
  assert.equal('photos' in first, false, '列表不下发照片数组，详情弹窗才取');
  assert.equal('openid' in first, false, 'openid 不外泄');

  const a3 = d.items.find((x: any) => x.title === `${MZ}-A3`);
  assert.equal(a3.province, '', '省市缺失原样为空串，前端显示 —');
  assert.equal(a3.peopleCount, 2);
  assert.equal(a3.userUid, '91001');
});

test('F2 筛选：用户 / 省份 / 关键词（标题·昵称）/ 照片数下限 / 到访日期区间可叠加', async () => {
  let d = await data(`?userId=${uidA}`);
  assert.equal(d.total, 3, '按用户筛（该用户只有种子数据）');

  d = await data(`?keyword=${MZ}&province=${encodeURIComponent('测试省乙')}`);
  assert.deepEqual(titles(d), [`${MZ}-A2`], '按省筛');

  d = await data(`?keyword=${encodeURIComponent(`${MZ}-A1`)}`);
  assert.deepEqual(titles(d), [`${MZ}-A1`], '关键词命中标题');

  d = await data(`?keyword=${encodeURIComponent(`${MZ}甲`)}`);
  assert.deepEqual(titles(d).sort(), [`${MZ}-A1`, `${MZ}-A2`, `${MZ}-A3`], '关键词命中昵称 → 该用户全部足迹');
  assert.deepEqual([...new Set(d.items.map((x: any) => x.userId))], [uidA]);

  d = await data(`?keyword=${MZ}&minPhotos=2`);
  assert.deepEqual(titles(d), [`${MZ}-B1`, `${MZ}-A1`], '照片数 ≥2（含等于）');

  d = await data(`?keyword=${MZ}&visitFrom=2026-09-01&visitTo=2026-10-01`);
  assert.deepEqual(titles(d), [`${MZ}-B1`, `${MZ}-A1`], '到访日期含 from 不含 to');

  d = await data(`?userId=${uidA}&province=${encodeURIComponent('测试省甲')}&minPhotos=1`);
  assert.deepEqual(titles(d), [`${MZ}-A1`], '三个条件同时生效');

  d = await data(`?keyword=${encodeURIComponent(`${MZ}不存在`)}`);
  assert.deepEqual({ total: d.total, items: d.items }, { total: 0, items: [] }, '无命中返回空形态而非报错');
});

test('F3 分页：pageSize 上限夹到 100、翻页不重不漏、越界页 total 不变', async () => {
  let d = await data(`?keyword=${MZ}&pageSize=500`);
  assert.equal(d.pageSize, 100, 'pageSize 夹到 100（与 /admin/activities 同口径）');

  d = await data(`?keyword=${MZ}&pageSize=2&page=1`);
  const p1 = titles(d);
  d = await data(`?keyword=${MZ}&pageSize=2&page=2`);
  const p2 = titles(d);
  assert.equal(p1.length, 2);
  assert.deepEqual([...p1, ...p2].sort(), [`${MZ}-A1`, `${MZ}-A2`, `${MZ}-A3`, `${MZ}-B1`], '两页拼起来正好全量，不重不漏');

  d = await data(`?keyword=${MZ}&pageSize=2&page=9`);
  assert.deepEqual({ items: d.items, total: d.total }, { items: [], total: 4 }, '越界页：空列表但 total 仍是真实总数');

  d = await data(`?keyword=${MZ}&page=0`);
  assert.equal(d.page, 1, 'page 下限夹到 1');
});

test('F4 鉴权：无 token 与非管理员 token 都 401', async () => {
  assert.equal((await req('', '')).statusCode, 401, '未登录 401');
  const userLogin = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'mock_openid_admin_footprints' },
  });
  const userToken = userLogin.json().data.accessToken;
  assert.ok(userToken, 'mock 用户登录应拿到 token');
  const res = await req(`?keyword=${MZ}`, userToken);
  assert.equal(res.statusCode, 401, '普通用户 token 不是管理员 token，不能读全站足迹');
  await UserModel.deleteOne({ _id: userLogin.json().data.user.id });
});

test('F5 非法筛选参数：userId 不是 ObjectId → 404 而不是 CastError 500', async () => {
  const res = await req('?userId=not-an-object-id');
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(res.json().message, '用户不存在');
});

test('F6 详情：返回完整正文 + 照片数组 + 归属人信息（列表里没有的字段这里齐全）', async () => {
  const d0 = await data(`?keyword=${encodeURIComponent(`${MZ}-A3`)}`);
  const id = d0.items[0].id;
  assert.equal('photos' in d0.items[0], false, '前提：列表确实没下发照片');

  const res = await app.inject({
    method: 'GET',
    url: `/sport-track/api/admin/footprint-records/${id}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  assert.equal(d.id, id);
  assert.equal(d.title, `${MZ}-A3`);
  assert.equal(d.description, '同行两人');
  assert.deepEqual(d.people, ['张三', '李四']);
  assert.deepEqual(d.photos, ['https://example.com/a3.jpg'], '详情下发照片（非 bucket URL 原样返回，不发外呼）');
  assert.equal(d.location.name, '未知地点');
  assert.equal(d.location.latitude, 1.5, '坐标原样下发（弹窗地图定位用）');
  assert.equal(d.userId, uidA);
  assert.equal(d.userNickname, `${MZ}甲`);
  assert.equal(d.userUid, '91001');
});

test('F7 详情异常：文档不存在 / id 形态非法都 404「足迹不存在」', async () => {
  const GHOST = 'ffffffffffffffffffffffff';
  const r1 = await app.inject({
    method: 'GET',
    url: `/sport-track/api/admin/footprint-records/${GHOST}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(r1.statusCode, 404, r1.body);
  assert.equal(r1.json().message, '足迹不存在');

  for (const bad of ['abc', 'not-an-object-id', 'zzzzzzzzzzzzzzzzzzzzzzzz']) {
    const r = await app.inject({
      method: 'GET',
      url: `/sport-track/api/admin/footprint-records/${bad}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(r.statusCode, 404, `${bad} 应 404，实际 ${r.statusCode}: ${r.body}`);
    assert.equal(r.json().message, '足迹不存在', `${bad} 不能漏出 CastError 文案`);
  }
});

test('F8 删除：管理员可跨用户硬删，删后列表与详情都查不到；重复删 404', async () => {
  const d0 = await data(`?keyword=${encodeURIComponent(`${MZ}-A2`)}`);
  const id = d0.items[0].id;
  assert.equal(d0.items[0].userId, uidA, '前提：这条属于 A，删除用的 token 是管理员');

  const del = await app.inject({
    method: 'DELETE',
    url: `/sport-track/api/admin/footprint-records/${id}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(del.statusCode, 200, del.body);
  assert.equal(await FootprintRecordModel.countDocuments({ _id: new Types.ObjectId(id) }), 0, '库里真删了');

  const left = await data(`?keyword=${encodeURIComponent(`${MZ}-A2`)}`);
  assert.deepEqual({ total: left.total, items: left.items }, { total: 0, items: [] }, '列表不再出现');

  const again = await app.inject({
    method: 'DELETE',
    url: `/sport-track/api/admin/footprint-records/${id}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(again.statusCode, 404, '重复删除 404');
  assert.equal(again.json().message, '足迹不存在');

  const bad = await app.inject({
    method: 'DELETE',
    url: '/sport-track/api/admin/footprint-records/abc',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(bad.statusCode, 404, '非法 id 删除 404 而不是 500');
  assert.equal(bad.json().message, '足迹不存在');
});

test('F9 鉴权：详情与删除同样只认管理员 token', async () => {
  const d0 = await data(`?keyword=${encodeURIComponent(`${MZ}-B1`)}`);
  const id = d0.items[0].id;
  for (const [method, path] of [
    ['GET', `/admin/footprint-records/${id}`],
    ['DELETE', `/admin/footprint-records/${id}`],
  ] as const) {
    const noToken = await app.inject({ method, url: `/sport-track/api${path}` });
    assert.equal(noToken.statusCode, 401, `${method} ${path} 无凭证应 401：${noToken.body}`);
    const userLogin = await app.inject({
      method: 'POST',
      url: '/sport-track/api/auth/login',
      payload: { code: 'mock_openid_admin_footprints_2' },
    });
    const asUser = await app.inject({
      method,
      url: `/sport-track/api${path}`,
      headers: { authorization: `Bearer ${userLogin.json().data.accessToken}` },
    });
    assert.equal(asUser.statusCode, 401, `${method} ${path} 普通用户 token 应 401：${asUser.body}`);
    await UserModel.deleteOne({ _id: userLogin.json().data.user.id });
  }
});
