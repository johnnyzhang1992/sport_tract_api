/**
 * 一起运动活动（campaign）：成员状态机
 * join / leave / approve / reject / pending / kick / dissolve。
 *
 * routes 属 Task 6 → 与 Task 2/3 同款做法：buildApp 只为连上 Mongo，断言直接打在 service 上；
 * 收尾只 `app.close()`（mongo 插件的 onClose 会断开连接，不再手动 disconnect）。
 *
 * 时间窗一律用**远期**（2099-01-01..2099-01-07）：
 * `effectiveStatus` 是按 now 派生的（now >= endAt 即 ended），写死的历史窗口会让 join 立刻 403，
 * 用例就会因为「今天是哪天」而红绿飘忽，与要验证的状态机无关。只有刻意断言 dissolved 的用例才另说。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';
import { UserModel } from '../src/models/user.model.js';
import { CampaignModel } from '../src/models/campaign.model.js';
import { CampaignMemberModel } from '../src/models/campaign-member.model.js';
import {
  createCampaign,
  joinCampaign,
  leaveCampaign,
  listPending,
  approveMember,
  rejectMember,
  kickMember,
  dissolveCampaign,
  loadCampaignOr404,
  assertCreator,
} from '../src/services/campaign.js';
import type { CreateCampaignInput } from '../src/utils/validators.js';

let app: FastifyInstance;

/** 固定用户池：每个用例各自建新活动，跨用例复用同一批用户是安全的（状态挂在活动-成员行上） */
const U = {
  creator: new mongoose.Types.ObjectId(),
  outsider: new mongoose.Types.ObjectId(),
  a: new mongoose.Types.ObjectId(),
  b: new mongoose.Types.ObjectId(),
  c: new mongoose.Types.ObjectId(),
  d: new mongoose.Types.ObjectId(),
  e: new mongoose.Types.ObjectId(),
  f: new mongoose.Types.ObjectId(),
};

/** 本文件创建的 campaign id：after() 只清这些，不碰 dev 库里既有数据 */
const createdIds: mongoose.Types.ObjectId[] = [];

/**
 * 窗口取「已开赛 3 天、还剩 3 天」：
 * 结束在未来 → `effectiveStatus` 派生为 active，join/approve 不被状态闸门挡；
 * 开始也在过去 → 不会因「未开始」把用例顺带推进 upcoming 档（那是 campaign-upcoming.test.ts 的活）。
 * 写死日期会让红绿随「今天是哪天」飘忽，所以一律相对 now。
 */
const DAY_MS = 86400000;
function bjDateAfter(days: number): string {
  return new Date(Date.now() + 8 * 3600000 + days * DAY_MS).toISOString().slice(0, 10);
}

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

/** createCampaign + 登记 id（清理用），返回活动 id 字符串 */
async function mk(creator: string, over: Partial<CreateCampaignInput> = {}): Promise<string> {
  const dto = await createCampaign(creator, base(over));
  createdIds.push(new mongoose.Types.ObjectId(dto.id));
  return dto.id;
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await UserModel.insertMany(
    Object.entries(U).map(([label, _id]) => ({
      _id,
      openid: `campaign-membership-${label}`,
      nickname: `用户${label}`,
      avatarUrl: '',
      avatarPreset: 'default-1',
    })),
  );
});

after(async () => {
  await CampaignMemberModel.deleteMany({ campaignId: { $in: createdIds } });
  await CampaignModel.deleteMany({ _id: { $in: createdIds } });
  await UserModel.deleteMany({ _id: { $in: Object.values(U) } });
  await app.close();
});

test('CM1 公开活动：join 直接 joined，joinedAt 落库', async () => {
  const cid = await mk(String(U.creator), { title: 'CM1' });

  const r = await joinCampaign(cid, String(U.a));
  assert.equal(r.myState, 'joined');

  const row = await CampaignMemberModel.findOne({ campaignId: cid, userId: U.a, state: 'joined' });
  assert.ok(row, '公开活动 join 应直接产生 joined 行');
  assert.ok(row.joinedAt, 'joinedAt 必须落库（它是统计时间窗的下界）');
});

test('CM2 隐私活动：join 置 pending；pending 也占位（满员再来一人 409）', async () => {
  // memberLimit=2：发起人占 1 席，b 的 pending 占第 2 席 → c 再 join 时 occupied(2) >= limit → 409。
  // 若 pending 不占位，则 occupied 只有 1，c 会被放进来（用例变红）——这正是要钉住的语义。
  // （brief 标题写「memberLimit=1」，但那样第一个人就被挡在门外、pending 根本不会产生；以注释语义取 2。）
  const cid = await mk(String(U.creator), { title: 'CM2', visibility: 'private', memberLimit: 2 });

  const r = await joinCampaign(cid, String(U.b));
  assert.equal(r.myState, 'pending');
  const row = await CampaignMemberModel.findOne({ campaignId: cid, userId: U.b, state: 'pending' });
  assert.ok(row, '隐私活动 join 应产生 pending 行');

  await assert.rejects(
    () => joinCampaign(cid, String(U.c)),
    (e: any) => {
      assert.equal(e.statusCode, 409);
      assert.match(e.message, /人数已满/);
      return true;
    },
  );
  assert.equal(await CampaignMemberModel.countDocuments({ campaignId: cid, userId: U.c }), 0, '被拒者不应留下任何行');
});

