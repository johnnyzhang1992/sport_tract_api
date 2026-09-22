import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { UserModel } from '../src/models/user.model.js';
import { FootprintRecordModel } from '../src/models/footprint-record.model.js';

/**
 * 数据概况三接口的足迹字段：/overview（总量三口径）、/stats（今日/周/月新增）、/trend（按桶新增）
 *
 * 断言全部走「播种前后差值」而不是绝对值：这几张表统计的是全站数据，dev 库里本就有真实足迹，
 * 写死绝对数等于把测试绑在库内容上。差值口径同时保证了「新增字段确实跟着数据动」。
 * trend 不断言落在哪个桶：分桶用 $dateToString（UTC）而桶标签用本地时间 getters，
 * 本地 00:00–08:00 创建的记录会归到前一天的桶里，逐桶断言会随时钟抖动。
 */
const ADMIN_USER = 'test_admin_fp_metrics';
const ADMIN_PASS = 'admin_pass_123';
const MZ = '足迹概况回归';

let app: FastifyInstance;
let adminToken = '';
let uid = '';

async function get(path: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/sport-track/api/admin/${path}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 200, `${path} → ${res.statusCode}: ${res.body}`);
  return res.json().data;
}

const doc = (over: Record<string, unknown> = {}) => ({
  userId: new Types.ObjectId(uid),
  visitDate: '2026-09-22',
  title: `${MZ}-?`,
  people: [],
  description: '',
  location: { name: '某地', address: '', province: '测试省戊', city: '测试市戊', latitude: 30, longitude: 120 },
  photos: [],
  createdAt: new Date(),
  ...over,
});

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
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/login',
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  adminToken = login.json().data.token;
  assert.ok(adminToken);

  await FootprintRecordModel.deleteMany({ title: new RegExp(`^${MZ}`) });
  await UserModel.deleteMany({ nickname: new RegExp(`^${MZ}`) });
  const u = await UserModel.create({ nickname: `${MZ}用户`, uid: 91003, openid: `fpmetric_${MZ}` });
  uid = String(u._id);
});

