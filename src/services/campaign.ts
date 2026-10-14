/**
 * 一起运动活动（campaign）：创建 / 列表 / 详情。
 *
 * 本文件是活动模块的 service 层入口；成员操作（Task 4）与排行榜（Task 5）后续追加到同一文件。
 *
 * 两个贯穿全文件的口径：
 *   1. **状态派生不写库**：到期只看 `endAt` 与 `now`（`effectiveStatus`），避免并发写状态。
 *   2. **响应按身份裁剪**：非成员只拿到「标题/时间/可见性/可否加入/myState」，
 *      成员列表、全队汇总、我的面板仅成员可见（`getCampaignDetail`）。
 */
import mongoose from 'mongoose';
import { CampaignModel } from '../models/campaign.model.js';
import { CampaignMemberModel } from '../models/campaign-member.model.js';
import { UserModel } from '../models/user.model.js';
import { ActivityModel } from '../models/activity.model.js';
import {
  loadSegments,
  statsForMembers,
  streakForUser,
  type CampaignDoc,
  type MemberStats,
} from './campaign-stats.js';
import { assertObjectIdLike } from '../utils/object-id.js';
import { bjDayStart } from '../utils/bj-time.js';
import { checkText } from './wechat-sec.js';
import { AppError } from '../utils/app-error.js';
import type { CreateCampaignInput, ListCampaignQueryInput } from '../utils/validators.js';

const DAY_MS = 86400000;

/** 每次返回新对象：汇总结果会直接进响应，避免多个响应共享同一个可变实例 */
const emptyStats = (): MemberStats => ({ count: 0, distance: 0, duration: 0 });

/** 我对某活动的身份（决定详情响应下发什么） */
export type MyState = 'none' | 'pending' | 'joined' | 'left' | 'rejected' | 'removed';

/**
 * 详情响应必须**显式声明**（见下）：函数有两个分支（非成员 / 成员），若交给 TS 推断，
 * 返回类型是 union，而 `myState` 不是字面量判别符 → 消费方 `detail.myPanel` 无法收窄 → 类型报错。
 * 故成员专属字段一律声明为可选。
 */
export interface MemberRow {
  userId: string;
  role: string;
  name: string;
  avatarUrl: string;
  avatarPreset: string;
  joinedAt: number | null;
  count: number;
  distance: number;
  duration: number;
}
export interface CampaignDetailDto {
  id: string;
  title: string;
  description: string;
  visibility: 'public' | 'private';
  allowedTypes: string[];
  memberLimit: number | null;
  startAt: number;
  endAt: number;
  status: 'active' | 'ended' | 'dissolved';
  creatorId: string;
  myState: MyState;
  canJoin: boolean;
  /** 以下仅「成员」分支下发 */
  totals?: MemberStats;
  members?: MemberRow[];
  myPanel?: MemberStats & { streak: number };
}

/** 派生状态：到期即 ended（不写库，避免并发写） */
export function effectiveStatus(c: CampaignDoc, now = Date.now()): 'active' | 'ended' | 'dissolved' {
  if (c.status === 'dissolved') return 'dissolved';
  if (c.status === 'ended') return 'ended';
  return now >= c.endAt ? 'ended' : 'active';
}

/** 成员行 → 我的状态（joined > pending > removed > left > rejected，越活跃越靠前） */
function myStateOf(rows: { state: string }[]): MyState {
  if (rows.length === 0) return 'none';
  for (const s of ['joined', 'pending', 'removed', 'left', 'rejected']) {
    if (rows.some((r) => r.state === s)) return s as MyState;
  }
  return 'none';
}

/** 有任一文本被判违规就拒（skipped＝微信侧不可用，仍放行，那是容错） */
export function assertTextAllowed(secs: { risky: boolean }[]): void {
  if (secs.some((s) => s.risky)) throw new AppError(400, '内容包含违规信息，请修改后重试');
}

