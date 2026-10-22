/**
 * 活动详情（webAdmin）新增的两块数据：按运动类型的汇总 + 距离排行榜（TOP 10）。
 *
 * 口径由产品确认：**两者都只算当前在队（state=joined）的成员**，
 * 与成员表不同 —— 成员表刻意含已离开/被移出的历史段。
 *
 * 计入判据沿用成员汇总那一套（campaign-stats.baseMatch + 各成员窗口并集）：
 * status=finished、未检出搭车、类型在 allowedTypes、startTime ∈ [max(startAt, joinedAt), leftAt)。
 * 所以这里既钉「分类型聚合」，也钉「窗口/搭车/类型过滤真的生效」——否则两块新数据会悄悄多算。
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
import { ActivityModel } from '../src/models/activity.model.js';

const API = '/sport-track/api';
const ADMIN_USER = 'test_admin_campaign_detail';
const ADMIN_PASS = 'admin_pass_123';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

let app: FastifyInstance;
let adminToken = '';

type Who = { id: string; token: string };
let creator: Who;
let joiner: Who;
/** 9 个零距离在队成员：凑满 11 人，用来钉 TOP 10 截断与名次连续 */
const idle: Who[] = [];

let cid = '';
/** 限定类型的活动（只允许 running）：钉 typeSummary 与排行榜都受 allowedTypes 约束 */
let cidRunningOnly = '';

const createdCampaignIds: mongoose.Types.ObjectId[] = [];
const createdUserIds: mongoose.Types.ObjectId[] = [];

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

async function loginMock(openid: string): Promise<Who> {
  const res = await app.inject({
    method: 'POST',
    url: `${API}/auth/login`,
    payload: { code: openid },
  });
  assert.equal(res.statusCode, 200, `登录失败: ${res.body}`);
  const data = res.json().data;
  const who = { id: data.user?.id ?? data.user?._id, token: data.accessToken };
  createdUserIds.push(new mongoose.Types.ObjectId(who.id));
  return who;
}

let campaignId: mongoose.Types.ObjectId;

/** 造一行在队成员（跳过审批流程：本文件只验只读聚合，不验成员状态机） */
async function addJoined(campaign: mongoose.Types.ObjectId, userId: string, joinedAt: number) {
  await CampaignMemberModel.create({
    campaignId: campaign,
    userId: new mongoose.Types.ObjectId(userId),
    role: 'member',
    state: 'joined',
    joinedAt,
    leftAt: null,
  });
}

