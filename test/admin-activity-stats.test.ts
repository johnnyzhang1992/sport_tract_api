import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';

/**
 * admin 轨迹统计接口测试：
 * - /admin/activity-stats：多范围概况（$facet）
 * - /admin/activity-trend：近 N 天按天趋势（东八区分桶）
 * - /admin/activity-geo-stats：省份→城市层级分布（range 过滤）
 * - /admin/activities 列表：startProvince/startCity 字段 + 不下发轨迹点
 */

const ADMIN_USER = 't-admin-geo';
const ADMIN_PASS = 'test-admin-pass-123';

let app: FastifyInstance;
let adminToken = '';
let userToken = '';
let userId = '';

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  // 独立测试 admin（用户名固定，重复跑覆盖密码）
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

  // 测试用户（mock 登录）：mock openid 是 code hash 后四位，须按返回的 userId 清理，
  // 否则旧活动累积触发 1h 创建限流（429）
  const pre = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'mock_openid_geo_stats' },
  });
  const preUser = pre.json().data.user;
  const preUserId = preUser?.id ?? preUser?._id;
  if (preUserId) {
    await ActivityModel.deleteMany({ userId: preUserId });
    await UserModel.deleteMany({ _id: preUserId });
  }
  const u = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'mock_openid_geo_stats' },
  });
  userId = u.json().data.user.id;
  userToken = u.json().data.accessToken;
  assert.ok(userToken);
});

