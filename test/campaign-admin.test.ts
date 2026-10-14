/**
 * 一起运动活动（campaign）：webAdmin 只读接口（Task 7）。
 *
 * 与前几个 campaign 测试文件（断言直接打在 service 上）不同，本文件走**真实 HTTP**：
 * 管理员登录拿 admin token → app.inject 两条只读接口，钉住「路由注册 + 鉴权 + 入参解析 + 状态码」。
 *
 * 夹具形状照 `test/campaign-routes.test.ts`（loginMock / auth / get / post 小工具 + createdIds 只清自己建的），
 * admin token 取法照 `test/admin-footprints.test.ts`（AdminModel.create + POST /admin/login）。
 *
 * 时间窗一律用**远期**（2099）：effectiveStatus 按 now 派生（now >= endAt 即 ended），
 * 写死的历史窗口会让 join 立刻 403，用例会因「今天是哪天」而红绿飘忽。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { UserModel } from '../src/models/user.model.js';
import { CampaignModel } from '../src/models/campaign.model.js';
import { CampaignMemberModel } from '../src/models/campaign-member.model.js';

const API = '/sport-track/api';
const ADMIN_USER = 'test_admin_campaign';
const ADMIN_PASS = 'admin_pass_123';
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;

type Who = { id: string; token: string };

let creator: Who;
let joiner: Who;
let adminToken = '';

/** 夹具活动的 id 与发起人的**编号** uid（下发的 creatorUid/uid 是这个，不是 _id） */
let cid = '';
/** 三态过滤夹具：active（远期）/ ended（库内 active 但 endAt 已过）/ dissolved（已解散） */
let cidActive = '';
let cidEnded = '';
let cidDissolved = '';
let creatorUid: number | null = null;

/** 本文件创建的 campaign id：after() 只清这些，不碰 dev 库里既有数据 */
const createdIds: mongoose.Types.ObjectId[] = [];

/** 管理员登录拿 admin token（独立 JWT secret，普通用户 token 打 admin 接口必 401） */
async function ensureAdmin() {
  const existing = await AdminModel.findOne({ username: ADMIN_USER });
  if (existing) {
    existing.passwordHash = await hashPassword(ADMIN_PASS);
    await existing.save();
  } else {
    await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  }
  const login = await app.inject({
    method: 'POST',
    url: `${API}/admin/login`,
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  adminToken = login.json().data.token;
  assert.ok(adminToken, '管理员登录应拿到 token');
}

/** 登录拿 token（mock 登录：任意 code 直接换测试 openid） */
async function loginMock(openid: string): Promise<Who> {
  const res = await app.inject({
    method: 'POST',
    url: `${API}/auth/login`,
    payload: { code: openid },
  });
  assert.equal(res.statusCode, 200, `登录失败: ${res.body}`);
  const data = res.json().data;
  return { id: data.user?.id ?? data.user?._id, token: data.accessToken };
}

const auth = (token?: string) => (token ? { authorization: `Bearer ${token}` } : {});

const get = (url: string, token?: string): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'GET', url: `${API}${url}`, headers: auth(token) });

const post = (url: string, payload: Record<string, unknown>, token?: string): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'POST', url: `${API}${url}`, payload, headers: auth(token) });

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await ensureAdmin();
  creator = await loginMock('mock_openid_campaign_admin_creator');
  joiner = await loginMock('mock_openid_campaign_admin_joiner');
  // 下发的 uid 是用户编号（user.uid），不是 _id；从库里取真值来钉（mock 登录会补号）
  creatorUid = (await UserModel.findById(creator.id).select('uid').lean())?.uid ?? null;
  assert.equal(typeof creatorUid, 'number', '夹具发起人应有 uid 编号');

  // 隐私活动（远期窗口）：joiner 申请 → 发起人审批通过 → 2 名 joined 成员
  const created = await post(
    '/campaigns',
    {
      title: 'admin 只读回归',
      description: '',
      visibility: 'private',
      allowedTypes: [],
      memberLimit: null,
      startDate: '2099-01-01',
      endDate: '2099-01-07',
    },
    creator.token,
  );
  assert.equal(created.statusCode, 200, `创建活动失败: ${created.body}`);
  cid = created.json().data.id;
  cidActive = cid;
  createdIds.push(new mongoose.Types.ObjectId(cid));

  const applied = await post(`/campaigns/${cid}/join`, {}, joiner.token);
  assert.equal(applied.statusCode, 200, `申请加入失败: ${applied.body}`);
  assert.equal(applied.json().data.myState, 'pending');

  const approved = await post(`/campaigns/${cid}/approve`, { userId: joiner.id }, creator.token);
  assert.equal(approved.statusCode, 200, `审批失败: ${approved.body}`);

  // ended 档夹具：绕开 POST /campaigns（zod 会拒过期日期），直接用模型造一条
  // 「库内 status 仍是 active、但 endAt 已过」的活动 —— 这正是派生状态与库内状态分叉的那类。
  const now = Date.now();
  const endedDoc = await CampaignModel.create({
    creatorId: new mongoose.Types.ObjectId(creator.id),
    title: 'admin 已到期回归',
    description: '',
    visibility: 'private',
    allowedTypes: [],
    memberLimit: null,
    startAt: now - 7 * DAY,
    endAt: now - 1 * DAY,
    status: 'active',
  });
  cidEnded = String(endedDoc._id);
  createdIds.push(endedDoc._id);

  // dissolved 档夹具：正常建一条再解散（dissolveCampaign 会把库内 status 写成 'dissolved'）
  const diss = await post(
    '/campaigns',
    {
      title: 'admin 已解散回归',
      description: '',
      visibility: 'private',
      allowedTypes: [],
      memberLimit: null,
      startDate: '2099-01-01',
      endDate: '2099-01-07',
    },
    creator.token,
  );
  assert.equal(diss.statusCode, 200, `创建待解散活动失败: ${diss.body}`);
  cidDissolved = diss.json().data.id;
  createdIds.push(new mongoose.Types.ObjectId(cidDissolved));
  const del = await app.inject({
    method: 'DELETE',
    url: `${API}/campaigns/${cidDissolved}`,
    headers: auth(creator.token),
  });
  assert.equal(del.statusCode, 200, `解散失败: ${del.body}`);
});