after(async () => {
  await FootprintRecordModel.deleteMany({ title: new RegExp(`^${MZ}`) });
  await UserModel.deleteMany({ nickname: new RegExp(`^${MZ}`) });
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

test('overview：footprintCount / footprintUserCount / footprintPhotoCount 随数据走', async () => {
  const before0 = await get('overview');
  assert.equal(typeof before0.footprintCount, 'number', '字段必须存在（不是 undefined）');

  await FootprintRecordModel.insertMany(
    [
      doc({ title: `${MZ}-1`, photos: ['https://example.com/m1.jpg', 'https://example.com/m2.jpg'] }),
      doc({ title: `${MZ}-2`, photos: ['https://example.com/m3.jpg'] }),
    ],
    { timestamps: false },
  );
  const after0 = await get('overview');
  assert.equal(after0.footprintCount - before0.footprintCount, 2, '足迹条数 +2');
  assert.equal(after0.footprintUserCount - before0.footprintUserCount, 1, '有足迹的用户数 +1（两条同一用户）');
  assert.equal(after0.footprintPhotoCount - before0.footprintPhotoCount, 3, '照片总数 2+1');

  // 第二个用户哪怕只有 0 张图也要被算进 footprintUserCount
  const u2 = await UserModel.create({ nickname: `${MZ}无图用户`, uid: 91005, openid: `fpmetric3_${MZ}` });
  await FootprintRecordModel.insertMany(
    [doc({ userId: new Types.ObjectId(String(u2._id)), title: `${MZ}-3`, photos: [] })],
    { timestamps: false },
  );
  const after1 = await get('overview');
  assert.equal(after1.footprintCount - after0.footprintCount, 1);
  assert.equal(after1.footprintUserCount - after0.footprintUserCount, 1, '新用户即便无图也算一个用户');
  assert.equal(after1.footprintPhotoCount - after0.footprintPhotoCount, 0, '无图不抬高照片数');
  await FootprintRecordModel.deleteMany({ userId: u2._id });
  await UserModel.deleteOne({ _id: u2._id });
});

test('overview：同一用户重复出现只算一次用户数', async () => {
  const before0 = await get('overview');
  const u = await UserModel.create({ nickname: `${MZ}多用户`, uid: 91004, openid: `fpmetric2_${MZ}` });
  await FootprintRecordModel.insertMany(
    [
      doc({ userId: new Types.ObjectId(String(u._id)), title: `${MZ}-4` }),
      doc({ userId: new Types.ObjectId(String(u._id)), title: `${MZ}-5` }),
      doc({ userId: new Types.ObjectId(String(u._id)), title: `${MZ}-6` }),
    ],
    { timestamps: false },
  );
  const after0 = await get('overview');
  assert.equal(after0.footprintCount - before0.footprintCount, 3);
  assert.equal(after0.footprintUserCount - before0.footprintUserCount, 1, '3 条同一用户 → 用户数只 +1');
  await FootprintRecordModel.deleteMany({ userId: u._id });
  await UserModel.deleteOne({ _id: u._id });
});

test('stats：today/week/month 每档带 newFootprints，且只算 createdAt 落在窗口内的', async () => {
  const before0 = await get('stats');
  const now = new Date();
  await FootprintRecordModel.insertMany(
    [
      doc({ title: `${MZ}-7`, createdAt: now }),
      doc({ title: `${MZ}-8`, createdAt: new Date(now.getTime() - 3 * 86400000) }), // 3 天前：本周内、今日外
      doc({ title: `${MZ}-9`, createdAt: new Date(now.getTime() - 20 * 86400000) }), // 20 天前：本月内、本周外
    ],
    { timestamps: false },
  );
  const after0 = await get('stats');
  for (const k of ['today', 'week', 'month']) {
    assert.equal(typeof before0[k].newFootprints, 'number', `${k}.newFootprints 必须存在`);
  }
  assert.equal(after0.today.newFootprints - before0.today.newFootprints, 1, '今日 1 条');
  assert.equal(after0.week.newFootprints - before0.week.newFootprints, 2, '近 7 天 2 条');
  assert.equal(after0.month.newFootprints - before0.month.newFootprints, 3, '近 30 天 3 条');
});

test('trend：四个维度的每个桶都带 newFootprints，桶值与窗口口径对得上', async () => {
  const sum = (rows: any[]) => rows.reduce((acc, r) => acc + (r.newFootprints ?? 0), 0);
  const beforeDay = await get('trend?type=day');
  assert.ok(beforeDay.data.length === 30, 'day 维度 30 个桶');
  const beforeYear = await get('trend?type=year');
  const before2024H1 = beforeYear.data.find((r: any) => r.date === '2024-H1')?.newFootprints ?? 0;

  await FootprintRecordModel.insertMany(
    [
      doc({ title: `${MZ}-10`, createdAt: new Date() }),
      doc({ title: `${MZ}-11`, createdAt: new Date() }),
      doc({ title: `${MZ}-12`, createdAt: new Date('2024-03-01T00:00:00Z') }), // 落在近 30 天之外、近 6 年之内
    ],
    { timestamps: false },
  );

  for (const type of ['day', 'week', 'month', 'year']) {
    const d = await get(`trend?type=${type}`);
    assert.equal(d.type, type);
    assert.ok(d.data.length > 0);
    assert.ok(
      d.data.every((r: any) => typeof r.newFootprints === 'number'),
      `${type}：每个桶都要有 newFootprints（前端直接取值，缺字段会画出 undefined）`,
    );
  }

  const day = await get('trend?type=day');
  assert.equal(sum(day.data) - sum(beforeDay.data), 2, 'day 维度只多今日这 2 条（2024-03 那条超出近 30 天桶）');

  const year = await get('trend?type=year');
  const now2024H1 = year.data.find((r: any) => r.date === '2024-H1')?.newFootprints ?? -1;
  assert.equal(now2024H1 - before2024H1, 1, 'year 维度按半年分桶：2024-03 归 2024-H1，且只进这一个桶');
});

// ==================== /admin/footprint-stats（足迹数据概况，五档一次给全）====================

type Cell = {
  total: number;
  userCount: number;
  provinceCount: number;
  cityCount: number;
  photoCount: number;
  withPhotoCount: number;
};
const KEYS = ['today', 'week', 'month', 'year', 'all'] as const;
const diff = (a: Record<string, Cell>, b: Record<string, Cell>) => {
  const out: Record<string, Partial<Cell>> = {};
  for (const k of KEYS) {
    out[k] = Object.fromEntries(
      (Object.keys(b[k]) as (keyof Cell)[]).map((f) => [f, b[k][f] - a[k][f]]),
    ) as Partial<Cell>;
  }
  return out;
};

test('footprint-stats：五档齐全，时间窗口按 createdAt 各自生效', async () => {
  const before0 = (await get('footprint-stats')) as Record<string, Cell>;
  for (const k of KEYS) {
    assert.equal(typeof before0[k]?.total, 'number', `${k} 档必须存在且是数字`);
  }

  const now = Date.now();
  await FootprintRecordModel.insertMany(
    [
      doc({ title: `${MZ}-s1`, createdAt: new Date(now) }), // 今日
      doc({ title: `${MZ}-s2`, createdAt: new Date(now - 40 * 86400000) }), // 近30天之外、近一年之内
      doc({ title: `${MZ}-s3`, createdAt: new Date(now - 400 * 86400000) }), // 近一年之外，只进累计
    ],
    { timestamps: false },
  );
  const d = diff(before0, (await get('footprint-stats')) as Record<string, Cell>);
  assert.equal(d.today?.total, 1, '今日 1 条');
  assert.equal(d.week?.total, 1, '近7天 1 条');
  assert.equal(d.month?.total, 1, '近30天 1 条（40 天前那条不算）');
  assert.equal(d.year?.total, 2, '近一年 2 条');
  assert.equal(d.all?.total, 3, '累计 3 条');
});

test('footprint-stats：省市去重且空省市不计，用户数按人去重', async () => {
  const before0 = (await get('footprint-stats')) as Record<string, Cell>;
  const u = await UserModel.create({ nickname: `${MZ}概况用户`, uid: 91006, openid: `fpmetric4_${MZ}` });
  const uid2 = String(u._id);
  const loc = (province: string, city: string) => ({
    name: '某地',
    address: '',
    province,
    city,
    latitude: 1,
    longitude: 2,
  });
  await FootprintRecordModel.insertMany(
    [
      doc({ userId: new Types.ObjectId(uid2), title: `${MZ}-p1`, location: loc('测试省己', '测试市己'), photos: ['https://example.com/p1a.jpg', 'https://example.com/p1b.jpg'] }),
      doc({ userId: new Types.ObjectId(uid2), title: `${MZ}-p2`, location: loc('测试省庚', '测试市庚'), photos: [] }),
      // 同城不同省（脏数据/同名市）：城市按「省|市」组合去重，不能把两个 测试市己 合成一个
      doc({ userId: new Types.ObjectId(uid2), title: `${MZ}-p3`, location: loc('测试省辛', '测试市己'), photos: ['https://example.com/p3.jpg'] }),
      // 省市全空：只进 total，不进省市计数
      doc({ userId: new Types.ObjectId(uid2), title: `${MZ}-p4`, location: loc('', ''), photos: [] }),
    ],
    { timestamps: false },
  );
  const d = diff(before0, (await get('footprint-stats')) as Record<string, Cell>);
  assert.equal(d.all?.total, 4);
  assert.equal(d.all?.userCount, 1, '4 条同一新用户 → 用户数 +1');
  assert.equal(d.all?.provinceCount, 3, '空省不计，其余三个省各算一个');
  assert.equal(d.all?.cityCount, 3, '省|市 组合去重：测试省辛|测试市己 与 测试省己|测试市己 是两个');
  assert.equal(d.all?.photoCount, 3, '照片数 2+0+1+0');
  assert.equal(d.all?.withPhotoCount, 2, '有照片的按「条」计，多图不重复计');
  await FootprintRecordModel.deleteMany({ userId: u._id });
  await UserModel.deleteOne({ _id: u._id });
});

test('footprint-stats：未登录 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/sport-track/api/admin/footprint-stats' });
  assert.equal(res.statusCode, 401);
});

