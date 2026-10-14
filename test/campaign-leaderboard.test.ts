/**
 * 一起运动活动（campaign）：活动内排行榜 + 成员明细（仅发起人）。
 *
 * routes 属 Task 6 → 与 Task 2/3/4 同款做法：buildApp 只为连上 Mongo，断言直接打在 service 上；
 * 收尾只 `app.close()`（mongo 插件的 onClose 会断开连接）。
 *
 * 时间窗一律用**远期**（2099-01-01..2099-01-07）：`effectiveStatus` 按 now 派生，
 * 写死的历史窗口会让 join 立刻 403，用例就会随「今天是哪天」红绿飘忽。
 * 注意：排行榜/明细的**计入判据**只受「成员加入时段」约束（joinedAt 是真实 now），
 * 与活动 startAt/endAt 无关，所以造轨迹时以 joinedAt（≈now）为基准。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { CampaignModel } from '../src/models/campaign.model.js';
import { CampaignMemberModel } from '../src/models/campaign-member.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { createCampaign, joinCampaign, campaignLeaderboard, memberDetail } from '../src/services/campaign.js';
import type { CreateCampaignInput } from '../src/utils/validators.js';

let app: FastifyInstance;

const DAY = 86400000;

/** 固定用户池：每个用例各自建新活动，跨用例复用同一批用户是安全的（状态挂在活动-成员行上） */
const U = {
  creator: new mongoose.Types.ObjectId(),
  a: new mongoose.Types.ObjectId(),
  t: new mongoose.Types.ObjectId(),
  left: new mongoose.Types.ObjectId(),
  c: new mongoose.Types.ObjectId(),
  outsider: new mongoose.Types.ObjectId(),
  noSeg: new mongoose.Types.ObjectId(),
};

const createdIds: mongoose.Types.ObjectId[] = [];

const base = (over: Partial<CreateCampaignInput> = {}): CreateCampaignInput => ({
  title: 'T',
  description: '',
  visibility: 'public',
  allowedTypes: [],
  memberLimit: null,
  startDate: '2099-01-01',
  endDate: '2099-01-07',
  ...over,
});

async function mk(creator: string, over: Partial<CreateCampaignInput> = {}): Promise<string> {
  const dto = await createCampaign(creator, base(over));
  createdIds.push(new mongoose.Types.ObjectId(dto.id));
  return dto.id;
}

/** 造一条 finished 轨迹（缺省 vehicleMs=0） */
async function seedActivity(
  userId: mongoose.Types.ObjectId,
  startTime: number,
  type: string,
  over: { vehicleMs?: number; distance?: number; duration?: number; status?: string } = {},
) {
  const doc = await ActivityModel.create({
    userId,
    type,
    status: over.status ?? 'finished',
    startTime,
    distance: over.distance ?? 1000,
    duration: over.duration ?? 600,
    vehicleMs: over.vehicleMs ?? 0,
  });
  return doc._id;
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await UserModel.insertMany(
    Object.entries(U).map(([label, _id]) => ({
      _id,
      openid: `campaign-leaderboard-${label}`,
      nickname: `用户${label}`,
      avatarUrl: `https://x/${label}.png`,
      avatarPreset: 'default-1',
    })),
  );
});

after(async () => {
  await CampaignMemberModel.deleteMany({ campaignId: { $in: createdIds } });
  await CampaignModel.deleteMany({ _id: { $in: createdIds } });
  await ActivityModel.deleteMany({ userId: { $in: Object.values(U) } });
  await UserModel.deleteMany({ _id: { $in: Object.values(U) } });
  await app.close();
});

test('CL1 排行榜按距离降序，只含当前 joined 成员', async () => {
  const cid = await mk(String(U.creator), { title: 'CL1' });
  await joinCampaign(cid, String(U.a));

  const now = Date.now();
  // creator：1 条 1000m
  await seedActivity(U.creator, now + 1000, 'running', { distance: 1000, duration: 600 });
  // a：2 条合计 3000m（排名第一）
  await seedActivity(U.a, now + 2000, 'running', { distance: 2000, duration: 600 });
  await seedActivity(U.a, now + 3000, 'running', { distance: 1000, duration: 300 });

  // left：已离开但历史贡献保留（loadSegments 会把 left 行也读出来），距离最大。
  // 若排行榜忘了排除非 joined，它就会顶到 rows[0] —— 这条是那处遗漏的哨兵。
  const jb = now - 2 * DAY;
  await CampaignMemberModel.create({
    campaignId: new mongoose.Types.ObjectId(cid),
    userId: U.left,
    role: 'member',
    state: 'left',
    joinedAt: jb,
    leftAt: jb + DAY,
  });
  await seedActivity(U.left, jb + 3600_000, 'running', { distance: 9999 });

  const { rows } = await campaignLeaderboard(cid, String(U.a));

  assert.equal(rows.length, 2, '只有 creator 与 a 是 joined');
  assert.ok(
    !rows.some((r) => r.userId === String(U.left)),
    '已离开成员不得出现在排行榜里',
  );

  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].userId, String(U.a));
  assert.equal(rows[0].distance, 3000, '按距离降序：a 应排第一');
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].duration, 900);
  assert.equal(rows[0].name, '用户a', '昵称从 User 表解析');
  assert.equal(rows[0].avatarUrl, 'https://x/a.png');
  assert.equal(rows[0].avatarPreset, 'default-1');

  assert.equal(rows[1].rank, 2);
  assert.equal(rows[1].userId, String(U.creator));
  assert.equal(rows[1].distance, 1000);
});

