/**
 * 一起运动活动（campaign）：「未开始」（upcoming）档位。
 *
 * 口径（10-16 与产品确认）：
 *   1. `effectiveStatus` 三档派生：dissolved > upcoming（now < startAt）> active > ended。
 *      startAt / endAt 都从不参与写库，只按 now 派生。
 *   2. 未开始时**可以加入、可以审批**——报名早于开赛是常态。
 *   3. 轨迹计入窗口下限是 `max(startAt, joinedAt)`：开赛前走的里程不计入活动。
 *   4. 未开始时**可以编辑**（正是最该改时间的阶段）；只有 ended / dissolved 定稿。
 *   5. 列表排序三段式：未开始 → 进行中 → 已结束。
 *
 * 本文件钉 1（纯函数）与 3/4/5（需落库）；2 由 campaign-membership.test.ts 补。
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
import {
  effectiveStatus,
  createCampaign,
  joinCampaign,
  getCampaignDetail,
  listCampaigns,
  updateCampaign,
} from '../src/services/campaign.js';
import type { CampaignDoc } from '../src/services/campaign-stats.js';
import type { CreateCampaignInput } from '../src/utils/validators.js';
import { bjDayStart, bjDateStr } from '../src/utils/bj-time.js';

const DAY_MS = 86400000;

let app: FastifyInstance;

const creator = new mongoose.Types.ObjectId();
const joiner = new mongoose.Types.ObjectId();
const createdIds: mongoose.Types.ObjectId[] = [];
const usedUserIds: mongoose.Types.ObjectId[] = [];

/** 相对「今天」的 YYYY-MM-DD（正数=未来） */
function bjDateAfter(days: number): string {
  return bjDateStr(bjDayStart(Date.now()) + days * DAY_MS + 12 * 3600 * 1000);
}

async function create(who: string, title: string, startDate: string, endDate: string) {
  const dto = await createCampaign(who, {
    title,
    description: '',
    visibility: 'public',
    allowedTypes: [],
    memberLimit: null,
    startDate,
    endDate,
  } satisfies CreateCampaignInput);
  createdIds.push(new mongoose.Types.ObjectId(dto.id));
  return dto;
}

before(async () => {
  app = await buildApp();
  await app.ready();
  for (const u of [creator, joiner]) {
    await UserModel.findOneAndUpdate(
      { _id: u },
      { openid: `up-${u}`, nickname: `U${u.toString().slice(-4)}`, avatarPreset: 'a', weightKg: 60 },
      { upsert: true },
    );
    usedUserIds.push(u);
  }
});

after(async () => {
  await CampaignModel.deleteMany({ _id: { $in: createdIds } });
  await CampaignMemberModel.deleteMany({ campaignId: { $in: createdIds } });
  await ActivityModel.deleteMany({ userId: { $in: usedUserIds } });
  await UserModel.deleteMany({ _id: { $in: usedUserIds } });
  await app.close();
});

/** 造一个 CampaignDoc 形状的对象给纯函数用 */
function doc(partial: Partial<CampaignDoc>): CampaignDoc {
  return {
    _id: new mongoose.Types.ObjectId(),
    status: 'active',
    startAt: 0,
    endAt: 0,
    ...partial,
  } as unknown as CampaignDoc;
}

// ── 1. effectiveStatus 派生 ─────────────────────────────────────────────────

test('UPG1 now < startAt → upcoming（此前会被判成 active）', () => {
  const now = Date.now();
  const c = doc({ startAt: now + DAY_MS, endAt: now + 8 * DAY_MS });
  assert.equal(effectiveStatus(c, now), 'upcoming');
});

test('UPG2 now 正好等于 startAt → active（开始时刻即开赛）', () => {
  const now = Date.now();
  const c = doc({ startAt: now, endAt: now + DAY_MS });
  assert.equal(effectiveStatus(c, now), 'active');
});

test('UPG3 startAt <= now < endAt → active', () => {
  const now = Date.now();
  const c = doc({ startAt: now - DAY_MS, endAt: now + DAY_MS });
  assert.equal(effectiveStatus(c, now), 'active');
});

test('UPG4 now >= endAt → ended，即使 startAt 也在未来（结束优先）', () => {
  const now = Date.now();
  const c = doc({ startAt: now + DAY_MS, endAt: now });
  assert.equal(effectiveStatus(c, now), 'ended');
});

test('UPG5 dissolved 优先于 upcoming：未开始但已解散 → dissolved', () => {
  const now = Date.now();
  const c = doc({ status: 'dissolved', startAt: now + DAY_MS, endAt: now + 8 * DAY_MS });
  assert.equal(effectiveStatus(c, now), 'dissolved');
});

// ── 4. 编辑闸门：upcoming 可编辑 ─────────────────────────────────────────────

test('UPG6 未开始的活动发起人可以编辑（闸门只挡 ended / dissolved）', async () => {
  const dto = await create(String(creator), '未开始可编辑', bjDateAfter(3), bjDateAfter(10));
  assert.equal((await getCampaignDetail(dto.id, String(creator))).status, 'upcoming');

  const updated = await updateCampaign(dto.id, String(creator), { title: '改过标题' });
  assert.equal(updated.title, '改过标题');
});

