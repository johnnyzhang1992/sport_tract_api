import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import { NotificationModel } from '../src/models/notification.model.js';
import { NotificationReadModel } from '../src/models/notification-read.model.js';
import { SubscribeGrantModel } from '../src/models/subscribe-grant.model.js';
import { UserModel } from '../src/models/user.model.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import {
  getReminderSettings,
  setReminderSettings,
  resetReminderSettingsCacheForTest,
  MEMBER_EXPIRY_TEMPLATE_ID,
} from '../src/services/member-reminder.js';
import {
  getWeeklySportsSettings,
  setWeeklySportsSettings,
  resetWeeklySportsSettingsCacheForTest,
} from '../src/services/weekly-sports-reminder.js';

/**
 * 消息中心（2026-11-04）：分类 + 搜索 + 只看未读 + 分类计数 + 模板订阅状态。
 * dev 库里有别的运行留下的通知，所以所有断言都绑定本文件造的 id/唯一前缀，不写死全表绝对值。
 */

const PREFIX = `NC-${Date.now()}-`;
const TOKEN = `中心检索词${Date.now()}`;
let app: FastifyInstance;
let adminToken = '';
const ADMIN_USER = 'test_admin_notification_center';
const ADMIN_PASS = 'admin_pass_123';
const madeNotices: string[] = [];
const users: { id: string; token: string }[] = [];

const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
const getWith = (tok: string, url: string) =>
  app.inject({ method: 'GET', url: `/sport-track/api${url}`, headers: auth(tok) });
const getGuest = (url: string) => app.inject({ method: 'GET', url: `/sport-track/api${url}` });
const postWith = (tok: string, url: string, payload?: object) =>
  app.inject({ method: 'POST', url: `/sport-track/api${url}`, headers: auth(tok), ...(payload ? { payload } : {}) });
const adminReq = (method: string, path: string, body?: unknown) =>
  app.inject({
    method: method as never,
    url: `/sport-track/api/admin${path}`,
    headers: auth(adminToken),
    ...(body ? { payload: body as object } : {}),
  });

