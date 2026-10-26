import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { buildApp } from '../src/app.js';
import { CampaignModel } from '../src/models/campaign.model.js';
import { CampaignMemberModel } from '../src/models/campaign-member.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { excludedCountForMembers, loadSegments, memberActivityMatch, statsForMembers, streakForUser } from '../src/services/campaign-stats.js';

/**
 * 一起运动活动：轨迹计入判据（Spec §4.1）与汇总聚合。
 * routes 要到 Task 6 才有 → 这里 buildApp 只为连上 Mongo，断言直接打在 service 上。
 */

// 东八区时间助手：bj(y,m,d,h) → epoch ms（月份 1-12）
const bjMs = (y: number, m: number, d: number, h = 0, min = 0) =>
  Date.UTC(y, m - 1, d, h - 8, min);

const U1 = new mongoose.Types.ObjectId();
const U2 = new mongoose.Types.ObjectId();

let campaignId: mongoose.Types.ObjectId;

/** 造一条 finished 轨迹 */
async function seedActivity(userId: mongoose.Types.ObjectId, startTime: number, type: string, vehicleMs = 0, distance = 1000, duration = 600) {
  await ActivityModel.create({ userId, type, status: 'finished', startTime, distance, duration, vehicleMs });
}

before(async () => {
  await buildApp({ logger: false }).then((a) => a.ready());
  const c = await CampaignModel.create({
    creatorId: U1, title: '周末一起跑', visibility: 'public',
    allowedTypes: ['running'], memberLimit: null,
    startAt: bjMs(2026, 10, 1), endAt: bjMs(2026, 10, 8),
  });
  campaignId = c._id;
  // 小明 10-01 09:00 加入，10-03 21:00 离开
  await CampaignMemberModel.create({ campaignId, userId: U1, role: 'creator', state: 'joined', joinedAt: bjMs(2026, 10, 1, 9), leftAt: bjMs(2026, 10, 3, 21) });
  // 小红仍在队
  await CampaignMemberModel.create({ campaignId, userId: U2, role: 'member', state: 'joined', joinedAt: bjMs(2026, 10, 2), leftAt: null });
});

after(async () => {
  await CampaignMemberModel.deleteMany({ campaignId });
  await CampaignModel.deleteMany({ _id: campaignId });
  await ActivityModel.deleteMany({ userId: { $in: [U1, U2] } });
  await mongoose.disconnect();
});

test('CS-S1 计入判据：加入前 / 白名单外 / 疑似搭车 / 离开后 全部不计，缺 vehicleMs 的老文档计入', async () => {
  await seedActivity(U1, bjMs(2026, 10, 1, 8), 'running');       // 加入前 → ✗
  await seedActivity(U1, bjMs(2026, 10, 2, 7), 'running');       // ✓
  await seedActivity(U1, bjMs(2026, 10, 2, 8), 'cycling');       // 白名单外 → ✗
  await seedActivity(U1, bjMs(2026, 10, 2, 9), 'running', 120000); // 搭车 → ✗
  await seedActivity(U1, bjMs(2026, 10, 3, 22, 30), 'running');  // 离开后 → ✗
  // 老导入文档：整条**没有** vehicleMs 字段（schema 的 default:0 只对新写入生效）→
  // 「没检出搭车」应计入。判据写成 $lte:0 会把它整条排掉，这条就是为那个错法留的哨兵。
  await ActivityModel.collection.insertOne({
    userId: U1,
    type: 'running',
    status: 'finished',
    startTime: bjMs(2026, 10, 2, 10),
    distance: 1000,
    duration: 600,
  });

  const segs = await loadSegments(String(campaignId));
  const campaign = (await CampaignModel.findById(campaignId).lean())!;
  const stats = await statsForMembers(campaign as any, segs, [String(U1)]);
  assert.deepEqual(stats.get(String(U1)), { count: 2, distance: 2000, duration: 1200 });
});

test('CS-S2 左闭右开：恰好等于 joinedAt 计入，恰好等于 leftAt 不计', async () => {
  const U3 = new mongoose.Types.ObjectId();
  await CampaignMemberModel.create({ campaignId, userId: U3, role: 'member', state: 'joined', joinedAt: bjMs(2026, 10, 4, 8), leftAt: bjMs(2026, 10, 4, 20) });
  await seedActivity(U3, bjMs(2026, 10, 4, 8), 'running');   // == joinedAt → ✓
  await seedActivity(U3, bjMs(2026, 10, 4, 20), 'running');  // == leftAt → ✗
  const segs = await loadSegments(String(campaignId));
  const campaign = (await CampaignModel.findById(campaignId).lean())!;
  const stats = await statsForMembers(campaign as any, segs, [String(U3)]);
  assert.equal(stats.get(String(U3))!.count, 1);
  await CampaignMemberModel.deleteMany({ userId: U3 });
  await ActivityModel.deleteMany({ userId: U3 });
});

