import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { FootprintRecordModel } from '../src/models/footprint-record.model.js';
import { CreateFootprintRecordSchema } from '../src/utils/validators.js';
import { cleanUrl } from '../src/services/oss.js';
import { removedPhotos } from '../src/services/footprint-record.js';

// 模型用例要真实落库，沿用仓库惯例用 buildApp 建 Mongo 连接（Task 2 的接口用例复用同一 app）
let app: FastifyInstance;
let tokenA = '';
let tokenB = '';

async function loginAs(code: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/sport-track/api/auth/login', payload: { code } });
  assert.equal(res.statusCode, 200, res.body);
  // mock 登录同一 code 幂等返回同一用户
  return res.json().data.accessToken as string;
}
function req(method: string, url: string, token: string, payload?: Record<string, unknown>) {
  return app.inject({
    method: method as 'GET',
    url: `/sport-track/api/footprint-records${url}`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}
const fp = (over: Record<string, unknown> = {}) => ({
  visitDate: '2024-05-01', title: '足迹测试A',
  location: { name: '西湖', address: '杭州市西湖区', latitude: 30.24, longitude: 120.15 },
  ...over,
});

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  tokenA = await loginAs('fp-user-a');
  tokenB = await loginAs('fp-user-b');
  await FootprintRecordModel.deleteMany({ title: /^足迹测试/ });
});