test('CL2 非成员调排行榜 → 403；成员可调', async () => {
  const cid = await mk(String(U.creator), { title: 'CL2', visibility: 'private' });
  await joinCampaign(cid, String(U.a)); // private → pending（joinedAt 为 null，仍是非 joined）

  // 完全没加入过的登录用户
  await assert.rejects(
    () => campaignLeaderboard(cid, String(U.outsider)),
    (e: any) => {
      assert.equal(e.statusCode, 403);
      return true;
    },
  );
  // 待审批者（myState='pending'）也不是成员，同样看不到成员数据（§5 总则）
  await assert.rejects(
    () => campaignLeaderboard(cid, String(U.a)),
    (e: any) => e.statusCode === 403,
  );

  // 发起人（joined）可调，证明上面的 403 是按身份闸门而非一律拒绝
  const { rows } = await campaignLeaderboard(cid, String(U.creator));
  assert.deepEqual(
    rows.map((r) => r.userId),
    [String(U.creator)],
  );
});

test('CL3 成员明细：非发起人 403；发起人拿到概况 + 分页明细（判据与 campaign-stats 同口径）', async () => {
  const cid = await mk(String(U.creator), { title: 'CL3', allowedTypes: ['running'] });
  // 明细目标用**专属用户 t**：计入窗口以 joinedAt≈now 为下界，若复用其它用例的用户，
  // 那些用例造的「now 附近」轨迹会落进本次窗口，条数随用例执行耗时窜动。
  await joinCampaign(cid, String(U.t));
  await joinCampaign(cid, String(U.c));

  // 非发起人（同为 joined 成员）不得看他人明细
  await assert.rejects(
    () => memberDetail(cid, String(U.c), String(U.t), { page: 1, pageSize: 20 }),
    (e: any) => {
      assert.equal(e.statusCode, 403);
      return true;
    },
  );

  const now = Date.now();
  const a1 = await seedActivity(U.t, now + 1000, 'running', { distance: 2000, duration: 600 }); // ✓
  const a2 = await seedActivity(U.t, now + 2000, 'running', { distance: 1000, duration: 300 }); // ✓
  await seedActivity(U.t, now + 3000, 'running', { vehicleMs: 120000 }); // 搭车 → ✗
  await seedActivity(U.t, now + 4000, 'cycling'); // 白名单外 → ✗
  await seedActivity(U.t, now + 5000, 'running', { status: 'in_progress' }); // 未完成 → ✗
  await seedActivity(U.t, now - 100000, 'running'); // 加入前 → ✗
  // 老导入文档：整条没有 vehicleMs 字段 → 「没检出搭车」应计入（$lte:0 会误杀它）
  const old = await ActivityModel.collection.insertOne({
    userId: U.t,
    type: 'running',
    status: 'finished',
    startTime: now + 6000,
    distance: 500,
    duration: 100,
  });

  const d = await memberDetail(cid, String(U.creator), String(U.t), { page: 1, pageSize: 20 });

  assert.equal(d.stats.count, 3);
  assert.equal(d.stats.distance, 3500);
  assert.equal(d.stats.duration, 1000);
  assert.equal(d.total, 3);
  assert.equal(d.items.length, 3);
  assert.deepEqual(
    d.items.map((i) => i.id).sort(),
    [String(a1), String(a2), String(old.insertedId)].sort(),
  );
  // 明细按 startTime 倒序
  assert.deepEqual(
    d.items.map((i) => i.startTime),
    [...d.items.map((i) => i.startTime)].sort((x, y) => y - x),
  );
  assert.equal(d.items[0].type, 'running');
  assert.equal(typeof d.items[0].distance, 'number');
  assert.equal(typeof d.items[0].duration, 'number');
  assert.equal(typeof d.items[0].elevationGain, 'number');

  // 分页：pageSize=2 → 第 1 页 2 条、第 2 页 1 条，total 恒为 3
  const p1 = await memberDetail(cid, String(U.creator), String(U.t), { page: 1, pageSize: 2 });
  assert.equal(p1.items.length, 2);
  assert.equal(p1.total, 3);
  const p2 = await memberDetail(cid, String(U.creator), String(U.t), { page: 2, pageSize: 2 });
  assert.equal(p2.items.length, 1);
  assert.equal(p2.total, 3);

  // 该用户在活动里没有任何贡献时段（未加入过）→ 空明细，绝不能因 $or:[] 抛错
  const empty = await memberDetail(cid, String(U.creator), String(U.noSeg), { page: 1, pageSize: 20 });
  assert.equal(empty.stats.count, 0);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.items, []);
});
