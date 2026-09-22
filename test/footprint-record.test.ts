import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { FootprintRecordModel } from '../src/models/footprint-record.model.js';
import { CreateFootprintRecordSchema } from '../src/utils/validators.js';
import { cleanUrl } from '../src/services/oss.js';
import { removedPhotos, searchScore } from '../src/services/footprint-record.js';
import { config } from '../src/config/index.js';

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

// ==================== Final fix wave：照片 URL 归属闸门（spec §5 第二道闸）====================

/** 闸门口径要拼自己的 {baseDir}/users/{userId}/ 前缀：从 accessToken 解出 userId */
function userIdFromToken(token: string): string {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString()).userId as string;
}

/** 本 bucket 下某用户的对象 URL；endpoint 未配置时返回 '' —— 用例据此走放行分支 */
function bucketUrl(userId: string, name: string): string {
  const base = config.oss.endpoint.replace(/\/$/, '');
  return base ? `${base}/${config.oss.baseDir}/users/${userId}/${name}` : '';
}

test('照片归属闸门（POST）：他人前缀 bucket URL 400 且不落库；自己前缀正常放行', async () => {
  const myId = userIdFromToken(tokenA);
  const own = bucketUrl(myId, 'ok.jpg');
  if (!own) {
    // endpoint 未配置：无 bucket 可比对，任意 URL 原样放行（保持 156 条存量用例口径）
    const lax = await req('POST', '', tokenA, fp({ title: '足迹测试H-放行', photos: ['https://example.com/x.jpg'] }));
    assert.equal(lax.statusCode, 200, lax.body);
    assert.deepEqual(lax.json().data.record.photos, ['https://example.com/x.jpg']);
    await FootprintRecordModel.deleteMany({ title: '足迹测试H-放行' });
    return;
  }

  // 自己前缀必须放行：否则"直传成功后提交 URL"的正常链路会被误杀
  // POST 不触发 deleteOssObjects，且 signatureUrl 为本地计算 —— 用例不外呼 OSS
  const ok = await req('POST', '', tokenA, fp({ title: '足迹测试H-归属', photos: [own] }));
  assert.equal(ok.statusCode, 200, ok.body);
  const id = ok.json().data.record.id as string;
  assert.deepEqual((await FootprintRecordModel.findById(id).lean())?.photos, [own]);

  // 伪造他人前缀：400，且闸门在写库之前 —— 无任何残留
  const foreign = bucketUrl(new Types.ObjectId().toString(), 'steal.jpg');
  const bad = await req('POST', '', tokenA, fp({ title: '足迹测试H-越权', photos: [foreign] }));
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal(bad.json().message, '照片地址不属于当前用户');
  assert.equal(await FootprintRecordModel.countDocuments({ title: '足迹测试H-越权' }), 0);

  // 库层清理：API DELETE 会对 bucket URL 发起真实 OSS 删除，测试不外呼
  await FootprintRecordModel.deleteMany({ title: /^足迹测试H/ });
});

test('照片归属闸门（PUT）：他人前缀 bucket URL 400 且原照片不被覆盖；自己前缀可写入', async () => {
  const created = await req('POST', '', tokenA, fp({ title: '足迹测试I-闸门', photos: [] }));
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().data.record.id as string;

  // 越权 URL 先试：闸门若写在 findOneAndUpdate 之后，库内照片会被覆盖成 foreign
  const foreign = bucketUrl(new Types.ObjectId().toString(), 'steal.jpg');
  if (foreign) {
    const bad = await req('PUT', `/${id}`, tokenA, fp({ title: '足迹测试I-闸门', photos: [foreign] }));
    assert.equal(bad.statusCode, 400, bad.body);
    assert.equal(bad.json().message, '照片地址不属于当前用户');
    assert.deepEqual((await FootprintRecordModel.findById(id).lean())?.photos, []);
  }

  const own = bucketUrl(userIdFromToken(tokenA), 'edit.jpg');
  const next = own || 'https://example.com/edit.jpg'; // endpoint 未配置时验放行分支
  const upd = await req('PUT', `/${id}`, tokenA, fp({ title: '足迹测试I-闸门', photos: [next] }));
  assert.equal(upd.statusCode, 200, upd.body);
  // 旧列表为空 → 无被移除项 → 不触发 deleteOssObjects
  assert.deepEqual((await FootprintRecordModel.findById(id).lean())?.photos, [next]);
  await FootprintRecordModel.deleteMany({ title: '足迹测试I-闸门' });
});

