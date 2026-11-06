/**
 * 步数PK + 普通活动步数辅助：窗口按天、步数聚合、按天对比、详情/排行/趋势。
 * 只测 service 口径；路由鉴权沿用 campaign 既有测试。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { UserModel } from '../src/models/user.model.js';
import { CampaignModel } from '../src/models/campaign.model.js';
import { CampaignMemberModel } from '../src/models/campaign-member.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { WerunDayModel } from '../src/models/werun-day.model.js';
import {
  createCampaign, getCampaignDetail, campaignLeaderboard, campaignTrend, campaignMemberDaySteps,
  updateCampaign,
} from '../src/services/campaign.js';
import { membershipDays, stepStatsForMembers, memberDayStepComparison } from '../src/services/campaign-steps.js';
import { loadSegments, type CampaignDoc } from '../src/services/campaign-stats.js';
import { CreateCampaignSchema, UpdateCampaignSchema, UpdateMeSchema } from '../src/utils/validators.js';

const RUN = Date.now().toString(36);
const CREATOR_OPENID = `cs_creator_${RUN}`;
const MEMBER_OPENID = `cs_member_${RUN}`;
const DAY = 86_400_000;
const bj = (date: string) => Date.parse(`${date}T00:00:00+08:00`);
const at = (date: string, hour: number) => bj(date) + hour * 3600_000;

let creatorId = '';
let memberId = '';
let activityCampaign = '';
let stepCampaign = '';
/** CS-6 临时创建的 campaign，after 一起清 */
const extraCampaigns: string[] = [];

async function addSteps(uid: string, rows: Array<[string, number]>) {
  await WerunDayModel.insertMany(rows.map(([date, step]) => ({
    userId: new mongoose.Types.ObjectId(uid), date, step, syncedAt: Date.now(),
  })));
}

async function addActivity(uid: string, type: string, date: string, distance: number) {
  await ActivityModel.create({
    userId: new mongoose.Types.ObjectId(uid), type, status: 'finished',
    startTime: at(date, 8), endTime: at(date, 9), duration: 3600, distance,
  });
}

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  const [c, m] = await UserModel.create([
    { openid: CREATOR_OPENID, nickname: '创建者', uid: 880001 },
    { openid: MEMBER_OPENID, nickname: '成员', uid: 880002 },
  ]);
  creatorId = String(c._id);
  memberId = String(m._id);

  const created = await createCampaign(creatorId, {
    title: `步数辅助测试-${RUN}`,
    description: '',
    visibility: 'public',
    kind: 'activity',
    stepAuxEnabled: true,
    allowedTypes: ['running'],
    memberLimit: 10,
    startDate: '2026-11-01',
    endDate: '2026-11-07',
  }, async () => ({ risky: false }));
  activityCampaign = created.id;
  await CampaignMemberModel.create({
    campaignId: new mongoose.Types.ObjectId(activityCampaign), userId: memberId,
    role: 'member', state: 'joined', joinedAt: at('2026-11-02', 20), leftAt: at('2026-11-06', 10),
  });

  const step = await createCampaign(creatorId, {
    title: `步数PK测试-${RUN}`,
    description: '',
    visibility: 'public',
    kind: 'steps',
    allowedTypes: [],
    memberLimit: 10,
    startDate: '2026-11-01',
    endDate: '2026-11-07',
  }, async () => ({ risky: false }));
  stepCampaign = step.id;
  await CampaignMemberModel.create({
    campaignId: new mongoose.Types.ObjectId(stepCampaign), userId: memberId,
    role: 'member', state: 'joined', joinedAt: at('2026-11-02', 20), leftAt: at('2026-11-06', 10),
  });
});

beforeEach(async () => {
  await ActivityModel.deleteMany({ userId: { $in: [creatorId, memberId] } });
  await WerunDayModel.deleteMany({ userId: { $in: [creatorId, memberId] } });
});

after(async () => {
  await ActivityModel.deleteMany({ userId: { $in: [creatorId, memberId] } });
  await WerunDayModel.deleteMany({ userId: { $in: [creatorId, memberId] } });
  const allIds = [activityCampaign, stepCampaign, ...extraCampaigns].filter(Boolean).map((id) => new mongoose.Types.ObjectId(id));
  await CampaignMemberModel.deleteMany({ campaignId: { $in: allIds } });
  await CampaignModel.deleteMany({ _id: { $in: allIds } });
  await UserModel.deleteMany({ openid: { $in: [CREATOR_OPENID, MEMBER_OPENID] } });
  const mongoose2 = (await import('mongoose')).default;
  await mongoose2.disconnect().catch(() => {});
});

