/**
 * 管理端「成员轨迹弹窗」数据源：活动成员在活动窗口内的轨迹 + 逐条归属。
 *
 * 为什么要服务端判归属：计入判据是多段贡献窗口的并集（joinedAt/leftAt），
 * 前端只有当前这一行成员记录的 joinedAt/leftAt，拿不到同一人的历史段，
 * 于是原先前端自己按 vehicleMs>0 或 driftScore>30 猜，会把「入队前的轨迹」标成计入，
 * 和活动汇总/排行榜数字对不上。
 *
 * 本文件钉住：
 * - reason 与服务端汇总同源：finished + 类型白名单 + 贡献窗口 + 无搭车 + 未超漂移门禁
 * - 活动外（开赛前/入队前/离队后/复归前）单列，不混进「未计入」
 * - 摘要按全量算，不随分页变化；列表按 startTime 倒序、翻页不漏不重
 * - 类型筛选同时收敛列表与摘要；非成员 404
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
const ADMIN_USER = 't-admin-member-activities';
const ADMIN_PASS = 'test-admin-pass-123';
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let adminToken = '';

const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdCampaignIds: mongoose.Types.ObjectId[] = [];

let memberId = '';
let outsiderId = '';
let cid = '';
let cidRunningOnly = '';
/** 逐条轨迹的 ObjectId → 期望 reason */
const expectReason = new Map<string, string>();

async function loginMock(openid: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `${API}/auth/login`, payload: { code: openid } });
  assert.equal(res.statusCode, 200, `登录失败: ${res.body}`);
  const data = res.json().data;
  const id = data.user?.id ?? data.user?._id;
  createdUserIds.push(new mongoose.Types.ObjectId(id));
  return id;
}