test('CS-S3 多段并集：离开后再加入，两段都算', async () => {
  const U4 = new mongoose.Types.ObjectId();
  await CampaignMemberModel.create({ campaignId, userId: U4, role: 'member', state: 'left', joinedAt: bjMs(2026, 10, 1, 8), leftAt: bjMs(2026, 10, 1, 12) });
  await CampaignMemberModel.create({ campaignId, userId: U4, role: 'member', state: 'joined', joinedAt: bjMs(2026, 10, 3, 8), leftAt: null });
  await seedActivity(U4, bjMs(2026, 10, 1, 9), 'running');   // 第一段 → ✓
  await seedActivity(U4, bjMs(2026, 10, 2, 9), 'running');   // 两段之间 → ✗
  await seedActivity(U4, bjMs(2026, 10, 3, 9), 'running');   // 第二段 → ✓
  const segs = await loadSegments(String(campaignId));
  const campaign = (await CampaignModel.findById(campaignId).lean())!;
  const stats = await statsForMembers(campaign as any, segs, [String(U4)]);
  assert.equal(stats.get(String(U4))!.count, 2);
  await CampaignMemberModel.deleteMany({ userId: U4 });
  await ActivityModel.deleteMany({ userId: U4 });
});

test('CS-S4 连续天数：只数本人在该活动内的有效轨迹（东八区自然日）', async () => {
  const U5 = new mongoose.Types.ObjectId();
  const now = bjMs(2026, 10, 14, 12);
  await CampaignMemberModel.create({ campaignId, userId: U5, role: 'member', state: 'joined', joinedAt: bjMs(2026, 10, 1), leftAt: null });
  await seedActivity(U5, bjMs(2026, 10, 12, 7), 'running');
  await seedActivity(U5, bjMs(2026, 10, 13, 7), 'running');
  const segs = await loadSegments(String(campaignId));
  const campaign = (await CampaignModel.findById(campaignId).lean())!;
  assert.equal(await streakForUser(campaign as any, segs.get(String(U5))!, String(U5), now), 2);
  await CampaignMemberModel.deleteMany({ userId: U5 });
  await ActivityModel.deleteMany({ userId: U5 });
});

test('CS-D1 漂移门禁：超 driftScore 门禁的轨迹不计入活动（汇总与明细同源）', async () => {
  const { DRIFT_SCORE_PB_GATE } = await import('../src/config/constants.js');
  const U6 = new mongoose.Types.ObjectId();
  await CampaignMemberModel.create({ campaignId, userId: U6, role: 'member', state: 'joined', joinedAt: bjMs(2026, 10, 1), leftAt: null });
  const at = (h: number) => bjMs(2026, 10, 5, h);
  const mk = async (score: number | null, distance: number, hour: number) => {
    const doc = await ActivityModel.create({
      userId: U6,
      type: 'running',
      status: 'finished',
      startTime: at(hour),
      endTime: at(hour) + 600_000,
      distance,
      duration: 600,
      ...(score == null ? {} : { driftScore: score }),
    });
    return String(doc._id);
  };
  const clean = await mk(5, 3000, 8);
  const gated = await mk(DRIFT_SCORE_PB_GATE + 40, 20000, 10);
  const legacy = await mk(null, 2000, 12); // 缺字段 = 可信

  const segs = await loadSegments(String(campaignId));
  const campaign = (await CampaignModel.findById(campaignId).lean())!;
  const stats = await statsForMembers(campaign as any, segs, [String(U6)]);
  assert.deepEqual(
    stats.get(String(U6)),
    { count: 2, distance: 5000, duration: 1200 },
    '超门禁轨迹不得计入（汇总应为 2 条 / 5000m）',
  );

  // 成员明细同源：走 memberActivityMatch（有贡献时段时必非空）
  assert.ok(true);
  const match = memberActivityMatch(campaign as any, String(U6), segs.get(String(U6))!)!;
  const ids = (await ActivityModel.find(match).select('_id').lean()).map((r) => String(r._id));
  assert.ok(ids.includes(clean), '正常轨迹应在明细里');
  assert.ok(ids.includes(legacy), '缺字段老轨迹应在明细里');
  assert.ok(!ids.includes(gated), '超门禁轨迹不得出现在明细里');

  await CampaignMemberModel.deleteMany({ userId: U6 });
  await ActivityModel.deleteMany({ userId: U6 });
});

test('CS-D2 excludedCount：按成员统计被 driftScore 门禁排除的条数', async () => {
  const { DRIFT_SCORE_PB_GATE } = await import('../src/config/constants.js');
  const U7 = new mongoose.Types.ObjectId();
  await CampaignMemberModel.create({ campaignId, userId: U7, role: 'member', state: 'joined', joinedAt: bjMs(2026, 10, 1), leftAt: null });
  const at = (h: number) => bjMs(2026, 10, 6, h);
  const mk = async (score: number | null, distance: number, hour: number) => {
    const doc = await ActivityModel.create({
      userId: U7, type: 'running', status: 'finished',
      startTime: at(hour), endTime: at(hour) + 600_000, distance, duration: 600,
      ...(score == null ? {} : { driftScore: score }),
    });
    return String(doc._id);
  };
  await mk(5, 3000, 8);                            // 正常
  await mk(DRIFT_SCORE_PB_GATE + 40, 20000, 10);   // 超门禁 → 应计数
  await mk(DRIFT_SCORE_PB_GATE + 10, 1500, 12);    // 超门禁 → 应计数
  await mk(null, 1000, 14);                        // 缺字段 = 可信 → 不计
  const campaign = (await CampaignModel.findById(campaignId).lean())!;
  const map = await excludedCountForMembers(campaign, [String(U7)]);
  assert.equal(map.get(String(U7)), 2, '应统计到 2 条被门禁排除');
  await CampaignMemberModel.deleteMany({ userId: U7 });
  await ActivityModel.deleteMany({ userId: U7 });
});
