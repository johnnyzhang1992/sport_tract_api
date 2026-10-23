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
import { createCampaign, joinCampaign, leaveCampaign, campaignLeaderboard, memberDetail, getCampaignDetail, campaignTrend } from '../src/services/campaign.js';
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

/** CL4 分页用例专用的 24 名成员（+ 发起人共 25 人）：after() 里一并清掉 */
const pagedUserIds: mongoose.Types.ObjectId[] = [];

const DAY_MS = 86400000;

/** 相对「今天」的东八区 YYYY-MM-DD */
function bjDateAfter(days: number): string {
  return new Date(Date.now() + 8 * 3600000 + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * 窗口取「已开赛 3 天、还剩 3 天」：结束在未来 → 派生 active，join 不被挡；
 * 开始也在过去 → 计入窗口下限 max(startAt, joinedAt) 落在 joinedAt 上，
 * 本文件以 joinedAt（≈now）为基准造的轨迹才在窗内。
 */
const base = (over: Partial<CreateCampaignInput> = {}): CreateCampaignInput => ({
  title: 'T',
  description: '',
  visibility: 'public',
  allowedTypes: [],
  memberLimit: null,
  startDate: bjDateAfter(-3),
  endDate: bjDateAfter(3),
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
  await ActivityModel.deleteMany({ userId: { $in: [...Object.values(U), ...pagedUserIds] } });
  await UserModel.deleteMany({ _id: { $in: [...Object.values(U), ...pagedUserIds] } });
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

  const { rows } = await campaignLeaderboard(cid, String(U.a), { page: 1, pageSize: 20 });

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
    () => campaignLeaderboard(cid, String(U.outsider), { page: 1, pageSize: 20 }),
    (e: any) => {
      assert.equal(e.statusCode, 403);
      return true;
    },
  );
  // 待审批者（myState='pending'）也不是成员，同样看不到成员数据（§5 总则）
  await assert.rejects(
    () => campaignLeaderboard(cid, String(U.a), { page: 1, pageSize: 20 }),
    (e: any) => e.statusCode === 403,
  );

  // 发起人（joined）可调，证明上面的 403 是按身份闸门而非一律拒绝
  const { rows } = await campaignLeaderboard(cid, String(U.creator), { page: 1, pageSize: 20 });
  assert.deepEqual(
    rows.map((r) => r.userId),
    [String(U.creator)],
  );
});

test('CL3 成员明细：活动内成员可看（非成员 / 已退出 403）；发起人拿到概况 + 分页明细；成员零轨迹 200、未加入 404（判据与 campaign-stats 同口径）', async () => {
  const cid = await mk(String(U.creator), { title: 'CL3', allowedTypes: ['running'] });
  // 明细目标用**专属用户 t**：计入窗口以 joinedAt≈now 为下界，若复用其它用例的用户，
  // 那些用例造的「now 附近」轨迹会落进本次窗口，条数随用例执行耗时窜动。
  await joinCampaign(cid, String(U.t));
  await joinCampaign(cid, String(U.c));

  // 闸门认的是「现在是不是活动内成员」：从未加入 → 403（成员数据不外泄的对象是非成员）
  await assert.rejects(
    () => memberDetail(cid, String(U.outsider), String(U.t), { page: 1, pageSize: 20 }),
    (e: any) => {
      assert.equal(e.statusCode, 403);
      return true;
    },
  );
  // 加入过又退出的人不再是成员 → 同样 403（「曾经是成员」不放行）
  await joinCampaign(cid, String(U.left));
  await leaveCampaign(cid, String(U.left));
  await assert.rejects(
    () => memberDetail(cid, String(U.left), String(U.t), { page: 1, pageSize: 20 }),
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
  // 「同源」回归：total 走 memberDetail 的明细查询（countDocuments(memberActivityMatch)），
  // stats.count 走 statsForMembers 的聚合（baseMatch + timeOr）——两条路径必须给出一致的计入判据。
  // 本 fixture 覆盖了每个判据分支（搭车 vehicleMs / 白名单外 type / 未完成 status / 加入前时间窗 /
  // 无 vehicleMs 字段的老文档），任一条判据只在一边改动，这两个数就会分叉、此断言即红。
  assert.equal(
    d.total,
    d.stats.count,
    '明细条数与汇总次数必须同源——两条路径的计入判据若分叉即变红',
  );
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

  // 同为 joined 的普通成员（U.c）看到的是**同一份**明细——不是「能打开但内容被裁剪」：
  // 两份载荷必须逐字段相等，否则「成员可见」就成了半开的口子。
  const dAsMember = await memberDetail(cid, String(U.c), String(U.t), { page: 1, pageSize: 20 });
  assert.deepEqual(dAsMember.items, d.items);
  assert.deepEqual(dAsMember.stats, d.stats);
  assert.equal(dAsMember.total, d.total);

  // 分页：pageSize=2 → 第 1 页 2 条、第 2 页 1 条，total 恒为 3
  const p1 = await memberDetail(cid, String(U.creator), String(U.t), { page: 1, pageSize: 2 });
  assert.equal(p1.items.length, 2);
  assert.equal(p1.total, 3);
  const p2 = await memberDetail(cid, String(U.creator), String(U.t), { page: 2, pageSize: 2 });
  assert.equal(p2.items.length, 1);
  assert.equal(p2.total, 3);

  // 是成员但零轨迹 → 仍 200 + 全 0（A3 改动后的「不要误伤」面：有加入段即可，轨迹可以一条都没有）
  const zero = await memberDetail(cid, String(U.creator), String(U.c), { page: 1, pageSize: 20 });
  assert.equal(zero.stats.count, 0);
  assert.equal(zero.total, 0);
  assert.deepEqual(zero.items, []);

  // 未加入过（在本活动没有任何加入段）→ 404：不是成员就不按「空数据」回 200。
  // （旧行为是 200 + 全 0，与本仓「非法/不属于即 404」惯例冲突，随 A3 修正。）
  await assert.rejects(
    () => memberDetail(cid, String(U.creator), String(U.noSeg), { page: 1, pageSize: 20 }),
    (e: any) => e.statusCode === 404,
  );
});

/* ─────────────── CL4 排行榜分页（GET /:id/leaderboard?page&pageSize） ───────────────
 * 名次是**全局名次**而不是页内序号：端上「加载更多」是往同一个列表后面追加，
 * 第二页首行若回 rank=1，屏上就会出现两个第 1 名。
 * 排序仍按距离降序、仍只含 joined —— CL1 已钉，这里只钉「切页」这一层。
 * ─────────────────────────────────────────────────────────────────────────────── */

/** 批次号：openid 上有唯一索引，多批成员不能撞 openid */
let pagedBatch = 0;

/**
 * 造一个 25 人活动：成员 m1..m24 距离 1000..24000，发起人 500m。
 * 于是名次完全可预测：m24=1、m23=2 … m1=24、发起人=25（垫底，正好落在第二页末尾）。
 */
async function mkPaged(title: string): Promise<string> {
  const cid = await mk(String(U.creator), { title });
  const now = Date.now();
  const joinedAt = now - 10 * DAY;
  const batch = ++pagedBatch;
  for (let i = 1; i <= 24; i++) {
    const uid = new mongoose.Types.ObjectId();
    pagedUserIds.push(uid);
    await UserModel.create({
      _id: uid,
      openid: `campaign-leaderboard-paged-${batch}-${i}`,
      nickname: `成员${i}`,
      avatarUrl: '',
      avatarPreset: 'default-1',
    });
    await CampaignMemberModel.create({
      campaignId: new mongoose.Types.ObjectId(cid),
      userId: uid,
      role: 'member',
      state: 'joined',
      joinedAt,
    });
    await seedActivity(uid, now, 'running', { distance: i * 1000, duration: 600 });
  }
  await seedActivity(U.creator, now, 'running', { distance: 500, duration: 600 });
  return cid;
}

test('CL4 排行榜分页：page1 回 20 行、page2 回 5 行，名次接着数且两页不重不漏', async () => {
  const cid = await mkPaged('CL4');

  const p1 = await campaignLeaderboard(cid, String(U.creator), { page: 1, pageSize: 20 });
  assert.equal(p1.total, 25, 'total 是 joined 成员总数，与分页无关');
  assert.equal(p1.page, 1);
  assert.equal(p1.pageSize, 20);
  assert.equal(p1.rows.length, 20);
  assert.equal(p1.rows[0].rank, 1);
  assert.equal(p1.rows[0].userId, String(pagedUserIds[23]), '距离 24000 的成员排第一');
  assert.equal(p1.rows[19].rank, 20);

  const p2 = await campaignLeaderboard(cid, String(U.creator), { page: 2, pageSize: 20 });
  assert.equal(p2.rows.length, 5);
  assert.equal(p2.rows[0].rank, 21, '第二页首行名次必须是 21 —— 用页内下标就会写成 1');
  assert.equal(p2.rows[4].rank, 25);
  assert.equal(p2.rows[4].userId, String(U.creator), '发起人 500m 垫底，正好落在第二页末行');

  const ids = p1.rows.concat(p2.rows).map((r) => r.userId);
  assert.equal(new Set(ids).size, 25, '两页拼起来不重不漏');
  assert.deepEqual(
    p1.rows.concat(p2.rows).map((r) => r.rank),
    Array.from({ length: 25 }, (_, i) => i + 1),
    '拼起来的名次序列必须正好是 1..25',
  );
});

test('CL5 越界页回空数组但 total 照给（端上据此收起「加载更多」，不能靠 rows.length 判到底）', async () => {
  const cid = await mkPaged('CL5');
  const p3 = await campaignLeaderboard(cid, String(U.creator), { page: 3, pageSize: 20 });
  assert.deepEqual(p3.rows, []);
  assert.equal(p3.total, 25);
  assert.equal(p3.page, 3);
});

test('CL6 分页不改变闸门与排序口径：非成员仍 403，页内仍是距离降序', async () => {
  const cid = await mkPaged('CL6');
  await assert.rejects(
    () => campaignLeaderboard(cid, String(U.outsider), { page: 1, pageSize: 20 }),
    (e: any) => e.statusCode === 403,
  );
  const p1 = await campaignLeaderboard(cid, String(U.creator), { page: 1, pageSize: 20 });
  assert.deepEqual(
    p1.rows.map((r) => r.distance),
    [...p1.rows.map((r) => r.distance)].sort((x, y) => y - x),
  );
});

test('CL7 每页大小可变：pageSize=10 时第 3 页是第 21..30 名（名次跟着页偏移走）', async () => {
  const cid = await mkPaged('CL7');
  const p3 = await campaignLeaderboard(cid, String(U.creator), { page: 3, pageSize: 10 });
  assert.equal(p3.rows.length, 5, '25 人 → 第 3 页只剩 21..25');
  assert.deepEqual(p3.rows.map((r) => r.rank), [21, 22, 23, 24, 25]);
});


/** 共享用户池的轨迹会被后续用例的计入窗口吞进来：新用例开头先清一遍（CL4-7 的专属用户不受影响） */
async function clearSharedActivities() {
  await ActivityModel.deleteMany({ userId: { $in: [U.creator, U.a, U.t, U.c, U.left] } });
}

test('CL8 详情 myPanel 带名次 / 总人数 / 距第一名 / 距上一名 / 全队占比', async () => {
  await clearSharedActivities();
  const cid = await mk(String(U.creator), { title: 'CL8' });
  await joinCampaign(cid, String(U.a));
  await joinCampaign(cid, String(U.t));
  const now = Date.now();
  await seedActivity(U.creator, now + 1000, 'running', { distance: 3000, duration: 1800 });
  await seedActivity(U.a, now + 1000, 'running', { distance: 4000, duration: 2400 });
  await seedActivity(U.t, now + 1000, 'running', { distance: 500, duration: 300 });

  const asA = await getCampaignDetail(cid, String(U.a));
  assert.equal(asA.myPanel?.rank, 1);
  assert.equal(asA.myPanel?.members, 3);
  assert.equal(asA.myPanel?.gapToLeader, 0);
  assert.equal(asA.myPanel?.gapToPrev, 0, '第一名没有上一名');
  assert.ok(Math.abs((asA.myPanel?.share ?? 0) - 4000 / 7500) < 1e-9, '我的距离 / 全队距离');

  const asCreator = await getCampaignDetail(cid, String(U.creator));
  assert.equal(asCreator.myPanel?.rank, 2);
  assert.equal(asCreator.myPanel?.gapToLeader, 1000);
  assert.equal(asCreator.myPanel?.gapToPrev, 1000, '第 2 名的上一名就是榜首，两个数应当相等');

  // 第 3 名才是两个口径的分水岭：距榜首 3500，但追上上一名（第 2 名）只差 2500
  const asT = await getCampaignDetail(cid, String(U.t));
  assert.equal(asT.myPanel?.rank, 3);
  assert.equal(asT.myPanel?.gapToLeader, 3500);
  assert.equal(asT.myPanel?.gapToPrev, 2500);
});

test('CL9 排行支持次数/时长指标，并回 my 名次与差距', async () => {
  await clearSharedActivities();
  const cid = await mk(String(U.creator), { title: 'CL9' });
  await joinCampaign(cid, String(U.a));
  await joinCampaign(cid, String(U.t));
  const now = Date.now();
  // creator 2 次、a 1 次；距离 a 更大、时长 a 更长
  await seedActivity(U.creator, now + 1000, 'running', { distance: 500, duration: 600 });
  await seedActivity(U.creator, now + 2000, 'running', { distance: 500, duration: 600 });
  await seedActivity(U.a, now + 1000, 'running', { distance: 4000, duration: 2400 });
  await seedActivity(U.t, now + 1000, 'running', { distance: 500, duration: 300 });

  const byDist = await campaignLeaderboard(cid, String(U.a), { page: 1, pageSize: 20 });
  assert.equal(byDist.metric, 'distance');
  assert.equal(byDist.rows[0].userId, String(U.a));
  assert.equal(byDist.my?.rank, 1);

  const byCount = await campaignLeaderboard(cid, String(U.a), { page: 1, pageSize: 20, metric: 'count' });
  assert.equal(byCount.metric, 'count');
  assert.equal(byCount.rows[0].userId, String(U.creator), '2 次排第一');
  assert.equal(byCount.my?.rank, 2);
  assert.equal(byCount.my?.value, 1);
  assert.equal(byCount.my?.gapToLeader, 1);

  const byDur = await campaignLeaderboard(cid, String(U.a), { page: 1, pageSize: 20, metric: 'duration' });
  assert.equal(byDur.rows[0].userId, String(U.a), '2400s 最长');
  assert.equal(byDur.my?.rank, 1);
});

test('CL10 类型筛选只统计指定类型；超出活动白名单返回 400', async () => {
  await clearSharedActivities();
  const cid = await mk(String(U.creator), { title: 'CL10', allowedTypes: ['running', 'walking'] });
  await joinCampaign(cid, String(U.a));
  const now = Date.now();
  await seedActivity(U.creator, now + 1000, 'running', { distance: 1000 });
  await seedActivity(U.creator, now + 2000, 'walking', { distance: 5000 });
  await seedActivity(U.a, now + 1000, 'running', { distance: 3000 });

  const running = await campaignLeaderboard(cid, String(U.a), { page: 1, pageSize: 20, type: 'running' });
  assert.equal(running.type, 'running');
  assert.equal(running.rows[0].userId, String(U.a));
  assert.equal(running.rows[0].distance, 3000);

  const walking = await campaignLeaderboard(cid, String(U.a), { page: 1, pageSize: 20, type: 'walking' });
  assert.equal(walking.rows[0].userId, String(U.creator));
  assert.equal(walking.rows[0].distance, 5000);
  assert.equal(walking.my?.value, 0);

  await assert.rejects(
    () => campaignLeaderboard(cid, String(U.a), { page: 1, pageSize: 20, type: 'cycling' }),
    (e: any) => e.statusCode === 400,
    '白名单外的类型不能悄悄查',
  );
});

test('CL11 每日累计趋势：返回全员口径的日期桶，me 与前三均在内', async () => {
  await clearSharedActivities();
  const cid = await mk(String(U.creator), { title: 'CL11', allowedTypes: ['running', 'walking'] });
  await joinCampaign(cid, String(U.a));
  await joinCampaign(cid, String(U.t));
  const cDoc = (await CampaignModel.findById(cid).lean()) as any;
  // 把三人的加入时间挪到开赛时，才能造多天轨迹
  await CampaignMemberModel.updateMany({ campaignId: new mongoose.Types.ObjectId(cid) }, { $set: { joinedAt: cDoc.startAt } });
  const day = cDoc.startAt + 3600_000;
  await seedActivity(U.creator, day, 'running', { distance: 1000 });
  await seedActivity(U.creator, day + DAY, 'walking', { distance: 3000 });
  await seedActivity(U.a, day, 'running', { distance: 1000 });
  await seedActivity(U.a, day + DAY, 'running', { distance: 2000 });
  await seedActivity(U.a, day + 2 * DAY, 'running', { distance: 1000 });

  const trend = await campaignTrend(cid, String(U.a), {});
  assert.equal(trend.metric, 'distance');
  assert.ok(trend.labels.length >= 3, '开赛至今至少 3 个日期桶');
  // X 轴标签的日期分隔符跟 App 其它日期展示同一口径（斜杠），别留 ISO 的横杠
  assert.ok(
    trend.labels.every((l: string) => /^\d{2}\/\d{2}$/.test(l)),
    `标签应为 MM/DD，实际 ${JSON.stringify(trend.labels.slice(0, 3))}`,
  );
  assert.equal(trend.series.length, 3, '三名成员都在');
  const mine = trend.series.find((s: any) => s.userId === String(U.a));
  assert.ok(mine && mine.isMe, '本人系列要标记 isMe');
  assert.equal(mine.values[mine.values.length - 1], 4000, '累计距离 4km');
  assert.deepEqual(mine.values.slice(-3), [3000, 4000, 4000], '按日累计');

  const walking = await campaignTrend(cid, String(U.a), { type: 'walking' });
  const creator = walking.series.find((s: any) => s.userId === String(U.creator));
  assert.ok(creator, '类型筛选后 creator 仍在系列里');
  assert.equal(creator!.values[creator!.values.length - 1], 3000, '只看散步：creator 3km');
  const mineWalking = walking.series.find((s: any) => s.userId === String(U.a));
  assert.ok(mineWalking, '本人系列恒在');
  assert.equal(mineWalking!.values[mineWalking!.values.length - 1], 0);
});

test('CL12 by=type：一条线＝一个运动类型，全队口径且与汇总卡同源', async () => {
  await clearSharedActivities();
  const cid = await mk(String(U.creator), { title: 'CL12', allowedTypes: ['running', 'walking', 'cycling'] });
  await joinCampaign(cid, String(U.a));
  await joinCampaign(cid, String(U.t));
  await joinCampaign(cid, String(U.c));
  const cDoc = (await CampaignModel.findById(cid).lean()) as any;
  // creator / t / c 从开赛就在队；a 晚两天才加入——他加入前那 9km 不该进任何类型线
  await CampaignMemberModel.updateMany({ campaignId: new mongoose.Types.ObjectId(cid) }, { $set: { joinedAt: cDoc.startAt } });
  await CampaignMemberModel.updateOne(
    { campaignId: new mongoose.Types.ObjectId(cid), userId: U.a },
    { $set: { joinedAt: cDoc.startAt + 2 * DAY } },
  );
  const day = cDoc.startAt + 3600_000;
  await seedActivity(U.creator, day, 'running', { distance: 1000 });
  await seedActivity(U.creator, day + DAY, 'walking', { distance: 3000 });
  await seedActivity(U.a, day, 'running', { distance: 9000 });
  await seedActivity(U.a, day + 2 * DAY, 'cycling', { distance: 2000 });
  await seedActivity(U.t, day + 2 * DAY, 'running', { distance: 500 });
  // c 故意排第 4：按人档只画前三 + 我，画不到他；按类型档必须把他算进骑行线
  await seedActivity(U.c, day + 2 * DAY, 'cycling', { distance: 100 });

  const byType = await campaignTrend(cid, String(U.a), { by: 'type' });
  assert.equal(byType.by, 'type');
  assert.deepEqual(
    byType.series.map((s: any) => s.type).sort(),
    ['cycling', 'running', 'walking'],
    '只出有数据的三类；a 加入前的 9km 不计入任何类型',
  );
  const last = (t: string) => {
    const s = byType.series.find((x: any) => x.type === t)!;
    return s.values[s.values.length - 1];
  };
  assert.equal(last('running'), 1500, '跑步＝creator 1000 + t 500（a 的 9000 在加入前）');
  assert.equal(last('walking'), 3000);
  assert.equal(last('cycling'), 2100, '骑行线吃全队：第 4 名 c 的 100m 也要在里面');
  assert.ok(byType.series.every((s: any) => !s.isMe), '按类型档没有「我」这条线');
  assert.ok(byType.series.every((s: any) => s.userId === undefined), '按类型档不下发 userId');

  // 各条线终点相加＝「全队汇总」卡的距离：两处同源，不会分叉
  const detail = await getCampaignDetail(cid, String(U.a));
  const sum = byType.series.reduce((acc: number, s: any) => acc + s.values[s.values.length - 1], 0);
  assert.equal(sum, detail.totals!.distance, '分类型累计之和要等于全队运动距离');

  // 按类型档照吃类型 chip：只看骑行就只有一条线，且仍是全队口径
  const onlyCycling = await campaignTrend(cid, String(U.a), { by: 'type', type: 'cycling' });
  assert.deepEqual(onlyCycling.series.map((s: any) => s.type), ['cycling']);
  assert.equal(onlyCycling.series[0].values[onlyCycling.series[0].values.length - 1], 2100);

  // 缺省档＝按人，与今天完全一致：系列带 userId、不带 type，且只有前三 + 我（画不到第 4 名 c）
  const byPerson = await campaignTrend(cid, String(U.a), {});
  assert.equal(byPerson.by, 'person');
  assert.ok(byPerson.series.every((s: any) => s.userId && s.type === undefined), '按人档形状不变');
  assert.equal(byPerson.series.length, 3, '按人档＝前三 + 我，不铺全队');
  assert.ok(!byPerson.series.some((s: any) => s.userId === String(U.c)), '第 4 名不在按人档里');
});