async function loginFresh(tag: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: `openid:nc-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  const u = { id: String(d.user?.id ?? d.user?._id), token: d.accessToken as string };
  users.push(u);
  return u;
}

async function makeNotice(input: {
  title: string;
  content: string;
  category?: string;
  publishedAt?: number;
}) {
  const doc = await NotificationModel.create({
    title: input.title,
    content: input.content,
    category: input.category,
    published: true,
    publishedAt: input.publishedAt ?? Date.now() + madeNotices.length + 1,
  });
  madeNotices.push(String(doc._id));
  return String(doc._id);
}

function idsOf(data: { items: Array<{ id: string }> }): string[] {
  return data.items.map((i) => i.id);
}

function itemOf(
  data: { items: Array<{ id: string; category?: string; categoryText?: string; read?: boolean }> },
  id: string,
) {
  return data.items.find((i) => i.id === id);
}

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
  assert.ok(adminToken, '测试管理员应登录成功');
});

after(async () => {
  for (const u of users) {
    await NotificationReadModel.deleteMany({ userId: new Types.ObjectId(u.id) });
    await SubscribeGrantModel.deleteMany({ userId: new Types.ObjectId(u.id) });
    await UserModel.deleteOne({ _id: new Types.ObjectId(u.id) });
  }
  await NotificationModel.deleteMany({ _id: { $in: madeNotices.map((id) => new Types.ObjectId(id)) } });
  await NotificationReadModel.deleteMany({
    notificationId: { $in: madeNotices.map((id) => new Types.ObjectId(id)) },
  });
  await AdminModel.deleteOne({ username: ADMIN_USER });
  resetReminderSettingsCacheForTest();
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

test('NC1 分类筛选：只回指定分类；老数据缺 category 归入系统通知', async () => {
  const me = await loginFresh('cat');
  const member = await makeNotice({
    title: `${PREFIX}cat-member`,
    content: '会员正文',
    category: 'member',
  });
  const reward = await makeNotice({
    title: `${PREFIX}cat-reward`,
    content: '奖励正文',
    category: 'reward',
  });
  const system = await makeNotice({
    title: `${PREFIX}cat-system`,
    content: '系统正文',
    category: 'system',
  });

  // 模拟上线前的老行：直接走 collection，绕过 schema 默认值
  const legacy = await NotificationModel.collection.insertOne({
    title: `${PREFIX}cat-legacy`,
    content: '老数据没有分类字段',
    published: true,
    publishedAt: Date.now() + 10_000,
    userId: null,
    dedupeKey: null,
  });
  madeNotices.push(String(legacy.insertedId));

  const memberList = (await getWith(me.token, `/notifications?q=${encodeURIComponent(PREFIX + 'cat-')}&category=member`)).json().data;
  assert.deepEqual(idsOf(memberList), [member], 'category=member 只回会员行');
  assert.equal(itemOf(memberList, member)?.categoryText, '会员服务');

  const systemList = (await getWith(me.token, `/notifications?q=${encodeURIComponent(PREFIX + 'cat-')}&category=system`)).json().data;
  assert.ok(idsOf(systemList).includes(system), '显式 system 行要出现');
  assert.ok(idsOf(systemList).includes(String(legacy.insertedId)), '缺字段的老行要归入系统通知');
  assert.ok(!idsOf(systemList).includes(reward), '系统筛选不能混入奖励行');

  const bad = await getWith(me.token, '/notifications?category=unknown');
  assert.equal(bad.statusCode, 400, bad.body);
  assert.match(bad.json().message, /分类/, `文案要点名分类：${bad.body}`);
});

test('NC2 搜索：标题/正文都能搜到，大小写不敏感，正则元字符按字面处理', async () => {
  const me = await loginFresh('search');
  const inTitle = await makeNotice({ title: `${PREFIX}s-title ${TOKEN}`, content: '普通正文' });
  const inContent = await makeNotice({ title: `${PREFIX}s-content`, content: `正文里含${TOKEN}` });
  const literalRegex = await makeNotice({ title: `${PREFIX}s-regex ${TOKEN}.*`, content: '字面量' });
  const noRegex = await makeNotice({ title: `${PREFIX}s-noregex`, content: `不含元字符的${TOKEN}` });

  const byToken = (await getWith(me.token, `/notifications?q=${encodeURIComponent(TOKEN)}`)).json().data;
  const ids = idsOf(byToken);
  assert.ok(ids.includes(inTitle), '标题命中');
  assert.ok(ids.includes(inContent), '正文命中');
  assert.ok(ids.includes(literalRegex));
  assert.ok(ids.includes(noRegex));

  const byRegexToken = (await getWith(me.token, `/notifications?q=${encodeURIComponent(`${TOKEN}.*`)}`)).json().data;
  assert.deepEqual(idsOf(byRegexToken), [literalRegex], '.* 要当字面量，不能变成通配');

  const lower = (await getWith(me.token, `/notifications?q=${encodeURIComponent(TOKEN.toLowerCase())}`)).json().data;
  assert.ok(idsOf(lower).includes(inTitle), '英文大小写不敏感');

  const long = await getWith(me.token, `/notifications?q=${encodeURIComponent('x'.repeat(51))}`);
  assert.equal(long.statusCode, 400, long.body);
  assert.match(long.json().message, /50/);
});

test('NC3 只看未读：只回未读；分类列表带未读计数且只列有数据的分类', async () => {
  const me = await loginFresh('unread');
  const a = await makeNotice({ title: `${PREFIX}u-a`, content: 'a', category: 'member' });
  const b = await makeNotice({ title: `${PREFIX}u-b`, content: 'b', category: 'member' });
  const c = await makeNotice({ title: `${PREFIX}u-c`, content: 'c', category: 'reward' });

  const all = (await getWith(me.token, `/notifications?q=${encodeURIComponent(PREFIX + 'u-')}`)).json().data;
  assert.equal(all.total, 3);
  assert.deepEqual(idsOf(all).sort(), [a, b, c].sort());

  const catsBefore = all.categories as Array<{ key: string; label: string; unreadCount: number }>;
  const memberBefore = catsBefore.find((x) => x.key === 'member');
  assert.ok(memberBefore, '本文件的 member 行要出现在分类里');
  assert.equal(memberBefore?.label, '会员服务');
  assert.ok((memberBefore?.unreadCount ?? 0) >= 1);

  await postWith(me.token, `/notifications/${b}/read`);
  const unread = (await getWith(me.token, `/notifications?q=${encodeURIComponent(PREFIX + 'u-')}&unread=1`)).json().data;
  assert.equal(unread.total, 2);
  assert.deepEqual(idsOf(unread).sort(), [a, c].sort(), '已读的 b 不能出现');

  const withRead = (await getWith(me.token, `/notifications?q=${encodeURIComponent(PREFIX + 'u-')}`)).json().data;
  assert.equal(itemOf(withRead, b)?.read, true);
  assert.equal(itemOf(withRead, a)?.read, false);

  const memberAfter = (withRead.categories as Array<{ key: string; unreadCount: number }>).find((x) => x.key === 'member');
  assert.equal(
    (memberAfter?.unreadCount ?? 0) + 1,
    memberBefore?.unreadCount,
    '读掉 b 后 member 分类未读数要减 1（共享库其它行不动）',
  );
});

test('NC4 全部已读：清空当前用户所有未读（含搜索命中的分类）', async () => {
  const me = await loginFresh('readall');
  const a = await makeNotice({ title: `${PREFIX}ra-a`, content: 'a', category: 'member' });
  const b = await makeNotice({ title: `${PREFIX}ra-b`, content: 'b', category: 'reward' });
  const before = (await getWith(me.token, `/notifications?q=${encodeURIComponent(PREFIX + 'ra-')}`)).json().data;
  assert.equal(before.total, 2);

  const res = await postWith(me.token, '/notifications/read-all');
  assert.equal(res.statusCode, 200, res.body);

  const after = (await getWith(me.token, `/notifications?q=${encodeURIComponent(PREFIX + 'ra-')}&unread=1`)).json().data;
  assert.equal(after.total, 0, '全部已读后只看未读应为空');
  const all = (await getWith(me.token, `/notifications?q=${encodeURIComponent(PREFIX + 'ra-')}`)).json().data;
  assert.deepEqual(idsOf(all).sort(), [a, b].sort());
  assert.ok(all.items.every((i: { read: boolean }) => i.read));
});

test('NC5 详情带分类与分类文案', async () => {
  const me = await loginFresh('detail');
  const id = await makeNotice({ title: `${PREFIX}d-member`, content: '详情正文', category: 'member' });
  const res = await getWith(me.token, `/notifications/${id}`);
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.equal(data.category, 'member');
  assert.equal(data.categoryText, '会员服务');
});

test('NC6 消息订阅：状态来自本地额度台账；已消耗就不算已订阅；开关关闭不列项', async () => {
  const me = await loginFresh('sub');
  const original = await getReminderSettings();
  const originalWeekly = await getWeeklySportsSettings();
  resetReminderSettingsCacheForTest();
  resetWeeklySportsSettingsCacheForTest();
  await setReminderSettings({
    enabled: true,
    templateId: MEMBER_EXPIRY_TEMPLATE_ID,
    daysBefore: 3,
  });
  // 本用例只验证会员到期提醒；把每周运动数据显式关掉，避免共享库残留让「只有一项」失真
  await setWeeklySportsSettings({ enabled: false, templateId: originalWeekly.templateId });

  try {
    const first = (await getWith(me.token, '/notifications/subscriptions')).json().data;
    assert.equal(first.items.length, 1, '当前只有一个真正会下发的订阅模板');
    assert.equal(first.items[0].key, 'memberExpiry');
    assert.equal(first.items[0].label, '会员到期提醒');
    assert.equal(first.items[0].templateId, MEMBER_EXPIRY_TEMPLATE_ID);
    assert.equal(first.items[0].subscribed, false);
    assert.equal(first.items[0].subscribeType, '一次性订阅', '消息类型标注（工具类目仅一次性模板）');
    assert.match(first.items[0].description, /3 天/);

    const grant = await postWith(me.token, '/notifications/subscriptions/grant', {
      key: 'memberExpiry',
      scene: 'message_center',
    });
    assert.equal(grant.statusCode, 200, grant.body);
    assert.equal(grant.json().data.subscribed, true);

    const second = (await getWith(me.token, '/notifications/subscriptions')).json().data;
    assert.equal(second.items[0].subscribed, true, '有一条未消耗额度就算已订阅');

    await SubscribeGrantModel.updateMany(
      { userId: new Types.ObjectId(me.id), templateKey: 'memberExpiry' },
      { $set: { status: 'consumed', consumedAt: Date.now() } },
    );
    const consumed = (await getWith(me.token, '/notifications/subscriptions')).json().data;
    assert.equal(consumed.items[0].subscribed, false, '额度消耗完（一次性订阅）就不再是已订阅');

    await setReminderSettings({ enabled: false, templateId: MEMBER_EXPIRY_TEMPLATE_ID, daysBefore: 3 });
    const off = (await getWith(me.token, '/notifications/subscriptions')).json().data;
    assert.deepEqual(off.items, [], '开关关闭时不列不可用的订阅');
    const offGrant = await postWith(me.token, '/notifications/subscriptions/grant', { key: 'memberExpiry' });
    assert.equal(offGrant.statusCode, 403, offGrant.body);

    const badKey = await postWith(me.token, '/notifications/subscriptions/grant', { key: 'nope' });
    assert.equal(badKey.statusCode, 400, badKey.body);
    assert.match(badKey.json().message, /订阅/);
  } finally {
    await setReminderSettings(original);
    await setWeeklySportsSettings(originalWeekly);
    resetReminderSettingsCacheForTest();
    resetWeeklySportsSettingsCacheForTest();
  }
});

test('NC7 订阅接口需登录', async () => {
  assert.equal((await getGuest('/notifications/subscriptions')).statusCode, 401);
  const grant = await app.inject({
    method: 'POST',
    url: '/sport-track/api/notifications/subscriptions/grant',
    payload: { key: 'memberExpiry' },
  });
  assert.equal(grant.statusCode, 401, grant.body);
});

test('NC8 管理端：创建/更新带分类，非法分类 400，缺省为系统通知', async () => {
  const created = await adminReq('POST', '/notifications', {
    title: `${PREFIX}admin-reward`,
    content: '后台奖励公告',
    published: true,
    category: 'reward',
  });
  assert.equal(created.statusCode, 200, created.body);
  madeNotices.push(created.json().data.id);
  assert.equal(created.json().data.category, 'reward');
  assert.equal(created.json().data.categoryText, '榜单奖励');

  const list = (await adminReq('GET', '/notifications')).json().data as Array<{
    id: string;
    category: string;
    categoryText: string;
  }>;
  const row = list.find((n) => n.id === created.json().data.id);
  assert.equal(row?.category, 'reward', '后台列表要回分类');
  assert.equal(row?.categoryText, '榜单奖励');

  const updated = await adminReq('PUT', `/notifications/${created.json().data.id}`, { category: 'member' });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().data.category, 'member');

  const bad = await adminReq('POST', '/notifications', {
    title: `${PREFIX}admin-bad`,
    content: 'x',
    published: true,
    category: 'nope',
  });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.match(bad.json().message, /分类/);

  const defaulted = await adminReq('POST', '/notifications', {
    title: `${PREFIX}admin-default`,
    content: '不传分类',
    published: true,
  });
  assert.equal(defaulted.statusCode, 200, defaulted.body);
  madeNotices.push(defaulted.json().data.id);
  assert.equal(defaulted.json().data.category, 'system');
  assert.equal(defaulted.json().data.categoryText, '系统通知');
});
