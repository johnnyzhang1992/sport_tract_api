/**
 * 一起运动活动（campaign）：用户端 HTTP 路由（Task 6）。
 *
 * 与前几个 campaign 测试文件（断言直接打在 service 上）不同，本文件走**真实 HTTP**：
 * login 拿 token → 带 authorization 头 app.inject 各接口，钉住「路由注册 + 鉴权 + 入参解析 + 状态码」。
 *
 * 时间窗一律用**远期**（2099-01-01..2099-01-07）：effectiveStatus 按 now 派生（now >= endAt 即 ended），
 * 写死的历史窗口会让 join 立刻 403，用例会因「今天是哪天」而红绿飘忽。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { CampaignModel } from '../src/models/campaign.model.js';
import { CampaignMemberModel } from '../src/models/campaign-member.model.js';

const API = '/sport-track/api';

let app: FastifyInstance;

type Who = { id: string; token: string };

let creator: Who;
let joiner: Who;
let outsider: Who;

/** 本文件创建的 campaign id：after() 只清这些，不碰 dev 库里既有数据 */
const createdIds: mongoose.Types.ObjectId[] = [];

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

const del = (url: string, token?: string): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'DELETE', url: `${API}${url}`, headers: auth(token) });

/** 建活动（远期公共表单）并登记 id 供清理；返回 campaign id */
async function mkCampaign(
  token: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const res = await post(
    '/campaigns',
    {
      title: '周末一起跑',
      description: '',
      visibility: 'public',
      allowedTypes: [],
      memberLimit: null,
      startDate: '2099-01-01',
      endDate: '2099-01-07',
      ...over,
    },
    token,
  );
  assert.equal(res.statusCode, 200, `创建活动失败: ${res.body}`);
  const id = res.json().data.id;
  createdIds.push(new mongoose.Types.ObjectId(id));
  return id;
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  creator = await loginMock('mock_openid_campaign_routes_creator');
  joiner = await loginMock('mock_openid_campaign_routes_joiner');
  outsider = await loginMock('mock_openid_campaign_routes_outsider');
});

after(async () => {
  await CampaignMemberModel.deleteMany({ campaignId: { $in: createdIds } });
  await CampaignModel.deleteMany({ _id: { $in: createdIds } });
  await UserModel.deleteMany({ _id: { $in: [creator.id, joiner.id, outsider.id] } });
  await app.close();
});

test('CR1 未登录 → 401', async () => {
  const list = await get('/campaigns');
  assert.equal(list.statusCode, 401);
  assert.equal(list.json().code, 401);

  const create = await post('/campaigns', { title: 'x' });
  assert.equal(create.statusCode, 401);
});

test('CR2 创建 → 列表 → 详情（含非成员裁剪 myState/members）', async () => {
  const cid = await mkCampaign(creator.token);
  assert.match(cid, /^[a-f\d]{24}$/i);

  const list = await get('/campaigns?role=created', creator.token);
  assert.equal(list.statusCode, 200);
  assert.ok(
    list.json().data.items.some((i: { id: string }) => i.id === cid),
    '我发起的列表应含刚创建的活动',
  );

  // 发起人（=成员）：拿得到成员列表 / 汇总 / 我的面板
  const asCreator = await get(`/campaigns/${cid}`, creator.token);
  assert.equal(asCreator.statusCode, 200);
  assert.equal(asCreator.json().data.myState, 'joined');
  assert.ok(Array.isArray(asCreator.json().data.members));

  // 非成员：只拿到公开字段，成员数据被裁剪掉
  const asOutsider = await get(`/campaigns/${cid}`, outsider.token);
  assert.equal(asOutsider.statusCode, 200);
  const od = asOutsider.json().data;
  assert.equal(od.members, undefined, '非成员不应看到成员列表');
  assert.equal(od.totals, undefined, '非成员不应看到全队汇总');
  assert.equal(od.myPanel, undefined, '非成员不应看到我的面板');
  assert.equal(od.myState, 'none');
  assert.equal(od.status, 'active');
  assert.equal(od.canJoin, true);
});