/** 建活动：发起人自动成为 joined 成员；日期按东八区日边界落库（endDate 含当日 → 左闭右开） */
export async function createCampaign(
  creatorId: string,
  input: CreateCampaignInput,
  /** 仅供测试注入替身；生产调用点只传两个参数，走真实 checkText */
  check: (text: string, openid?: string) => Promise<{ risky: boolean }> = checkText,
): Promise<CampaignDetailDto> {
  const ocid = new mongoose.Types.ObjectId(creatorId);
  const startAt = bjDayStart(Date.parse(`${input.startDate}T00:00:00+08:00`));
  const endAt = bjDayStart(Date.parse(`${input.endDate}T00:00:00+08:00`)) + DAY_MS;

  // 标题/描述是会被他人看到的自由文本，先过内容安全（未配置时内部降级放行）。
  // msgSecCheck 需要真实 openid，照 user.routes.ts:41-44 的既有做法先取出来传进去；
  // 不传会退化成 openid:'unknown' → 微信返回 errcode → 服务内按 skipped 放行，等于没检测。
  // 返回值必须检查：判到 risky（含任一文本）即 400 拒写，防 UGC 红线（docs/13 §10）。
  const creator = await UserModel.findById(ocid).select('openid').lean();
  for (const t of [input.title, input.description].filter(Boolean) as string[]) {
    const sec = await check(t, creator?.openid);
    assertTextAllowed([sec]);
  }

  const [campaign] = await CampaignModel.create([
    {
      creatorId: ocid,
      title: input.title,
      description: input.description,
      visibility: input.visibility,
      allowedTypes: input.allowedTypes,
      memberLimit: input.memberLimit,
      startAt,
      endAt,
      status: 'active',
    },
  ]);
  await CampaignMemberModel.create({
    campaignId: campaign._id,
    userId: ocid,
    role: 'creator',
    state: 'joined',
    joinedAt: Date.now(),
  });
  return getCampaignDetail(String(campaign._id), creatorId);
}

/**
 * 我发起 / 我参与的活动列表（分页）。
 * created 以 `Campaign.creatorId` 为准，joined 取成员行里 role='member' 且加入过的活动。
 */
export async function listCampaigns(
  userId: string,
  query: ListCampaignQueryInput,
): Promise<{ items: CampaignCardDto[]; total: number; page: number; pageSize: number }> {
  const oid = new mongoose.Types.ObjectId(userId);
  const skip = (query.page - 1) * query.pageSize;

  let filter: Record<string, unknown>;
  if (query.role === 'created') {
    filter = { creatorId: oid };
  } else {
    const rows = await CampaignMemberModel.find({ userId: oid, role: 'member', joinedAt: { $ne: null } })
      .select('campaignId')
      .lean();
    filter = { _id: { $in: rows.map((r) => r.campaignId) } };
  }

  const [total, docs] = await Promise.all([
    CampaignModel.countDocuments(filter),
    CampaignModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.pageSize).lean(),
  ]);
  const items: CampaignCardDto[] = [];
  // 每个活动一次 loadSegments：v1 接受的 N+1（页大小上限 100），不做缓存
  for (const c of docs as CampaignDoc[]) items.push(await toCard(c, userId));
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/** 列表卡片：标题 / 时间 / 状态 / 我在该活动的汇总 */
async function toCard(c: CampaignDoc, userId: string) {
  const segs = await loadSegments(String(c._id));
  const stats = await statsForMembers(c, segs, segs.has(userId) ? [userId] : []);
  return {
    id: String(c._id),
    title: c.title,
    visibility: c.visibility,
    startAt: c.startAt,
    endAt: c.endAt,
    status: effectiveStatus(c),
    myStats: stats.get(userId) ?? emptyStats(),
  };
}

export type CampaignCardDto = Awaited<ReturnType<typeof toCard>>;

