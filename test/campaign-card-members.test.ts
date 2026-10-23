/**
 * 活动列表卡片（CampaignCardDto）的成员面：memberCount + memberAvatars。
 *
 * 首页「一起运动」轮播卡要显示「头像堆叠 + N 人」，而这两个字段原来不在 card DTO 里。
 * 两条口径：
 *   1. **只算 joined**：pending（待审批）/ left（已离开）都不进人数、也不进头像堆叠；
 *   2. **头像是私有桶链接，必须签名**（与详情/待审批/排行榜三处同口径，见 campaign-avatar-urls.test.ts）。
 * 头像取「活动内排行榜（距离降序）前 3 位」，与排行榜页同一套排序；距离相同再按 joinedAt 升序（早加入在前）。
 * fixture 直接建成员行并写死 joinedAt，不用 joinCampaign（后者用 now，会同毫秒并列）。
 *
 * 做法照 admin-image-urls.test.ts：未配置 OSS 时 getSignedUrl 原样返回，断言跟着分叉。
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
import { config, isOssConfigured } from '../src/config/index.js';
import { createCampaign, listCampaigns } from '../src/services/campaign.js';
import type { CreateCampaignInput } from '../src/utils/validators.js';

const OSS = `${config.oss.endpoint.replace(/\/$/, '')}/${config.oss.baseDir}/card-members-test`;
const av = (n: string) => `${OSS}/${n}.png`;

let app: FastifyInstance;

const U = {
  creator: new mongoose.Types.ObjectId(),
  m1: new mongoose.Types.ObjectId(),
  m2: new mongoose.Types.ObjectId(),
  m3: new mongoose.Types.ObjectId(),
  m4: new mongoose.Types.ObjectId(),
  pending: new mongoose.Types.ObjectId(),
  left: new mongoose.Types.ObjectId(),
};
const createdIds: mongoose.Types.ObjectId[] = [];

/** joinedAt 基准：取过去时间，避免与 createCampaign 里 creator 的 now 撞同毫秒 */
const BASE = Date.now() - 100_000;

const DAY_MS = 86400000;

/** 相对「今天」的东八区 YYYY-MM-DD —— 窗口要跟着运行时刻走，写死日期会随哪天跑而红绿飘忽 */
function bjDateAfter(days: number): string {
  const d = new Date(Date.now() + 8 * 3600000 + days * DAY_MS);
  return d.toISOString().slice(0, 10);
}

/**
 * 窗口取「已开赛 3 天、还剩 3 天」：
 *   - 结束时间在未来 → `effectiveStatus` 派生为 active，join 不会被闸门挡；
 *   - 开始时间也在过去 → 计入窗口下限 max(startAt, joinedAt) 落在 joinedAt 上，
 *     用例造的「≈now」轨迹才在窗内（开始时间若设在未来，这些轨迹会全部不计入）。
 */