test('CM3 被踢后进黑名单：join 被 403 拒（即使公开）', async () => {
  const cid = await mk(String(U.creator), { title: 'CM3' });
  await joinCampaign(cid, String(U.a));
  await kickMember(cid, String(U.creator), String(U.a));

  await assert.rejects(
    () => joinCampaign(cid, String(U.a)),
    (e: any) => e.statusCode === 403,
  );
});

test('CM4 leave 后新插入一行 joined，旧行 leftAt 封口；两次段都在', async () => {
  const cid = await mk(String(U.creator), { title: 'CM4' });
  await joinCampaign(cid, String(U.b));

  const r = await leaveCampaign(cid, String(U.b));
  assert.equal(r.myState, 'left');

  const old = await CampaignMemberModel.findOne({ campaignId: cid, userId: U.b, state: 'left' });
  assert.ok(old, '离开后原 joined 行应变为 left');
  assert.ok(old.leftAt, 'leftAt 应封口（否则统计时间窗会一直张开）');

  await joinCampaign(cid, String(U.b));
  assert.equal(
    await CampaignMemberModel.countDocuments({ campaignId: cid, userId: U.b, state: 'joined' }),
    1,
    '再入只应有一条 joined（partial unique index 的口径）',
  );
  assert.equal(
    await CampaignMemberModel.countDocuments({ campaignId: cid, userId: U.b }),
    2,
    '一行 = 一个加入段：旧 left 行 + 新 joined 行，共 2 行',
  );
});

test('CM5 approve：仅发起人可调；pending → joined 且 joinedAt 刷新', async () => {
  const cid = await mk(String(U.creator), { title: 'CM5', visibility: 'private' });
  await joinCampaign(cid, String(U.c));

  await assert.rejects(
    () => approveMember(cid, String(U.outsider), String(U.c)),
    (e: any) => e.statusCode === 403,
  );

  await approveMember(cid, String(U.creator), String(U.c));
  const row = await CampaignMemberModel.findOne({ campaignId: cid, userId: U.c });
  assert.equal(row?.state, 'joined');
  assert.ok(row?.joinedAt, 'approve 后 joinedAt 必须刷新（统计窗口下界）');
});

test('CM6 reject 后可再申请：状态回 pending', async () => {
  const cid = await mk(String(U.creator), { title: 'CM6', visibility: 'private' });
  await joinCampaign(cid, String(U.d));

  await rejectMember(cid, String(U.creator), String(U.d));
  assert.equal(
    (await CampaignMemberModel.findOne({ campaignId: cid, userId: U.d }))?.state,
    'rejected',
  );

  const again = await joinCampaign(cid, String(U.d));
  assert.equal(again.myState, 'pending', '被拒后可再申请，回到 pending');
  assert.equal(
    await CampaignMemberModel.countDocuments({ campaignId: cid, userId: U.d }),
    1,
    '复用那条 rejected 行改回 pending，不应新增行',
  );
});

test('CM7 kick：仅发起人；目标 joined → removed 且 leftAt 封口；不能踢自己', async () => {
  const cid = await mk(String(U.creator), { title: 'CM7' });
  await joinCampaign(cid, String(U.e));

  await assert.rejects(
    () => kickMember(cid, String(U.outsider), String(U.e)),
    (e: any) => e.statusCode === 403,
  );
  await assert.rejects(
    () => kickMember(cid, String(U.creator), String(U.creator)),
    (e: any) => e.statusCode === 403,
  );

  await kickMember(cid, String(U.creator), String(U.e));
  const row = await CampaignMemberModel.findOne({ campaignId: cid, userId: U.e });
  assert.equal(row?.state, 'removed');
  assert.ok(row?.leftAt, '被踢也应封口 leftAt');
});

test('CM8 发起人不能 leave（403）；解散后 join 被 403', async () => {
  const cid = await mk(String(U.creator), { title: 'CM8' });

  await assert.rejects(
    () => leaveCampaign(cid, String(U.creator)),
    (e: any) => e.statusCode === 403,
  );

  await dissolveCampaign(cid, String(U.creator));
  assert.equal((await CampaignModel.findById(cid).lean())?.status, 'dissolved');

  await assert.rejects(
    () => joinCampaign(cid, String(U.f)),
    (e: any) => e.statusCode === 403,
  );
});