export async function getCampaignDetail(id: string, viewerId: string): Promise<CampaignDetailDto> {
  assertObjectIdLike(id, '活动不存在');
  const c = (await CampaignModel.findById(id).lean()) as CampaignDoc | null;
  if (!c) throw new AppError(404, '活动不存在');

  const rows = await CampaignMemberModel.find({ campaignId: c._id, userId: viewerId })
    .sort({ createdAt: -1 })
    .lean();
  const myState = myStateOf(rows);
  const status = effectiveStatus(c);

  const base = {
    id: String(c._id),
    title: c.title,
    description: c.description,
    visibility: c.visibility,
    allowedTypes: c.allowedTypes,
    memberLimit: c.memberLimit ?? null,
    startAt: c.startAt,
    endAt: c.endAt,
    status,
    creatorId: String(c.creatorId),
    myState,
  };

  const segs = await loadSegments(String(c._id));
  const counts = await memberCounts(c._id); // joined + pending 都占位（决策 §2-6）
  const canJoin =
    status === 'active' &&
    myState !== 'joined' &&
    myState !== 'pending' &&
    myState !== 'removed' &&
    (c.memberLimit == null || counts.occupied < c.memberLimit);

  // 非成员：只回标题/时间/可见性/可否加入/myState
  if (myState !== 'joined') return { ...base, canJoin };

  // 成员：成员列表 + 全队汇总 + 我的面板（+ 明细/审批另开接口）
  const members = await CampaignMemberModel.find({ campaignId: c._id, state: 'joined' })
    .select('userId role joinedAt')
    .lean();
  const uids = members.map((m) => String(m.userId));
  const users = await UserModel.find({ _id: { $in: uids } })
    .select('nickname avatarUrl avatarPreset gender')
    .lean();
  const uMap = new Map(users.map((u) => [String(u._id), u]));
  const stats = await statsForMembers(c, segs, uids);

  const memberList: MemberRow[] = members.map((m) => {
    const u = uMap.get(String(m.userId));
    return {
      userId: String(m.userId),
      role: m.role,
      name: u?.nickname || '微信用户',
      avatarUrl: u?.avatarUrl || '',
      avatarPreset: u?.avatarPreset || '',
      joinedAt: m.joinedAt ?? null,
      ...(stats.get(String(m.userId)) ?? emptyStats()),
    };
  });
  const totals = memberList.reduce<MemberStats>(
    (a, m) => ({
      count: a.count + m.count,
      distance: a.distance + m.distance,
      duration: a.duration + m.duration,
    }),
    emptyStats(),
  );
  // 底部悬浮面板（仅本人）：次数 / 连续运动天数 / 距离 / 时长
  const myStats = stats.get(viewerId) ?? emptyStats();
  const streak = await streakForUser(c, segs.get(viewerId) ?? [], viewerId);
  return { ...base, canJoin, totals, members: memberList, myPanel: { ...myStats, streak } };
}

/** joined + pending 占用数（隐私活动的申请也占位，决策 §2-6） */
async function memberCounts(campaignId: mongoose.Types.ObjectId) {
  const rows = await CampaignMemberModel.aggregate<{ _id: string; n: number }>([
    { $match: { campaignId, state: { $in: ['joined', 'pending'] } } },
    { $group: { _id: '$state', n: { $sum: 1 } } },
  ]);
  const get = (s: string) => rows.find((r) => r._id === s)?.n ?? 0;
  return { joined: get('joined'), pending: get('pending'), occupied: get('joined') + get('pending') };
}

// ─────────────────────────────────────────────────────────────────────────────
// 成员状态机（Task 4）
//
// 一行 = 一个加入段：再入是**插新行**，旧行留成 left/removed 并封口 leftAt（统计据此切时段）。
// `{campaignId,userId}` 的 partial unique index（仅约束 state='joined'）保证同一时刻只有一条活跃行。
// 黑名单 = 该 (活动,用户) 存在任一 state='removed' 的行。
// ─────────────────────────────────────────────────────────────────────────────