let seq = 0;
async function addActivity(opts: {
  userId: string;
  type: string;
  distance: number;
  duration: number;
  startTime: number;
  vehicleMs?: number;
}) {
  seq += 1;
  await ActivityModel.create({
    userId: new mongoose.Types.ObjectId(opts.userId),
    type: opts.type,
    status: 'finished',
    startTime: opts.startTime,
    endTime: opts.startTime + opts.duration * 1000,
    duration: opts.duration,
    distance: opts.distance,
    vehicleMs: opts.vehicleMs ?? 0,
    points: [{ seq: seq * 10, lat: 30, lng: 120, timestamp: opts.startTime }],
  });
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await ensureAdmin();
  creator = await loginMock('mock_openid_campaign_detail_creator');
  joiner = await loginMock('mock_openid_campaign_detail_joiner');
  for (let i = 0; i < 9; i += 1) idle.push(await loginMock(`mock_openid_campaign_detail_idle_${i}`));

  // 活动窗口：昨天开赛、还剩 5 天（派生 active），不限类型
  const startAt = Date.now() - DAY;
  const endAt = Date.now() + 5 * DAY;
  const c = await CampaignModel.create({
    creatorId: new mongoose.Types.ObjectId(creator.id),
    title: 'admin 详情汇总回归',
    description: '',
    visibility: 'private',
    allowedTypes: [],
    memberLimit: null,
    startAt,
    endAt,
    status: 'active',
  });
  campaignId = c._id as mongoose.Types.ObjectId;
  cid = String(c._id);
  createdCampaignIds.push(campaignId);

  const joinedAt = Date.now() - 20 * HOUR;
  await CampaignMemberModel.create({
    campaignId,
    userId: new mongoose.Types.ObjectId(creator.id),
    role: 'creator',
    state: 'joined',
    joinedAt,
    leftAt: null,
  });
  await addJoined(campaignId, joiner.id, joinedAt + HOUR);
  for (const u of idle) await addJoined(campaignId, u.id, joinedAt + 2 * HOUR);

  // 发起人：running 两条 + walking 一条（合计 10000m / 3900s）
  await addActivity({ userId: creator.id, type: 'running', distance: 5000, duration: 1800, startTime: joinedAt + 2 * HOUR });
  await addActivity({ userId: creator.id, type: 'running', distance: 3000, duration: 1200, startTime: joinedAt + 3 * HOUR });
  await addActivity({ userId: creator.id, type: 'walking', distance: 2000, duration: 900, startTime: joinedAt + 4 * HOUR });
  // 加入前的一条：不在贡献时段内，必须被排除
  await addActivity({ userId: creator.id, type: 'running', distance: 99999, duration: 9999, startTime: joinedAt - HOUR });
  // 疑似搭车：必须被排除
  await addActivity({ userId: creator.id, type: 'running', distance: 88888, duration: 8888, startTime: joinedAt + 5 * HOUR, vehicleMs: 600000 });

  // joiner：总距离 30000（running 10000 + cycling 20000），应排第 1
  await addActivity({ userId: joiner.id, type: 'running', distance: 10000, duration: 3600, startTime: joinedAt + 3 * HOUR });
  await addActivity({ userId: joiner.id, type: 'cycling', distance: 20000, duration: 2400, startTime: joinedAt + 4 * HOUR });

  // 已离开成员：贡献不进汇总，也不进排行榜
  const leaver = await loginMock('mock_openid_campaign_detail_leaver');
  const leftAt = Date.now() - 10 * HOUR;
  await CampaignMemberModel.create({
    campaignId,
    userId: new mongoose.Types.ObjectId(leaver.id),
    role: 'member',
    state: 'left',
    joinedAt: joinedAt,
    leftAt,
  });
  await addActivity({ userId: leaver.id, type: 'running', distance: 15000, duration: 4000, startTime: joinedAt + 5 * HOUR });

  // 第二张夹具：只允许 running，用来钉 allowedTypes 过滤。
  // 用独立发起人 —— 活动之间不隔离轨迹，同一人的轨迹会被两张活动同时计入，会污染第一张的断言。
  const creator2 = await loginMock('mock_openid_campaign_detail_creator2');
  const c2 = await CampaignModel.create({
    creatorId: new mongoose.Types.ObjectId(creator2.id),
    title: 'admin 详情类型过滤回归',
    description: '',
    visibility: 'private',
    allowedTypes: ['running'],
    memberLimit: null,
    startAt: Date.now() - DAY,
    endAt: Date.now() + 5 * DAY,
    status: 'active',
  });
  cidRunningOnly = String(c2._id);
  createdCampaignIds.push(c2._id as mongoose.Types.ObjectId);
  await CampaignMemberModel.create({
    campaignId: c2._id,
    userId: new mongoose.Types.ObjectId(creator2.id),
    role: 'creator',
    state: 'joined',
    joinedAt: Date.now() - 20 * HOUR,
    leftAt: null,
  });
  await addActivity({ userId: creator2.id, type: 'running', distance: 4000, duration: 1000, startTime: Date.now() - 10 * HOUR });
  await addActivity({ userId: creator2.id, type: 'walking', distance: 7000, duration: 2000, startTime: Date.now() - 9 * HOUR });
});

after(async () => {
  await ActivityModel.deleteMany({ userId: { $in: createdUserIds } });
  await CampaignMemberModel.deleteMany({ campaignId: { $in: createdCampaignIds } });
  await CampaignModel.deleteMany({ _id: { $in: createdCampaignIds } });
  await UserModel.deleteMany({ _id: { $in: createdUserIds } });
  await app.close();
});