test('CS-1 按天窗口：加入当天算、退出当天不算、多段合并、未来日期不参与', () => {
  const c = {
    startAt: bj('2026-11-01'), endAt: bj('2026-11-08'),
  } as CampaignDoc;
  assert.deepEqual(
    membershipDays(c, [{ joinedAt: at('2026-11-03', 15), leftAt: at('2026-11-06', 10) }], at('2026-11-07', 12)),
    ['2026-11-03', '2026-11-04', '2026-11-05'],
  );
  assert.deepEqual(
    membershipDays(c, [{ joinedAt: at('2026-11-03', 15), leftAt: at('2026-11-05', 10) }, { joinedAt: at('2026-11-06', 9), leftAt: null }], at('2026-11-07', 12)),
    ['2026-11-03', '2026-11-04', '2026-11-06', '2026-11-07'],
  );
  assert.deepEqual(membershipDays(c, [], at('2026-11-07', 12)), []);
});

test('CS-2 步数聚合：只算成员窗口内的天，窗口外和未来都不算', async () => {
  const c = await CampaignModel.findById(stepCampaign).lean() as CampaignDoc;
  const segs = await loadSegments(stepCampaign);
  await addSteps(memberId, [
    ['2026-11-02', 9000],
    ['2026-11-03', 1000],
    ['2026-11-04', 2000],
    ['2026-11-05', 3000],
    ['2026-11-06', 4000],
    ['2026-11-08', 5000],
  ]);
  const stats = await stepStatsForMembers(c, segs, [memberId], at('2026-11-07', 12));
  assert.deepEqual(stats.get(memberId), { step: 15000, days: 4 }, '11-02（加入当天算整天）/03/04/05 共 15000；11-06 退出当天不算');
});

test('CS-3 按天对比：匹配 / 步数偏少 / 仅步数 / 未同步', async () => {
  const c = await CampaignModel.findById(activityCampaign).lean() as CampaignDoc;
  const segs = await loadSegments(activityCampaign);
  await addActivity(memberId, 'running', '2026-11-03', 5000);
  await addActivity(memberId, 'running', '2026-11-04', 5000);
  await addActivity(memberId, 'cycling', '2026-11-05', 5000); // 不在 allowedTypes，距离 0
  await addActivity(memberId, 'running', '2026-11-06', 9000); // 退出当天，窗口外
  await addSteps(memberId, [
    ['2026-11-03', 3000], // 3000*2*1.25=7500 >= 5000 → 匹配
    ['2026-11-04', 1000], // 2500 < 5000 → 偏少
    ['2026-11-05', 6000], // 只有步数
    ['2026-11-06', 10000],
  ]);
  const r = await memberDayStepComparison(c, segs.get(memberId)!, memberId, { page: 1, pageSize: 20 }, at('2026-11-07', 12));
  assert.equal(r.total, 3);
  assert.deepEqual(r.items.map((x) => [x.date, x.status]), [
    ['2026-11-05', 'noTrack'],
    ['2026-11-04', 'low'],
    ['2026-11-03', 'match'],
  ]);
  assert.equal(r.summary.distance, 10000, '只算 running 5+5；退出当天和 cycling 不计');
  assert.equal(r.summary.step, 10000);
});

test('CS-4 步数PK详情/排行/趋势：按步数而不是轨迹', async () => {
  await addSteps(creatorId, [['2026-11-06', 8000]]);
  await addSteps(memberId, [['2026-11-03', 3000], ['2026-11-04', 4000], ['2026-11-05', 5000]]);

  const detail = await getCampaignDetail(stepCampaign, creatorId);
  assert.equal(detail.kind, 'steps');
  assert.equal(detail.totals?.step, 20000);
  assert.equal(detail.myPanel?.step, 8000);
  assert.equal(detail.members?.find((m) => m.userId === memberId)?.step, 12000);

  const board = await campaignLeaderboard(stepCampaign, creatorId, { page: 1, pageSize: 20 });
  assert.equal(board.metric, 'step');
  assert.equal(board.rows[0].userId, memberId, '成员 12000 > 创建者 8000');
  assert.equal(board.rows[0].step, 12000);
  assert.equal(board.my.rank, 2);

  const trend = await campaignTrend(stepCampaign, creatorId, {});
  assert.equal(trend.metric, 'step');
  assert.ok(trend.labels.length > 0);
  assert.equal(
    trend.series.find((s) => s.userId === memberId)?.values.at(-1),
    12000,
    '成员累计步数终点',
  );
});

test('CS-5 成员按天接口：普通活动未开辅助 400；开启后 joined 可读；步数PK可读', async () => {
  await addSteps(memberId, [['2026-11-04', 2000]]);
  const r = await campaignMemberDaySteps(activityCampaign, creatorId, memberId, { page: 1, pageSize: 20 });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].step, 2000);

  const off = await CampaignModel.findByIdAndUpdate(activityCampaign, { $set: { stepAuxEnabled: false } }, { returnDocument: 'after' }).lean();
  assert.ok(off);
  await assert.rejects(
    () => campaignMemberDaySteps(activityCampaign, creatorId, memberId, { page: 1, pageSize: 20 }),
    /未开启微信步数辅助/,
  );
  await CampaignModel.updateOne({ _id: activityCampaign }, { $set: { stepAuxEnabled: true } });

  const stepRows = await campaignMemberDaySteps(stepCampaign, creatorId, memberId, { page: 1, pageSize: 20 });
  assert.equal(stepRows.items[0].status, 'stepOnly');
});

