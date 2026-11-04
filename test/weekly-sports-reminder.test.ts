/**
 * 每周运动数据提醒（一次性订阅）：上周窗口、数据口径、模板字段、周一 09:00 闸门、
 * 额度消耗、43101、幂等与网络失败重试。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/weekly-sports-reminder.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { UserModel } from '../src/models/user.model.js';
import { AppSettingModel } from '../src/models/app-setting.model.js';
import { SubscribeGrantModel } from '../src/models/subscribe-grant.model.js';
import { SubscribeMessageLogModel } from '../src/models/subscribe-message-log.model.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { bjIsoWeekLabel, bjIsoWeekStart } from '../src/utils/bj-time.js';
import {
  WEEKLY_SPORTS_SETTINGS_KEY, WEEKLY_SPORTS_TEMPLATE_KEY, WEEKLY_SPORTS_TEMPLATE_ID,
  getWeeklySportsSettings, setWeeklySportsSettings, resetWeeklySportsSettingsCacheForTest,
  isWeeklySendTime, collectWeeklySports, buildWeeklySportsData,
  recordWeeklySportsGrant, hasWeeklySportsGrant, weeklyDedupeKey,
  runWeeklySportsReminders, __setSubscribeSenderForTest,
} from '../src/services/weekly-sports-reminder.js';
import {
  REMINDER_SETTINGS_KEY, setReminderSettings, resetReminderSettingsCacheForTest,
  MEMBER_EXPIRY_TEMPLATE_KEY,
} from '../src/services/member-reminder.js';
import { listMessageSubscriptions, grantMessageSubscription } from '../src/services/subscriptions.js';

const RUN = Date.now().toString(36);
const OPENID = `weekly_${RUN}`;
const ADMIN_USER = `t-admin-weekly-${RUN}`;
const ADMIN_PASS = 'test-admin-pass-123';
const DAY = 86_400_000;
// 2026-11-09 09:30 东八区（周一）
const NOW = Date.UTC(2026, 10, 9, 1, 30, 0);
const WEEK_START = Date.UTC(2026, 10, 2, -8, 0, 0); // 2026-11-02 00:00 东八区
const WEEK_END = Date.UTC(2026, 10, 9, -8, 0, 0); // 2026-11-09 00:00 东八区

let app: FastifyInstance;
let uid = '';
let token = '';
let adminToken = '';
let seq = 0;

const at = (day: number, hour: number, minute = 0) => Date.UTC(2026, 10, day, hour - 8, minute);

async function loginFresh() {
  const res = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/auth/login`,
    payload: { code: `openid:${OPENID}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data;
}

async function mkActivity(over: Record<string, unknown> = {}) {
  seq += 1;
  return ActivityModel.create({
    userId: new mongoose.Types.ObjectId(uid),
    type: 'running',
    status: 'finished',
    startTime: at(3, 8, 0) + seq,
    endTime: at(3, 8, 30) + seq,
    duration: 1800,
    distance: 5000,
    ...over,
  });
}

let sends: Array<{ openid: string; templateId: string; page?: string; data: Record<string, { value: string }> }> = [];
let sendResult = { errcode: 0, errmsg: 'ok' };
let sendThrows = false;

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  app = await buildApp({ logger: false });
  await app.ready();
  const d = await loginFresh();
  token = d.accessToken;
  uid = String(d.user?.id ?? d.user?._id);

  const existing = await AdminModel.findOne({ username: ADMIN_USER });
  if (existing) {
    existing.passwordHash = await hashPassword(ADMIN_PASS);
    await existing.save();
  } else {
    await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  }
  const al = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/admin/login`,
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  adminToken = al.json().data.token;
});

beforeEach(async () => {
  await ActivityModel.deleteMany({ userId: new mongoose.Types.ObjectId(uid) });
  await SubscribeGrantModel.deleteMany({ userId: new mongoose.Types.ObjectId(uid) });
  await SubscribeMessageLogModel.deleteMany({ templateKey: WEEKLY_SPORTS_TEMPLATE_KEY });
  await AppSettingModel.deleteMany({ _id: { $in: [WEEKLY_SPORTS_SETTINGS_KEY, REMINDER_SETTINGS_KEY] } });
  resetWeeklySportsSettingsCacheForTest();
  resetReminderSettingsCacheForTest();
  sends = [];
  sendResult = { errcode: 0, errmsg: 'ok' };
  sendThrows = false;
  __setSubscribeSenderForTest(async (input) => {
    if (sendThrows) throw new Error('ETIMEDOUT');
    sends.push(input as never);
    return sendResult;
  });
});

after(async () => {
  await ActivityModel.deleteMany({ userId: new mongoose.Types.ObjectId(uid) });
  await SubscribeGrantModel.deleteMany({ userId: new mongoose.Types.ObjectId(uid) });
  await SubscribeMessageLogModel.deleteMany({ templateKey: WEEKLY_SPORTS_TEMPLATE_KEY });
  await AppSettingModel.deleteMany({ _id: { $in: [WEEKLY_SPORTS_SETTINGS_KEY, REMINDER_SETTINGS_KEY] } });
  await UserModel.deleteMany({ openid: OPENID });
  await AdminModel.deleteMany({ username: ADMIN_USER });
  __setSubscribeSenderForTest(null);
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

test('WS-1 窗口与口径：只算上周已完成轨迹；跑步里程、活跃天数、最近一条', async () => {
  await mkActivity({ type: 'running', distance: 5000, startTime: at(3, 8, 0) });
  await mkActivity({ type: 'running', distance: 3000, startTime: at(5, 19, 0) });
  await mkActivity({ type: 'cycling', distance: 12000, duration: 2400, startTime: at(8, 10, 0) });
  // 以下都不该计入：本周、进行中、作废、上上周
  await mkActivity({ type: 'walking', distance: 2000, startTime: at(9, 0, 30) });
  await mkActivity({ type: 'running', distance: 1000, status: 'in_progress', startTime: at(4, 8, 0) });
  await mkActivity({ type: 'running', distance: 1000, status: 'cancelled', startTime: at(4, 9, 0) });
  await mkActivity({ type: 'running', distance: 1000, startTime: at(1, 9, 0) });

  const data = await collectWeeklySports(uid, NOW);
  assert.equal(data.weekStart, WEEK_START);
  assert.equal(data.weekEnd, WEEK_END);
  assert.equal(data.runningMeters, 8000, '只算 running');
  assert.equal(data.activeDays, 3, '11-03 / 11-05 / 11-08 三天');
  assert.equal(data.latest?.type, 'cycling');
  assert.equal(data.latest?.distance, 12000);
  assert.equal(data.latest?.startTime, at(8, 10, 0));

  const tpl = buildWeeklySportsData(data);
  assert.equal(tpl.character_string4.value, '8.00 公里');
  assert.equal(tpl.thing2.value, '上周 3 天');
  assert.equal(tpl.thing1.value, '上周骑行 12.00 公里');
  assert.equal(tpl.time3.value, '2026年11月8日 10:00');
  assert.ok(tpl.thing1.value.length <= 20);
  assert.ok(tpl.thing2.value.length <= 20);
  assert.ok(tpl.character_string4.value.length <= 32);
});

test('WS-2 周一 09:00 闸门：周日/周一 08:59 不发；09:00 起发；force 可手动绕过', async () => {
  assert.equal(isWeeklySendTime(at(8, 20, 0)), false, '周日不发');
  assert.equal(isWeeklySendTime(at(9, 8, 59)), false, '周一 08:59 不发');
  assert.equal(isWeeklySendTime(at(9, 9, 0)), true, '周一 09:00 发');
  const oldTZ = process.env.TZ;
  process.env.TZ = 'UTC';
  assert.equal(isWeeklySendTime(Date.UTC(2026, 10, 9, 1, 0)), true, '与服务器时区无关');
  process.env.TZ = oldTZ;
});

test('WS-2b 非发送时间整轮跳过；后台 force 可手动补跑', async () => {
  await setWeeklySportsSettings({ enabled: true, templateId: 'TPL_WEEKLY' });
  await recordWeeklySportsGrant(uid, 'message_center');
  await mkActivity({ startTime: at(3, 8, 0) });

  const beforeNine = at(9, 8, 0);
  const skipped = await runWeeklySportsReminders(beforeNine);
  assert.equal(skipped.sent, 0);
  assert.equal(sends.length, 0);
  assert.equal(await hasWeeklySportsGrant(uid), true);

  const forced = await runWeeklySportsReminders(beforeNine, { force: true });
  assert.equal(forced.sent, 1, 'force 绕过时间闸门');
  assert.equal(sends.length, 1);
});

test('WS-3 有额度有数据：发一条、消耗额度、同周不重发', async () => {
  await setWeeklySportsSettings({ enabled: true, templateId: 'TPL_WEEKLY' });
  await recordWeeklySportsGrant(uid, 'message_center');
  await mkActivity({ type: 'running', distance: 5000, startTime: at(3, 8, 0) });
  await mkActivity({ type: 'cycling', distance: 12000, duration: 2400, startTime: at(8, 10, 0) });

  const r = await runWeeklySportsReminders(NOW);
  assert.deepEqual({ sent: r.sent, noData: r.noData, failed: r.failed, skipped: r.skipped }, {
    sent: 1, noData: 0, failed: 0, skipped: 0,
  });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].openid, OPENID);
  assert.equal(sends[0].templateId, 'TPL_WEEKLY');
  assert.equal(sends[0].page, '/pages/stats/stats');
  assert.equal(sends[0].data.character_string4.value, '5.00 公里');
  assert.equal(sends[0].data.thing2.value, '上周 2 天');
  assert.equal(sends[0].data.thing1.value, '上周骑行 12.00 公里');
  assert.equal(sends[0].data.time3.value, '2026年11月8日 10:00');

  const grant = await SubscribeGrantModel.findOne({
    userId: new mongoose.Types.ObjectId(uid), templateKey: WEEKLY_SPORTS_TEMPLATE_KEY,
  }).lean();
  assert.equal(grant?.status, 'consumed');
  const log = await SubscribeMessageLogModel.findOne({
    dedupeKey: weeklyDedupeKey(uid, bjIsoWeekLabel(WEEK_START)),
  }).lean();
  assert.equal(log?.status, 'sent');

  // 同周重跑：额度已消耗，不在扫描名单；不重发
  const again = await runWeeklySportsReminders(NOW);
  assert.equal(again.sent, 0);
  assert.equal(sends.length, 1, '同周只发一条');

  // 模拟「发成功但额度没来得及置 consumed」：占位还在 → skipped，不重发
  await SubscribeGrantModel.updateOne(
    { userId: new mongoose.Types.ObjectId(uid), templateKey: WEEKLY_SPORTS_TEMPLATE_KEY },
    { $set: { status: 'granted' } },
  );
  const dedupe = await runWeeklySportsReminders(NOW);
  assert.equal(dedupe.skipped, 1, '同周占位挡住重复投递');
  assert.equal(sends.length, 1);
});

test('WS-4 上周无运动：不发、不消耗额度；没有额度的人不在扫描名单', async () => {
  await setWeeklySportsSettings({ enabled: true, templateId: 'TPL_WEEKLY' });
  await recordWeeklySportsGrant(uid, 'message_center');
  // 只有本周运动，上周为空
  await mkActivity({ startTime: at(9, 8, 0) });
  const r = await runWeeklySportsReminders(NOW);
  assert.equal(r.sent, 0);
  assert.equal(r.noData, 1);
  assert.equal(sends.length, 0);
  assert.equal(await hasWeeklySportsGrant(uid), true, '空数据不消耗额度');
  assert.equal(await SubscribeMessageLogModel.countDocuments({}), 0, '空数据不写投递台账');

  // 有数据但没额度 → 不在扫描名单
  await ActivityModel.deleteMany({ userId: new mongoose.Types.ObjectId(uid) });
  await mkActivity({ startTime: at(3, 8, 0) });
  await SubscribeGrantModel.deleteMany({ userId: new mongoose.Types.ObjectId(uid) });
  const noGrant = await runWeeklySportsReminders(NOW);
  assert.equal(noGrant.sent, 0);
  assert.equal(sends.length, 0);
});

test('WS-5 43101：额度作废、记失败；同周不重试', async () => {
  await setWeeklySportsSettings({ enabled: true, templateId: 'TPL_WEEKLY' });
  await recordWeeklySportsGrant(uid, 'message_center');
  await mkActivity({ startTime: at(3, 8, 0) });
  sendResult = { errcode: 43101, errmsg: 'user refuse' };

  const r = await runWeeklySportsReminders(NOW);
  assert.equal(r.failed, 1);
  assert.equal(r.sent, 0);
  const grant = await SubscribeGrantModel.findOne({
    userId: new mongoose.Types.ObjectId(uid), templateKey: WEEKLY_SPORTS_TEMPLATE_KEY,
  }).lean();
  assert.equal(grant?.status, 'invalid');
  assert.equal(grant?.invalidReason, '43101');
  const log = await SubscribeMessageLogModel.findOne({
    dedupeKey: weeklyDedupeKey(uid, bjIsoWeekLabel(WEEK_START)),
  }).lean();
  assert.equal(log?.status, 'failed');
  assert.equal(log?.errcode, 43101);

  const again = await runWeeklySportsReminders(NOW);
  assert.equal(again.sent, 0);
  assert.equal(sends.length, 1, '43101 是终态，同周不重试');
});

test('WS-6 网络失败：删占位，下一轮可重试；额度不消耗', async () => {
  await setWeeklySportsSettings({ enabled: true, templateId: 'TPL_WEEKLY' });
  await recordWeeklySportsGrant(uid, 'message_center');
  await mkActivity({ startTime: at(3, 8, 0) });
  sendThrows = true;

  const first = await runWeeklySportsReminders(NOW);
  assert.equal(first.failed, 1);
  assert.equal(await hasWeeklySportsGrant(uid), true, '失败不消耗额度');
  assert.equal(await SubscribeMessageLogModel.countDocuments({}), 0, '网络失败删掉 sending 占位');

  sendThrows = false;
  const second = await runWeeklySportsReminders(NOW);
  assert.equal(second.sent, 1, '下一轮重试成功');
});

test('WS-7 后台设置：默认关闭；保存后读取生效；非法模板 ID 拒绝', async () => {
  const d = await getWeeklySportsSettings();
  assert.equal(d.enabled, false);
  assert.equal(d.templateId, WEEKLY_SPORTS_TEMPLATE_ID);

  const next = await setWeeklySportsSettings({ enabled: true, templateId: 'TPL_WEEKLY' });
  assert.equal(next.enabled, true);
  assert.equal(next.templateId, 'TPL_WEEKLY');

  const auth = { authorization: `Bearer ${adminToken}` };
  const got = await app.inject({
    method: 'GET', url: `${config.apiPrefix}/admin/xpay/weekly-sports-settings`, headers: auth,
  });
  assert.equal(got.statusCode, 200, got.body);
  assert.equal(got.json().data.enabled, true);

  const put = await app.inject({
    method: 'PUT', url: `${config.apiPrefix}/admin/xpay/weekly-sports-settings`,
    headers: auth, payload: { enabled: false, templateId: 'TPL_NEXT' },
  });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal(put.json().data.enabled, false);
  assert.equal(put.json().data.templateId, 'TPL_NEXT');

  const bad = await app.inject({
    method: 'PUT', url: `${config.apiPrefix}/admin/xpay/weekly-sports-settings`,
    headers: auth, payload: { enabled: true, templateId: '' },
  });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.match(bad.json().message, /模板/);
});

test('WS-9 后台设置接口都要过鉴权，且不许是 404', async () => {
  const cases: Array<['GET' | 'PUT' | 'POST', string, Record<string, unknown> | undefined]> = [
    ['GET', '/admin/xpay/weekly-sports-settings', undefined],
    ['PUT', '/admin/xpay/weekly-sports-settings', { enabled: true, templateId: 'TPL_WEEKLY' }],
    ['POST', '/admin/xpay/weekly-sports-settings/run', undefined],
  ];
  for (const [method, path, payload] of cases) {
    const res = await app.inject({
      method, url: `${config.apiPrefix}${path}`, ...(payload ? { payload } : {}),
    });
    assert.ok(res.statusCode === 401 || res.statusCode === 403, `${method} ${path} 落到了 ${res.statusCode}`);
    assert.notEqual(res.statusCode, 404);
  }
});

test('WS-8 消息订阅列表：两项按开关出现；每周运动数据按本地额度显示已订阅', async () => {
  await setReminderSettings({ enabled: true, templateId: 'TPL_MEMBER', daysBefore: 3 });
  await setWeeklySportsSettings({ enabled: true, templateId: 'TPL_WEEKLY' });

  const first = await listMessageSubscriptions(uid);
  assert.deepEqual(first.items.map((i) => i.key), [MEMBER_EXPIRY_TEMPLATE_KEY, WEEKLY_SPORTS_TEMPLATE_KEY]);
  const weekly = first.items.find((i) => i.key === WEEKLY_SPORTS_TEMPLATE_KEY);
  assert.equal(weekly?.label, '每周运动数据');
  assert.equal(weekly?.description, '每周一 09:00 汇总上周运动数据');
  assert.equal(weekly?.templateId, 'TPL_WEEKLY');
  assert.equal(weekly?.subscribed, false);

  await grantMessageSubscription(uid, WEEKLY_SPORTS_TEMPLATE_KEY, 'message_center');
  const second = await listMessageSubscriptions(uid);
  assert.equal(second.items.find((i) => i.key === WEEKLY_SPORTS_TEMPLATE_KEY)?.subscribed, true);

  await setWeeklySportsSettings({ enabled: false, templateId: 'TPL_WEEKLY' });
  const off = await listMessageSubscriptions(uid);
  assert.deepEqual(off.items.map((i) => i.key), [MEMBER_EXPIRY_TEMPLATE_KEY], '关闭后不列空开关');
  await assert.rejects(
    () => grantMessageSubscription(uid, WEEKLY_SPORTS_TEMPLATE_KEY, 'message_center'),
    /暂未开放/,
  );
});