test('CM9 listPending：仅发起人可见；返回 pending 申请人（含昵称 / 申请时间）', async () => {
  const cid = await mk(String(U.creator), { title: 'CM9', visibility: 'private' });
  await joinCampaign(cid, String(U.a));
  // 另一人被拒 → 不应出现在待审批列表里
  await joinCampaign(cid, String(U.b));
  await rejectMember(cid, String(U.creator), String(U.b));

  await assert.rejects(
    () => listPending(cid, String(U.outsider)),
    (e: any) => e.statusCode === 403,
  );

  const rows = await listPending(cid, String(U.creator));
  assert.equal(rows.length, 1, '只有 pending 的 a 在列表里');
  assert.equal(rows[0].userId, String(U.a));
  assert.equal(rows[0].name, '用户a', '昵称从 User 表解析；缺失时才回退占位文案');
  assert.ok(rows[0].appliedAt, 'appliedAt 应取行 createdAt');
});

test('CM10 helpers：loadCampaignOr404 非法/不存在 id → 404；assertCreator 非发起人 → 403', async () => {
  await assert.rejects(() => loadCampaignOr404('not-an-id'), (e: any) => e.statusCode === 404);
  await assert.rejects(
    () => loadCampaignOr404(String(new mongoose.Types.ObjectId())),
    (e: any) => e.statusCode === 404,
  );

  const cid = await mk(String(U.creator), { title: 'CM10' });
  const doc = await loadCampaignOr404(cid);
  assert.equal(String(doc._id), cid);
  assert.doesNotThrow(() => assertCreator(doc, String(U.creator)));
  assert.throws(() => assertCreator(doc, String(U.outsider)), (e: any) => e.statusCode === 403);
});

test('CM11 E11000 兜底：{campaignId,userId} 唯一冲突翻成 409「你已在该活动中」', async () => {
  // 应用层「先查再插」有并发窗口：同一用户同时 join 两次，输的那次由 partial unique index 兜底，
  // error-handler 必须按索引字段组合认出它并翻成 409，而不是 500 + 内部信息。
  // 直接给 error-handler 喂一个同形的 E11000，避免依赖不可控的并发调度。
  const inst = Fastify({ logger: false });
  await inst.register(errorHandlerPlugin);
  inst.post('/boom', async () => {
    const err = new Error(
      'E11000 duplicate key error collection: sport-track.campaignmembers index: unique_joined_per_campaign_user',
    ) as Error & { code?: number; keyPattern?: Record<string, unknown> };
    err.code = 11000;
    err.keyPattern = { campaignId: 1, userId: 1 };
    throw err;
  });
  await inst.ready();

  const res = await inst.inject({ method: 'POST', url: '/boom' });
  await inst.close();

  assert.equal(res.statusCode, 409, res.body);
  const body = res.json();
  assert.equal(body.code, 409);
  assert.equal(body.message, '你已在该活动中');
  for (const leak of ['E11000', 'duplicate key', 'unique_joined_per_campaign_user', 'ObjectId']) {
    assert.ok(!res.body.includes(leak), `响应里出现了内部信息 ${leak}：${res.body.slice(0, 200)}`);
  }
});

test('CM12 已解散 / 已到期的活动：approve 403（且不产生 joined 行）', async () => {
  // 可达路径：活动解散后发起人详情页仍能拉 /pending、徽标可点 → approveMember 没有状态闸门时
  // 会把 pending 行刷成 joined（joinedAt=now），该成员在死活动里开始累积成绩。
  const dissolved = await mk(String(U.creator), { title: 'CM12-dissolved', visibility: 'private' });
  await joinCampaign(dissolved, String(U.a)); // 造一条 pending 申请（此时活动还活着）
  await dissolveCampaign(dissolved, String(U.creator));

  await assert.rejects(
    () => approveMember(dissolved, String(U.creator), String(U.a)),
    (e: any) => {
      assert.equal(e.statusCode, 403, `解散后 approve 应 403，实际：${e.statusCode} ${e.message}`);
      assert.match(e.message, /已解散/, '文案要说明是「已解散」');
      assert.match(e.message, /dissolved/, '文案要含活动状态实值');
      return true;
    },
  );
  assert.equal(
    await CampaignMemberModel.countDocuments({ campaignId: dissolved, userId: U.a, state: 'joined' }),
    0,
    '已解散的活动不得因 approve 产生 joined 行',
  );

  // 到期：effectiveStatus 按 now 派生 ended（不写库）。join 自己也有闸门走不通，
  // 直接落一条 pending 行模拟「到期前申请、拖到到期后才审批」。
  const ended = await mk(String(U.creator), {
    title: 'CM12-ended',
    visibility: 'private',
    startDate: '2000-01-01',
    endDate: '2000-01-07',
  });
  await CampaignMemberModel.create({ campaignId: ended, userId: U.b, role: 'member', state: 'pending' });

  await assert.rejects(
    () => approveMember(ended, String(U.creator), String(U.b)),
    (e: any) => {
      assert.equal(e.statusCode, 403, `到期后 approve 应 403，实际：${e.statusCode} ${e.message}`);
      assert.match(e.message, /已结束/, '文案要说明是「已结束」');
      assert.match(e.message, /ended/, '文案要含活动状态实值');
      return true;
    },
  );
  assert.equal(
    await CampaignMemberModel.countDocuments({ campaignId: ended, userId: U.b, state: 'joined' }),
    0,
    '已到期的活动不得因 approve 产生 joined 行',
  );
});