// ==================== /admin/footprint-geo-stats（足迹省份分布）====================

const locOf = (province: string, city: string) => ({
  name: '某地',
  address: '',
  province,
  city,
  latitude: 1,
  longitude: 2,
});

test('footprint-geo-stats：省→市层级与计数正确，空省市不入图', async () => {
  const before0 = await get('footprint-geo-stats?range=all');
  const u = await UserModel.create({ nickname: `${MZ}分布用户`, uid: 91007, openid: `fpmetric5_${MZ}` });
  const uid2 = String(u._id);
  await FootprintRecordModel.insertMany(
    [
      doc({ userId: new Types.ObjectId(uid2), title: `${MZ}-g1`, location: locOf('测试省壬', '测试市壬') }),
      doc({ userId: new Types.ObjectId(uid2), title: `${MZ}-g2`, location: locOf('测试省壬', '测试市壬') }),
      doc({ userId: new Types.ObjectId(uid2), title: `${MZ}-g3`, location: locOf('测试省壬', '测试市癸') }),
      // 省市全空：只进概况总数，地图上没有它的位置
      doc({ userId: new Types.ObjectId(uid2), title: `${MZ}-g4`, location: locOf('', '') }),
    ],
    { timestamps: false },
  );
  const after0 = await get('footprint-geo-stats?range=all');
  assert.equal(after0.range, 'all');
  assert.equal(after0.total - before0.total, 3, '空省市那条不入图 → 分布总数只 +3');

  const prov = after0.provinces.find((p: any) => p.province === '测试省壬');
  assert.ok(prov, '测试省壬 应出现在省份列表');
  assert.equal(prov.count, 3, '省级计数 = 其城市计数之和');
  assert.deepEqual(
    prov.cities,
    [{ city: '测试市壬', count: 2 }, { city: '测试市癸', count: 1 }],
    '城市按计数倒序，同名市不合并不同省',
  );
  // 省份整体按计数倒序（前端地图按省上色用得到）
  const counts = after0.provinces.map((p: any) => p.count);
  assert.deepEqual([...counts].sort((a: number, b: number) => b - a), counts, '省份按 count 倒序');

  await FootprintRecordModel.deleteMany({ userId: u._id });
  await UserModel.deleteOne({ _id: u._id });
});