// ── 3. 计入窗口下限 = max(startAt, joinedAt) ────────────────────────────────

test('UPG7 提前报名、开赛前走一段 → 不计入（窗口下限是 startAt，不是 joinedAt）', async () => {
  const startAt = bjDayStart(Date.parse(`${bjDateAfter(2)}T00:00:00+08:00`));
  const dto = await create(String(creator), '赛前不计入', bjDateAfter(2), bjDateAfter(9));
  // 模拟「提前报名」：joinedAt 落在两天前，于是 joinedAt < 轨迹 startTime < startAt。
  // 老规则（下限=joinedAt）会把这段算进去，只有新规则（下限=max(startAt,joinedAt)）才挡住。
  await CampaignMemberModel.create({
    campaignId: new mongoose.Types.ObjectId(dto.id),
    userId: joiner,
    role: 'member',
    state: 'joined',
    joinedAt: Date.now() - 2 * DAY_MS,
    leftAt: null,
  });

  await ActivityModel.create({
    userId: joiner,
    type: 'walking',
    status: 'finished',
    distance: 5000,
    duration: 3000,
    startTime: Date.now(),
    endTime: Date.now() + 60_000,
    points: [],
    provinces: ['福建省'],
  });

  const detail = await getCampaignDetail(dto.id, String(joiner));
  assert.ok(startAt > Date.now(), '前置条件：该活动确实还没开始');
  assert.equal(detail.myPanel?.count, 0, '开赛前的里程不计入活动');
  assert.equal(detail.myPanel?.distance, 0);
});

test('UPG8 开赛后的轨迹计入（窗口下限取 max 而非无条件 startAt）', async () => {
  const dto = await create(String(creator), '赛后计入', bjDateAfter(-1), bjDateAfter(9));
  await joinCampaign(dto.id, String(joiner));

  await ActivityModel.create({
    userId: joiner,
    type: 'walking',
    status: 'finished',
    distance: 5000,
    duration: 3000,
    startTime: Date.now(),
    endTime: Date.now() + 60_000,
    points: [],
    provinces: ['福建省'],
  });

  const detail = await getCampaignDetail(dto.id, String(joiner));
  assert.equal(detail.myPanel?.count, 1, '已开赛，加入后的里程要计入');
});

test('UPG9 加入晚于开赛 → 窗口下限仍是 joinedAt（不被 startAt 往前放）', async () => {
  const dto = await create(String(creator), '加入晚于开赛', bjDateAfter(-5), bjDateAfter(9));
  await joinCampaign(dto.id, String(joiner));
  const joinedAt = (
    await CampaignMemberModel.findOne({ campaignId: dto.id, userId: joiner }).lean()
  )!.joinedAt as number;

  await ActivityModel.create({
    userId: joiner,
    type: 'walking',
    status: 'finished',
    distance: 5000,
    duration: 3000,
    startTime: joinedAt - 2 * DAY_MS,
    endTime: joinedAt - DAY_MS,
    points: [],
    provinces: ['福建省'],
  });

  const detail = await getCampaignDetail(dto.id, String(joiner));
  assert.equal(detail.myPanel?.count, 0, '加入之前的里程不计入');
});

// ── 5. 列表三段式排序 ───────────────────────────────────────────────────────

test('UPG10 列表排序：未开始 → 进行中 → 已结束', async () => {
  const ended = await create(String(creator), '已结束', bjDateAfter(-20), bjDateAfter(-10));
  const active = await create(String(creator), '进行中', bjDateAfter(-1), bjDateAfter(5));
  const upcoming = await create(String(creator), '未开始', bjDateAfter(2), bjDateAfter(12));

  const res = await listCampaigns(String(creator), { role: 'created', page: 1, pageSize: 50 });
  const order = res.items
    .filter((i) => [ended.id, active.id, upcoming.id].includes(i.id))
    .map((i) => i.status);
  assert.deepEqual(order, ['upcoming', 'active', 'ended']);
});

test('UPG11 未开始档内按 startAt 升序（快开赛的在前），而非沿用 endAt 升序', async () => {
  // 故意让两个排序键冲突：late 结束得更早、但开赛更晚。
  // 沿用「进行中档 endAt 升序」会把 late 排前面；未开始档必须按 startAt 排。
  const late = await create(String(creator), '晚开赛早结束', bjDateAfter(8), bjDateAfter(15));
  const soon = await create(String(creator), '快开赛晚结束', bjDateAfter(1), bjDateAfter(20));

  const res = await listCampaigns(String(creator), { role: 'created', page: 1, pageSize: 50 });
  const ids = res.items.map((i) => i.id);
  assert.ok(
    ids.indexOf(soon.id) < ids.indexOf(late.id),
    'startAt 更早的未开始活动应排在前面（endAt 更早的那个不该插队）',
  );
});

test('UPG12 详情 DTO 下发 startDate 与状态一致：未开始活动 status=upcoming', async () => {
  const dto = await create(String(creator), '状态下发', bjDateAfter(3), bjDateAfter(10));
  const detail = await getCampaignDetail(dto.id, String(creator));
  assert.equal(detail.status, 'upcoming');
  assert.equal(detail.startDate, bjDateAfter(3));
});