/** 活动 id → 文档（非法 / 不存在一律 404） */
export async function loadCampaignOr404(id: string): Promise<CampaignDoc> {
  assertObjectIdLike(id, '活动不存在');
  const c = (await CampaignModel.findById(id).lean()) as CampaignDoc | null;
  if (!c) throw new AppError(404, '活动不存在');
  return c;
}

/** 发起人闸门：审批 / 踢人 / 解散都只认发起人（发起人只能解散，不能离开） */
export function assertCreator(c: CampaignDoc, userId: string): void {
  if (String(c.creatorId) !== String(userId)) throw new AppError(403, '只有发起人可以操作');
}

/** 该用户在此活动是否有被踢记录（黑名单） */
async function isRemoved(campaignId: mongoose.Types.ObjectId, userId: string): Promise<boolean> {
  return (
    (await CampaignMemberModel.countDocuments({
      campaignId,
      userId: new mongoose.Types.ObjectId(userId),
      state: 'removed',
    })) > 0
  );
}

/** 加入：公开直接 joined；隐私置 pending（被拒过则复用那条 rejected 行改回 pending） */
export async function joinCampaign(id: string, userId: string): Promise<{ myState: MyState }> {
  const c = await loadCampaignOr404(id);
  if (effectiveStatus(c) !== 'active') throw new AppError(403, '活动已结束或已解散');
  if (await isRemoved(c._id, userId)) throw new AppError(403, '你已被移出该活动，无法再次加入');

  const uid = new mongoose.Types.ObjectId(userId);
  const mine = await CampaignMemberModel.find({ campaignId: c._id, userId: uid }).lean();
  const st = myStateOf(mine);
  if (st === 'joined') throw new AppError(409, '你已在该活动中');
  if (st === 'pending') throw new AppError(409, '你已提交申请，等待发起人同意');

  if (c.memberLimit != null) {
    const { occupied } = await memberCounts(c._id);
    if (occupied >= c.memberLimit) throw new AppError(409, `人数已满（上限 ${c.memberLimit}）`);
  }

  if (c.visibility === 'public') {
    await CampaignMemberModel.create({
      campaignId: c._id,
      userId: uid,
      role: 'member',
      state: 'joined',
      joinedAt: Date.now(),
    });
    return { myState: 'joined' };
  }
  // 隐私：已有 rejected 行则复用为 pending，否则新插
  const lastRejected = mine.find((m) => m.state === 'rejected');
  if (lastRejected) {
    await CampaignMemberModel.updateOne({ _id: lastRejected._id }, { $set: { state: 'pending' } });
  } else {
    await CampaignMemberModel.create({ campaignId: c._id, userId: uid, role: 'member', state: 'pending' });
  }
  return { myState: 'pending' };
}

/** 离开：自愿退出 → left（可再入）；发起人不能离开（只能解散） */
export async function leaveCampaign(id: string, userId: string): Promise<{ myState: MyState }> {
  const c = await loadCampaignOr404(id);
  if (String(c.creatorId) === String(userId)) throw new AppError(403, '发起人不能离开，请改用解散');
  const row = await CampaignMemberModel.findOne({
    campaignId: c._id,
    userId: new mongoose.Types.ObjectId(userId),
    state: 'joined',
  });
  if (!row) throw new AppError(409, '你当前不在该活动中');
  row.state = 'left';
  row.leftAt = Date.now();
  await row.save();
  return { myState: 'left' };
}

/** 待审批列表（仅发起人）：pending 行 + 申请人昵称/头像 */
export async function listPending(id: string, creatorId: string) {
  const c = await loadCampaignOr404(id);
  assertCreator(c, creatorId);
  const rows = await CampaignMemberModel.find({ campaignId: c._id, state: 'pending' })
    .sort({ createdAt: 1 })
    .lean();
  const users = await UserModel.find({ _id: { $in: rows.map((r) => r.userId) } })
    .select('nickname avatarUrl avatarPreset')
    .lean();
  const uMap = new Map(users.map((u) => [String(u._id), u]));
  return rows.map((r) => ({
    userId: String(r.userId),
    appliedAt: r.createdAt,
    name: uMap.get(String(r.userId))?.nickname || '微信用户',
    avatarUrl: uMap.get(String(r.userId))?.avatarUrl || '',
    avatarPreset: uMap.get(String(r.userId))?.avatarPreset || '',
  }));
}

