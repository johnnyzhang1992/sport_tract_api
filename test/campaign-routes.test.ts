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

const put = (url: string, payload: Record<string, unknown>, token?: string): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'PUT', url: `${API}${url}`, payload, headers: auth(token) });

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

test('CR4 小程序码：未登录 401；非成员 403；body 非法 400（成功分支见注释）', async () => {
  // 未登录：不带 token，即使 body 非法也先被鉴权闸门拦下
  const unauthed = await post('/campaigns/mini-code', { campaignId: 'x' }, undefined);
  assert.equal(unauthed.statusCode, 401);

  const cid = await mkCampaign(creator.token);

  const forbidden = await post('/campaigns/mini-code', { campaignId: cid }, outsider.token);
  assert.equal(forbidden.statusCode, 403, '只有活动成员可以生成邀请码');

  // body 里的 campaignId 非法 → 400（body 走 zod，path 才走 404 闸门）
  const badBody = await post('/campaigns/mini-code', { campaignId: 'bad-id' }, creator.token);
  assert.equal(badBody.statusCode, 400);

  // 成功分支（真实调微信取码 + OSS 上传，失败降级 base64）刻意不在此断言：
  // 它完整镜像 src/routes/share.routes.ts 的同款流程，而 share.routes.ts 的 404/400
  // 闸门分支在 test/auth.test.ts「分享：非本人活动生成小程序码 → 404」/「分享：非法 activityId → 400」
  // 已有覆盖，真正无覆盖的只有成功分支，产物靠人工联调验证。
  // 这里只钉鉴权 / 成员闸门 / 入参校验——均不依赖外部服务。
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

test("CR6 创建日期必须真实存在：假日期 → 400（不是 500）", async () => {
  // 只过 \d{4}-\d{2}-\d{2} 正则的话，'2026-13-01' / '2026-02-30' 会一路进 createCampaign 的
  // Date.parse → NaN → bjDayStart(NaN) → mongoose「Cast to Number failed」→ 通用 500
  //（dev 环境还把内部 message 回给客户端）。这里钉住门票层 400 + 提示含字段名与实际值。
  const form = {
    title: '日期校验',
    description: '',
    visibility: 'public',
    allowedTypes: [],
    memberLimit: null,
    startDate: '2099-01-01',
    endDate: '2099-01-07',
  };
  for (const bad of ['2026-13-01', '2026-02-30']) {
    const res = await post('/campaigns', { ...form, startDate: bad }, creator.token);
    assert.equal(res.statusCode, 400, `startDate=${bad} 应为 400，实际 ${res.statusCode}: ${res.body}`);
    assert.equal(res.json().code, 400);
    assert.match(res.json().message, /startDate/, `提示应含字段名，实际：${res.json().message}`);
    assert.ok(res.json().message.includes(bad), `提示应含实际值 ${bad}，实际：${res.json().message}`);
  }
  // endDate 同样走闸门（提示换字段名）。用「区间合法但日历上不存在」的值，
  // 避免先被 endDate >= startDate 的区间校验拦下、盖住真正要钉的日历校验提示。
  const badEnd = await post('/campaigns', { ...form, endDate: '2099-02-30' }, creator.token);
  assert.equal(badEnd.statusCode, 400, badEnd.body);
  assert.match(badEnd.json().message, /endDate/, `提示应含字段名，实际：${badEnd.json().message}`);
  assert.ok(badEnd.json().message.includes('2099-02-30'), `提示应含实际值，实际：${badEnd.json().message}`);

  // 正常（含闰日）日期仍 200
  const ok = await mkCampaign(creator.token, { startDate: '2099-01-01', endDate: '2099-01-07' });
  assert.match(ok, /^[a-f\d]{24}$/i);
});

test('CR7 成员明细 uid 闸门：畸形 uid / 非成员 → 404；成员零轨迹仍 200', async () => {
  const cid = await mkCampaign(creator.token);

  // 畸形 uid：与 :id 同待遇走 404 闸门（既不是 CastError → 500，也不是静默 200 + 全 0）
  const malformed = await get(`/campaigns/${cid}/members/not-a-uid`, creator.token);
  assert.equal(malformed.statusCode, 404, malformed.body);
  assert.equal(malformed.json().code, 404);

  // 格式合法（24 位 hex）但与本活动无关的人：没有任何加入段 → 不是成员 → 404
  const stranger = String(new mongoose.Types.ObjectId());
  const strangerRes = await get(`/campaigns/${cid}/members/${stranger}`, creator.token);
  assert.equal(strangerRes.statusCode, 404, `非成员 hex 应 404，实际 ${strangerRes.statusCode}: ${strangerRes.body}`);

  // 是成员但还没有轨迹 → 仍是 200 + 全 0（不要误伤这条既有正确行为）
  assert.equal((await post(`/campaigns/${cid}/join`, {}, joiner.token)).statusCode, 200);
  const memberRes = await get(`/campaigns/${cid}/members/${joiner.id}`, creator.token);
  assert.equal(memberRes.statusCode, 200, memberRes.body);
  assert.deepEqual(memberRes.json().data.stats, { count: 0, distance: 0, duration: 0 });
  assert.equal(memberRes.json().data.total, 0);
});

test('CR8 描述上限 120 字：120 字通过、121 字 → 400', async () => {
  const okId = await mkCampaign(creator.token, { title: '描述上限', description: '字'.repeat(120) });
  assert.match(okId, /^[a-f\d]{24}$/i, '恰好 120 字应通过');

  const tooLong = await post(
    '/campaigns',
    {
      title: '描述超限',
      description: '字'.repeat(121),
      visibility: 'public',
      allowedTypes: [],
      memberLimit: null,
      startDate: '2099-01-01',
      endDate: '2099-01-07',
    },
    creator.token,
  );
  assert.equal(tooLong.statusCode, 400, tooLong.body);
  assert.equal(tooLong.json().code, 400);
  assert.match(tooLong.json().message, /描述/, `提示应点名对象，实际：${tooLong.json().message}`);
  assert.ok(tooLong.json().message.includes('120'), `提示应含上限 120，实际：${tooLong.json().message}`);
});

test('CR9 memberLimit 不带该字段 → 默认 100 落库；显式 null 仍是「不限」', async () => {
  // ① 整段不带 memberLimit（模拟没填这个字段的调用方）
  const omitted = await post(
    '/campaigns',
    {
      title: '默认人数上限',
      description: '',
      visibility: 'public',
      allowedTypes: [],
      startDate: '2099-01-01',
      endDate: '2099-01-07',
    },
    creator.token,
  );
  assert.equal(omitted.statusCode, 200, omitted.body);
  const omittedId = omitted.json().data.id;
  createdIds.push(new mongoose.Types.ObjectId(omittedId));
  assert.equal(
    (await get(`/campaigns/${omittedId}`, creator.token)).json().data.memberLimit,
    100,
    '不带该字段应按默认 100 落库（不是 null）',
  );

  // ② 显式 null＝不限：默认值只能兜「没带」，不能吃掉端上「清空＝不限制」的明确意图
  const explicitNullId = await mkCampaign(creator.token, { title: '显式不限人数' });
  assert.equal(
    (await get(`/campaigns/${explicitNullId}`, creator.token)).json().data.memberLimit,
    null,
    '显式 null 必须仍然是不限',
  );
});

test('CR10 编辑：未登录 PUT → 401', async () => {
  const cid = await mkCampaign(creator.token, { title: '编辑需登录' });
  const res = await put(`/campaigns/${cid}`, { title: '偷改' });
  assert.equal(res.statusCode, 401);
});

test('CR11 编辑的 body 闸门：空体 / 标题超 30 / 类型不在白名单 → 400，库里原值不动', async () => {
  const cid = await mkCampaign(creator.token, { title: '编辑入参校验' });
  const cases: Array<[string, Record<string, unknown>]> = [
    ['空请求体', {}],
    ['标题超 30 字', { title: '一'.repeat(31) }],
    ['类型不在白名单', { allowedTypes: ['yoga'] }],
    ['只有 startDate', { startDate: '2099-03-01' }],
  ];
  for (const [label, payload] of cases) {
    const res = await put(`/campaigns/${cid}`, payload, creator.token);
    assert.equal(res.statusCode, 400, `${label} 应 400，实际 ${res.statusCode}: ${res.body}`);
  }
  const detail = await get(`/campaigns/${cid}`, creator.token);
  assert.equal(detail.json().data.title, '编辑入参校验');
  assert.equal(detail.json().data.startAt, Date.parse('2099-01-01T00:00:00+08:00'), 'startDate 不接受上送');

  // 「只有 startDate」单独传会被 zod 当未知字段丢掉、再被「空体」规则兜成 400 —— 两层防御互相掩盖。
  // 真正要钉的是**混在合法字段里**：丢掉 startDate 会返回 200，用户以为开始时间改成功了。
  const mixed = await put(`/campaigns/${cid}`, { title: '合法标题', startDate: '2099-03-01' }, creator.token);
  assert.equal(mixed.statusCode, 400, `startDate 混在合法字段里必须 400（.strict()），实际：${mixed.body}`);
  assert.equal(
    (await get(`/campaigns/${cid}`, creator.token)).json().data.title,
    '编辑入参校验',
    '被拒的请求不能留下半套改动',
  );
});

test('CR12 编辑成功 → 200 回显新值，GET 详情同步（含 startDate/endDate 字符串供端上预填）', async () => {
  const cid = await mkCampaign(creator.token, { title: '改前标题' });
  const res = await put(
    `/campaigns/${cid}`,
    { title: '改后标题', endDate: '2099-02-01', visibility: 'private', memberLimit: 8 },
    creator.token,
  );
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().data.title, '改后标题');

  const detail = (await get(`/campaigns/${cid}`, creator.token)).json().data;
  assert.equal(detail.title, '改后标题');
  assert.equal(detail.visibility, 'private');
  assert.equal(detail.memberLimit, 8);
  assert.equal(detail.startDate, '2099-01-01');
  assert.equal(detail.endDate, '2099-02-01');
});

test('CR13 编辑只认发起人：非发起人（含成员）PUT → 403', async () => {
  const cid = await mkCampaign(creator.token, { title: '只认发起人' });
  const joined = await post(`/campaigns/${cid}/join`, {}, joiner.token);
  assert.equal(joined.statusCode, 200, joined.body);

  for (const token of [joiner.token, outsider.token]) {
    const res = await put(`/campaigns/${cid}`, { title: '偷改' }, token);
    assert.equal(res.statusCode, 403, res.body);
  }
  assert.equal((await get(`/campaigns/${cid}`, creator.token)).json().data.title, '只认发起人');
});

test('CR14 排行榜分页参数走路由默认：不带 query＝page1/pageSize20，越界回空页，pageSize 超上限 400', async () => {
  const cid = await mkCampaign(creator.token, { title: '排行榜分页' });

  const d = (await get(`/campaigns/${cid}/leaderboard`, creator.token)).json().data;
  assert.equal(d.page, 1, '不带 query 要吃到默认页码');
  assert.equal(d.pageSize, 20, '不带 query 要吃到默认页大小');
  assert.equal(d.total, 1, 'total 是成员总数，不随分页变');
  assert.equal(d.rows.length, 1);

  const beyond = await get(`/campaigns/${cid}/leaderboard?page=2`, creator.token);
  assert.equal(beyond.statusCode, 200, beyond.body);
  assert.deepEqual(beyond.json().data.rows, [], '越界页回空数组，端上据此收起「加载更多」');
  assert.equal(beyond.json().data.total, 1);

  for (const q of ['?pageSize=101', '?page=0', '?page=abc']) {
    const bad = await get(`/campaigns/${cid}/leaderboard${q}`, creator.token);
    assert.equal(bad.statusCode, 400, `${q} 应 400，实际 ${bad.statusCode}: ${bad.body}`);
  }
});