after(async () => {
  await FootprintRecordModel.deleteMany({ title: /^足迹测试/ });
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

const baseDoc = {
  userId: new Types.ObjectId(),
  visitDate: '2024-05-01',
  title: '足迹测试-模型',
  location: { latitude: 30.24, longitude: 120.15 },
};

// 模型层只验必填与默认值；日期格式在 zod 层校验（模型存任意日期字符串合法）
test('模型：合法文档可保存，默认值生效，必填缺失被拒绝', async () => {
  const doc = await FootprintRecordModel.create(baseDoc);
  assert.equal(doc.title, '足迹测试-模型');
  assert.deepEqual(doc.photos, []);
  assert.deepEqual(doc.people, []);
  assert.equal(doc.description, '');
  assert.equal(doc.location.province, ''); // 省市由服务层补，模型默认空串
  await assert.rejects(FootprintRecordModel.create({ ...baseDoc, title: undefined }));
  await assert.rejects(FootprintRecordModel.create({ ...baseDoc, location: { latitude: 1 } })); // 缺 longitude
  await FootprintRecordModel.deleteOne({ _id: doc._id });
});

test('zod：visitDate 必须 YYYY-MM-DD；people≤10 每项≤20 字；photos≤3；标题 1-50', () => {
  const ok = CreateFootprintRecordSchema.parse({
    visitDate: '2024-05-01', title: 'a'.repeat(50),
    people: ['张三', '李四'], description: 'x',
    location: { name: '西湖', address: '杭州市西湖区', latitude: 30.24, longitude: 120.15 },
    photos: [],
  });
  assert.equal(ok.people.length, 2);
  assert.equal(ok.visitDate, '2024-05-01'); // 合法日历日通过
  assert.equal(CreateFootprintRecordSchema.parse({ ...ok, visitDate: '2024-02-29' }).visitDate, '2024-02-29'); // 闰日合法
  assert.throws(() => CreateFootprintRecordSchema.parse({ ...ok, visitDate: '2024-5-1' }));
  assert.throws(() => CreateFootprintRecordSchema.parse({ ...ok, visitDate: '2024-13-45' })); // 格式对但日历不存在
  assert.throws(() => CreateFootprintRecordSchema.parse({ ...ok, visitDate: '2023-02-29' })); // 非闰年 2 月 29
  assert.throws(() => CreateFootprintRecordSchema.parse({ ...ok, title: '' }));
  assert.throws(() => CreateFootprintRecordSchema.parse({ ...ok, title: 'a'.repeat(51) }));
  assert.throws(() => CreateFootprintRecordSchema.parse({ ...ok, people: Array(11).fill('甲') }));
  assert.throws(() => CreateFootprintRecordSchema.parse({ ...ok, people: ['a'.repeat(21)] }));
  assert.throws(() => CreateFootprintRecordSchema.parse({ ...ok, photos: ['u?1', 'u?2', 'u?3', 'u?4'].map((s) => `https://e.com/${s}.jpg`) }));
  assert.throws(() => CreateFootprintRecordSchema.parse({ ...ok, description: 'x'.repeat(501) }));
  assert.throws(() => CreateFootprintRecordSchema.parse({ ...ok, location: { ...ok.location, latitude: 91 } }));
});

// ==================== Task 2：/footprint-records 接口集成测试 ====================

test('CRUD：创建→列表→详情→更新→删除', async () => {
  const created = await req('POST', '', tokenA, fp({ people: ['张三'], description: '春天', photos: ['https://example.com/a.jpg'] }));
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().data.record.id as string;
  assert.equal(created.json().data.record.photos[0], 'https://example.com/a.jpg'); // OSS 未配置时 getSignedUrl 原样返回

  const list = await req('GET', '?page=1&pageSize=20', tokenA);
  assert.ok(list.json().data.items.some((r: any) => r.id === id));

  const kw = await req('GET', '?keyword=西湖', tokenA);
  assert.equal(kw.json().data.items.length, 1);
  const kwMiss = await req('GET', '?keyword=不存在词xyz', tokenA);
  assert.equal(kwMiss.json().data.items.length, 0);

  const upd = await req('PUT', `/${id}`, tokenA, fp({ title: '足迹测试A-更新', people: [] }));
  assert.equal(upd.statusCode, 200, upd.body);
  assert.equal(upd.json().data.record.title, '足迹测试A-更新');

  const del = await req('DELETE', `/${id}`, tokenA);
  assert.equal(del.statusCode, 200);
  const gone = await req('GET', `/${id}`, tokenA);
  assert.equal(gone.statusCode, 404);
});

test('归属隔离：B 不可读写 A 的记录（404）；未登录 401', async () => {
  const id = (await req('POST', '', tokenA, fp({ title: '足迹测试B' }))).json().data.record.id as string;
  assert.equal((await req('GET', `/${id}`, tokenB)).statusCode === 200, false);
  assert.equal((await req('GET', `/${id}`, tokenB)).json().code, 404);
  assert.equal((await req('PUT', `/${id}`, tokenB, fp())).json().code, 404);
  assert.equal((await req('DELETE', `/${id}`, tokenB)).json().code, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/sport-track/api/footprint-records' })).statusCode, 401);
  await req('DELETE', `/${id}`, tokenA);
});

test('校验与排序：坏日期 400；列表按 visitDate 倒序同日按创建倒序', async () => {
  const bad = await req('POST', '', tokenA, fp({ visitDate: '2024-5-1', title: '足迹测试C' }));
  assert.equal(bad.statusCode, 400);
  await req('POST', '', tokenA, fp({ visitDate: '2023-01-01', title: '足迹测试C-旧' }));
  const r1 = (await req('POST', '', tokenA, fp({ visitDate: '2024-06-01', title: '足迹测试C-新1' }))).json().data.record.id;
  const r2 = (await req('POST', '', tokenA, fp({ visitDate: '2024-06-01', title: '足迹测试C-新2' }))).json().data.record.id;
  const items = (await req('GET', '?keyword=足迹测试C', tokenA)).json().data.items;
  assert.equal(items[0].id, r2); // 同日：后创建的在前
  assert.equal(items[1].id, r1);
  assert.equal(items[2].visitDate, '2023-01-01'); // 跨日：visitDate 倒序
  await FootprintRecordModel.deleteMany({ title: /^足迹测试C/ });
});

test('geo 端点：轻量字段 + coverPhoto，不分页', async () => {
  await req('POST', '', tokenA, fp({ title: '足迹测试D', photos: ['https://example.com/d.jpg'] }));
  const items = (await req('GET', '/geo', tokenA)).json().data.items;
  const d = items.find((r: any) => r.title === '足迹测试D');
  assert.ok(d);
  assert.equal(d.coverPhoto, 'https://example.com/d.jpg');
  assert.equal('description' in d, false);
  await FootprintRecordModel.deleteMany({ title: '足迹测试D' });
});

test('防刷：1 小时第 31 条创建返回 429', async () => {
  // 专属用户，避免污染其他用例计数
  const tokenC = await loginAs('fp-user-rate');
  await FootprintRecordModel.deleteMany({ title: /^足迹测试E/ }); // 重跑残留清零
  for (let i = 0; i < 30; i++) {
    const ok = await req('POST', '', tokenC, fp({ title: `足迹测试E${i}` }));
    assert.equal(ok.statusCode, 200, `第 ${i + 1} 条应成功: ${ok.body}`);
  }
  const blocked = await req('POST', '', tokenC, fp({ title: '足迹测试E30' }));
  assert.equal(blocked.statusCode, 429);
  assert.ok(blocked.json().message.includes('30'));
  await FootprintRecordModel.deleteMany({ title: /^足迹测试E/ });
});

// ==================== Fix round 1：两条硬约束补测（省市离线补全 / PUT 差集清理）====================

test('省市离线补全：buildLocation 用 locateRegion 写 province/city，POST 与 PUT 响应均可见', async () => {
  const created = await req('POST', '', tokenA, fp({
    title: '足迹测试F-省市补全',
    // 入参不含 province/city：由服务层按坐标离线补全（不依赖逆地理编码）
    location: { name: '苏堤', address: '杭州市西湖区', latitude: 30.24, longitude: 120.15 },
  }));
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().data.record.id as string;
  const loc = created.json().data.record.location;
  // 杭州坐标 (30.24, 120.15) 离线落在杭州市多边形内
  // 期望值为先跑打印确认后固化的字面断言（非"非空即可"弱断言）
  assert.equal(loc.province, '浙江省');
  assert.equal(loc.city, '杭州市');
  assert.equal(loc.name, '苏堤'); // 补全不覆盖入参字段
  assert.equal(loc.latitude, 30.24);
  assert.equal(loc.longitude, 120.15);

  // 编辑同样走 buildLocation：换坐标即换省市
  const upd = await req('PUT', `/${id}`, tokenA, fp({
    title: '足迹测试F-省市补全',
    location: { name: '苏堤', address: '杭州市西湖区', latitude: 39.90, longitude: 116.40 },
  }));
  assert.equal(upd.statusCode, 200, upd.body);
  assert.equal(upd.json().data.record.location.province, '北京市');
  assert.equal(upd.json().data.record.location.city, '北京市');

  // 落库复核（DTO 只是映射，真实值在文档上）
  const stored = await FootprintRecordModel.findById(id).lean();
  assert.equal(stored?.location.province, '北京市');
  assert.equal(stored?.location.city, '北京市');

  await req('DELETE', `/${id}`, tokenA);
  await FootprintRecordModel.deleteMany({ title: '足迹测试F-省市补全' });
});

test('removedPhotos 差集纯函数：编辑时被移除的旧图 = 旧列表 − 新列表', () => {
  const a = 'https://bucket.oss.example.com/sport-track/users/u1/a.jpg';
  const b = 'https://bucket.oss.example.com/sport-track/users/u1/b.jpg';
  assert.deepEqual(removedPhotos([a, b], [a]), [b]); // 移除 b
  assert.deepEqual(removedPhotos([a, b], [a, b]), []); // 全保留：不误删
  assert.deepEqual(removedPhotos([a, b], []), [a, b]); // 全移除
  assert.deepEqual(removedPhotos([], [a]), []); // 新增图不在清理范围
  // 签名回传的 URL 先 cleanUrl 归一才能对上（前端把详情里的签名 URL 原样回传的场景）
  assert.deepEqual(removedPhotos([a], [`${a}?Expires=1&Signature=x`].map(cleanUrl)), []);
});

test('PUT 差集清理：回传只保留一张图后，被移除的图不再出现在详情里（行为层复核）', async () => {
  const a = 'https://example.com/sport-track/users/fp-a/a.jpg';
  const b = 'https://example.com/sport-track/users/fp-a/b.jpg';
  const created = await req('POST', '', tokenA, fp({ title: '足迹测试G-图片差集', photos: [a, b] }));
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().data.record.id as string;
  assert.deepEqual(created.json().data.record.photos, [a, b]); // 测试环境 OSS 未配置：getSignedUrl 原样返回

  // 只回传 a：b 属于被移除项，走 deleteOssObjects（失败不阻塞），响应与库内均只剩 a
  const upd = await req('PUT', `/${id}`, tokenA, fp({ title: '足迹测试G-图片差集', photos: [a] }));
  assert.equal(upd.statusCode, 200, upd.body);
  assert.deepEqual(upd.json().data.record.photos, [a]);

  const got = await req('GET', `/${id}`, tokenA);
  assert.equal(got.statusCode, 200, got.body);
  const photos = got.json().data.photos as string[];
  assert.equal(photos.length, 1);
  assert.deepEqual(photos, [a]);

  await req('DELETE', `/${id}`, tokenA);
  await FootprintRecordModel.deleteMany({ title: '足迹测试G-图片差集' });
});
