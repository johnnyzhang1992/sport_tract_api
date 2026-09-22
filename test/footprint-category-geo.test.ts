import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { FootprintRecordModel } from '../src/models/footprint-record.model.js';
import { UserModel } from '../src/models/user.model.js';
import { CreateFootprintRecordSchema, FootprintGeoQuery } from '../src/utils/validators.js';

/**
 * 足迹「分类」字段 + /footprint-records/geo 过滤参数（地图页筛选/搜索用）
 *
 * 种子数据直插（create 接口的省市会被 locateRegion 覆盖，测省市过滤必须自己写省市）。
 * 省市名用 分类测试省X 这种唯一串，避免被 dev 库既有数据污染断言。
 * 清理按捕获的 userId 删（mock 登录存的 openid 是 mock_openid_<hash>，按 code 前缀删会静默漏）。
 */
const MARK = '分类回归';
const loc = (name: string, province: string, city: string) => ({
  name,
  address: `${province}${city}${name}`,
  province,
  city,
  latitude: 30,
  longitude: 120,
});

let app: FastifyInstance;
let token = '';
let uid = '';

async function api(method: string, url: string, payload?: Record<string, unknown>) {
  return app.inject({
    method: method as 'GET',
    url: `/sport-track/api/footprint-records${url}`,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown> | undefined,
  });
}
const json = (res: any) => res.json().data;
/** POST/PUT 把文档包在 data.record 里，GET 详情/列表则是裸 data */
const record = (res: any) => json(res).record;

const seed = [
  { title: `${MARK}-华山`, visitDate: '2024-06-01', category: 'mountain', location: loc('华山', '分类测试省甲', '分类测试市甲') },
  { title: `${MARK}-古寺`, visitDate: '2024-11-01', category: 'heritage', location: loc('古寺', '分类测试省甲', '分类测试市甲') },
  { title: `${MARK}-西湖`, visitDate: '2023-04-01', category: 'scenic', location: loc('西湖', '分类测试省乙', '分类测试市乙') },
  { title: `${MARK}-无名地`, visitDate: '2025-01-01', category: '', location: loc('无名地', '分类测试省甲', '分类测试市丙') },
];
const titles = (items: any[]) => items.map((x) => x.title).sort();

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/sport-track/api/auth/login', payload: { code: 'fp-cat-user' } });
  token = login.json().data.accessToken;
  uid = (await app.inject({ method: 'GET', url: '/sport-track/api/users/me', headers: { authorization: `Bearer ${token}` } })).json().data.id;
  await FootprintRecordModel.deleteMany({ title: new RegExp(`^${MARK}`) });
  await FootprintRecordModel.insertMany(seed.map((s) => ({ ...s, userId: new Types.ObjectId(uid), people: [], description: '', photos: [] })));
});