test('CR3 join / leave / leaderboard / pending / approve / reject / kick / delete 返回码正确', async () => {
  // 公开活动：join 直接 joined
  const pub = await mkCampaign(creator.token);
  const joined = await post(`/campaigns/${pub}/join`, {}, joiner.token);
  assert.equal(joined.statusCode, 200, joined.body);
  assert.equal(joined.json().data.myState, 'joined');

  // 排行榜：非成员 403；成员 200（发起人 + joiner 两行）
  const lbOutsider = await get(`/campaigns/${pub}/leaderboard`, outsider.token);
  assert.equal(lbOutsider.statusCode, 403);
  const lbMember = await get(`/campaigns/${pub}/leaderboard`, joiner.token);
  assert.equal(lbMember.statusCode, 200);
  assert.equal(lbMember.json().data.rows.length, 2);

  // 成员明细：仅发起人可看；普通成员 403
  const detailAsCreator = await get(`/campaigns/${pub}/members/${joiner.id}`, creator.token);
  assert.equal(detailAsCreator.statusCode, 200);
  assert.ok(detailAsCreator.json().data.stats);
  const detailAsMember = await get(`/campaigns/${pub}/members/${joiner.id}`, joiner.token);
  assert.equal(detailAsMember.statusCode, 403);

  // leave：发起人不能离开（403）；成员可离开（200 → left）
  const leaveForbidden = await post(`/campaigns/${pub}/leave`, {}, creator.token);
  assert.equal(leaveForbidden.statusCode, 403);
  const leave = await post(`/campaigns/${pub}/leave`, {}, joiner.token);
  assert.equal(leave.statusCode, 200);
  assert.equal(leave.json().data.myState, 'left');

  // 再入后 kick：非发起人 403；发起人 200
  assert.equal((await post(`/campaigns/${pub}/join`, {}, joiner.token)).statusCode, 200);
  const kickForbidden = await post(`/campaigns/${pub}/kick`, { userId: joiner.id }, outsider.token);
  assert.equal(kickForbidden.statusCode, 403);
  const kickOk = await post(`/campaigns/${pub}/kick`, { userId: joiner.id }, creator.token);
  assert.equal(kickOk.statusCode, 200);

  // 隐私活动：join → pending；发起人待审批列表 200
  const priv = await mkCampaign(creator.token, { visibility: 'private' });
  const pend = await post(`/campaigns/${priv}/join`, {}, outsider.token);
  assert.equal(pend.statusCode, 200, pend.body);
  assert.equal(pend.json().data.myState, 'pending');

  // pending：非发起人 403；发起人 200 且含申请人
  assert.equal((await get(`/campaigns/${priv}/pending`, joiner.token)).statusCode, 403);
  const pendingList = await get(`/campaigns/${priv}/pending`, creator.token);
  assert.equal(pendingList.statusCode, 200);
  assert.equal(pendingList.json().data.rows.length, 1);
  assert.equal(pendingList.json().data.rows[0].userId, outsider.id);

  // approve / reject：非发起人 403；发起人 200
  assert.equal(
    (await post(`/campaigns/${priv}/approve`, { userId: outsider.id }, joiner.token)).statusCode,
    403,
  );
  const rejectOk = await post(`/campaigns/${priv}/reject`, { userId: outsider.id }, creator.token);
  assert.equal(rejectOk.statusCode, 200);
  // 被拒后可再申请 → pending，再被同意
  assert.equal(
    (await post(`/campaigns/${priv}/join`, {}, outsider.token)).json().data.myState,
    'pending',
  );

  // 审批入参 userId 非法 → 400（body 走 zod）
  const badTarget = await post(`/campaigns/${priv}/approve`, { userId: 'nope' }, creator.token);
  assert.equal(badTarget.statusCode, 400);

  assert.equal(
    (await post(`/campaigns/${priv}/approve`, { userId: outsider.id }, creator.token)).statusCode,
    200,
  );

  // 解散：非发起人 403；发起人 200 → 派生状态 dissolved
  assert.equal((await del(`/campaigns/${pub}`, outsider.token)).statusCode, 403);
  const delOk = await del(`/campaigns/${pub}`, creator.token);
  assert.equal(delOk.statusCode, 200);
  assert.equal((await get(`/campaigns/${pub}`, creator.token)).json().data.status, 'dissolved');
});

test('CR4 小程序码：非成员 403；成员返回 url（OSS）或 base64 降级', async () => {
  const cid = await mkCampaign(creator.token);

  const forbidden = await post('/campaigns/mini-code', { campaignId: cid }, outsider.token);
  assert.equal(forbidden.statusCode, 403, '只有活动成员可以生成邀请码');

  // body 里的 campaignId 非法 → 400（body 走 zod，path 才走 404 闸门）
  const badBody = await post('/campaigns/mini-code', { campaignId: 'bad-id' }, creator.token);
  assert.equal(badBody.statusCode, 400);

  const ok = await post('/campaigns/mini-code', { campaignId: cid }, creator.token);
  assert.equal(ok.statusCode, 200, ok.body);
  const d = ok.json().data;
  assert.ok(d.url || d.base64, '应返回 url 或 base64 降级');
  if (d.url) assert.match(d.url, /^https?:\/\//);
  else assert.match(d.base64, /^data:image\/png;base64,/);
});

test('CR5 非法 id → 404（不是 500，也不是 400）', async () => {
  const detail = await get('/campaigns/not-an-id', creator.token);
  assert.equal(detail.statusCode, 404);
  assert.equal(detail.json().code, 404);

  // 带 :id 的写路径同样走 object-id 闸门 → 404
  assert.equal((await post('/campaigns/not-an-id/join', {}, creator.token)).statusCode, 404);
  assert.equal((await post('/campaigns/not-an-id/leave', {}, creator.token)).statusCode, 404);
  assert.equal((await get('/campaigns/not-an-id/leaderboard', creator.token)).statusCode, 404);
  assert.equal((await del('/campaigns/not-an-id', creator.token)).statusCode, 404);

  // uid 段非法也应 404（非发起人根本到不了；发起人对不存在的活动先 404）
  assert.equal((await get('/campaigns/not-an-id/members/not-a-uid', creator.token)).statusCode, 404);
});
