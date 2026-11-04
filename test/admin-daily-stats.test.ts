/**
 * 管理员每日数据统计：昨日 UV/PV、轨迹创建/完成、签到人数、新增用户；
 * 全部指标塞进站内通知 content，只投给 role=admin 的用户；同一天幂等。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/admin-daily-stats.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { LoginLogModel } from '../src/models/login-log.model.js';
import { NotificationModel } from '../src/models/notification.model.js';
import { PointSigninModel } from '../src/models/point.model.js';
import { UserModel } from '../src/models/user.model.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { bjToday0 } from '../src/utils/bj-time.js';
import {
  collectDailyStats, buildDailyStatsContent, runAdminDailyStats,
  bjMonthDay, dailyStatsDedupeKey,
} from '../src/services/admin-daily-stats.js';
import { bjYmd } from '../src/services/member-reminder.js';

let app: FastifyInstance;
const RUN = Date.now().toString(36);
const ADMIN_OPENID = `dst_admin_${RUN}`;
const USER_OPENID = `dst_user_${RUN}`;
const NEW_OPENID = `dst_new_${RUN}`;
const ADMIN_USER = `t-admin-daily-${RUN}`;
const ADMIN_PASS = 'test-admin-pass-123';
const NOW = Date.UTC(2026, 10, 4, 2, 0, 0); // 2026-11-04 10:00 东八区
const DAY = 86_400_000;
const DAY_START = bjToday0(NOW) - DAY; // 2026-11-03 00:00 +08

let adminUid = '';
let normalUid = '';
let adminToken = '';

async function login(openid: string) {
  const res = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/auth/login`, payload: { code: `openid:${openid}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.accessToken as string;
}

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  app = await buildApp({ logger: false });
  await app.ready();
  await login(ADMIN_OPENID);
  await login(USER_OPENID);
  const a = await UserModel.findOne({ openid: ADMIN_OPENID }).lean();
  const u = await UserModel.findOne({ openid: USER_OPENID }).lean();
  adminUid = String(a?._id);
  normalUid = String(u?._id);
  await UserModel.updateOne({ _id: a?._id }, { $set: { role: 'admin' } });

  const existing = await AdminModel.findOne({ username: ADMIN_USER });
  if (existing) {
    existing.passwordHash = await hashPassword(ADMIN_PASS);
    await existing.save();
  } else {
    await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  }
  const al = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/admin/login`, payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  adminToken = al.json().data.token;
});

async function seedDay() {
  const at = new Date(DAY_START + 3600_000);
  await LoginLogModel.insertMany([
    { userId: adminUid, createdAt: at, ip: '1.1.1.1' },
    { userId: adminUid, createdAt: new Date(DAY_START + 7200_000), ip: '1.1.1.1' },
    { userId: normalUid, createdAt: new Date(DAY_START + 9000_000), ip: '2.2.2.2' },
    { userId: normalUid, createdAt: new Date(NOW - 1000), ip: '2.2.2.2' }, // 今天，不计入
  ]);
  await ActivityModel.create([
    { userId: adminUid, type: 'walking', status: 'in_progress', startTime: DAY_START + 3600_000, createdAt: at, updatedAt: at },
    { userId: normalUid, type: 'running', status: 'finished', startTime: DAY_START + 4000_000, endTime: DAY_START + 5000_000, createdAt: at, updatedAt: at },
    { userId: normalUid, type: 'walking', status: 'finished', startTime: NOW - 3600_000, endTime: NOW - 1800_000, createdAt: new Date(NOW - 3600_000), updatedAt: new Date(NOW - 1800_000) },
  ]);
  await PointSigninModel.create([
    { userId: adminUid, dateKey: bjYmd(DAY_START), streakDay: 1, points: 5, source: 'sign', createdAt: DAY_START + 1000 },
    { userId: normalUid, dateKey: bjYmd(DAY_START), streakDay: 1, points: 5, source: 'sign', createdAt: DAY_START + 2000 },
  ]);
  await UserModel.create({
    openid: NEW_OPENID, nickname: '新用户', uid: 900000 + Math.floor(Math.random() * 90000),
    createdAt: new Date(DAY_START + 5000_000), updatedAt: new Date(DAY_START + 5000_000),
  });
}

beforeEach(async () => {
  await LoginLogModel.deleteMany({ userId: { $in: [adminUid, normalUid] } });
  await ActivityModel.deleteMany({ userId: { $in: [adminUid, normalUid] } });
  await PointSigninModel.deleteMany({ dateKey: bjYmd(DAY_START) });
  await NotificationModel.deleteMany({ dedupeKey: /^adminDailyStats:/ });
  await UserModel.deleteMany({ openid: NEW_OPENID });
  await UserModel.updateOne({ _id: adminUid }, { $set: { role: 'admin' } });
  await UserModel.updateOne({ _id: normalUid }, { $set: { role: 'user' } });
});

after(async () => {
  await LoginLogModel.deleteMany({ userId: { $in: [adminUid, normalUid] } });
  await ActivityModel.deleteMany({ userId: { $in: [adminUid, normalUid] } });
  await PointSigninModel.deleteMany({ dateKey: bjYmd(DAY_START) });
  await NotificationModel.deleteMany({ dedupeKey: /^adminDailyStats:/ });
  await UserModel.deleteMany({ openid: { $in: [ADMIN_OPENID, USER_OPENID, NEW_OPENID] } });
  await AdminModel.deleteMany({ username: ADMIN_USER });
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

test('DS-1 口径：UV/PV、轨迹创建/完成、签到人数、新增用户 + 正文六行', async () => {
  const before = await collectDailyStats(DAY_START);
  await seedDay();
  const s = await collectDailyStats(DAY_START);
  assert.equal(s.uv - before.uv, 2);
  assert.equal(s.pv - before.pv, 3, '今天那条登录不计入昨日');
  assert.equal(s.tracksCreated - before.tracksCreated, 2, '昨天创建的两条');
  assert.equal(s.tracksFinished - before.tracksFinished, 1, '昨天完成的一条（今天完成的不算）');
  assert.equal(s.signinUsers - before.signinUsers, 2, '按签到日期聚合（含补签落到该日）');
  assert.equal(s.newUsers - before.newUsers, 1);
  assert.equal(bjMonthDay(DAY_START), '11月3日');
  const text = buildDailyStatsContent(s);
  assert.match(text, /^访问人数：\d+ 人\n访问次数：\d+ 次\n轨迹创建：\d+ 条\n轨迹完成：\d+ 条\n签到人数：\d+ 人\n新增用户：\d+ 人$/);
});

test('DS-2 只投给管理员：定向通知、content 装全部指标、重复跑不重发', async () => {
  await seedDay();
  const r = await runAdminDailyStats(NOW);
  assert.ok(r.admins >= 1);
  assert.ok(r.sent >= 1);
  const n = await NotificationModel.findOne({
    userId: adminUid, dedupeKey: dailyStatsDedupeKey(DAY_START, adminUid),
  }).lean();
  assert.ok(n, '管理员收到通知');
  assert.equal(n?.title, '昨日数据统计（11月3日）');
  assert.equal(n?.category, 'system', '管理员日报归「系统通知」');
  assert.match(String(n?.content), /访问人数：\d+ 人/);
  assert.match(String(n?.content), /新增用户：\d+ 人/);
  assert.equal((String(n?.content).match(/\n/g) || []).length, 5, '六行指标');
  assert.ok(!(await NotificationModel.exists({ userId: normalUid })), '普通用户收不到');

  const again = await runAdminDailyStats(NOW);
  assert.equal(again.sent, 0);
  assert.ok(again.skipped >= 1);
});

test('DS-3 角色接口：普通用户→管理员可切换；非法角色 400；列表回 role', async () => {
  const list = await app.inject({
    method: 'GET', url: `${config.apiPrefix}/admin/users?page=1&pageSize=100`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const row = list.json().data.items.find((i: { id: string }) => i.id === normalUid);
  assert.equal(row.role, 'user');

  const bad = await app.inject({
    method: 'PATCH', url: `${config.apiPrefix}/admin/users/${normalUid}/role`,
    headers: { authorization: `Bearer ${adminToken}` }, payload: { role: 'root' },
  });
  assert.equal(bad.statusCode, 400);

  const ok = await app.inject({
    method: 'PATCH', url: `${config.apiPrefix}/admin/users/${normalUid}/role`,
    headers: { authorization: `Bearer ${adminToken}` }, payload: { role: 'admin' },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((await UserModel.findById(normalUid).lean())?.role, 'admin');

  const back = await app.inject({
    method: 'PATCH', url: `${config.apiPrefix}/admin/users/${normalUid}/role`,
    headers: { authorization: `Bearer ${adminToken}` }, payload: { role: 'user' },
  });
  assert.equal(back.statusCode, 200, back.body);
});

test('DS-3b 最后一名管理员保护：降级仅存 admin → 400 且角色不变；再提一名后可降', async () => {
  // 只保留 normalUid 一个管理员（清全表角色：历史运行残留的 admin 会干扰「仅存一人」断言；
  // User.role 不被其他用例消费，放开到全量是安全的）
  await UserModel.updateMany({}, { $set: { role: 'user' } });
  await UserModel.updateOne({ _id: normalUid }, { $set: { role: 'admin' } });

  const deny = await app.inject({
    method: 'PATCH', url: `${config.apiPrefix}/admin/users/${normalUid}/role`,
    headers: { authorization: `Bearer ${adminToken}` }, payload: { role: 'user' },
  });
  assert.equal(deny.statusCode, 400, deny.body);
  assert.match(deny.json().message, /至少保留一名管理员/);
  assert.equal((await UserModel.findById(normalUid).lean())?.role, 'admin', '角色未被改动');

  // 提一名新管理员后，原管理员即可降级
  const promote = await app.inject({
    method: 'PATCH', url: `${config.apiPrefix}/admin/users/${adminUid}/role`,
    headers: { authorization: `Bearer ${adminToken}` }, payload: { role: 'admin' },
  });
  assert.equal(promote.statusCode, 200, promote.body);
  const back = await app.inject({
    method: 'PATCH', url: `${config.apiPrefix}/admin/users/${normalUid}/role`,
    headers: { authorization: `Bearer ${adminToken}` }, payload: { role: 'user' },
  });
  assert.equal(back.statusCode, 200, back.body);
});

test('DS-4 管理端手动跑一轮：返回投递数并生成通知', async () => {
  const r = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/admin/daily-stats/run`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().data.sent >= 1);
  assert.ok(await NotificationModel.exists({ dedupeKey: dailyStatsDedupeKey(DAY_START, adminUid) }));
});