async function addActivity(opts: {
  userId: string;
  type: string;
  status?: 'finished' | 'in_progress' | 'cancelled';
  distance: number;
  duration: number;
  startTime: number;
  vehicleMs?: number;
  driftScore?: number;
}): Promise<string> {
  const doc = await ActivityModel.create({
    userId: new mongoose.Types.ObjectId(opts.userId),
    type: opts.type,
    status: opts.status ?? 'finished',
    startTime: opts.startTime,
    endTime: opts.startTime + opts.duration * 1000,
    duration: opts.duration,
    distance: opts.distance,
    vehicleMs: opts.vehicleMs ?? 0,
    ...(opts.driftScore != null ? { driftScore: opts.driftScore } : {}),
    trackPoints: [],
    markers: [],
  });
  return String(doc._id);
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
    url: `${API}/admin/login`,
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  adminToken = login.json().data.token;
  assert.ok(adminToken);

  const stale = await UserModel.find({ openid: /^mock_openid_member_activities/ }).select('_id').lean();
  if (stale.length) {
    await ActivityModel.deleteMany({ userId: { $in: stale.map((u) => u._id) } });
    await CampaignMemberModel.deleteMany({ userId: { $in: stale.map((u) => u._id) } });
    await CampaignModel.deleteMany({ creatorId: { $in: stale.map((u) => u._id) } });
    await UserModel.deleteMany({ _id: { $in: stale.map((u) => u._id) } });
  }

  const now = Date.now();
  const creatorId = await loginMock('mock_openid_member_activities_creator');
  memberId = await loginMock('mock_openid_member_activities_member');
  outsiderId = await loginMock('mock_openid_member_activities_outsider');

  // 活动窗口：10 天前开赛，还剩 5 天
  const startAt = now - 10 * DAY;
  const endAt = now + 5 * DAY;
  const c = await CampaignModel.create({
    creatorId: new mongoose.Types.ObjectId(creatorId),
    title: '成员轨迹归属回归',
    description: '',
    visibility: 'private',
    allowedTypes: [],
    memberLimit: null,
    startAt,
    endAt,
    status: 'active',
  });
  cid = String(c._id);
  createdCampaignIds.push(c._id as mongoose.Types.ObjectId);

  await CampaignMemberModel.create({
    campaignId: c._id,
    userId: new mongoose.Types.ObjectId(creatorId),
    role: 'creator',
    state: 'joined',
    joinedAt: startAt,
    leftAt: null,
  });
  // 成员两段：8 天前加入、2 天前离开、1 天前复归 —— 复归前那段空窗里的轨迹必须算活动外
  const uid = new mongoose.Types.ObjectId(memberId);
  await CampaignMemberModel.create({
    campaignId: c._id,
    userId: uid,
    role: 'member',
    state: 'left',
    joinedAt: now - 8 * DAY,
    leftAt: now - 2 * DAY,
  });
  await CampaignMemberModel.create({
    campaignId: c._id,
    userId: uid,
    role: 'member',
    state: 'joined',
    joinedAt: now - 1 * DAY,
    leftAt: null,
  });

  const add = async (opts: Parameters<typeof addActivity>[0], reason: string) => {
    const id = await addActivity(opts);
    expectReason.set(id, reason);
    return id;
  };
  // 计入：段内 + 已结束 + 无搭车 + 未超门禁
  await add({ userId: memberId, type: 'running', distance: 5000, duration: 1800, startTime: now - 7 * DAY }, 'counted');
  await add({ userId: memberId, type: 'walking', distance: 2000, duration: 900, startTime: now - 6 * DAY }, 'counted');
  // 未计入：疑似搭车拉长距离
  await add({ userId: memberId, type: 'running', distance: 88888, duration: 8888, startTime: now - 5 * DAY, vehicleMs: 600000 }, 'vehicle');
  // 未计入：定位漂移超门禁（30）
  await add({ userId: memberId, type: 'running', distance: 99999, duration: 9999, startTime: now - 4 * DAY, driftScore: 55 }, 'drift');
  // 未计入：进行中/作废（还没成为一条完成的运动）
  await add({ userId: memberId, type: 'running', status: 'in_progress', distance: 300, duration: 60, startTime: now - 3 * DAY }, 'unfinished');
  // 活动外：开赛后、入队前
  await add({ userId: memberId, type: 'running', distance: 7777, duration: 2222, startTime: now - 9 * DAY }, 'outside');
  // 活动外：离队后、复归前
  await add({ userId: memberId, type: 'running', distance: 6666, duration: 1111, startTime: now - 1.5 * DAY }, 'outside');
  // 窗口外（开赛前）：根本不在列表范围
  await addActivity({ userId: memberId, type: 'running', distance: 12345, duration: 3333, startTime: now - 12 * DAY });

  // 第二张夹具：只允许 running，用来钉类型白名单
  const creator2 = await loginMock('mock_openid_member_activities_creator2');
  const c2 = await CampaignModel.create({
    creatorId: new mongoose.Types.ObjectId(creator2),
    title: '成员轨迹类型过滤回归',
    description: '',
    visibility: 'private',
    allowedTypes: ['running'],
    memberLimit: null,
    startAt,
    endAt,
    status: 'active',
  });
  cidRunningOnly = String(c2._id);
  createdCampaignIds.push(c2._id as mongoose.Types.ObjectId);
  await CampaignMemberModel.create({
    campaignId: c2._id,
    userId: new mongoose.Types.ObjectId(creator2),
    role: 'creator',
    state: 'joined',
    joinedAt: startAt,
    leftAt: null,
  });
  await addActivity({ userId: creator2, type: 'running', distance: 4000, duration: 1000, startTime: now - 5 * DAY });
  await addActivity({ userId: creator2, type: 'walking', distance: 7000, duration: 2000, startTime: now - 4 * DAY });
});

after(async () => {
  await ActivityModel.deleteMany({ userId: { $in: createdUserIds } });
  await CampaignMemberModel.deleteMany({ campaignId: { $in: createdCampaignIds } });
  await CampaignModel.deleteMany({ _id: { $in: createdCampaignIds } });
  await UserModel.deleteMany({ _id: { $in: createdUserIds } });
  await app.close();
});

