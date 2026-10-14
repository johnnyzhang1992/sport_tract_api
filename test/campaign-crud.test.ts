/**
 * 一起运动活动（campaign）：创建 / 列表 / 详情（身份裁剪）。
 *
 * routes 属 Task 6 → 本文件与 Task 2 同款做法：buildApp 只为连上 Mongo，
 * 断言直接打在 service 上；收尾只 `app.close()`（mongo 插件的 onClose 会断开连接，不再手动 disconnect）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { CampaignModel } from '../src/models/campaign.model.js';
import { CampaignMemberModel } from '../src/models/campaign-member.model.js';
import {
  createCampaign,
  getCampaignDetail,
  listCampaigns,
  effectiveStatus,
} from '../src/services/campaign.js';
import type { CampaignDoc } from '../src/services/campaign-stats.js';
import type { CreateCampaignInput } from '../src/utils/validators.js';

const DAY_MS = 86400000;

let app: FastifyInstance;

/** 发起人（本文件唯一需要 User 文档的用户：成员行要取昵称 / 预设头像） */
const userId = new mongoose.Types.ObjectId();

/** 本文件创建的 campaign id：after() 只清这些，不碰 dev 库里既有数据 */
const createdIds: mongoose.Types.ObjectId[] = [];

/** createCampaign + 登记 id（清理用） */
async function create(creator: string, input: CreateCampaignInput) {
  const dto = await createCampaign(creator, input);
  createdIds.push(new mongoose.Types.ObjectId(dto.id));
  return dto;
}

/** 时间窗与状态无关的公共表单（10-01..10-02，相对运行时刻已是过去 → 派生状态 'ended'） */
const base = {
  description: '',
  visibility: 'public' as const,
  allowedTypes: [],
  memberLimit: null,
  startDate: '2026-10-01',
  endDate: '2026-10-02',
} satisfies Omit<CreateCampaignInput, 'title'>;

/**
 * 东八区「今天 + N 天」的日期串。
 * 需要断言 canJoin=true / status='active' 的用例必须用**落在 now 之后**的窗口：
 * effectiveStatus 是按 now 派生的（到期即 ended），写死的历史日期只会得到 ended → canJoin 恒为 false。
 */
function bjDateAfter(days: number): string {
  return new Date(Date.now() + days * DAY_MS + 8 * 3600000).toISOString().slice(0, 10);
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await UserModel.create({
    _id: userId,
    openid: `campaign-crud-${String(userId)}`,
    nickname: '小明',
    avatarUrl: '',
    avatarPreset: 'default-1',
  });
});

after(async () => {
  await CampaignMemberModel.deleteMany({ campaignId: { $in: createdIds } });
  await CampaignModel.deleteMany({ _id: { $in: createdIds } });
  await UserModel.deleteMany({ _id: userId });
  await app.close();
});

test('CC1 创建：发起人自动成为 joined 成员，startAt/endAt 落到东八区日边界', async () => {
  const dto = await create(String(userId), {
    title: '周末一起跑', description: '', visibility: 'public',
    allowedTypes: ['running'], memberLimit: null,
    startDate: '2026-10-01', endDate: '2026-10-07',
  });
  assert.equal(dto.myState, 'joined');
  assert.equal(dto.startAt, Date.UTC(2026, 8, 30, 16, 0, 0)); // 东八区 10-01 00:00
  // endDate 10-07 是**含**当日（model 注释：结束日 24:00 ＝ 次日 00:00，左闭右开）
  // → 东八区 10-08 00:00 == Date.UTC(2026, 9, 7, 16)。
  // 注意：brief/计划把这条字面量写成 Date.UTC(2026, 9, 6, 16)（＝东八区 10-07 00:00），
  // 与它自己的注释「10-08 00:00」和实现（endDate + 1 天）都差一天，属笔误，以语义为准。
  assert.equal(dto.endAt, Date.UTC(2026, 9, 7, 16, 0, 0));
  assert.equal(dto.endAt - dto.startAt, 7 * DAY_MS); // 10-01..10-07 含 7 个自然日

  const rows = await CampaignMemberModel.find({ campaignId: dto.id, userId });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'creator');
  assert.equal(rows[0].state, 'joined');
  assert.ok(rows[0].joinedAt, 'joinedAt 应落库（统计时间窗的下界）');
});

test('CC2 标题/描述过内容安全检测（checkText 被调用）', async () => {
  // 见 wechat-sec.checkText：未配置 WX_SECRET 时降级放行；此用例只断言不因检测而 5xx
  const dto = await create(String(userId), {
    title: '合规标题', description: '正常描述', visibility: 'public',
    allowedTypes: [], memberLimit: null, startDate: '2026-10-01', endDate: '2026-10-02',
  });
  assert.ok(dto.id);
});