const getDetail = (id: string): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'GET',
    url: `${API}/admin/campaigns/${id}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });

test('CAD1 按运动类型汇总：只算在队成员，且窗口/搭车过滤生效', async () => {
  const res = await getDetail(cid);
  assert.equal(res.statusCode, 200, res.body);
  const rows: any[] = res.json().data.typeSummary;
  assert.ok(Array.isArray(rows), '应下发 typeSummary');

  const byType = Object.fromEntries(rows.map((r) => [r.type, r]));
  assert.deepEqual(byType.running, { type: 'running', count: 3, distance: 18000, duration: 6600 });
  assert.deepEqual(byType.walking, { type: 'walking', count: 1, distance: 2000, duration: 900 });
  assert.deepEqual(byType.cycling, { type: 'cycling', count: 1, distance: 20000, duration: 2400 });
  // 已离开成员的 15000m 不在其中（否则 running 会是 33000）
  assert.equal(rows.length, 3, '只应有三种类型');
  // 排序：距离降序
  assert.deepEqual(rows.map((r) => r.type), ['cycling', 'running', 'walking']);
});

test('CAD2 按运动类型汇总：受 allowedTypes 约束', async () => {
  const res = await getDetail(cidRunningOnly);
  const rows: any[] = res.json().data.typeSummary;
  assert.deepEqual(rows, [{ type: 'running', count: 1, distance: 4000, duration: 1000 }]);
});

test('CAD3 排行榜：按距离降序、名次连续、只取前 10', async () => {
  const res = await getDetail(cid);
  const rows: any[] = res.json().data.leaderboard;
  assert.ok(Array.isArray(rows), '应下发 leaderboard');
  assert.equal(rows.length, 10, '在队 11 人，榜只取前 10');
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(rows[0].userId, joiner.id);
  assert.equal(rows[0].distance, 30000);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].duration, 6000);
  assert.equal(rows[1].userId, creator.id);
  assert.equal(rows[1].distance, 10000);
  assert.equal(typeof rows[0].name, 'string');
  // 已离开的人不进榜
  const uids = rows.map((r) => r.userId);
  assert.equal(uids.filter((u) => u === creator.id || u === joiner.id).length, 2);
  // 11 个在队成员里，缺的是名次最末那位（零距离里加入最晚的）
  const joinedUids = new Set([creator.id, joiner.id, ...idle.map((u) => u.id)]);
  const missing = [...joinedUids].filter((u) => !uids.includes(u));
  assert.equal(missing.length, 1, '恰好缺 1 人');
  assert.equal(missing[0], idle[idle.length - 1].id, '零距离同分时按加入时间早者在前，缺的是最晚加入的');
});

test('CAD4 成员表分页：page/pageSize 生效、总数与全量口径一致', async () => {
  const all = (await getDetail(`${cid}?page=1&pageSize=100`)).json().data;
  assert.equal(all.membersTotal, 12, '12 行 = 发起人 + joiner + 9 零距离 + 1 已离开');
  assert.equal(all.members.length, 12);

  const rowKey = (m: any) => `${m.userId}-${m.joinedAt}-${m.state}`;
  const p1 = (await getDetail(`${cid}?page=1&pageSize=5`)).json().data;
  const p2 = (await getDetail(`${cid}?page=2&pageSize=5`)).json().data;
  const p3 = (await getDetail(`${cid}?page=3&pageSize=5`)).json().data;
  assert.equal(p1.members.length, 5);
  assert.equal(p2.members.length, 5);
  assert.equal(p3.members.length, 2, '最后一页只有 2 行');
  assert.equal(p1.membersPage, 1);
  assert.equal(p2.membersPage, 2);

  // 分页顺序必须与全量一致（joinedAt 升序、同刻按 _id 兜底），否则翻页会漏/重
  const allKeys = all.members.map(rowKey);
  const pageKeys = [...p1.members, ...p2.members, ...p3.members].map(rowKey);
  assert.deepEqual(pageKeys, allKeys, '三页拼起来应与全量同序');

  // 每页的汇总/排行不受分页影响（都按全员算）
  assert.deepEqual(p2.leaderboard, all.leaderboard);
  assert.deepEqual(p2.typeSummary, all.typeSummary);

  // 越界页返回空列表而不是报错
  const far = (await getDetail(`${cid}?page=99&pageSize=5`)).json().data;
  assert.equal(far.members.length, 0);
  assert.equal(far.membersTotal, 12);

  // 非法 pageSize 收紧到 1（与列表接口同一套钳制），不 500
  const bad = (await getDetail(`${cid}?page=1&pageSize=-5`)).json().data;
  assert.equal(bad.members.length, 1);
});