/** 取某人的 pending 行（审批 / 拒绝共用；不在 pending 一律 404） */
async function assertPendingRow(campaignId: mongoose.Types.ObjectId, targetUid: string) {
  const row = await CampaignMemberModel.findOne({
    campaignId,
    userId: new mongoose.Types.ObjectId(targetUid),
    state: 'pending',
  });
  if (!row) throw new AppError(404, '该申请不存在或已处理');
  return row;
}

/** 同意：pending → joined 并刷新 joinedAt（统计窗口下界） */
export async function approveMember(id: string, creatorId: string, targetUid: string): Promise<void> {
  const c = await loadCampaignOr404(id);
  assertCreator(c, creatorId);
  const row = await assertPendingRow(c._id, targetUid);
  row.state = 'joined';
  row.joinedAt = Date.now();
  await row.save();
}

/** 拒绝：pending → rejected（被拒者可再申请，再申请时复用该行改回 pending） */
export async function rejectMember(id: string, creatorId: string, targetUid: string): Promise<void> {
  const c = await loadCampaignOr404(id);
  assertCreator(c, creatorId);
  const row = await assertPendingRow(c._id, targetUid);
  row.state = 'rejected';
  await row.save();
}

/** 踢人：joined → removed（进黑名单，封口 leftAt）；不能踢发起人自己 */
export async function kickMember(id: string, creatorId: string, targetUid: string): Promise<void> {
  const c = await loadCampaignOr404(id);
  assertCreator(c, creatorId);
  if (String(c.creatorId) === String(targetUid)) throw new AppError(403, '不能踢出自己');
  const row = await CampaignMemberModel.findOne({
    campaignId: c._id,
    userId: new mongoose.Types.ObjectId(targetUid),
    state: 'joined',
  });
  if (!row) throw new AppError(404, '该成员当前不在活动中');
  row.state = 'removed';
  row.leftAt = Date.now();
  await row.save();
}

/** 解散：仅发起人；写库 status='dissolved'（幂等，已是 dissolved 直接返回） */
export async function dissolveCampaign(id: string, creatorId: string): Promise<void> {
  const c = await loadCampaignOr404(id);
  assertCreator(c, creatorId);
  if (c.status === 'dissolved') return;
  await CampaignModel.updateOne({ _id: c._id }, { $set: { status: 'dissolved' } });
}

// ─────────────────────────────────────────────────────────────────────────────
// 活动内排行榜 + 成员明细（Task 5）
//
// 权限（Spec §5 总则）：成员数据只对 `joined`（含发起人）可见 —— 排行榜非成员 403；
// 他人明细进一步收紧为**仅发起人**（普通成员只看得到汇总）。
// ─────────────────────────────────────────────────────────────────────────────

/** 排行榜一行：页面用它同时渲染「成员列表＋排行榜」这一栏（名次 / 头像 / 昵称 / 距离 / 次数 / 时长） */
export interface LeaderRow {
  rank: number;
  userId: string;
  name: string;
  avatarUrl: string;
  avatarPreset: string;
  distance: number;
  count: number;
  duration: number;
}

/** 成员明细里的一条轨迹（概况之外的逐条列表；字段刻意精简，够弹窗列表渲染即可） */
export interface CampaignTrackDto {
  id: string;
  type: string;
  distance: number;
  duration: number;
  startTime: number;
  elevationGain: number;
}