test('CC3 详情按身份裁剪：非成员看不到成员列表与汇总', async () => {
  const outsider = new mongoose.Types.ObjectId();
  // 用「现在之后」的窗口：只有 active 才可能 canJoin=true（见 bjDateAfter 注释）
  const dto = await create(String(userId), {
    title: 'X', description: '', visibility: 'public', allowedTypes: [], memberLimit: null,
    startDate: bjDateAfter(1), endDate: bjDateAfter(2),
  });
  const asOutsider = await getCampaignDetail(dto.id, String(outsider));
  assert.equal(asOutsider.members, undefined);
  assert.equal(asOutsider.totals, undefined);
  assert.equal(asOutsider.myPanel, undefined);
  assert.equal(asOutsider.myState, 'none');
  assert.equal(asOutsider.status, 'active');
  assert.equal(asOutsider.canJoin, true);

  const asCreator = await getCampaignDetail(dto.id, String(userId));
  assert.ok(Array.isArray(asCreator.members));
  assert.ok(asCreator.totals);
  assert.equal(asCreator.canJoin, false); // 已在队 → 不能再加入
  assert.deepEqual(asCreator.totals, { count: 0, distance: 0, duration: 0 });
  assert.deepEqual(asCreator.myPanel, { count: 0, distance: 0, duration: 0, streak: 0 });
  const me = asCreator.members?.find((m) => m.userId === String(userId));
  assert.ok(me, '成员列表应含发起人');
  assert.equal(me.role, 'creator');
  assert.equal(me.name, '小明');
  assert.equal(me.avatarPreset, 'default-1');
});

test('CC4 非法 id → 404', async () => {
  await assert.rejects(() => getCampaignDetail('not-an-id', String(userId)), (e: any) => e.statusCode === 404);
});

test('CC5 列表 role：created 只回我发起的，joined 只回我参与的', async () => {
  const a = new mongoose.Types.ObjectId();
  const b = new mongoose.Types.ObjectId();
  const c1 = await create(String(a), { ...base, title: 'A1' });
  const c2 = await create(String(a), { ...base, title: 'A2' });
  const c3 = await create(String(b), { ...base, title: 'B1' });
  // 直接造一行「a 参与 b 的活动」——joinCampaign 属 Task 4，本任务还不能用
  await CampaignMemberModel.create({ campaignId: new mongoose.Types.ObjectId(c3.id), userId: a, role: 'member', state: 'joined', joinedAt: Date.now() });

  const created = await listCampaigns(String(a), { role: 'created', page: 1, pageSize: 20 });
  assert.deepEqual(created.items.map((i) => i.id).sort(), [c1.id, c2.id].sort());
  assert.equal(created.total, 2);
  assert.equal(created.page, 1);
  assert.equal(created.pageSize, 20);

  const joined = await listCampaigns(String(a), { role: 'joined', page: 1, pageSize: 20 });
  assert.deepEqual(joined.items.map((i) => i.id), [c3.id]);
  assert.equal(joined.total, 1);
  // 卡片自带我在该活动的汇总（无轨迹 → 全 0）
  assert.deepEqual(joined.items[0].myStats, { count: 0, distance: 0, duration: 0 });
});

test('CC6 effectiveStatus：到期即 ended（不写库），dissolved 优先于时间', async () => {
  const dto = await create(String(userId), { ...base, title: '状态判定' });
  const doc = (await CampaignModel.findById(dto.id).lean()) as unknown as CampaignDoc;
  assert.equal(effectiveStatus(doc, dto.endAt - 1), 'active'); // 结束前一刻仍是 active
  assert.equal(effectiveStatus(doc, dto.endAt), 'ended');      // now >= endAt 即到期
  // 10-01..10-02 相对运行时刻已过 → 详情里派生为 ended，但库里 status 未被改写
  assert.equal((await getCampaignDetail(dto.id, String(userId))).status, 'ended');
  assert.equal((await CampaignModel.findById(dto.id).lean())!.status, 'active');

  await CampaignModel.updateOne({ _id: dto.id }, { status: 'dissolved' });
  const dissolved = (await CampaignModel.findById(dto.id).lean()) as unknown as CampaignDoc;
  assert.equal(effectiveStatus(dissolved, dto.endAt - 1), 'dissolved');
  assert.equal((await getCampaignDetail(dto.id, String(userId))).status, 'dissolved');
});
