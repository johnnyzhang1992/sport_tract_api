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

let app: FastifyInstance;

type Who = { id: string; token: string };

let creator: Who;
let joiner: Who;
let adminToken = '';

/** 夹具活动的 id 与发起人的**编号** uid（下发的 creatorUid/uid 是这个，不是 _id） */
let cid = '';
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
  createdIds.push(new mongoose.Types.ObjectId(cid));

  const applied = await post(`/campaigns/${cid}/join`, {}, joiner.token);
  assert.equal(applied.statusCode, 200, `申请加入失败: ${applied.body}`);
  assert.equal(applied.json().data.myState, 'pending');

  const approved = await post(`/campaigns/${cid}/approve`, { userId: joiner.id }, creator.token);
  assert.equal(approved.statusCode, 200, `审批失败: ${approved.body}`);
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

test('CA2 admin 列表：status 过滤；非法 status → 400（不是静默空列表）', async () => {
  const ok = await get('/admin/campaigns?status=dissolved', adminToken);
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.json().data.items.every((x: any) => x.status === 'dissolved'));

  const bad = await get('/admin/campaigns?status=bogus', adminToken);
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().message, /bogus/); // 提示含实际值
  assert.match(bad.json().message, /dissolved/); // 且含合法值
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

test('CA4 非法 id → 404（全仓惯例；不是 400）', async () => {
  const res = await get('/admin/campaigns/not-an-objectid', adminToken);
  assert.equal(res.statusCode, 404);
});

test('CA5 用户 token 打 admin 接口 → 401', async () => {
  const res = await get('/admin/campaigns', creator.token);
  assert.equal(res.statusCode, 401);
});
