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

/** 建活动：发起人自动成为 joined 成员；日期按东八区日边界落库（endDate 含当日 → 左闭右开） */
export async function createCampaign(
  creatorId: string,
  input: CreateCampaignInput,
): Promise<CampaignDetailDto> {
  const ocid = new mongoose.Types.ObjectId(creatorId);
  const startAt = bjDayStart(Date.parse(`${input.startDate}T00:00:00+08:00`));
  const endAt = bjDayStart(Date.parse(`${input.endDate}T00:00:00+08:00`)) + DAY_MS;

  // 标题/描述是会被他人看到的自由文本，先过内容安全（未配置时内部降级放行）。
  // msgSecCheck 需要真实 openid，照 user.routes.ts:41-44 的既有做法先取出来传进去；
  // 不传会退化成 openid:'unknown' → 微信返回 errcode → 服务内按 skipped 放行，等于没检测。
  const creator = await UserModel.findById(ocid).select('openid').lean();
  for (const text of [input.title, input.description].filter(Boolean)) {
    await checkText(text, creator?.openid);
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