const base = (over: Partial<CreateCampaignInput> = {}): CreateCampaignInput => ({
  title: 'CM',
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

/** 建一条成员行（joinedAt 写死，保证排序确定） */
async function seat(
  cid: string,
  userId: mongoose.Types.ObjectId,
  state: 'joined' | 'pending' | 'left',
  joinedAt: number | null,
) {
  await CampaignMemberModel.create({
    campaignId: new mongoose.Types.ObjectId(cid),
    userId,
    role: 'member',
    state,
    joinedAt,
    ...(state === 'left' ? { leftAt: joinedAt! + 1000 } : {}),
  });
}

/** 造一条 finished 轨迹（进活动统计的净指标；缺省 vehicleMs=0） */
async function seedActivity(userId: mongoose.Types.ObjectId, distance: number) {
  await ActivityModel.create({
    userId,
    type: 'running',
    status: 'finished',
    startTime: Date.now(),
    distance,
    duration: 600,
    vehicleMs: 0,
  });
}

const expectSigned = (got: string, bare: string) => {
  if (isOssConfigured()) {
    assert.ok(got.startsWith(`${bare}?`), `应是 ${bare} 的签名链，实际 ${got}`);
    assert.match(got, /[?&]Signature=/, '签名链要带 Signature');
  } else {
    assert.equal(got, bare, 'OSS 未配置时原样返回裸链');
  }
};

/** 取「我发起」列表里某个活动的卡片 */
async function cardOf(cid: string) {
  const res = await listCampaigns(String(U.creator), { role: 'created', page: 1, pageSize: 20 });
  const card = res.items.find((i) => i.id === cid);
  assert.ok(card, `列表里应有 ${cid}`);
  return card!;
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await UserModel.insertMany(
    Object.entries(U).map(([label, _id]) => ({
      _id,
      openid: `campaign-card-members-${label}`,
      nickname: `用户${label}`,
      avatarUrl: av(label),
      avatarPreset: `preset-${label}`,
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

test('CM1 memberCount 只算 joined：pending / left 不计入', async () => {
  const cid = await mk(String(U.creator), { title: 'CM1' });
  // creator 的加入行由 createCampaign 建，把它的 joinedAt 也钉到基准上
  await CampaignMemberModel.updateOne(
    { campaignId: new mongoose.Types.ObjectId(cid), userId: U.creator, state: 'joined' },
    { joinedAt: BASE },
  );
  await seat(cid, U.m1, 'joined', BASE + 1000);
  await seat(cid, U.m2, 'joined', BASE + 2000);
  await seat(cid, U.pending, 'pending', null);
  await seat(cid, U.left, 'left', BASE + 3000);

  const card = await cardOf(cid);
  assert.equal(card.memberCount, 3, 'creator + m1 + m2 = 3；pending/left 不算');
});

test('CM2 都没轨迹（距离全 0）时按 joinedAt 升序兜底：creator → m1 → m2，且本桶头像已签名', async () => {
  const cid = await mk(String(U.creator), { title: 'CM2' });
  await CampaignMemberModel.updateOne(
    { campaignId: new mongoose.Types.ObjectId(cid), userId: U.creator, state: 'joined' },
    { joinedAt: BASE },
  );
  await seat(cid, U.m1, 'joined', BASE + 1000);
  await seat(cid, U.m2, 'joined', BASE + 2000);
  await seat(cid, U.m3, 'joined', BASE + 3000);
  await seat(cid, U.m4, 'joined', BASE + 4000);

  const card = await cardOf(cid);
  assert.equal(card.memberCount, 5);
  assert.equal(card.memberAvatars.length, 3, '堆叠最多 3 个');
  // 平手时按加入时间升序：creator → m1 → m2
  expectSigned(card.memberAvatars[0].avatarUrl, av('creator'));
  expectSigned(card.memberAvatars[1].avatarUrl, av('m1'));
  expectSigned(card.memberAvatars[2].avatarUrl, av('m2'));
  // 备用头像档位随行下发（端上 avatarUrl 为空时回退 preset 图）
  assert.equal(card.memberAvatars[0].avatarPreset, 'preset-creator');
  // 昵称也要随行下发：既没头像也没 preset 时，端上要用昵称首字填占位圆（少了它只能画空圈）
  assert.deepEqual(
    card.memberAvatars.map((a: any) => a.nickname),
    ['用户creator', '用户m1', '用户m2'],
    '头像堆叠带昵称（顺序同 avatarUrl）',
  );
});

test('CM4 memberAvatars 按排行榜口径（距离降序）取前 3，不按加入时间', async () => {
  const cid = await mk(String(U.creator), { title: 'CM4' });
  await CampaignMemberModel.updateOne(
    { campaignId: new mongoose.Types.ObjectId(cid), userId: U.creator, state: 'joined' },
    { joinedAt: BASE },
  );
  await seat(cid, U.m1, 'joined', BASE + 1000);
  await seat(cid, U.m2, 'joined', BASE + 2000);
  await seat(cid, U.m3, 'joined', BASE + 3000);
  await seat(cid, U.m4, 'joined', BASE + 4000);

  // 距离：m3 > m1 > 其余 0。若按加入时间取，会是 creator → m1 → m2。
  await seedActivity(U.m3, 5000);
  await seedActivity(U.m1, 3000);

  const card = await cardOf(cid);
  assert.equal(card.memberCount, 5);
  assert.deepEqual(
    card.memberAvatars.map((a) => a.avatarPreset),
    ['preset-m3', 'preset-m1', 'preset-creator'], // 前两名按距离；第 3 名与其余人同为 0，按加入时间取 creator
  );
});

test('CM3 只有发起人时：人数 1、堆叠 1（列表接口对空成员也不炸）', async () => {
  const cid = await mk(String(U.creator), { title: 'CM3' });
  const card = await cardOf(cid);
  assert.equal(card.memberCount, 1);
  assert.equal(card.memberAvatars.length, 1);
});