test('CS-6 入参闸门：步数PK 不接受运动类型/辅助开关；设置项可写且默认开启', async () => {
  const form = {
    title: '步数PK校验', visibility: 'public' as const, kind: 'steps' as const,
    startDate: '2026-11-01', endDate: '2026-11-07',
  };
  assert.equal(CreateCampaignSchema.safeParse({ ...form, allowedTypes: ['running'] }).success, false, '步数PK带类型应拒绝');
  assert.equal(CreateCampaignSchema.safeParse(form).success, true, '步数PK不传类型可创建');

  assert.equal(UpdateCampaignSchema.safeParse({ kind: 'activity' }).success, false, 'kind 不可编辑');
  assert.equal(UpdateCampaignSchema.safeParse({ stepAuxEnabled: true }).success, true);
  await assert.rejects(
    () => updateCampaign(stepCampaign, creatorId, { stepAuxEnabled: true }),
    /步数PK不区分运动类型/,
  );

  // service 兜底：即使调用方绕过 schema 传了类型/辅助开关，落库也归一
  const created = await createCampaign(creatorId, {
    title: `步数PK归一-${RUN}`, description: '', visibility: 'public',
    kind: 'steps', stepAuxEnabled: true, allowedTypes: ['running'],
    memberLimit: 10, startDate: '2026-11-01', endDate: '2026-11-07',
  }, async () => ({ risky: false }));
  extraCampaigns.push(created.id);
  const doc = await CampaignModel.findById(created.id).lean();
  assert.equal(doc?.kind, 'steps');
  assert.equal(doc?.stepAuxEnabled, false);
  assert.deepEqual(doc?.allowedTypes, []);

  assert.equal(UpdateMeSchema.safeParse({ settings: { dailyStepSync: false } }).success, true);
  assert.equal(UpdateMeSchema.safeParse({ settings: { dailyStepSync: 'no' } }).success, false);
  const fresh = await UserModel.create({ openid: `cs_default_${RUN}`, nickname: '默认设置' });
  assert.equal(fresh.settings?.dailyStepSync, true, '默认每天同步，老用户缺字段按开关默认处理');
  await UserModel.deleteOne({ _id: fresh._id });
});

test('CS-7 步数辅助只拿可比类型判真实性：骑行距离再长也不判「步数偏少」', async () => {
  const c = await createCampaign(creatorId, {
    title: `步数可比类型-${RUN}`, description: '', visibility: 'public',
    kind: 'activity', stepAuxEnabled: true, allowedTypes: ['running', 'cycling'],
    memberLimit: 10, startDate: '2026-11-01', endDate: '2026-11-07',
  }, async () => ({ risky: false }));
  extraCampaigns.push(c.id);
  await CampaignMemberModel.create({
    campaignId: new mongoose.Types.ObjectId(c.id), userId: memberId,
    role: 'member', state: 'joined', joinedAt: at('2026-11-02', 8), leftAt: null,
  });
  // 11-03 只骑行 20km + 3000 步：不可比类型 → 不判低
  await addActivity(memberId, 'cycling', '2026-11-03', 20000);
  // 11-04 骑行 20km + 跑步 5km + 3000 步：只拿跑步 5km 比（7500m 上限）→ 匹配
  await addActivity(memberId, 'cycling', '2026-11-04', 20000);
  await addActivity(memberId, 'running', '2026-11-04', 5000);
  // 11-05 跑步 20km + 3000 步：可比距离 20km 超上限 → 偏少
  await addActivity(memberId, 'running', '2026-11-05', 20000);
  await addSteps(memberId, [
    ['2026-11-03', 3000],
    ['2026-11-04', 3000],
    ['2026-11-05', 3000],
  ]);

  const doc = await CampaignModel.findById(c.id).lean() as CampaignDoc;
  const segs = await loadSegments(c.id);
  const r = await memberDayStepComparison(doc, segs.get(memberId)!, memberId, { page: 1, pageSize: 20 }, at('2026-11-07', 12));
  const byDate = new Map(r.items.map((x) => [x.date, x]));
  assert.equal(byDate.get('2026-11-03')?.status, 'match', '只有骑行：不做低步数判断');
  assert.equal(byDate.get('2026-11-04')?.status, 'match', '骑行距离不参与步数真实性判断');
  assert.equal(byDate.get('2026-11-05')?.status, 'low', '可比距离超上限才是步数偏少');
  assert.equal(byDate.get('2026-11-04')?.distance, 25000, '展示距离仍是当天全部计入距离');
});
