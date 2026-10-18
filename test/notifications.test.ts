import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import { NotificationModel } from '../src/models/notification.model.js';
import { NotificationReadModel } from '../src/models/notification-read.model.js';
import { UserModel } from '../src/models/user.model.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';

/**
 * 系统通知公开接口：/notifications/summary、/notifications、/notifications/:id、
 * /notifications/:id/read。dev 库里可能已有别的通知，断言用「自己种的那几条 + 相对数量」，
 * 不写死全表绝对值。
 */

const PREFIX = `IT-NOTIF-${Date.now()}-`;
let app: FastifyInstance;
let token = '';
let userId = '';
let noticeA = ''; // 较早发布
let noticeB = ''; // 最新发布
let noticeDraft = ''; // 未发布

const ADMIN_USER = 'test_admin_notification';
const ADMIN_PASS = 'admin_pass_123';
let adminToken = '';
const madeNotices: string[] = [];

const auth = () => ({ authorization: `Bearer ${token}` });
const get = (url: string) =>
  app.inject({ method: 'GET', url: `/sport-track/api${url}`, headers: auth() });
const getGuest = (url: string) =>
  app.inject({ method: 'GET', url: `/sport-track/api${url}` });
const post = (url: string, headers: Record<string, string> = auth()) =>
  app.inject({ method: 'POST', url: `/sport-track/api${url}`, headers });

