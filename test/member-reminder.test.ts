/**
 * 会员到期提醒（一次性订阅）：额度台账、东八区天数、模板字段、幂等、43101 兜底。
 * 发送用注入的假 sender（真机才会走微信）；站内兜底走真实 Notification。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/member-reminder.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { XpayOrderModel } from '../src/models/xpay-order.model.js';
import { UserModel } from '../src/models/user.model.js';
import { AppSettingModel } from '../src/models/app-setting.model.js';
import { NotificationModel } from '../src/models/notification.model.js';
import { SubscribeGrantModel } from '../src/models/subscribe-grant.model.js';
import { SubscribeMessageLogModel } from '../src/models/subscribe-message-log.model.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import {
  REMINDER_SETTINGS_KEY, MEMBER_EXPIRY_TEMPLATE_KEY,
  getReminderSettings, setReminderSettings, resetReminderSettingsCacheForTest,
  daysUntilBj, truncateChars, buildReminderData, memberTypeOf, bjYmd,
  recordReminderGrant, hasReminderGrant,
  runMemberExpiryReminders, __setSubscribeSenderForTest,
} from '../src/services/member-reminder.js';

let app: FastifyInstance;
const RUN = Date.now().toString(36);
const OPENID = `remind_${RUN}`;
const ADMIN_USER = `t-admin-remind-${RUN}`;
const ADMIN_PASS = 'test-admin-pass-123';
const DAY = 86_400_000;
// 2026-11-01 12:00 东八区
const NOW = Date.UTC(2026, 10, 1, 4, 0, 0);
let token = '';
let adminToken = '';
let uid = '';
let seq = 0;

async function login() {
  const res = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/auth/login`, payload: { code: `openid:${OPENID}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.accessToken as string;
}

async function mkOrder(over: Record<string, unknown> = {}) {
  seq += 1;
  const u = await UserModel.findOne({ openid: OPENID }).lean();
  return XpayOrderModel.create({
    outTradeNo: `RMT${RUN}${String(seq).padStart(3, '0')}`.slice(0, 32),
    wxOrderId: `wxr${RUN}${seq}`,
    userId: u?._id, openid: OPENID,
    productKey: 'month_card', name: '会员月卡', priceFen: 199, durationDays: 30,
    perksSnapshot: { adFree: true, exportBundle: true, photoQuota: 300, subscribeNotice: true },
    status: 'delivered', channel: 'android',
    periodStart: NOW - 27 * DAY, periodEnd: NOW + 3 * DAY, ...over,
  });
}

let sends: Array<{ openid: string; templateId: string; page?: string; data: Record<string, { value: string }> }> = [];
let sendResult = { errcode: 0, errmsg: 'ok' };

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  app = await buildApp({ logger: false });
  await app.ready();
  token = await login();
  uid = String((await UserModel.findOne({ openid: OPENID }).lean())?._id);

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

beforeEach(async () => {
  await XpayOrderModel.deleteMany({ openid: OPENID });
  await SubscribeGrantModel.deleteMany({ userId: uid });
  await SubscribeMessageLogModel.deleteMany({ templateKey: MEMBER_EXPIRY_TEMPLATE_KEY });
  await NotificationModel.deleteMany({ dedupeKey: /^memberExpiry:/ });
  await AppSettingModel.deleteMany({ _id: REMINDER_SETTINGS_KEY });
  resetReminderSettingsCacheForTest();
  sends = [];
  sendResult = { errcode: 0, errmsg: 'ok' };
  __setSubscribeSenderForTest(async (input) => {
    sends.push(input as never);
    return sendResult;
  });
});

after(async () => {
  await XpayOrderModel.deleteMany({ openid: OPENID });
  await SubscribeGrantModel.deleteMany({ userId: uid });
  await SubscribeMessageLogModel.deleteMany({ templateKey: MEMBER_EXPIRY_TEMPLATE_KEY });
  await NotificationModel.deleteMany({ dedupeKey: /^memberExpiry:/ });
  await AppSettingModel.deleteMany({ _id: REMINDER_SETTINGS_KEY });
  await UserModel.deleteMany({ openid: OPENID });
  await AdminModel.deleteMany({ username: ADMIN_USER });
  __setSubscribeSenderForTest(null);
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

test('MR-1 东八区自然日：今天 0、跨日 1；字段按模板长度截断', () => {
  const todayLate = Date.UTC(2026, 10, 1, 15, 0, 0); // 东八 23:00
  assert.equal(daysUntilBj(todayLate, NOW), 0);
  assert.equal(daysUntilBj(NOW + 3 * DAY, NOW), 3);
  assert.equal(daysUntilBj(Date.UTC(2026, 10, 1, 15, 59, 59), NOW), 0, '同日 23:59 仍算 0 天');
  assert.equal(daysUntilBj(NOW + DAY, NOW), 1);
  assert.equal(truncateChars('一二三四五六七八九十一二三四五六七八九十多', 20).length, 20);
  assert.equal(truncateChars('🏃🏃🏃', 2), '🏃🏃');

  const d = buildReminderData({ name: '会员月卡', until: Date.UTC(2026, 11, 4, 2), daysLeft: 3 });
  assert.equal(d.thing1.value, '会员月卡');
  assert.equal(d.short_thing5.value, '月卡');
  assert.equal(d.date2.value, '2026年12月4日');
  assert.equal(d.number6.value, '3');
  assert.ok(d.thing3.value.length <= 20);
  assert.equal(memberTypeOf('会员年卡'), '年卡');
  assert.equal(memberTypeOf('神秘权益'), '神秘权益');
  assert.equal(bjYmd(NOW), '20261101');
});

test('MR-2 有额度：断言模板/字段/page，发完消耗额度；同到期日不重发', async () => {
  await setReminderSettings({ enabled: true, templateId: 'TPL_TEST', daysBefore: 3 });
  await mkOrder();
  await recordReminderGrant(uid, 'member_center');
  assert.equal(await hasReminderGrant(uid), true);

  const r = await runMemberExpiryReminders(NOW);
  assert.deepEqual({ sent: r.sent, inapp: r.inapp, failed: r.failed }, { sent: 1, inapp: 0, failed: 0 });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].templateId, 'TPL_TEST');
  assert.equal(sends[0].page, '/pages/member/member');
  assert.equal(sends[0].data.thing1.value, '会员月卡');
  assert.equal(sends[0].data.number6.value, '3');
  assert.equal(await hasReminderGrant(uid), false, '额度已消耗');
  const log = await SubscribeMessageLogModel.findOne({ templateKey: MEMBER_EXPIRY_TEMPLATE_KEY }).lean();
  assert.equal(log?.status, 'sent');

  const again = await runMemberExpiryReminders(NOW);
  assert.equal(again.sent, 0);
  assert.equal(sends.length, 1, '同用户同到期日只发一条');
});

test('MR-3 没有额度：不发微信，写站内通知兜底且不重复', async () => {
  await setReminderSettings({ enabled: true, templateId: 'TPL_TEST', daysBefore: 3 });
  await mkOrder();
  const r = await runMemberExpiryReminders(NOW);
  assert.equal(r.sent, 0);
  assert.equal(r.inapp, 1);
  assert.equal(sends.length, 0);
  const n = await NotificationModel.findOne({ dedupeKey: new RegExp(`^memberExpiry:inapp:${uid}:`) }).lean();
  assert.ok(n, '站内兜底通知已写');
  assert.equal(n?.userId?.toString(), uid);
  assert.equal(n?.category, 'member', '会员到期兜底要进「会员服务」分类');
  assert.match(String(n?.content), /到期/);

  const again = await runMemberExpiryReminders(NOW);
  assert.equal(again.inapp, 0, '同到期日兜底也只一条');
});

test('MR-4 43101：额度标记失效 + 站内兜底；关开关不发', async () => {
  await setReminderSettings({ enabled: true, templateId: 'TPL_TEST', daysBefore: 3 });
  await mkOrder();
  await recordReminderGrant(uid, 'test');
  sendResult = { errcode: 43101, errmsg: 'user refuse' };
  const r = await runMemberExpiryReminders(NOW);
  assert.equal(r.sent, 0);
  assert.equal(r.inapp, 1);
  const grants = await SubscribeGrantModel.find({ userId: uid }).lean();
  assert.equal(grants[0].status, 'invalid');
  const log = await SubscribeMessageLogModel.findOne({ templateKey: MEMBER_EXPIRY_TEMPLATE_KEY }).lean();
  assert.equal(log?.errcode, 43101);

  await setReminderSettings({ enabled: false, templateId: 'TPL_TEST', daysBefore: 3 });
  const off = await runMemberExpiryReminders(NOW);
  assert.deepEqual(off, { sent: 0, inapp: 0, skipped: 0, failed: 0 });
});

test('MR-5 设置校验：非法天数 / 空模板 ID 400', async () => {
  await assert.rejects(() => setReminderSettings({ enabled: true, templateId: '', daysBefore: 3 }), /模板 ID/);
  await assert.rejects(() => setReminderSettings({ enabled: true, templateId: 'x', daysBefore: 0 }), /1-30/);
  await assert.rejects(() => setReminderSettings({ enabled: 'yes', templateId: 'x', daysBefore: 3 }), /布尔/);
  const ok = await setReminderSettings({ enabled: true, templateId: 'TPL_X', daysBefore: 5 });
  assert.deepEqual(ok, { enabled: true, templateId: 'TPL_X', daysBefore: 5 });
  assert.deepEqual(await getReminderSettings(), ok);
});

test('MR-6 用户接口：未开启 403；开启后 grant 落库并回 subscribed', async () => {
  const off = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/member/reminder/grant`,
    headers: { authorization: `Bearer ${token}` }, payload: { scene: 'member_center' },
  });
  assert.equal(off.statusCode, 403);

  await setReminderSettings({ enabled: true, templateId: 'TPL_TEST', daysBefore: 3 });
  const g = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/member/reminder/grant`,
    headers: { authorization: `Bearer ${token}` }, payload: { scene: 'member_center' },
  });
  assert.equal(g.statusCode, 200, g.body);
  assert.equal(g.json().data.subscribed, true);

  const info = await app.inject({
    method: 'GET', url: `${config.apiPrefix}/member/reminder`, headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(info.statusCode, 200);
  assert.equal(info.json().data.enabled, true);
  assert.equal(info.json().data.templateId, 'TPL_TEST');
  assert.equal(info.json().data.subscribed, true);
  assert.equal(info.json().data.daysBefore, 3);

  const unauth = await app.inject({ method: 'GET', url: `${config.apiPrefix}/member/reminder` });
  assert.equal(unauth.statusCode, 401);
});

test('MR-7 管理端接口：读设置 / 保存 / 非法 400 / 手动跑一轮', async () => {
  const bad = await app.inject({
    method: 'PUT', url: `${config.apiPrefix}/admin/xpay/reminder-settings`,
    headers: { authorization: `Bearer ${adminToken}` }, payload: { enabled: true, templateId: '', daysBefore: 3 },
  });
  assert.equal(bad.statusCode, 400);

  const save = await app.inject({
    method: 'PUT', url: `${config.apiPrefix}/admin/xpay/reminder-settings`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { enabled: true, templateId: 'TPL_ADMIN', daysBefore: 3 },
  });
  assert.equal(save.statusCode, 200, save.body);
  assert.equal(save.json().data.templateId, 'TPL_ADMIN');

  const read = await app.inject({
    method: 'GET', url: `${config.apiPrefix}/admin/xpay/reminder-settings`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(read.json().data.enabled, true);

  const now = Date.now();
  await mkOrder({ periodStart: now - 27 * DAY, periodEnd: now + 3 * DAY });
  const run = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/admin/xpay/reminder-settings/run`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(run.statusCode, 200, run.body);
  assert.equal(run.json().data.inapp, 1, '没有额度时跑出站内兜底');
});
