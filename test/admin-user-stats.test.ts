import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { UserModel } from '../src/models/user.model.js';
import { LoginLogModel } from '../src/models/login-log.model.js';

/**
 * admin 用户统计接口测试：
 * - /admin/user-stats：用户总量 + 今日/近 7 天 登录 UV/PV（东八区口径）
 * - /admin/user-trend：注册用户量 + 登录 UV/PV 分桶（week/month/year）
 * - /admin/user-geo-stats：按登录 IP 归属地聚合省/市去重用户数
 */

const ADMIN_USER = 't-admin-user-stats';
const ADMIN_PASS = 'test-admin-pass-123';

let app: FastifyInstance;
let adminToken = '';
let userA = '';
let userB = '';

const DAY = 86400000;

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

  // 两个测试用户（mock 登录）；先清残留避免累计
  const createUser = async (code: string) => {
    const pre = await app.inject({
      method: 'POST',
      url: '/sport-track/api/auth/login',
      payload: { code },
    });
    const preId = pre.json().data.user?.id;
    if (preId) {
      await LoginLogModel.deleteMany({ userId: preId });
      await UserModel.deleteMany({ _id: preId });
    }
    const res = await app.inject({
      method: 'POST',
      url: '/sport-track/api/auth/login',
      payload: { code },
    });
    return res.json().data.user.id as string;
  };
  userA = await createUser('mock_user_stats_a');
  userB = await createUser('mock_user_stats_b');
  assert.ok(userA && userB);
});

after(async () => {
  await LoginLogModel.deleteMany({ userId: { $in: [userA, userB].filter(Boolean) } }).catch(() => {});
  await UserModel.deleteMany({ _id: { $in: [userA, userB].filter(Boolean) } }).catch(() => {});
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

async function adminReq(method: string, url: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${adminToken}` } });
}

/** 造登录日志：userId 在 daysAgo 天前（可指定省/市）登录 times 次 */
async function seedLogins(
  userId: string,
  daysAgo: number,
  times: number,
  province = '广东省',
  city = '深圳市',
) {
  const base = Date.now() - daysAgo * DAY;
  const docs = Array.from({ length: times }, (_, i) => ({
    userId,
    province,
    city,
    createdAt: new Date(base + i * 60_000),
  }));
  await LoginLogModel.insertMany(docs);
}

test('user-stats：用户总量 + 今日/近 7 天 UV、PV', async () => {
  // 清理两个测试用户历史日志，构造确定数据
  await LoginLogModel.deleteMany({ userId: { $in: [userA, userB] } });
  // A 今日登录 2 次
  await seedLogins(userA, 0, 2);
  // B 3 天前登录 1 次（计入近 7 天，不计今日）
  await seedLogins(userB, 3, 1, '北京市', '北京市');

  const res = await adminReq('GET', '/sport-track/api/admin/user-stats');
  assert.equal(res.statusCode, 200);
  const d = res.json().data;
  assert.ok(d.totalUsers >= 2, `用户总量应至少 2，实际 ${d.totalUsers}`);
  assert.ok(d.today.uv >= 1, '今日 UV 应至少 1');
  assert.ok(d.today.pv >= 2, '今日 PV 应至少 2');
  assert.ok(d.week.uv >= 2, '近 7 天 UV 应至少 2（A、B）');
  assert.ok(d.week.pv >= 3, '近 7 天 PV 应至少 3');
  assert.ok(d.today.uv <= d.week.uv, '今日 UV 不应大于近 7 天 UV');
  // 注册口径：今日 ≤ 近 7 日 ≤ 近 30 日
  assert.equal(typeof d.month.newUsers, 'number');
  assert.ok(d.today.newUsers <= d.week.newUsers, '今日注册不应大于近 7 日注册');
  assert.ok(d.week.newUsers <= d.month.newUsers, '近 7 日注册不应大于近 30 日注册');
});

test('user-trend：week 分桶 7 天、末位为今日（东八区）', async () => {
  const res = await adminReq('GET', '/sport-track/api/admin/user-trend?range=week');
  assert.equal(res.statusCode, 200);
  const d = res.json().data;
  assert.equal(d.range, 'week');
  assert.equal(d.data.length, 7, '近一周应有 7 个桶');
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  assert.equal(d.data[d.data.length - 1].date, today, '末位应为今天');
  const last = d.data[d.data.length - 1];
  assert.ok(last.pv >= 2, '今日 PV 应至少 2');
  assert.ok(last.uv >= 1, '今日 UV 应至少 1');
  assert.ok(d.data.every((p: { newUsers: number; uv: number; pv: number }) =>
    typeof p.newUsers === 'number' && typeof p.uv === 'number' && typeof p.pv === 'number'));
  // 3 天前的桶应含 B 的一次登录
  const threeAgo = new Date(Date.now() + 8 * 3600000 - 3 * DAY).toISOString().slice(0, 10);
  const bucket = d.data.find((p: { date: string }) => p.date === threeAgo);
  assert.ok(bucket && bucket.pv >= 1, `3 天前桶应至少 1 次登录，实际 ${bucket?.pv ?? 0}`);
});

test('user-trend：month/year 分桶数量 + 非法 range 兜底 week', async () => {
  const month = await adminReq('GET', '/sport-track/api/admin/user-trend?range=month');
  assert.equal(month.json().data.data.length, 30);
  const year = await adminReq('GET', '/sport-track/api/admin/user-trend?range=year');
  const yearData = year.json().data;
  assert.equal(yearData.range, 'year');
  assert.equal(yearData.data.length, 12, '近一年应有 12 个月桶');
  assert.match(yearData.data[0].date, /^\d{4}-\d{2}$/);
  const bad = await adminReq('GET', '/sport-track/api/admin/user-trend?range=nope');
  assert.equal(bad.json().data.range, 'week');
});

test('user-geo-stats：省/市去重用户数 + 定位失败归入“未知”', async () => {
  await LoginLogModel.deleteMany({ userId: { $in: [userA, userB] } });
  await seedLogins(userA, 1, 3, '广东省', '深圳市'); // 同省同市多次 → 省/市均去重为 1
  await seedLogins(userB, 1, 1, '广东省', '广州市');
  // 历史脏数据：定位失败落库 "0"/"内网IP"
  await seedLogins(userB, 1, 1, '0', '内网IP');

  const res = await adminReq('GET', '/sport-track/api/admin/user-geo-stats');
  assert.equal(res.statusCode, 200);
  const d = res.json().data;
  const gd = d.provinces.find((p: { name: string }) => p.name === '广东省');
  assert.ok(gd && gd.users >= 2, `广东省应至少 2 个去重用户，实际 ${gd?.users ?? 0}`);
  const sz = d.cities.find((c: { name: string }) => c.name === '深圳市');
  assert.ok(sz && sz.users >= 1, '深圳市应至少 1 个用户');
  assert.equal(sz.province, '广东省');
  // 定位失败不出现在真实省份里，统一为“未知”
  assert.equal(
    d.provinces.some((p: { name: string }) => p.name === '0' || p.name === ''),
    false,
    '不应出现 0/空串省份',
  );
  const unknown = d.provinces.find((p: { name: string }) => p.name === '未知');
  assert.ok(unknown && unknown.users >= 1, '定位失败应归入“未知”');
  assert.ok(d.totalUsers >= 2);
  assert.ok(Array.isArray(d.cities) && d.cities.length >= 2);
});