after(async () => {
  await FootprintRecordModel.deleteMany({ userId: new Types.ObjectId(uid) });
  await UserModel.deleteOne({ _id: new Types.ObjectId(uid) });
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

test('zod：category 收 9 个 key 与空串，非法值报文的含实际值与中文清单', () => {
  const base = {
    visitDate: '2024-06-01',
    title: `${MARK}-zod`,
    location: { name: 'x', address: 'y', latitude: 30, longitude: 120 },
  };
  for (const key of ['scenic', 'mountain', 'park', 'heritage', 'museum', 'street', 'food', 'camp', 'other', '']) {
    assert.equal(CreateFootprintRecordSchema.parse({ ...base, category: key }).category, key);
  }
  assert.equal(CreateFootprintRecordSchema.parse(base).category, ''); // 不传即未分类
  const err = (() => {
    try {
      CreateFootprintRecordSchema.parse({ ...base, category: 'temple' });
      return null;
    } catch (e: any) {
      return e.issues[0].message as string;
    }
  })();
  assert.ok(err, '非法分类应被拒');
  assert.match(err as string, /temple/, `报文要含实际值：${err}`);
  assert.match(err as string, /景区/, `报文要含可选清单：${err}`);
});

test('CRUD：category 在创建/详情/列表/geo 四条读路径一致下发，缺省为空串', async () => {
  const created = record(await api('POST', '', {
    visitDate: '2024-07-01',
    title: `${MARK}-接口`,
    location: { name: '灵隐寺', address: '杭州市西湖区', latitude: 30.24, longitude: 120.15 },
    category: 'heritage',
  }));
  assert.equal(created.category, 'heritage');
  assert.equal(json(await api('GET', `/${created.id}`)).category, 'heritage');
  const listed = json(await api('GET', `?keyword=${encodeURIComponent(MARK + '-接口')}`));
  assert.equal(listed.items[0].category, 'heritage');
  const geo = json(await api('GET', '/geo'));
  assert.deepEqual(
    geo.items.filter((x: any) => x.title === `${MARK}-接口`).map((x: any) => x.category),
    ['heritage'],
    'geo item 要带 category',
  );

  const blank = record(await api('POST', '', {
    visitDate: '2024-07-02',
    title: `${MARK}-缺省`,
    location: { name: '某处', address: '某市', latitude: 30.25, longitude: 120.16 },
  }));
  assert.equal(blank.category, '');
  assert.equal(json(await api('GET', `/${blank.id}`)).category, '');
  await FootprintRecordModel.deleteMany({ title: new RegExp(`^${MARK}-接口$|^${MARK}-缺省$`) });
});

test('编辑：category 可改可清空', async () => {
  const created = record(await api('POST', '', {
    visitDate: '2024-07-03',
    title: `${MARK}-编辑`,
    location: { name: '营地', address: '某市', latitude: 30.26, longitude: 120.17 },
    category: 'camp',
  }));
  const body = { visitDate: '2024-07-03', title: `${MARK}-编辑`, location: { name: '营地', address: '某市', latitude: 30.26, longitude: 120.17 } };
  assert.equal(record(await api('PUT', `/${created.id}`, { ...body, category: 'food' })).category, 'food');
  assert.equal(record(await api('PUT', `/${created.id}`, { ...body, category: '' })).category, '');
  assert.equal((await api('PUT', `/${created.id}`, { ...body, category: 'nope' })).statusCode, 400);
  await FootprintRecordModel.deleteMany({ title: `${MARK}-编辑` });
});

test('geo 过滤：province / year / category 各自生效，且可叠加', async () => {
  const all = titles((await api('GET', '/geo')).json().data.items.filter((x: any) => x.title.startsWith(MARK)));
  assert.equal(all.length, 4, `种子应为 4 条，实得 ${all.length}`);

  const byProvince = titles((await api('GET', '/geo?province=分类测试省甲')).json().data.items);
  assert.deepEqual(byProvince, [`${MARK}-华山`, `${MARK}-古寺`, `${MARK}-无名地`]);

  const byYear = titles((await api('GET', '/geo?year=2024')).json().data.items);
  assert.deepEqual(byYear, [`${MARK}-华山`, `${MARK}-古寺`]);

  const byCategory = titles((await api('GET', '/geo?category=scenic')).json().data.items);
  assert.deepEqual(byCategory, [`${MARK}-西湖`]);

  const stacked = (await api('GET', '/geo?province=分类测试省甲&year=2024&category=heritage')).json().data.items;
  assert.deepEqual(titles(stacked), [`${MARK}-古寺`]);

  const none = (await api('GET', '/geo?province=分类测试省甲&year=2023')).json().data.items;
  assert.deepEqual(none, [], '无命中要回空数组而不是全量');
});

test('geo 搜索：关键词命中省份与城市（地图页搜索框口径）', async () => {
  const byProvince = titles((await api('GET', `/geo?keyword=${encodeURIComponent('分类测试省乙')}`)).json().data.items);
  assert.deepEqual(byProvince, [`${MARK}-西湖`]);
  const byCity = titles((await api('GET', `/geo?keyword=${encodeURIComponent('分类测试市丙')}`)).json().data.items);
  assert.deepEqual(byCity, [`${MARK}-无名地`]);
  const byTitle = titles((await api('GET', `/geo?keyword=${encodeURIComponent('华山')}`)).json().data.items);
  assert.deepEqual(byTitle, [`${MARK}-华山`]);
});

test('列表搜索：关键词同样命中省份与城市（与 geo 共用一套 $or）', async () => {
  const items = (await api('GET', `?keyword=${encodeURIComponent('分类测试市乙')}`)).json().data.items;
  assert.deepEqual(items.map((x: any) => x.title), [`${MARK}-西湖`]);
});

test('geo 参数校验：year 非 4 位数字 / category 非法 → 400，合法边界通过', () => {
  assert.throws(() => FootprintGeoQuery.parse({ year: '20xx' }));
  assert.throws(() => FootprintGeoQuery.parse({ year: '20241' }));
  assert.throws(() => FootprintGeoQuery.parse({ category: 'temple' }));
  assert.equal(FootprintGeoQuery.parse({}).year, undefined);
  assert.equal(FootprintGeoQuery.parse({ year: '2024' }).year, 2024);
  assert.equal(FootprintGeoQuery.parse({ category: 'scenic' }).category, 'scenic');
  assert.equal(FootprintGeoQuery.parse({ keyword: '  西湖  ' }).keyword, '西湖');
});

test('geo 向后兼容：不带参数仍是全量、只回自己的数据、item 带省市', async () => {
  const geo = json(await api('GET', '/geo'));
  const mine = geo.items.filter((x: any) => x.title.startsWith(MARK));
  assert.equal(mine.length, 4);
  assert.ok(mine.every((x: any) => !!x.province && !!x.city), 'geo item 要下发省市，筛选弹窗本地算选项要用');
  assert.ok(geo.items.every((x: any) => x.title !== '别的用户足迹'));
});
