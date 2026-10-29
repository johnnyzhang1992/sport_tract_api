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
  for (const u of extraUsers) {
    await NotificationReadModel.deleteMany({ userId: new Types.ObjectId(u.id) });
    await UserModel.deleteOne({ _id: new Types.ObjectId(u.id) });
  }
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

test('NT2 登录 summary：注册前默认已读（最新一条保留未读），注册后正常未读', async () => {
  // 测试用户注册于 before() 开头：A（now-10s）在其之前 → 默认已读但作为「注册前最新一条」保留未读；
  // B（now+100s）在其之后 → 正常未读；库里其余历史通知全部默认已读
  const first = (await get('/notifications/summary')).json().data;
  assert.equal(first.item.id, noticeB, '最新未读 = B（注册后发布）');
  assert.equal(first.unreadCount, 2, 'B + 注册前最新一条 A；其余历史默认已读');

  // 读掉 A（注册前钩子）→ 只剩 B
  const r1 = await post(`/notifications/${noticeA}/read`);
  assert.equal(r1.statusCode, 200, r1.body);
  assert.equal(r1.json().data.unreadCount, 1);

  const second = (await get('/notifications/summary')).json().data;
  assert.equal(second.item.id, noticeB);
  assert.equal(second.unreadCount, 1);

  await post(`/notifications/${noticeB}/read`);
  const third = (await get('/notifications/summary')).json().data;
  assert.equal(third.unreadCount, 0);
  assert.equal(third.item, null, '全部读完 → 首页条消失');
});

