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
import { SubscribeGrantModel } from '../src/models/subscribe-grant.model.js';
import { SubscribeMessageLogModel } from '../src/models/subscribe-message-log.model.js';
import { bjToday0 } from '../src/utils/bj-time.js';
import {
  collectDailyStats, buildDailyStatsContent, buildDailyStatsSubscribeContent,
  buildDailyStatsSubscribeData, isDailyReportSendTime,
  runAdminDailyStats, bjMonthDay, dailyStatsDedupeKey,
  DAILY_REPORT_TEMPLATE_ID, DAILY_REPORT_TEMPLATE_KEY,
  recordDailyReportGrant, __setAdminDailyStatsSenderForTest,
} from '../src/services/admin-daily-stats.js';
import { bjYmd } from '../src/services/member-reminder.js';
import { listMessageSubscriptions, grantMessageSubscription } from '../src/services/subscriptions.js';

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
let sends: Array<{ openid: string; templateId: string; page?: string; data: Record<string, { value: string }> }> = [];
let sendResult = { errcode: 0, errmsg: 'ok' };
let sendThrows = false;

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
  await SubscribeGrantModel.deleteMany({ userId: { $in: [adminUid, normalUid] } });
  await SubscribeMessageLogModel.deleteMany({ templateKey: DAILY_REPORT_TEMPLATE_KEY });
  await UserModel.deleteMany({ openid: NEW_OPENID });
  await UserModel.updateOne({ _id: adminUid }, { $set: { role: 'admin' } });
  await UserModel.updateOne({ _id: normalUid }, { $set: { role: 'user' } });
  sends = [];
  sendResult = { errcode: 0, errmsg: 'ok' };
  sendThrows = false;
  __setAdminDailyStatsSenderForTest(async (input) => {
    if (sendThrows) throw new Error('ETIMEDOUT');
    sends.push(input as never);
    return sendResult;
  });
});

after(async () => {
  await LoginLogModel.deleteMany({ userId: { $in: [adminUid, normalUid] } });
  await ActivityModel.deleteMany({ userId: { $in: [adminUid, normalUid] } });
  await PointSigninModel.deleteMany({ dateKey: bjYmd(DAY_START) });
  await NotificationModel.deleteMany({ dedupeKey: /^adminDailyStats:/ });
  await SubscribeGrantModel.deleteMany({ userId: { $in: [adminUid, normalUid] } });
  await SubscribeMessageLogModel.deleteMany({ templateKey: DAILY_REPORT_TEMPLATE_KEY });
  await UserModel.deleteMany({ openid: { $in: [ADMIN_OPENID, USER_OPENID, NEW_OPENID] } });
  await AdminModel.deleteMany({ username: ADMIN_USER });
  __setAdminDailyStatsSenderForTest(null);
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

  // 订阅消息短字段：轨迹{完成}/{全部}签到{签到}新增{新增}
  const sample = {
    date: DAY_START, uv: 50, pv: 123,
    tracksCreated: 2, tracksFinished: 1, signinUsers: 2, newUsers: 1,
  };
  assert.equal(buildDailyStatsSubscribeContent(sample), '轨迹1/2签到2新增1');
  assert.ok(buildDailyStatsSubscribeContent(sample).length <= 20);
  const big = { ...sample, tracksCreated: 9999, tracksFinished: 9999, signinUsers: 9999, newUsers: 9999 };
  assert.equal(buildDailyStatsSubscribeContent(big), '轨9999/9999签9999新9999', '四位数字退短标签');
  assert.equal(buildDailyStatsSubscribeContent(big).length, 20);
  const wan = { ...sample, tracksCreated: 10000, tracksFinished: 10000, signinUsers: 10000, newUsers: 10000 };
  assert.equal(buildDailyStatsSubscribeContent(wan), '轨迹1万/1万签到1万新增1万');

  const data = buildDailyStatsSubscribeData(sample, DAY_START);
  assert.equal(data.time21.value, '2026年11月3日');
  assert.equal(data.thing29.value, '迹路者');
  assert.equal(data.number22.value, '50');
  assert.equal(data.number4.value, '123');
  assert.equal(data.thing1.value, '轨迹1/2签到2新增1');
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
  assert.equal(r.wechatSent, 0, '没有每日报告授权就不发微信');
  assert.equal(sends.length, 0);
});

test('DS-2b 管理员有授权：站内 + 微信同时发，字段完整，发完消耗额度', async () => {
  await seedDay();
  await recordDailyReportGrant(adminUid, 'message_center');
  const r = await runAdminDailyStats(NOW);
  assert.equal(r.wechatSent, 1);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].openid, ADMIN_OPENID);
  assert.equal(sends[0].templateId, DAILY_REPORT_TEMPLATE_ID);
  assert.equal(sends[0].page, '/pages/operator/operator', '点击应落到数据概览页');
  assert.ok(r.stats);
  assert.equal(sends[0].data.time21.value, '2026年11月3日');
  assert.equal(sends[0].data.thing29.value, '迹路者');
  assert.equal(sends[0].data.number22.value, String(r.stats!.uv));
  assert.equal(sends[0].data.number4.value, String(r.stats!.pv));
  assert.equal(sends[0].data.thing1.value, buildDailyStatsSubscribeContent(r.stats!));
  assert.ok(sends[0].data.thing1.value.length <= 20);

  const grant = await SubscribeGrantModel.findOne({
    userId: adminUid, templateKey: DAILY_REPORT_TEMPLATE_KEY,
  }).lean();
  assert.equal(grant?.status, 'consumed');
  const log = await SubscribeMessageLogModel.findOne({
    userId: adminUid, templateKey: DAILY_REPORT_TEMPLATE_KEY,
  }).lean();
  assert.equal(log?.status, 'sent');
  assert.ok(await NotificationModel.exists({ dedupeKey: dailyStatsDedupeKey(DAY_START, adminUid) }), '站内报告仍在');

  const again = await runAdminDailyStats(NOW);
  assert.equal(again.wechatSent, 0);
  assert.equal(sends.length, 1, '同一天同管理员只发一条');
});