after(async () => {
  await CampaignMemberModel.deleteMany({ campaignId: { $in: createdIds } });
  await CampaignModel.deleteMany({ _id: { $in: createdIds } });
  await UserModel.deleteMany({ _id: { $in: [creator.id, joiner.id] } });
  await app.close();
});

test('CA1 admin 列表：分页 + 下发创建者与成员数', async () => {
  const res = await get('/admin/campaigns?page=1&pageSize=20', adminToken);
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  assert.equal(d.page, 1);
  assert.equal(d.pageSize, 20);
  assert.ok(d.total >= 1);
  const item = d.items.find((x: any) => x.id === cid);
  assert.ok(item, '列表应含刚建的活动');
  assert.equal(item.joinedCount, 2); // 发起人 + 已审批的 joiner
  assert.equal(item.pendingCount, 0);
  assert.equal(item.creatorUid, creatorUid);
  assert.equal(item.status, 'active');
});

test('CA2 admin 列表：status 过滤与下发值同口径（三个档位互斥、各含命中项）', async () => {
  // 夹具：cidActive(2099) / cidEnded(过去 endAt，库内 status 仍是 active) / cidDissolved(已解散)
  const ids = (d: any) => d.items.map((x: any) => x.id);

  const active = (await get('/admin/campaigns?status=active&pageSize=100', adminToken)).json().data;
  assert.ok(ids(active).includes(cidActive), 'active 应含进行中');
  assert.ok(!ids(active).includes(cidEnded), 'active 不该含已到期（库内仍 active）的活动');
  assert.ok(!ids(active).includes(cidDissolved), 'active 不该含已解散');
  assert.ok(active.items.every((x: any) => x.status === 'active'), '下发值必须是 active');

  const ended = (await get('/admin/campaigns?status=ended&pageSize=100', adminToken)).json().data;
  assert.ok(ids(ended).includes(cidEnded), 'ended 必须能查出「已到期但库内仍 active」的活动');
  assert.ok(!ids(ended).includes(cidActive), 'ended 不该含进行中');
  assert.ok(ended.items.every((x: any) => x.status === 'ended'), '下发值必须是 ended');

  const dissolved = (await get('/admin/campaigns?status=dissolved&pageSize=100', adminToken)).json().data;
  assert.ok(ids(dissolved).includes(cidDissolved), 'dissolved 应含已解散');
  assert.ok(!ids(dissolved).includes(cidActive), 'dissolved 不该含进行中');
  assert.ok(dissolved.items.every((x: any) => x.status === 'dissolved'));
});

test('CA2b 非法 status / visibility → 400，提示含实际值与合法值', async () => {
  const badStatus = await get('/admin/campaigns?status=bogus', adminToken);
  assert.equal(badStatus.statusCode, 400);
  assert.match(badStatus.json().message, /bogus/); // 实际值
  assert.match(badStatus.json().message, /dissolved/); // 合法集合

  const badVis = await get('/admin/campaigns?visibility=secret', adminToken);
  assert.equal(badVis.statusCode, 400);
  assert.match(badVis.json().message, /secret/);
  assert.match(badVis.json().message, /private/);
});

test('CA3 admin 详情：成员列表含各自汇总', async () => {
  const res = await get(`/admin/campaigns/${cid}`, adminToken);
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  assert.equal(d.members.length, 2);
  const me = d.members.find((m: any) => m.role === 'creator');
  assert.ok(me);
  assert.equal(me.state, 'joined');
  assert.equal(me.uid, creatorUid);
  assert.equal(typeof me.count, 'number');
  assert.equal(typeof me.distance, 'number');
  assert.equal(typeof me.duration, 'number');
});

test('CA4 非法 id → 404，且是路由自己的闸门（不是「路由不存在」）', async () => {
  const res = await get('/admin/campaigns/not-an-objectid', adminToken);
  assert.equal(res.statusCode, 404);
  // 路由没注册时 fastify 也回 404，光断状态码没有区分力 —— 必须钉业务文案
  assert.equal(res.json().message, '活动不存在');
});

test('CA5 用户 token 打 admin 接口 → 401', async () => {
  const res = await get('/admin/campaigns', creator.token);
  assert.equal(res.statusCode, 401);
});

test('CA6 畸形 pageSize 不 500（负数会 skip(-5) 报错）', async () => {
  const res = await get('/admin/campaigns?page=2&pageSize=-5', adminToken);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().data.pageSize, 1);
});