test('NT3 列表：注册前默认已读、注册后正常未读；草稿不可见', async () => {
  // NT2 已把 A/B 都读掉：注册前通知（含历史）一律 read:true、未读数归零
  const pre = await get('/notifications');
  const preData = pre.json().data;
  assert.equal(preData.items.find((i: { id: string }) => i.id === noticeA)?.read, true);
  assert.equal(preData.items.find((i: { id: string }) => i.id === noticeB)?.read, true);
  assert.equal(preData.unreadCount, 0, '注册前通知全部默认已读（钩子已读后）');

  // 注册后新发布一条 → 正常未读（已注册用户发布的通知未读就未读）
  const c = await adminReq('POST', '/notifications', {
    title: `${PREFIX}C`,
    content: '注册后发布',
    published: true,
  });
  assert.equal(c.statusCode, 200, c.body);
  madeNotices.push(c.json().data.id);

  const res = await get('/notifications');
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  const ids = data.items.map((i: { id: string }) => i.id);
  // 排序：B 夹具 publishedAt = now+100s（未来）> C（now）> A（now-10s）
  assert.deepEqual(ids.slice(0, 3), [noticeB, c.json().data.id, noticeA], 'B(未来) > C(刚发) > A(最早)');
  assert.ok(!ids.includes(noticeDraft), '未发布通知不能出现在列表');
  assert.equal(data.items.find((i: { id: string }) => i.id === c.json().data.id)?.read, false, '注册后发布的通知未读就未读');
  assert.equal(data.unreadCount, 1);
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

// ==================== Task 8 定向通知（NT-DIR-1..5） ====================
// Notification.userId 可选：null/缺省＝全站广播，非空＝定向（只有收件人可见）。
// 游客与畸形 userId 一律只看广播；定向行不进后台列表（系统流水，不是公告）。

const extraUsers: { id: string; token: string }[] = []; // NT-DIR 临时用户，after 统一清理

/** 现造一个登录用户（openid 唯一即注册） */
async function loginFresh(tag: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: `openid:${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  return { id: String(d.user?.id ?? d.user?._id), token: d.accessToken as string };
}

const getWith = (tok: string, url: string) =>
  app.inject({ method: 'GET', url: `/sport-track/api${url}`, headers: { authorization: `Bearer ${tok}` } });
const postWith = (tok: string, url: string) =>
  app.inject({ method: 'POST', url: `/sport-track/api${url}`, headers: { authorization: `Bearer ${tok}` } });

test('NT-DIR-1 定向通知只对收件人可见，别的用户与列表都查不到', async () => {
  const other = await loginFresh('notif-other');
  extraUsers.push(other);

  const dir = (await adminReq('POST', '/notifications', {
    title: `${PREFIX}DIR1-TO-ME`,
    content: '定向正文',
    published: true,
    userId,
  })).json().data;
  madeNotices.push(dir.id);

  // 收件人：列表与详情都可见
  const mine = (await get('/notifications')).json().data;
  assert.ok(mine.items.some((i: { id: string }) => i.id === dir.id), '收件人列表要看到定向行');
  assert.equal((await get(`/notifications/${dir.id}`)).statusCode, 200, '收件人详情可读');

  // 非收件人：列表没有这一行；详情/标已读按仓内既有口径 404（不外泄「存在但不可见」）
  const theirs = (await getWith(other.token, '/notifications')).json().data;
  assert.ok(!theirs.items.some((i: { id: string }) => i.id === dir.id), '非收件人列表不能出现定向行');
  assert.equal((await getWith(other.token, `/notifications/${dir.id}`)).statusCode, 404, '别人打开定向详情要 404');
  assert.equal((await postWith(other.token, `/notifications/${dir.id}/read`)).statusCode, 404, '别人标已读定向行要 404');

  assert.equal(dir.userId, userId, '创建定向通知要回显收件人');
});

test('NT-DIR-2 广播通知所有人可见（现有行为不回归）', async () => {
  const other = await loginFresh('notif-bcast');
  extraUsers.push(other);

  const bcast = (await adminReq('POST', '/notifications', {
    title: `${PREFIX}DIR2-BROADCAST`,
    content: '广播正文',
    published: true,
  })).json().data;
  madeNotices.push(bcast.id);

  for (const [who, list] of [
    ['主用户', (await get('/notifications')).json().data],
    ['其它用户', (await getWith(other.token, '/notifications')).json().data],
    ['游客', (await getGuest('/notifications')).json().data],
  ] as const) {
    assert.ok(list.items.some((i: { id: string }) => i.id === bcast.id), `广播行 ${who} 的列表必须可见`);
  }
  assert.equal((await getWith(other.token, `/notifications/${bcast.id}`)).statusCode, 200, '广播详情人人可读');
  assert.equal((await getGuest(`/notifications/${bcast.id}`)).statusCode, 200, '游客广播详情可读');
  assert.equal(bcast.userId, null, '未传 userId 的广播行，收件人字段回显 null');
});

test('NT-DIR-3 未读数：一条广播 + 一条定向 = 2，不重复计', async () => {
  const fresh = await loginFresh('notif-unread');
  extraUsers.push(fresh);
  // 共享 dev 库不写死绝对值：先取基线，再断增量
  const base = (await getWith(fresh.token, '/notifications/summary')).json().data.unreadCount as number;

  const b = (await adminReq('POST', '/notifications', {
    title: `${PREFIX}DIR3-BC`,
    content: '广播一条',
    published: true,
  })).json().data;
  const d = (await adminReq('POST', '/notifications', {
    title: `${PREFIX}DIR3-DIR`,
    content: '定向一条',
    published: true,
    userId: fresh.id,
  })).json().data;
  madeNotices.push(b.id, d.id);

  const after = (await getWith(fresh.token, '/notifications/summary')).json().data;
  assert.equal(
    after.unreadCount - base,
    2,
    '广播走 userId:null 分支、定向走 $or 收件人分支；广播若同时被两分支重复计入会得到 3',
  );
  assert.equal((await getWith(fresh.token, `/notifications/${d.id}`)).statusCode, 200, '收件人能打开自己的定向行');
  assert.equal(d.userId, fresh.id, '定向行要回显收件人');
});

test('NT-DIR-4 定向通知不出现在后台通知管理列表（它是系统自动发的流水，不是公告）', async () => {
  const dir = (await adminReq('POST', '/notifications', {
    title: `${PREFIX}DIR4-HIDDEN`,
    content: '系统流水',
    published: true,
    userId,
  })).json().data;
  madeNotices.push(dir.id);
  const bcast = (await adminReq('POST', '/notifications', {
    title: `${PREFIX}DIR4-SHOW`,
    content: '广播公告（草稿）',
    published: false,
  })).json().data;
  madeNotices.push(bcast.id);

  const list = (await adminReq('GET', '/notifications')).json().data as { id: string }[];
  assert.ok(!list.some((n) => n.id === dir.id), '后台列表不能混入定向流水');
  assert.ok(list.some((n) => n.id === bcast.id), '广播草稿仍要出现在后台列表');

  // validateInput：畸形 userId 必须 400，不能静默降级成广播发出去
  const bad = await adminReq('POST', '/notifications', {
    title: `${PREFIX}DIR4-BAD`,
    content: 'x',
    published: true,
    userId: 'not-an-object-id',
  });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.match(bad.json().message, /收件人|userId/);

  // 显式 null＝广播，要正常接受
  const nullUid = (await adminReq('POST', '/notifications', {
    title: `${PREFIX}DIR4-NULL`,
    content: 'x',
    published: true,
    userId: null,
  })).json().data;
  madeNotices.push(nullUid.id);
  assert.equal(nullUid.userId, null, '显式 null 是广播');
});

test('NT-DIR-5 游客看不到任何定向项', async () => {
  const dir = (await adminReq('POST', '/notifications', {
    title: `${PREFIX}DIR5-GUEST`,
    content: '定向正文',
    published: true,
    userId,
  })).json().data;
  madeNotices.push(dir.id);

  const guestList = (await getGuest('/notifications')).json().data;
  assert.ok(
    !guestList.items.some((i: { id: string }) => i.id === dir.id),
    '游客列表不能出现定向行',
  );
  assert.equal((await getGuest(`/notifications/${dir.id}`)).statusCode, 404, '游客打开定向详情要 404');
  const guestSummary = (await getGuest('/notifications/summary')).json().data;
  assert.notEqual(guestSummary.item?.id, dir.id, '游客首页条不能取到定向行');
});

// ==================== NR 一键全读（消息中心「全部已读」） ====================

test('NR-1 read-all：全部未读清零，列表全 read，幂等重放不炸', async () => {
  const me = await loginFresh('notif-ra');
  extraUsers.push(me);
  const tick = () => new Promise<void>((r) => setImmediate(r));
  // 本用例造的广播用完即删（NT2/NT3 对未读数做绝对断言，留一行都会毒化后面的用例）
  const myNotices: Types.ObjectId[] = [];

  // 共享 dev 库里有别的运行留下的广播：未读数全部用相对值断言
  const base = (await getWith(me.token, '/notifications')).json().data.unreadCount;

  // 三条已发布广播：刚注册的用户全未读
  for (const i of [1, 2, 3]) {
    const doc = await NotificationModel.create({
      title: `公告 ${i}`, content: '内容', published: true, publishedAt: Date.now() + i, userId: null,
    });
    myNotices.push(doc._id);
  }
  await tick();
  const before = await getWith(me.token, '/notifications');
  assert.equal(before.json().data.unreadCount, base + 3, '新发三条全部计入未读');

  const first = await postWith(me.token, '/notifications/read-all');
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().data.unreadCount, 0, 'read-all 后未读清零（含存量）');

  // 列表全 read
  const after = await getWith(me.token, '/notifications');
  assert.ok(after.json().data.items.every((it: { read: boolean }) => it.read));

  // 幂等：再来一次不炸、仍是 0
  const replay = await postWith(me.token, '/notifications/read-all');
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().data.unreadCount, 0);

  // 部分已读后的增量路径：单条新公告 → 未读 1 → 再 read-all 清零
  const extra = await NotificationModel.create({
    title: '新公告', content: '内容', published: true, publishedAt: Date.now() + 100, userId: null,
  });
  myNotices.push(extra._id);
  await tick();
  const mid = await getWith(me.token, '/notifications');
  assert.equal(mid.json().data.unreadCount, 1);
  await postWith(me.token, '/notifications/read-all');
  assert.equal((await getWith(me.token, '/notifications')).json().data.unreadCount, 0);

  // 清场：本用例的广播全删（含已读行），不给 NT2/NT3 的绝对断言留脏数据
  await NotificationModel.deleteMany({ _id: { $in: myNotices } });
  await NotificationReadModel.deleteMany({ notificationId: { $in: myNotices } });
});

test('NR-2 read-all 需登录：游客 401', async () => {
  const res = await app.inject({ method: 'POST', url: '/sport-track/api/notifications/read-all' });
  assert.equal(res.statusCode, 401);
});