test('footprint-geo-stats：range 按 createdAt 收窗口，非法档回落累计', async () => {
  const beforeToday = await get('footprint-geo-stats?range=today');
  const beforeAll = await get('footprint-geo-stats?range=all');
  const now = Date.now();
  const u = await UserModel.create({ nickname: `${MZ}窗口用户`, uid: 91008, openid: `fpmetric6_${MZ}` });
  const uid2 = String(u._id);
  await FootprintRecordModel.insertMany(
    [
      doc({ userId: new Types.ObjectId(uid2), title: `${MZ}-w1`, location: locOf('测试省癸', '测试市子'), createdAt: new Date(now) }),
      doc({ userId: new Types.ObjectId(uid2), title: `${MZ}-w2`, location: locOf('测试省癸', '测试市丑'), createdAt: new Date(now - 400 * 86400000) }),
    ],
    { timestamps: false },
  );
  const find = (d: any) => d.provinces.find((p: any) => p.province === '测试省癸')?.count ?? 0;
  const today = await get('footprint-geo-stats?range=today');
  const all = await get('footprint-geo-stats?range=all');
  assert.equal(find(today), 1, '今日档只含今天落库的那条');
  assert.equal(find(all), 2, '累计档两条都在');
  assert.equal(today.total - beforeToday.total, 1, 'total 也跟着窗口走');
  assert.equal(all.total - beforeAll.total, 2);

  const junk = await get('footprint-geo-stats?range=not-a-range');
  assert.equal(junk.total, all.total, '非法档位回落成累计，而不是报错或空集');
  assert.equal(junk.range, 'not-a-range', '原样回显请求的档位');

  await FootprintRecordModel.deleteMany({ userId: u._id });
  await UserModel.deleteOne({ _id: u._id });
});

// ==================== /admin/footprint-trend（足迹趋势）====================

test('footprint-trend：按天补零、窗口只收 days 天内、照片数同桶累加', async () => {
  const before0 = await get('footprint-trend?days=30');
  assert.equal(before0.days, 30);
  assert.equal(before0.data.length, 30, '缺数据的桶要补 0，长度恒等于 days');
  const bjToday = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  assert.equal(before0.data[29].date, bjToday, '最后一个桶是东八区今日');
  const sum = (d: any, f: string) => d.data.reduce((a: number, r: any) => a + r[f], 0);

  await FootprintRecordModel.insertMany(
    [
      doc({
        title: `${MZ}-t1`,
        createdAt: new Date(),
        photos: ['https://example.com/t1a.jpg', 'https://example.com/t1b.jpg'],
      }),
      doc({ title: `${MZ}-t2`, createdAt: new Date(Date.now() - 40 * 86400000) }), // 窗口外
    ],
    { timestamps: false },
  );
  const after0 = await get('footprint-trend?days=30');
  assert.equal(sum(after0, 'count') - sum(before0, 'count'), 1, '40 天前那条不进近 30 天的桶');
  assert.equal(sum(after0, 'photos') - sum(before0, 'photos'), 2, '同桶照片数累加');
  const todayRow = after0.data.find((r: any) => r.date === bjToday);
  assert.ok(todayRow.count >= 1 && todayRow.photos >= 2, '今日桶拿得到新种的两条指标');

  await FootprintRecordModel.deleteMany({ title: new RegExp(`^${MZ}-t`) });
});