test('stats：省/市/总数聚合 + from/to 区间（含 from 不含 to）+ 非法入参 400', async () => {
  // 独立用户，避免与 tokenA/B 的历史数据串扰
  const token = await loginAs('fp-user-stats');
  const mk = (visitDate: string, latitude: number, longitude: number, title: string) =>
    req('POST', '', token, fp({ visitDate, title, location: { name: 'x', address: 'y', latitude, longitude } }));
  // 坐标的省市结果沿用既有用例固化的离线区域值：杭州(30.24,120.15)=浙江省/杭州市、北京(39.90,116.40)=北京市/北京市
  assert.equal((await mk('2026-01-10', 30.24, 120.15, '足迹测试-统计-1')).statusCode, 200);
  assert.equal((await mk('2026-02-15', 30.24, 120.15, '足迹测试-统计-2')).statusCode, 200);
  assert.equal((await mk('2026-03-20', 39.9, 116.4, '足迹测试-统计-3')).statusCode, 200);
  assert.equal((await mk('2027-01-05', 30.24, 120.15, '足迹测试-统计-4')).statusCode, 200); // 跨年

  // 全部：4 条、2 省、2 市；分省计数按次数倒序
  let res = await req('GET', '/stats', token);
  assert.equal(res.statusCode, 200, res.body);
  let d = res.json().data;
  assert.equal(d.total, 4);
  assert.equal(d.provinceCount, 2);
  assert.equal(d.cityCount, 2);
  assert.deepEqual(d.provinces, [
    { name: '浙江省', count: 3 },
    { name: '北京市', count: 1 },
  ]);

  // 2026 自然年（to 不含 2027-01-01）：跨年那条被排除
  d = (await req('GET', '/stats?from=2026-01-01&to=2027-01-01', token)).json().data;
  assert.equal(d.total, 3);
  assert.equal(d.provinceCount, 2);
  assert.equal(d.cityCount, 2);

  // 单月窗口：只剩 1 条
  d = (await req('GET', '/stats?from=2026-02-01&to=2026-03-01', token)).json().data;
  assert.equal(d.total, 1);
  assert.deepEqual(d.provinces, [{ name: '浙江省', count: 1 }]);

  // 空窗口：零值形态稳定（前端直接渲染）
  d = (await req('GET', '/stats?from=2020-01-01&to=2020-02-01', token)).json().data;
  assert.equal(d.total, 0);
  assert.equal(d.provinceCount, 0);
  assert.equal(d.cityCount, 0);
  assert.deepEqual(d.provinces, []);

  // 非法日期 / 倒置区间 400；未登录 401
  assert.equal((await req('GET', '/stats?from=2026/01/01', token)).statusCode, 400);
  assert.equal((await req('GET', '/stats?to=2026-1-1', token)).statusCode, 400);
  assert.equal((await req('GET', '/stats?from=2026-04-01&to=2026-01-01', token)).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/sport-track/api/footprint-records/stats' })).statusCode, 401);
});

test('searchScore：标题 3 / 同行的人 2 / 描述、地点名、地址、日期各 1；未命中 0', () => {
  assert.equal(searchScore({ title: '西湖漫步' }, '西湖'), 3);
  assert.equal(searchScore({ people: ['张三', '西湖友'] }, '西湖'), 2, '数组任一元素命中即算');
  assert.equal(searchScore({ description: '西湖春色' }, '西湖'), 1);
  assert.equal(searchScore({ location: { name: '西湖' } }, '西湖'), 1);
  assert.equal(searchScore({ location: { address: '杭州西湖区' } }, '西湖'), 1);
  assert.equal(searchScore({ visitDate: '2024-05-01' }, '2024-05'), 1, '日期串可搜');
  assert.equal(searchScore({ title: 'XIHU' }, 'xihu'), 3, '大小写不敏感');
  assert.equal(searchScore({ title: '别的' }, '西湖'), 0);
  // 多字段叠加：标题 3 + 同行 2 + 描述 1 + 地点名 1 + 地址 1（日期不含关键词）
  assert.equal(
    searchScore(
      { title: '西湖漫步', people: ['西湖友'], description: '西湖春色', location: { name: '西湖', address: '杭州西湖区' }, visitDate: '2024-05-01' },
      '西湖',
    ),
    8,
  );
});

test('列表加权搜索：标题 > 同行的人 > 描述；同分按 visitDate 倒序；分页按相关度切片', async () => {
  const token = await loginAs('fp-user-list-search');
  const mk = (over: Record<string, unknown>) => req('POST', '', token, fp(over));
  // 唯一关键词「权重词」，避免与历史数据串扰；四条分数依次 5 / 3 / 2 / 1，日期故意与分数反向
  assert.equal((await mk({ visitDate: '2024-01-01', title: '足迹测试-权重词-双', people: ['权重词'] })).statusCode, 200);
  assert.equal((await mk({ visitDate: '2024-03-01', title: '足迹测试-权重词-标题' })).statusCode, 200);
  assert.equal((await mk({ visitDate: '2024-03-02', title: '足迹测试-权重人', people: ['权重词'] })).statusCode, 200);
  assert.equal((await mk({ visitDate: '2024-03-03', title: '足迹测试-权重述', description: '关于权重词' })).statusCode, 200);

  const d = (await req('GET', '?keyword=权重词&pageSize=20', token)).json().data;
  assert.equal(d.total, 4, 'total 为匹配总数');
  assert.deepEqual(
    d.items.map((r: any) => r.title),
    ['足迹测试-权重词-双', '足迹测试-权重词-标题', '足迹测试-权重人', '足迹测试-权重述'],
    '标题+同行（5 分）排最前，即使它的 visitDate 最老；同行（2）压过描述（1）',
  );

  // 分页按相关度顺序切片（而非日期）：两页拼起来应与整页顺序一致
  const p1 = (await req('GET', '?keyword=权重词&pageSize=2&page=1', token)).json().data;
  const p2 = (await req('GET', '?keyword=权重词&pageSize=2&page=2', token)).json().data;
  assert.deepEqual(
    [...p1.items, ...p2.items].map((r: any) => r.title),
    ['足迹测试-权重词-双', '足迹测试-权重词-标题', '足迹测试-权重人', '足迹测试-权重述'],
  );

  // 同分（都是标题命中 3 分）按 visitDate 倒序
  assert.equal((await mk({ visitDate: '2024-04-01', title: '足迹测试-平局旧' })).statusCode, 200);
  assert.equal((await mk({ visitDate: '2024-04-10', title: '足迹测试-平局新' })).statusCode, 200);
  assert.deepEqual(
    (await req('GET', '?keyword=平局', token)).json().data.items.map((r: any) => r.title),
    ['足迹测试-平局新', '足迹测试-平局旧'],
  );
});

test('列表时间区间：from 含、to 不含；非法日期/倒置区间 400；可与 keyword 组合', async () => {
  const token = await loginAs('fp-user-list-range');
  const mk = (visitDate: string, title: string) => req('POST', '', token, fp({ visitDate, title }));
  assert.equal((await mk('2024-06-10', '足迹测试-区间A')).statusCode, 200);
  assert.equal((await mk('2024-06-15', '足迹测试-区间B')).statusCode, 200);
  assert.equal((await mk('2024-07-01', '足迹测试-区间C')).statusCode, 200);

  let d = (await req('GET', '?from=2024-06-01&to=2024-07-01', token)).json().data;
  assert.equal(d.total, 2, 'to 当天（07-01）不含');
  assert.deepEqual(d.items.map((r: any) => r.title), ['足迹测试-区间B', '足迹测试-区间A'], '区间内仍按 visitDate 倒序');

  d = (await req('GET', '?from=2024-06-01&to=2024-06-15', token)).json().data;
  assert.equal(d.total, 1, 'to 不含：06-15 那条被排除');

  d = (await req('GET', '?from=2024-06-15', token)).json().data;
  assert.equal(d.total, 2, 'from 含：06-15 那条在内（B + C）');

  d = (await req('GET', '?keyword=区间&from=2024-06-01&to=2024-06-20', token)).json().data;
  assert.equal(d.total, 2, 'keyword 与区间同时生效');

  assert.equal((await req('GET', '?from=2024/06/01', token)).statusCode, 400, '格式错 400');
  assert.equal((await req('GET', '?from=2024-13-01', token)).statusCode, 400, '日历日不存在 400');
  assert.equal((await req('GET', '?from=2024-07-01&to=2024-06-01', token)).statusCode, 400, '倒置区间 400');
  assert.equal((await req('GET', '?from=2024-06-01&to=2024-06-01', token)).statusCode, 400, 'from 等于 to 是空区间');
});

// ==================== 日历形态：GET /footprint-records/calendar ====================

test('calendar：days 按 visitDate 倒序计数；total/photoCount 全局累加；placeCount 按地点名去重且空名不计', async () => {
  const token = await loginAs('fp-user-calendar');
  const mk = (over: Record<string, unknown>) => req('POST', '', token, fp(over));
  const P = (n: number) => Array.from({ length: n }, (_, i) => `https://example.com/cal-${i}.jpg`);
  assert.equal((await mk({ visitDate: '2026-09-20', title: '足迹测试-日历-长陵1', location: { name: '长陵', address: 'a', latitude: 34.4, longitude: 109.0 }, photos: P(2) })).statusCode, 200);
  assert.equal((await mk({ visitDate: '2026-09-20', title: '足迹测试-日历-长陵2', location: { name: '长陵', address: 'a', latitude: 34.4, longitude: 109.0 }, photos: P(1) })).statusCode, 200);
  assert.equal((await mk({ visitDate: '2026-09-19', title: '足迹测试-日历-杜陵', location: { name: '杜陵', address: 'b', latitude: 34.4, longitude: 108.9 } })).statusCode, 200);
  assert.equal((await mk({ visitDate: '2026-08-05', title: '足迹测试-日历-无地名', location: { name: '', address: 'c', latitude: 30.24, longitude: 120.15 }, photos: P(1) })).statusCode, 200);

  const d = (await req('GET', '/calendar', token)).json().data;
  assert.equal(d.total, 4, '总条数');
  assert.equal(d.photoCount, 4, '照片数 = 各条 photos 之和');
  assert.equal(d.placeCount, 2, '长陵跨两条只算一个地方，空地点名不计');
  assert.deepEqual(
    d.days,
    [
      { date: '2026-09-20', count: 2 },
      { date: '2026-09-19', count: 1 },
      { date: '2026-08-05', count: 1 },
    ],
    'days 按日期倒序，前端切月只在本地过滤',
  );

  await FootprintRecordModel.deleteMany({ title: /^足迹测试-日历/ });
});

test('calendar 归属隔离：只含自己的记录（他人同日足迹不进 days/汇总）', async () => {
  const mine = await loginAs('fp-user-cal-own');
  const other = await loginAs('fp-user-cal-other');
  assert.equal((await req('POST', '', mine, fp({ visitDate: '2026-07-07', title: '足迹测试-日历-我', location: { name: '我的地点', address: 'a', latitude: 30.24, longitude: 120.15 }, photos: ['https://example.com/cal-own.jpg'] }))).statusCode, 200);
  // 同一天、同一地点名各塞一条：若 $match 漏了 userId，这些数字会被顶上去
  await req('POST', '', other, fp({ visitDate: '2026-07-07', title: '足迹测试-日历-他人', location: { name: '我的地点', address: 'a', latitude: 30.24, longitude: 120.15 }, photos: ['https://example.com/cal-o1.jpg', 'https://example.com/cal-o2.jpg'] }));
  await req('POST', '', other, fp({ visitDate: '2026-07-06', title: '足迹测试-日历-他人2', location: { name: '他人地点', address: 'b', latitude: 30.24, longitude: 120.15 } }));

  const d = (await req('GET', '/calendar', mine)).json().data;
  assert.deepEqual(d, { total: 1, placeCount: 1, photoCount: 1, days: [{ date: '2026-07-07', count: 1 }] });

  const otherSummary = (await req('GET', '/calendar', other)).json().data;
  assert.equal(otherSummary.total, 2, '他人视角只看到自己那两条');
  assert.equal(otherSummary.photoCount, 2);
  assert.deepEqual(otherSummary.days.map((x: any) => x.count), [1, 1]);

  await FootprintRecordModel.deleteMany({ title: /^足迹测试-日历/ });
});

test('calendar 空态与鉴权：无足迹返回全零 + 空 days；未登录 401', async () => {
  // before 钩子已清掉所有「足迹测试」前缀文档，这个专属用户必然为空态
  const fresh = await loginAs('fp-user-cal-empty');
  const res = await req('GET', '/calendar', fresh);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().data, { total: 0, placeCount: 0, photoCount: 0, days: [] }, '形态稳定，前端可直接渲染');
  assert.equal((await app.inject({ method: 'GET', url: '/sport-track/api/footprint-records/calendar' })).statusCode, 401);
});