async function publishedCount(): Promise<number> {
  return NotificationModel.countDocuments({ published: true });
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: `openid:notif-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  assert.equal(login.statusCode, 200, login.body);
  const data = login.json().data;
  userId = data.user?.id ?? data.user?._id;
  token = data.accessToken;

  const now = Date.now();
  const a = await NotificationModel.create({
    title: `${PREFIX}A`,
    content: '第一行\n第二行',
    published: true,
    publishedAt: now - 10_000,
  });
  const b = await NotificationModel.create({
    title: `${PREFIX}B`,
    content: '最新通知正文\n带换行',
    published: true,
    publishedAt: now + 100_000, // 保证比库里任何既有通知都新
  });
  const d = await NotificationModel.create({
    title: `${PREFIX}DRAFT`,
    content: '草稿不该被看到',
    published: false,
    publishedAt: null,
  });
  noticeA = String(a._id);
  noticeB = String(b._id);
  noticeDraft = String(d._id);

  const existing = await AdminModel.findOne({ username: ADMIN_USER });
  if (existing) {
    existing.passwordHash = await hashPassword(ADMIN_PASS);
    await existing.save();
  } else {
    await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  }
  const adminLogin = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/login',
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  adminToken = adminLogin.json().data.token;
  assert.ok(adminToken, '测试管理员应登录成功');
});

after(async () => {
  await NotificationReadModel.deleteMany({ userId: new Types.ObjectId(userId) });
  await NotificationModel.deleteMany({ title: new RegExp(`^${PREFIX}`) });
  await NotificationModel.deleteMany({ _id: { $in: madeNotices.map((id) => new Types.ObjectId(id)) } });
  await NotificationReadModel.deleteMany({
    notificationId: { $in: madeNotices.map((id) => new Types.ObjectId(id)) },
  });
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await UserModel.deleteMany({ _id: new Types.ObjectId(userId) });
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

test('NT1 游客 summary：最新已发布 + unreadCount=0', async () => {
  const res = await getGuest('/notifications/summary');
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.equal(data.item.id, noticeB, '游客看最新一条已发布');
  assert.equal(data.item.title, `${PREFIX}B`);
  assert.equal(data.unreadCount, 0, '游客没有已读概念');
});

test('NT2 登录 summary：未读 = 已发布数，按已读递减，读完为空', async () => {
  const total = await publishedCount();
  const first = (await get('/notifications/summary')).json().data;
  assert.equal(first.item.id, noticeB, '最新一条未读');
  assert.equal(first.unreadCount, total, '新用户一条都没读过');

  const r1 = await post(`/notifications/${noticeA}/read`);
  assert.equal(r1.statusCode, 200, r1.body);
  assert.equal(r1.json().data.unreadCount, total - 1);

  const second = (await get('/notifications/summary')).json().data;
  assert.equal(second.item.id, noticeB, '读掉较早那条不影响最新未读');
  assert.equal(second.unreadCount, total - 1);

  await post(`/notifications/${noticeB}/read`);
  const third = (await get('/notifications/summary')).json().data;
  assert.equal(third.unreadCount, total - 2);
  if (total - 2 === 0) {
    assert.equal(third.item, null, '全部读完 → 首页条消失');
  } else {
    assert.ok(third.item, '还有别的未读 → 顶上一条');
    assert.notEqual(third.item.id, noticeA);
    assert.notEqual(third.item.id, noticeB);
  }
});

test('NT3 列表：只含已发布、publishedAt 倒序、read 标记正确；草稿不可见', async () => {
  // 自己先把两条读掉，不依赖 NT2 的执行顺序（重复上报是幂等的）
  await post(`/notifications/${noticeA}/read`);
  await post(`/notifications/${noticeB}/read`);
  const res = await get('/notifications');
  const data = res.json().data;
  const ids = data.items.map((i: { id: string }) => i.id);
  assert.ok(ids.indexOf(noticeB) < ids.indexOf(noticeA), 'B 比 A 新，排在前面');
  assert.ok(!ids.includes(noticeDraft), '未发布通知不能出现在列表');
  const a = data.items.find((i: { id: string }) => i.id === noticeA);
  const b = data.items.find((i: { id: string }) => i.id === noticeB);
  assert.equal(a.read, true, '上面已标读 A');
  assert.equal(b.read, true, '上面已标读 B');
  assert.equal(data.unreadCount, (await publishedCount()) - 2);
});

test('NT4 详情：已发布返回正文（换行原样）；未发布/非法 id → 404', async () => {
  const ok = await get(`/notifications/${noticeB}`);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().data.content, '最新通知正文\n带换行', '换行必须原样下发');

  assert.equal((await get(`/notifications/${noticeDraft}`)).statusCode, 404);
  assert.equal((await get('/notifications/not-an-object-id')).statusCode, 404);
});

test('NT5 已读幂等：同一用户重复上报只留一条记录', async () => {
  await post(`/notifications/${noticeA}/read`);
  await post(`/notifications/${noticeA}/read`);
  const count = await NotificationReadModel.countDocuments({
    userId: new Types.ObjectId(userId),
    notificationId: new Types.ObjectId(noticeA),
  });
  assert.equal(count, 1);
});

test('NT6 已读要登录；未发布通知不能标已读', async () => {
  assert.equal((await post(`/notifications/${noticeA}/read`, {})).statusCode, 401);
  assert.equal((await post(`/notifications/${noticeDraft}/read`)).statusCode, 404);
});

const adminReq = (method: string, path: string, body?: unknown) =>
  app.inject({
    method: method as never,
    url: `/sport-track/api/admin${path}`,
    headers: { authorization: `Bearer ${adminToken}` },
    ...(body ? { payload: body as object } : {}),
  });

test('NT7 管理端创建/更新：校验标题与正文，校验失败 400 且提示具体', async () => {
  const ok = await adminReq('POST', '/notifications', {
    title: `${PREFIX}ADMIN`,
    content: '管理端正文\r\n第二行',
    published: true,
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const created = ok.json().data;
  madeNotices.push(created.id);
  assert.equal(created.content, '管理端正文\n第二行', '入库前统一换行符');
  assert.equal(created.published, true);
  assert.ok(created.publishedAt > 0, '发布时写 publishedAt');

  const noTitle = await adminReq('POST', '/notifications', { title: '  ', content: 'x' });
  assert.equal(noTitle.statusCode, 400);
  assert.match(noTitle.json().message, /标题/);

  const longTitle = await adminReq('POST', '/notifications', {
    title: 'x'.repeat(61),
    content: 'x',
  });
  assert.equal(longTitle.statusCode, 400);
  assert.match(longTitle.json().message, /60/);

  const noContent = await adminReq('POST', '/notifications', { title: '标题', content: '   ' });
  assert.equal(noContent.statusCode, 400);
  assert.match(noContent.json().message, /正文/);

  const longContent = await adminReq('POST', '/notifications', {
    title: '标题',
    content: 'x'.repeat(5001),
  });
  assert.equal(longContent.statusCode, 400);
  assert.match(longContent.json().message, /5000/);

  // 更新（PUT）走 partial 校验，同样要在这两条边界上拦下来
  const putNoTitle = await adminReq('PUT', `/notifications/${created.id}`, { title: '  ' });
  assert.equal(putNoTitle.statusCode, 400, putNoTitle.body);
  assert.match(putNoTitle.json().message, /标题/);

  const putLongContent = await adminReq('PUT', `/notifications/${created.id}`, {
    content: 'x'.repeat(5001),
  });
  assert.equal(putLongContent.statusCode, 400, putLongContent.body);
  assert.match(putLongContent.json().message, /5000/);
});

test('NT8 管理端列表/删除：删除通知级联清理已读行', async () => {
  // 自己建一条，不依赖 NT7 的产物（单独跑本用例也要能过）
  const created = (await adminReq('POST', '/notifications', {
    title: `${PREFIX}CASCADE`,
    content: '将被删除',
    published: true,
  })).json().data;
  madeNotices.push(created.id);

  await post(`/notifications/${created.id}/read`);
  const before = await NotificationReadModel.countDocuments({
    notificationId: new Types.ObjectId(created.id),
  });
  assert.equal(before, 1);

  // 管理端列表要含草稿
  const draft = (await adminReq('POST', '/notifications', {
    title: `${PREFIX}DRAFT-LIST`,
    content: '草稿也要在后台可见',
    published: false,
  })).json().data;
  madeNotices.push(draft.id);

  const list = await adminReq('GET', '/notifications');
  assert.equal(list.statusCode, 200, list.body);
  assert.ok(list.json().data.some((n: { id: string }) => n.id === created.id));

  const draftRow = list.json().data.find((n: { id: string }) => n.id === draft.id);
  assert.ok(draftRow, '未发布通知也要出现在管理端列表');
  assert.equal(draftRow.published, false);

  const times = list.json().data.map((n: { createdAt: number }) => n.createdAt);
  assert.deepEqual(times, [...times].sort((a, b) => b - a), '管理端按 createdAt 倒序');

  const del = await adminReq('DELETE', `/notifications/${created.id}`);
  assert.equal(del.statusCode, 200, del.body);
  const left = await NotificationReadModel.countDocuments({
    notificationId: new Types.ObjectId(created.id),
  });
  assert.equal(left, 0, '删除通知要连带清掉已读行');
});

test('NT9 未发布→发布 刷新 publishedAt；下架后公开接口不可见', async () => {
  const created = (await adminReq('POST', '/notifications', {
    title: `${PREFIX}REPUB`,
    content: '先草稿',
    published: false,
  })).json().data;
  madeNotices.push(created.id);
  assert.equal(created.publishedAt, null, '草稿没有发布时间');

  const pub1 = (await adminReq('PUT', `/notifications/${created.id}`, { published: true })).json().data;
  assert.ok(pub1.publishedAt > 0);

  await new Promise((r) => setTimeout(r, 5));
  await adminReq('PUT', `/notifications/${created.id}`, { published: false });
  assert.equal((await getGuest(`/notifications/${created.id}`)).statusCode, 404, '下架后详情 404');

  const pub2 = (await adminReq('PUT', `/notifications/${created.id}`, { published: true })).json().data;
  assert.ok(pub2.publishedAt > pub1.publishedAt, '重新发布要回到列表顶部');
});
