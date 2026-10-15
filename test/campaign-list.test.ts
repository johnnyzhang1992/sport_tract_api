/**
 * 一起运动「我的活动」列表（listCampaigns）口径：
 *
 * 1) 已解散的活动**不出现在列表**（我发起 / 我参与都过滤；仍可通过分享链接/小程序码进详情只读）。
 * 2) 存活的活动三段式降为两段排序：
 *      ① 进行中（endAt 升序 —— 快结束的在前）
 *      ② 已结束（endAt 降序 —— 刚结束的在前）
 *    同档同结束时间再按 createdAt 倒序。排序必须在 skip/limit **之前**生效。
 *
 * 桩：buildApp 只为连上 Mongo；断言打在 service 上；after() 只清本文件造的数据。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { CampaignModel } from '../src/models/campaign.model.js';
import { CampaignMemberModel } from '../src/models/campaign-member.model.js';
import { createCampaign, listCampaigns } from '../src/services/campaign.js';
import type { CreateCampaignInput } from '../src/utils/validators.js';

const DAY_MS = 86400000;

let app: FastifyInstance;

/** 本文件创建的 campaign id：after() 只清这些，不碰 dev 库里既有数据 */
const createdIds: mongoose.Types.ObjectId[] = [];

async function create(creator: string, title: string) {
  const input = {
    title,
    description: '',
    visibility: 'public' as const,
    allowedTypes: [],
    memberLimit: null,
    startDate: '2026-10-01',
    endDate: '2026-10-02',
  } satisfies CreateCampaignInput;
  const dto = await createCampaign(creator, input);
  createdIds.push(new mongoose.Types.ObjectId(dto.id));
  return dto;
}

/**
 * 造 5 条：两条进行中（结束时间不同）、两条已结束（结束时间不同）、一条已解散。
 * endAt 直接写库（创建接口只吃日期串，落不到分钟级差异）。
 * 创建顺序刻意与期望顺序**相反**，保证「按创建时间排」的实现会红。
 */
async function seed(creator: string) {
  const now = Date.now();
  const soon = await create(creator, 'soon'); // 进行中，最快结束
  const later = await create(creator, 'later'); // 进行中，较晚结束
  const recentEnd = await create(creator, 'recentEnd'); // 已结束，刚结束
  const oldEnd = await create(creator, 'oldEnd'); // 已结束，早就结束
  const gone = await create(creator, 'gone'); // 已解散（应被列表过滤）

  await CampaignModel.updateOne({ _id: soon.id }, { $set: { startAt: now - DAY_MS, endAt: now + 2 * DAY_MS } });
  await CampaignModel.updateOne({ _id: later.id }, { $set: { startAt: now - DAY_MS, endAt: now + 9 * DAY_MS } });
  await CampaignModel.updateOne({ _id: recentEnd.id }, { $set: { startAt: now - 5 * DAY_MS, endAt: now - 1 * DAY_MS } });
  await CampaignModel.updateOne({ _id: oldEnd.id }, { $set: { startAt: now - 30 * DAY_MS, endAt: now - 20 * DAY_MS } });
  // 已解散：status 落库为 dissolved；endAt 即便在未来也仍是 dissolved
  await CampaignModel.updateOne({ _id: gone.id }, { $set: { status: 'dissolved', endAt: now + 5 * DAY_MS } });

  return { soon, later, recentEnd, oldEnd, gone };
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await CampaignMemberModel.deleteMany({ campaignId: { $in: createdIds } });
  await CampaignModel.deleteMany({ _id: { $in: createdIds } });
  await app.close();
});

test('CL1 已解散的活动不出现在「我发起」列表', async () => {
  const owner = new mongoose.Types.ObjectId();
  const { gone } = await seed(String(owner));

  const list = await listCampaigns(String(owner), { role: 'created', page: 1, pageSize: 20 });

  assert.equal(list.total, 4, '已解散那条不计入 total');
  assert.equal(list.items.some((i) => i.id === gone.id), false, '已解散的活动不出现在列表');
  assert.equal(list.items.some((i) => i.status === 'dissolved'), false);
});

test('CL2 已解散的活动不出现在「我参与」列表', async () => {
  const owner = new mongoose.Types.ObjectId();
  const me = new mongoose.Types.ObjectId();
  const { gone, soon } = await seed(String(owner));
  // 我是这两条的成员（joined）
  await CampaignMemberModel.create([
    { campaignId: new mongoose.Types.ObjectId(soon.id), userId: me, role: 'member', state: 'joined', joinedAt: Date.now() },
    { campaignId: new mongoose.Types.ObjectId(gone.id), userId: me, role: 'member', state: 'joined', joinedAt: Date.now() },
  ]);

  const list = await listCampaigns(String(me), { role: 'joined', page: 1, pageSize: 20 });

  assert.deepEqual(list.items.map((i) => i.id), [soon.id], '只回没解散的那条');
  assert.equal(list.total, 1);
});

test('CL3 两段式：进行中(快结束在前) → 已结束(刚结束在前)', async () => {
  const owner = new mongoose.Types.ObjectId();
  const { soon, later, recentEnd, oldEnd } = await seed(String(owner));

  const list = await listCampaigns(String(owner), { role: 'created', page: 1, pageSize: 20 });

  assert.deepEqual(
    list.items.map((i) => i.id),
    [soon.id, later.id, recentEnd.id, oldEnd.id],
  );
  assert.deepEqual(
    list.items.map((i) => i.status),
    ['active', 'active', 'ended', 'ended'],
  );
});

test('CL4 排序在分页之前生效（page/pageSize 与整表序一致）', async () => {
  const owner = new mongoose.Types.ObjectId();
  const { soon, later, recentEnd, oldEnd } = await seed(String(owner));

  const p1 = await listCampaigns(String(owner), { role: 'created', page: 1, pageSize: 2 });
  const p2 = await listCampaigns(String(owner), { role: 'created', page: 2, pageSize: 2 });

  assert.deepEqual(p1.items.map((i) => i.id), [soon.id, later.id]);
  assert.deepEqual(p2.items.map((i) => i.id), [recentEnd.id, oldEnd.id]);
  assert.equal(p1.total, 4);
});