test('DS-2c 43101：额度作废、记失败；站内报告仍生成', async () => {
  await seedDay();
  await recordDailyReportGrant(adminUid, 'message_center');
  sendResult = { errcode: 43101, errmsg: 'user refuse' };
  const r = await runAdminDailyStats(NOW);
  assert.equal(r.wechatFailed, 1);
  assert.equal(r.wechatSent, 0);
  const grant = await SubscribeGrantModel.findOne({
    userId: adminUid, templateKey: DAILY_REPORT_TEMPLATE_KEY,
  }).lean();
  assert.equal(grant?.status, 'invalid');
  assert.equal(grant?.invalidReason, '43101');
  const log = await SubscribeMessageLogModel.findOne({
    userId: adminUid, templateKey: DAILY_REPORT_TEMPLATE_KEY,
  }).lean();
  assert.equal(log?.status, 'failed');
  assert.equal(log?.errcode, 43101);
  assert.ok(await NotificationModel.exists({ dedupeKey: dailyStatsDedupeKey(DAY_START, adminUid) }));
});

test('DS-5 发送时间：09:00–12:00 才发微信；force 可手动补', async () => {
  assert.equal(isDailyReportSendTime(Date.UTC(2026, 10, 4, 0, 59)), false, '08:59 不发');
  assert.equal(isDailyReportSendTime(NOW), true, '10:00 发');
  assert.equal(isDailyReportSendTime(Date.UTC(2026, 10, 4, 6, 0)), false, '14:00 不发');

  await seedDay();
  await recordDailyReportGrant(adminUid, 'message_center');
  const late = Date.UTC(2026, 10, 4, 6, 0, 0);
  const skipped = await runAdminDailyStats(late);
  assert.equal(skipped.wechatSent, 0);
  assert.equal(sends.length, 0);
  assert.ok(skipped.sent >= 1, '站内报告不受微信时间窗影响');

  const forced = await runAdminDailyStats(late, { force: true });
  assert.equal(forced.wechatSent, 1);
  assert.equal(sends.length, 1);
});

test('DS-6 每日报告只给管理员：列表出现、普通用户不可订阅', async () => {
  const adminList = await listMessageSubscriptions(adminUid);
  const daily = adminList.items.find((i) => i.key === DAILY_REPORT_TEMPLATE_KEY);
  assert.ok(daily, '管理员能看到每日数据报告');
  assert.equal(daily?.label, '每日数据报告');
  assert.equal(daily?.description, '每天 09:00 推送昨日数据');
  assert.equal(daily?.templateId, DAILY_REPORT_TEMPLATE_ID);
  assert.equal(daily?.subscribed, false);

  const normalList = await listMessageSubscriptions(normalUid);
  assert.ok(!normalList.items.some((i) => i.key === DAILY_REPORT_TEMPLATE_KEY), '普通用户看不到');
  await assert.rejects(
    () => grantMessageSubscription(normalUid, DAILY_REPORT_TEMPLATE_KEY, 'message_center'),
    /仅管理员/,
  );

  await grantMessageSubscription(adminUid, DAILY_REPORT_TEMPLATE_KEY, 'message_center');
  const after = await listMessageSubscriptions(adminUid);
  assert.equal(after.items.find((i) => i.key === DAILY_REPORT_TEMPLATE_KEY)?.subscribed, true);
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
  // 共享 dev 库里可能有真实管理员（例如本机 UID1004）：临时降级，测试结束必须在 finally 还原，
  // 不能像早期那样直接 updateMany({}) 把全平台角色永久清成 user。
  const priorAdmins = await UserModel.find({ role: 'admin' }).select({ _id: 1 }).lean();
  const priorIds = priorAdmins.map((a) => a._id);
  try {
    await UserModel.updateMany({ role: 'admin' }, { $set: { role: 'user' } });
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
  } finally {
    await UserModel.updateMany({ _id: { $in: priorIds } }, { $set: { role: 'admin' } });
    if (!priorIds.some((id) => String(id) === normalUid)) {
      await UserModel.updateOne({ _id: normalUid }, { $set: { role: 'user' } });
    }
    if (!priorIds.some((id) => String(id) === adminUid)) {
      await UserModel.updateOne({ _id: adminUid }, { $set: { role: 'user' } });
    }
  }
});

test('DS-4 管理端手动跑一轮：返回投递数并生成通知', async () => {
  const r = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/admin/daily-stats/run`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().data.sent >= 1);
  // 预期 dedupeKey 用响应回传的真实 dayStart 推导：路由内部用真实当前时间，
  // 跨天边界（本地时间过了午夜）时与固定 NOW 的 DAY_START 不再相等——按响应动态断言
  const dedupe = dailyStatsDedupeKey(r.json().data.date, adminUid);
  assert.ok(await NotificationModel.exists({ dedupeKey: dedupe }));
});