test('footprint-trend：days 夹在 7~365，非法值回落 30', async () => {
  for (const [q, want] of [['days=5', 7], ['days=9999', 365], ['days=abc', 30], ['', 30]] as const) {
    const d = await get(`footprint-trend?${q}`);
    assert.equal(d.days, want, `${q || '缺省'} → days=${want}`);
    assert.equal(d.data.length, want, `${q || '缺省'} → 补齐 ${want} 个桶`);
  }
});

test('footprint-geo-stats / footprint-trend：未登录 401', async () => {
  for (const path of ['footprint-geo-stats', 'footprint-trend']) {
    const res = await app.inject({ method: 'GET', url: `/sport-track/api/admin/${path}` });
    assert.equal(res.statusCode, 401, `${path} 未登录应 401`);
  }
});

test('footprint-stats?userId= 只算该用户（用户详情页个人概况），不带则是全站', async () => {
  const u1 = await UserModel.create({ nickname: `${MZ}个人甲`, uid: 91009, openid: `fpmetric7_${MZ}` });
  const u2 = await UserModel.create({ nickname: `${MZ}个人乙`, uid: 91010, openid: `fpmetric8_${MZ}` });
  await FootprintRecordModel.insertMany(
    [
      doc({ userId: new Types.ObjectId(String(u1._id)), title: `${MZ}-u1`, location: locOf('测试省壬', '测试市壬'), photos: ['https://example.com/u1a.jpg', 'https://example.com/u1b.jpg'] }),
      doc({ userId: new Types.ObjectId(String(u1._id)), title: `${MZ}-u2`, location: locOf('测试省癸', '测试市癸'), photos: [] }),
      doc({ userId: new Types.ObjectId(String(u2._id)), title: `${MZ}-u3`, location: locOf('测试省壬', '测试市子'), photos: ['https://example.com/u3.jpg'] }),
    ],
    { timestamps: false },
  );

  const p1 = (await get(`footprint-stats?userId=${u1._id}`)) as Record<string, Cell>;
  assert.equal(p1.all.total, 2, '甲只算自己的 2 条');
  assert.equal(p1.all.userCount, 1, '个人档用户数恒为 1');
  assert.equal(p1.all.provinceCount, 2);
  assert.equal(p1.all.cityCount, 2);
  assert.equal(p1.all.photoCount, 2);
  assert.equal(p1.all.withPhotoCount, 1, '只有 u1 那条带图');
  assert.equal(p1.today.total, 2, 'userId 与时间档叠加生效（三条都是刚落的库）');

  const p2 = (await get(`footprint-stats?userId=${u2._id}`)) as Record<string, Cell>;
  assert.equal(p2.all.total, 1);
  assert.equal(p2.all.provinceCount, 1, '乙只有测试省壬');

  const site = (await get('footprint-stats')) as Record<string, Cell>;
  assert.ok(site.all.total >= p1.all.total + p2.all.total, '不带 userId 仍是全站口径');
  assert.ok(site.all.total - p1.all.total - p2.all.total > 0, '全站里还有别人的数据，个人档不能污染它');

  const ghost = await get(`footprint-stats?userId=${'f'.repeat(24)}`);
  assert.equal((ghost as Record<string, Cell>).all.total, 0, '查无此人 → 全 0 而不是报错');

  const bad = await app.inject({
    method: 'GET',
    url: '/sport-track/api/admin/footprint-stats?userId=abc',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(bad.statusCode, 404, bad.body);
  assert.equal(bad.json().message, '用户不存在', '非法形态走用户闸门，不漏 CastError');

  await FootprintRecordModel.deleteMany({ userId: { $in: [u1._id, u2._id] } });
  await UserModel.deleteMany({ _id: { $in: [u1._id, u2._id] } });
});