/**
 * 活动内排行榜：仅当前 `joined` 成员，按**距离降序**（Spec §8 默认）。
 * 非成员（含待审批 / 游客 / 已离开 / 被踢）一律 403 —— 成员数据不外泄（§5 总则）。
 */
export async function campaignLeaderboard(
  id: string,
  viewerId: string,
): Promise<{ rows: LeaderRow[] }> {
  const c = await loadCampaignOr404(id);
  const mine = await CampaignMemberModel.find({
    campaignId: c._id,
    userId: new mongoose.Types.ObjectId(viewerId),
  }).lean();
  if (myStateOf(mine) !== 'joined') throw new AppError(403, '只有活动成员可以查看排行榜');

  const members = await CampaignMemberModel.find({ campaignId: c._id, state: 'joined' })
    .select('userId')
    .lean();
  const uids = members.map((m) => String(m.userId));
  const users = await UserModel.find({ _id: { $in: uids } })
    .select('nickname avatarUrl avatarPreset')
    .lean();
  const uMap = new Map(users.map((u) => [String(u._id), u]));
  const stats = await statsForMembers(c, await loadSegments(String(c._id)), uids);

  return {
    rows: uids
      .map((uid) => {
        const s = stats.get(uid)!;
        const u = uMap.get(uid);
        return {
          userId: uid,
          name: u?.nickname || '微信用户',
          avatarUrl: u?.avatarUrl || '',
          avatarPreset: u?.avatarPreset || '',
          distance: s.distance,
          count: s.count,
          duration: s.duration,
        };
      })
      .sort((a, b) => b.distance - a.distance)
      .map((r, i) => ({ rank: i + 1, ...r })),
  };
}

/**
 * 成员明细（仅发起人）：概况 + 分页轨迹列表。
 *
 * 明细的**计入判据与 campaign-stats 同口径**（否则弹窗里的条数/距离会和汇总对不上）：
 * `status='finished'`、`vehicleMs` 用 `{ $not: { $gt: 0 } }`（**不要** `$lte:0`，缺字段的老文档要计入）、
 * `type ∈ allowedTypes`（空则不限）、`startTime` 落在该用户的贡献时段并集内。
 */
export async function memberDetail(
  id: string,
  creatorId: string,
  targetUid: string,
  query: { page: number; pageSize: number },
): Promise<{
  stats: MemberStats;
  items: CampaignTrackDto[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const c = await loadCampaignOr404(id);
  assertCreator(c, creatorId);

  const segs = await loadSegments(String(c._id));
  const targetSegs = segs.get(targetUid) ?? [];
  const stats = (await statsForMembers(c, segs, [targetUid])).get(targetUid) ?? emptyStats();

  // 没有贡献时段（该用户从未加入 / 未产生段）→ 空明细。
  // 必须在此短路：`$or: []` 在 MongoDB 里是非法查询（会抛错），不能让空数组进 match。
  if (targetSegs.length === 0) {
    return { stats, items: [], total: 0, page: query.page, pageSize: query.pageSize };
  }

  const match = {
    userId: new mongoose.Types.ObjectId(targetUid),
    status: 'finished' as const,
    vehicleMs: { $not: { $gt: 0 } },
    ...(c.allowedTypes.length > 0 ? { type: { $in: c.allowedTypes } } : {}),
    $or: targetSegs.map((s) => ({
      startTime: { $gte: s.joinedAt, ...(s.leftAt != null ? { $lt: s.leftAt } : {}) },
    })),
  };
  const [total, docs] = await Promise.all([
    ActivityModel.countDocuments(match),
    ActivityModel.find(match)
      .sort({ startTime: -1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .lean(),
  ]);
  const items: CampaignTrackDto[] = docs.map((d) => ({
    id: String(d._id),
    type: d.type,
    distance: d.distance ?? 0,
    duration: d.duration ?? 0,
    startTime: d.startTime,
    elevationGain: d.elevationGain ?? 0,
  }));
  return { stats, items, total, page: query.page, pageSize: query.pageSize };
}