after(async () => {
  // 清理测试数据（admin 用户保留供复用）
  if (userId) {
    await UserModel.deleteOne({ _id: userId }).catch(() => {});
    await ActivityModel.deleteMany({ userId }).catch(() => {});
  }
  await app.close();
  // 显式断开 mongo，防 open handle 挂起测试进程
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

async function adminReq(method: string, url: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${adminToken}` } });
}

/** 创建一条 finished 活动（上海起点） */
async function createFinished(opts: { daysAgo: number; province?: string; city?: string; distance?: number }) {
  const startTs = Date.now() - opts.daysAgo * 86400000;
  const created = await app.inject({
    method: 'POST',
    url: '/sport-track/api/activities',
    headers: { authorization: `Bearer ${userToken}` },
    payload: { type: 'walking', startTime: startTs },
  });
  assert.equal(created.statusCode, 200, `创建活动失败: ${created.body}`);
  const id = created.json().data.activityId;
  const fin = await app.inject({
    method: 'PUT',
    url: `/sport-track/api/activities/${id}/finish`,
    headers: { authorization: `Bearer ${userToken}` },
    payload: { trackPoints: [], endTime: startTs + 60000, pausedMs: 0 },
  });
  assert.equal(fin.statusCode, 200);
  // 直接回填省市/距离（模拟 finish 已落库省市的活动）
  await ActivityModel.updateOne(
    { _id: id },
    { $set: { startProvince: opts.province ?? '上海市', startCity: opts.city ?? '上海市', distance: opts.distance ?? 1000 } },
    { timestamps: false },
  );
  return String(id);
}

test('activity-stats：多范围概况', async () => {
  await createFinished({ daysAgo: 0, distance: 2000 });
  await createFinished({ daysAgo: 3, distance: 3000 });
  await createFinished({ daysAgo: 20, distance: 4000 });
  await createFinished({ daysAgo: 100, distance: 5000 });

  const res = await adminReq('GET', '/sport-track/api/admin/activity-stats');
  assert.equal(res.statusCode, 200);
  const d = res.json().data;
  for (const key of ['today', 'week', 'month', 'year', 'all']) {
    assert.ok(d[key], `缺少 ${key}`);
    assert.equal(typeof d[key].count, 'number');
  }
  assert.ok(d.today.count >= 1, '今日应有轨迹');
  assert.ok(d.week.count >= 2, '本周（7天）应有 2 条');
  assert.ok(d.month.count >= 3, '本月（30天）应有 3 条');
  assert.ok(d.year.count >= 4, '今年（365天）应有 4 条');
  assert.ok(d.all.distance >= 14000, '累计距离应含全部测试轨迹');
});

test('activity-trend：近 30 天按天分桶补零', async () => {
  const res = await adminReq('GET', '/sport-track/api/admin/activity-trend?days=30');
  assert.equal(res.statusCode, 200);
  const d = res.json().data;
  assert.equal(d.days, 30);
  assert.equal(d.data.length, 30, '应补零到 30 个桶');
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  assert.equal(d.data[d.data.length - 1].date, today, '末位应为今天（东八区）');
  assert.ok(d.data[d.data.length - 1].count >= 1, '今天应有轨迹');
  const first = new Date(Date.now() + 8 * 3600000 - 29 * 86400000).toISOString().slice(0, 10);
  assert.equal(d.data[0].date, first, '首位应为 29 天前');
});

test('activity-geo-stats：省份→城市层级 + range 过滤', async () => {
  await createFinished({ daysAgo: 0, province: '湖北省', city: '襄阳市' });
  await createFinished({ daysAgo: 0, province: '湖北省', city: '武汉市' });
  await createFinished({ daysAgo: 0, province: '湖北省', city: '襄阳市' });
  await createFinished({ daysAgo: 40, province: '江苏省', city: '苏州市' }); // 超出 week 范围

  const all = await adminReq('GET', '/sport-track/api/admin/activity-geo-stats?range=all');
  assert.equal(all.statusCode, 200);
  const allData = all.json().data;
  const hubei = allData.provinces.find((p: { province: string }) => p.province === '湖北省');
  assert.ok(hubei, '应有湖北省');
  // 全局统计含其他用户数据，断言下限即可
  assert.ok(hubei.count >= 3, `湖北省应至少 3 条（测试造数），实际 ${hubei.count}`);
  const xiangyang = hubei.cities.find((c: { city: string }) => c.city === '襄阳市');
  assert.ok(xiangyang && xiangyang.count >= 2, `襄阳市应至少 2 条，实际 ${xiangyang?.count ?? 0}`);
  assert.ok(hubei.cities[0].count >= hubei.cities[hubei.cities.length - 1].count, '城市按数量降序');

  const week = await adminReq('GET', '/sport-track/api/admin/activity-geo-stats?range=week');
  const weekData = week.json().data;
  const weekHubei = weekData.provinces.find((p: { province: string }) => p.province === '湖北省');
  assert.ok(weekHubei && weekHubei.count >= 3, 'week 应含测试造的湖北轨迹');
});

test('activities 列表：startProvince/startCity 字段 + 不含轨迹点', async () => {
  const res = await adminReq('GET', '/sport-track/api/admin/activities?page=1&pageSize=5');
  assert.equal(res.statusCode, 200);
  const items = res.json().data.items;
  assert.ok(items.length >= 1);
  const item = items[0];
  assert.ok('startProvince' in item, '应有 startProvince');
  assert.ok('startCity' in item, '应有 startCity');
  assert.equal(item.trackPoints, undefined, '不应下发轨迹点');
  assert.equal(item.markers, undefined, '不应下发打点');
});

test('users 列表：下发纯数字 uid 不含 openid（敏感字段）', async () => {
  const res = await adminReq('GET', '/sport-track/api/admin/users?page=1&pageSize=5');
  assert.equal(res.statusCode, 200);
  const items = res.json().data.items;
  assert.ok(items.length >= 1);
  const item = items[0];
  assert.equal(item.openid, undefined, '不应下发 openid');
  assert.match(item.uid, /^\d+$/, 'uid 应为纯数字字符串');
});

test('backfill-uids：缺 UID 老用户按创建时间补号（不动昵称）', async () => {
  const hashOf = (code: string) => [...code].reduce((a, c) => a + c.charCodeAt(0), 0) % 10000;
  const openidOf = (code: string) => `mock_openid_${String(hashOf(code)).padStart(4, '0')}`;
  const aOpenid = openidOf('mock-old-uid-a');
  const bOpenid = openidOf('mock-old-uid-b');
  // 先清残留再构造两个无 uid 老用户（先注册 a：自定义昵称；后注册 b：空昵称）
  await UserModel.deleteMany({ openid: { $in: [aOpenid, bOpenid] } });
  await UserModel.create({ openid: aOpenid, nickname: '小小梦工场', createdAt: new Date(Date.now() - 3600000) });
  await new Promise((r) => setTimeout(r, 5));
  await UserModel.create({ openid: bOpenid, nickname: '', createdAt: new Date(Date.now() - 1800000) });

  const res = await adminReq('POST', '/sport-track/api/admin/users/backfill-uids');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.success, true);
  assert.ok(body.data.backfilled >= 2, `应至少补 2 个，实际 ${body.data.backfilled}`);
  assert.ok(body.data.remaining >= 0);

  const a = await UserModel.findOne({ openid: aOpenid });
  const b = await UserModel.findOne({ openid: bOpenid });
  assert.ok(a && a.uid != null && b && b.uid != null, '老用户应有 UID');
  assert.equal(a.nickname, '小小梦工场', '自定义昵称不被覆盖');
  assert.ok(a.uid < b.uid, `先注册的用户 UID 应更小: ${a.uid} vs ${b.uid}`);

  // 清理
  await UserModel.deleteMany({ openid: { $in: [aOpenid, bOpenid] } });
});