// ==================== 非法 id：CastError 不该冒 500 ====================

test('非法 id：非 ObjectId 字符串的 GET/PUT/DELETE 返回 404「足迹不存在」而不是 500', async () => {
  // 这些串在 mongoose 里会在 `_id` 上抛 CastError（错误处理器不认识它 → 500 并泄露内部文案）；
  // 对客户端来说「这个 id 不可能存在」就是 404
  for (const bad of ['not-an-objectid', 'abc', '1', '2024-05-01', 'ffffffffffffffffffffffffx']) {
    const got = await req('GET', `/${bad}`, tokenA);
    assert.equal(got.statusCode, 404, `GET /${bad} 应 404，实际 ${got.statusCode}：${got.body}`);
    assert.equal(got.json().message, '足迹不存在');
    assert.equal((await req('PUT', `/${bad}`, tokenA, fp({ title: '足迹测试-非法id' }))).statusCode, 404, `PUT /${bad} 应 404`);
    assert.equal((await req('DELETE', `/${bad}`, tokenA)).statusCode, 404, `DELETE /${bad} 应 404`);
  }
  // 形态合法但不存在的 id 行为不变（仍 404，且不能被误判成 400）
  const ghost = new Types.ObjectId().toString();
  assert.equal((await req('GET', `/${ghost}`, tokenA)).statusCode, 404);
  assert.equal(await FootprintRecordModel.countDocuments({ title: '足迹测试-非法id' }), 0, '非法 id 的写入不落库');
});