const getMemberActivities = (
  campaignId: string,
  query: Record<string, string | number> = {},
): Promise<LightMyRequestResponse> => {
  const qs = Object.entries({ ...query })
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return app.inject({
    method: 'GET',
    url: `${API}/admin/campaigns/${campaignId}/member-activities${qs ? `?${qs}` : ''}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
};

test('CMA1 逐条归属与服务端口径同源：计入 / 搭车 / 漂移 / 未完成 / 活动外', async () => {
  const res = await getMemberActivities(cid, { userId: memberId, pageSize: 50 });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.equal(data.total, 7, `窗口内应 7 条（开赛前那条不计）：${JSON.stringify(data.items?.map((i: any) => i.reason))}`);

  for (const item of data.items) {
    assert.equal(item.reason, expectReason.get(item.id), `轨迹 ${item.id} 的归属不对：${JSON.stringify(item)}`);
  }

  assert.deepEqual(data.summary, { counted: 2, vehicle: 1, drift: 1, unfinished: 1, outside: 2 });
});

test('CMA2 列表按开始时间倒序（最近的在最上面）', async () => {
  const res = await getMemberActivities(cid, { userId: memberId, pageSize: 50 });
  const times: number[] = res.json().data.items.map((i: any) => i.startTime);
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'startTime 应倒序');
});

test('CMA3 分页：页内切片、摘要按全量算、三页拼起来不漏不重', async () => {
  const all = (await getMemberActivities(cid, { userId: memberId, pageSize: 50 })).json().data;
  const p1 = (await getMemberActivities(cid, { userId: memberId, page: 1, pageSize: 3 })).json().data;
  const p2 = (await getMemberActivities(cid, { userId: memberId, page: 2, pageSize: 3 })).json().data;
  const p3 = (await getMemberActivities(cid, { userId: memberId, page: 3, pageSize: 3 })).json().data;

  assert.equal(p1.items.length, 3);
  assert.equal(p2.items.length, 3);
  assert.equal(p3.items.length, 1);
  assert.equal(p1.page, 1);
  assert.equal(p2.page, 2);
  assert.deepEqual(p2.summary, p1.summary, '摘要不随分页变化');
  assert.deepEqual(
    [...p1.items, ...p2.items, ...p3.items].map((i: any) => i.id),
    all.items.map((i: any) => i.id),
    '三页拼起来应与全量同序',
  );

  const far = (await getMemberActivities(cid, { userId: memberId, page: 99, pageSize: 3 })).json().data;
  assert.equal(far.items.length, 0);
  assert.equal(far.total, 7);
});

test('CMA4 类型筛选同时收敛列表与摘要', async () => {
  const res = await getMemberActivities(cidRunningOnly, { userId: '', pageSize: 50 });
  // 不传 userId 应 400：这个接口必须落到具体成员
  assert.equal(res.statusCode, 400, res.body);

  const creatorId = String((await CampaignModel.findById(cidRunningOnly).lean())!.creatorId);
  const all = (await getMemberActivities(cidRunningOnly, { userId: creatorId, pageSize: 50 })).json().data;
  assert.equal(all.total, 1, '白名单外的散步轨迹不列');
  assert.equal(all.items[0].type, 'running');
  assert.deepEqual(all.summary, { counted: 1, vehicle: 0, drift: 0, unfinished: 0, outside: 0 });

  const filtered = (await getMemberActivities(cidRunningOnly, { userId: creatorId, type: 'walking', pageSize: 50 })).json().data;
  assert.equal(filtered.total, 0);
  assert.deepEqual(filtered.summary, { counted: 0, vehicle: 0, drift: 0, unfinished: 0, outside: 0 });
});

test('CMA5 非成员 / 不存在的活动都 404', async () => {
  const notMember = await getMemberActivities(cid, { userId: outsiderId });
  assert.equal(notMember.statusCode, 404, notMember.body);
  assert.match(notMember.json().message, /不是活动成员/, '别用「接口不存在」兜过去');

  const noCampaign = await getMemberActivities('65f000000000000000000000', { userId: memberId });
  assert.equal(noCampaign.statusCode, 404, noCampaign.body);
  assert.match(noCampaign.json().message, /活动不存在/);
});
