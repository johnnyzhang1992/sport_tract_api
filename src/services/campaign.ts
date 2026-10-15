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
  memberActivityMatch,
  type CampaignDoc,
  type MemberStats,
} from './campaign-stats.js';
import { assertObjectIdLike } from '../utils/object-id.js';
import { getAvatarUrl } from './oss.js';
import { bjDateStr, bjDayStart } from '../utils/bj-time.js';
import { checkText } from './wechat-sec.js';
import { AppError } from '../utils/app-error.js';
import type { CreateCampaignInput, ListCampaignQueryInput, UpdateCampaignInput } from '../utils/validators.js';

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
  /**
   * 东八区日期串（YYYY-MM-DD），由 startAt / endAt 反推。
   * 存在的理由：编辑页的 `<picker mode="date">` 要的就是这个格式，而端上刻意不做时区换算
   * （见 campaign-create.js 头注）。endAt 是「结束日 24:00」，所以 endDate 要先减一天再取日期，
   * 少减一天 = 编辑页预填多一天。
   */
  startDate: string;
  endDate: string;
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
 * 发起人编辑活动：只改传进来的字段（`undefined`＝不动，见 UpdateCampaignSchema）。
 *
 * 闸门顺序是刻意的：**先判权限与状态、再判内容安全、最后才碰数据库**。
 * 内容安全（msgSecCheck）必须在任何字段落库之前跑完，否则一条「改标题 + 改人数」的请求
 * 会在标题被判违规后把人数改成功（UP8 钉的就是这个半途生效）。
 *
 * 状态闸门按 `effectiveStatus` 的**派生值**判，不是按落库的 `c.status`：`'ended'` 从不写库，
 * 只挡 `'dissolved'` 会让一个早已跑完的活动继续可改（UP11 / UP13）。
 * 所以进行中的活动可以把 `endAt` 往后推（延期），已结束的不行——过期即定稿。
 */
export async function updateCampaign(
  id: string,
  editorId: string,
  input: UpdateCampaignInput,
  /** 仅供测试注入替身；生产调用点只传三个参数，走真实 checkText */
  check: (text: string, openid?: string) => Promise<{ risky: boolean }> = checkText,
): Promise<CampaignDetailDto> {
  const c = await loadCampaignOr404(id);
  assertCreator(c, editorId);
  const status = effectiveStatus(c);
  if (status !== 'active') {
    throw new AppError(403, status === 'dissolved' ? '活动已解散，无法修改' : '活动已结束，无法修改');
  }

  const texts = [input.title, input.description].filter(Boolean) as string[];
  if (texts.length > 0) {
    // 与 createCampaign 同一条 UGC 红线：改后的标题/描述同样会被他人看到。
    // openid 取发起人的（检测要真实 openid，否则微信侧降级放行＝没检测）。
    const owner = await UserModel.findById(c.creatorId).select('openid').lean();
    for (const t of texts) assertTextAllowed([await check(t, owner?.openid)]);
  }

  const set: Record<string, unknown> = {};
  if (input.title !== undefined) set.title = input.title;
  if (input.description !== undefined) set.description = input.description;
  if (input.visibility !== undefined) set.visibility = input.visibility;
  if (input.allowedTypes !== undefined) set.allowedTypes = input.allowedTypes;
  if (input.endDate !== undefined) {
    const endAt = bjDayStart(Date.parse(`${input.endDate}T00:00:00+08:00`)) + DAY_MS;
    // 开始日期不在本次请求里，所以提示必须把库里那个真实值点名出来
    if (endAt <= c.startAt) {
      throw new AppError(
        400,
        `结束日期不能早于开始日期（收到 ${input.endDate}，开始日期是 ${bjDateStr(c.startAt)}）`,
      );
    }
    set.endAt = endAt;
  }
  if (input.memberLimit !== undefined && input.memberLimit !== null) {
    // 上限低于已占位会让详情页出现「上限 3 人」而成员列表 5 行的自相矛盾，直接拒
    const { occupied } = await memberCounts(c._id);
    if (input.memberLimit < occupied) {
      throw new AppError(400, `人数上限不能小于当前已占用的 ${occupied} 人（收到 ${input.memberLimit}）`);
    }
    set.memberLimit = input.memberLimit;
  } else if (input.memberLimit === null) {
    set.memberLimit = null;
  }

  if (Object.keys(set).length > 0) {
    await CampaignModel.updateOne({ _id: c._id }, { $set: set });
  }
  return getCampaignDetail(String(c._id), editorId);
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
    const rows = await CampaignMemberModel.find({ userId: oid, role: { $in: ['member', 'creator'] }, joinedAt: { $ne: null } })
      .select('campaignId')
      .lean();
    filter = { _id: { $in: rows.map((r) => r.campaignId) } };
  }
  // 已解散的活动不出现在「我的活动」列表（两个 role 都过滤）：解散即从列表消失，
  // 但仍可通过分享链接 / 小程序码进详情只读（详情页的「活动已解散」态）。
  filter.status = { $ne: 'dissolved' };

  const now = Date.now();
  const [total, docs] = await Promise.all([
    CampaignModel.countDocuments(filter),
    // 两段式排序，必须在 skip/limit 之前生效（否则翻页序与整表序不一致）：
    //   ① 进行中（endAt 升序 —— 快结束的在前）
    //   ② 已结束（endAt 降序 —— 刚结束的在前）
    // 已解散的已在上面的 filter 里排除，不再参与排序。
    // 档位与 effectiveStatus 同口径（共用一个 now）；同档同结束时间再按 createdAt 倒序兜底。
    CampaignModel.aggregate<CampaignDoc>([
      { $match: filter },
      {
        $addFields: {
          _tier: { $cond: [{ $or: [{ $eq: ['$status', 'ended'] }, { $lte: ['$endAt', now] }] }, 1, 0] },
        },
      },
      // 进行中取 endAt、已结束取 -endAt，统一成升序即「进行中快结束在前 / 已结束刚结束在前」
      { $addFields: { _endKey: { $cond: [{ $eq: ['$_tier', 0] }, '$endAt', { $multiply: ['$endAt', -1] }] } } },
      { $sort: { _tier: 1, _endKey: 1, createdAt: -1 } },
      { $skip: skip },
      { $limit: query.pageSize },
      { $project: { _tier: 0, _endKey: 0 } },
    ]),
  ]);
  const docsArr = docs as CampaignDoc[];
  const facets = await memberFacets(docsArr.map((c) => c._id));

  // 每张卡一次 loadSegments + 一次 statsForMembers（v1 接受的 N+1，页大小上限 100，不做缓存）；
  // 成员面（人数 + 头像堆叠）由 memberFacets 批量取。头像取**排行榜口径的前 3**（距离降序，平手按加入时间）。
  const cards = await Promise.all(
    docsArr.map(async (c) => {
      const key = String(c._id);
      const members = facets.members.get(key) ?? [];
      const segs = await loadSegments(key);
      const stats = await statsForMembers(
        c,
        segs,
        members.map((m) => m.userId),
      );
      const rankOf = (m: { userId: string; joinedAt: number | null }) => ({
        distance: stats.get(m.userId)?.distance ?? 0,
        joinedAt: m.joinedAt,
      });
      const topUids = [...members]
        .sort((a, b) => byDistanceThenJoin(rankOf(a), rankOf(b)))
        .slice(0, 3)
        .map((m) => m.userId);
      return { c, key, stats, topUids };
    }),
  );

  // 所有卡片的前三 uid 一次批量取头像（私有桶，链接必须签名 —— 与详情/待审批/排行榜同口径）
  const avatarUids = [...new Set(cards.flatMap((x) => x.topUids))];
  const users = await UserModel.find({ _id: { $in: avatarUids } })
    .select('avatarUrl avatarPreset')
    .lean();
  const uMap = new Map(users.map((u) => [String(u._id), u]));

  const items: CampaignCardDto[] = cards.map(({ c, key, stats, topUids }) =>
    cardDto(
      c,
      stats.get(userId) ?? emptyStats(),
      facets.counts.get(key) ?? 0,
      topUids.map((uid) => {
        const u = uMap.get(uid);
        return {
          avatarUrl: u?.avatarUrl ? getAvatarUrl(u.avatarUrl) : '',
          avatarPreset: u?.avatarPreset || '',
        };
      }),
    ),
  );
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * 排行榜口径排序：距离降序；距离相同按加入时间升序（早加入在前）。
 * 平手必须有确定顺序，否则同一活动两次请求名次会漂，卡片头像也会和排行榜「前三」对不上。
 */
function byDistanceThenJoin(
  a: { distance: number; joinedAt: number | null },
  b: { distance: number; joinedAt: number | null },
): number {
  return b.distance - a.distance || (a.joinedAt ?? 0) - (b.joinedAt ?? 0);
}

/** 列表卡片的成员面：joined 计数 + 每个活动的 joined 成员（uid + 加入时间，供排行榜口径排序） */
async function memberFacets(campaignIds: mongoose.Types.ObjectId[]): Promise<{
  counts: Map<string, number>;
  members: Map<string, { userId: string; joinedAt: number | null }[]>;
}> {
  const counts = new Map<string, number>();
  const members = new Map<string, { userId: string; joinedAt: number | null }[]>();
  if (campaignIds.length === 0) return { counts, members };

  const [countRows, memberRows] = await Promise.all([
    CampaignMemberModel.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
      { $match: { campaignId: { $in: campaignIds }, state: 'joined' } },
      { $group: { _id: '$campaignId', n: { $sum: 1 } } },
    ]),
    CampaignMemberModel.find({ campaignId: { $in: campaignIds }, state: 'joined' })
      .select('campaignId userId joinedAt')
      .lean(),
  ]);
  for (const r of countRows) counts.set(String(r._id), r.n);
  for (const m of memberRows) {
    const key = String(m.campaignId);
    const arr = members.get(key) ?? [];
    arr.push({ userId: String(m.userId), joinedAt: m.joinedAt ?? null });
    members.set(key, arr);
  }
  return { counts, members };
}

/** 列表卡片：标题 / 时间 / 状态 / 我在该活动的汇总 / 成员面（人数 + 头像堆叠） */
function cardDto(
  c: CampaignDoc,
  myStats: MemberStats,
  memberCount: number,
  memberAvatars: { avatarUrl: string; avatarPreset: string }[],
) {
  return {
    id: String(c._id),
    title: c.title,
    visibility: c.visibility,
    startAt: c.startAt,
    endAt: c.endAt,
    status: effectiveStatus(c),
    myStats,
    memberCount,
    memberAvatars,
  };
}

export type CampaignCardDto = ReturnType<typeof cardDto>;

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
    startDate: bjDateStr(c.startAt),
    endDate: bjDateStr(c.endAt - 1),
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
      avatarUrl: u?.avatarUrl ? getAvatarUrl(u.avatarUrl) : '',
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
  return rows.map((r) => {
    const u = uMap.get(String(r.userId));
    return {
      userId: String(r.userId),
      appliedAt: r.createdAt,
      name: u?.nickname || '微信用户',
      avatarUrl: u?.avatarUrl ? getAvatarUrl(u.avatarUrl) : '',
      avatarPreset: u?.avatarPreset || '',
    };
  });
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

/**
 * 同意：pending → joined 并刷新 joinedAt（统计窗口下界）。
 *
 * 状态闸门与 joinCampaign 同形：解散 / 到期（effectiveStatus 派生）后不能再批入队。
 * 不拦的话——发起人详情页在活动解散后仍能拉 /pending、徽标可点——approve 会把 pending 行
 * 刷成 joined（joinedAt=now），该成员在已死活动里开始累积成绩。
 * 文案区分「已解散」/「已结束」并带上状态实值，便于端上提示与排障。
 * 注意：reject / kick / leave 是**收缩**成员集合的操作，刻意不加闸门；dissolve 保持幂等。
 */
export async function approveMember(id: string, creatorId: string, targetUid: string): Promise<void> {
  const c = await loadCampaignOr404(id);
  assertCreator(c, creatorId);
  const status = effectiveStatus(c);
  if (status !== 'active') {
    throw new AppError(
      403,
      status === 'dissolved'
        ? '活动已解散（活动状态：dissolved），不能再同意加入'
        : '活动已结束（活动状态：ended），不能再同意加入',
    );
  }
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
 *
 * 分页只切**响应**，不切**计算**：名次要按全员距离排，少算任何一个人的距离就会整体错位，
 * 所以 `statsForMembers` 照旧覆盖全部 joined 成员。分页真正省下来的是三处按人头的开销：
 * 昵称/头像的 User 查询、每行一次的 `getAvatarUrl` 签名、以及响应载荷与端上渲染的节点数。
 * 因此必须先 `slice` 再 `map`——反过来写行为一样，但那两处就白省了。
 */
export async function campaignLeaderboard(
  id: string,
  viewerId: string,
  query: { page: number; pageSize: number },
): Promise<{ rows: LeaderRow[]; total: number; page: number; pageSize: number }> {
  const c = await loadCampaignOr404(id);
  const mine = await CampaignMemberModel.find({
    campaignId: c._id,
    userId: new mongoose.Types.ObjectId(viewerId),
  }).lean();
  if (myStateOf(mine) !== 'joined') throw new AppError(403, '只有活动成员可以查看排行榜');

  const members = await CampaignMemberModel.find({ campaignId: c._id, state: 'joined' })
    .select('userId joinedAt')
    .lean();
  const uids = members.map((m) => String(m.userId));
  const stats = await statsForMembers(c, await loadSegments(String(c._id)), uids);

  // 与列表卡片头像同一条排序（byDistanceThenJoin）：两处「前三」必须一致
  const ranked = [...members].sort((x, y) => {
    const xs = stats.get(String(x.userId))!;
    const ys = stats.get(String(y.userId))!;
    return byDistanceThenJoin(
      { distance: xs.distance, joinedAt: x.joinedAt ?? null },
      { distance: ys.distance, joinedAt: y.joinedAt ?? null },
    );
  });

  const total = ranked.length;
  const from = (query.page - 1) * query.pageSize;
  const pageRows = ranked.slice(from, from + query.pageSize);

  const users = await UserModel.find({ _id: { $in: pageRows.map((m) => m.userId) } })
    .select('nickname avatarUrl avatarPreset')
    .lean();
  const uMap = new Map(users.map((u) => [String(u._id), u]));

  return {
    // rank 用全局下标（from + j），不是页内下标：端上「加载更多」是往同一个列表后面追加的，
    // 写 j + 1 会让第二页顶着一个「第 1 名」接在第 20 行后面。
    rows: pageRows.map((m, j) => {
      const uid = String(m.userId);
      const s = stats.get(uid)!;
      const u = uMap.get(uid);
      return {
        rank: from + j + 1,
        userId: uid,
        name: u?.nickname || '微信用户',
        avatarUrl: u?.avatarUrl ? getAvatarUrl(u.avatarUrl) : '',
        avatarPreset: u?.avatarPreset || '',
        distance: s.distance,
        count: s.count,
        duration: s.duration,
      };
    }),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * 成员明细（仅发起人）：概况 + 分页轨迹列表。
 *
 * 权限与存在性：仅发起人；`uid` 与 `:id` 同待遇——畸形串走 404 闸门（本仓硬性惯例），
 * 且目标在本活动**没有任何加入段**（从未加入 / 只有 pending）也 404，而不是 200 + 全 0。
 * 「是成员但还没有轨迹」不受影响：有加入段即照常 200 + 全 0。
 *
 * 明细的**计入判据与 campaign-stats 同口径**（否则弹窗里的条数/距离会和汇总对不上）：
 * 判据由 `memberActivityMatch` 单点提供（`status='finished'`、`vehicleMs: { $not: { $gt: 0 } }`、
 * `type ∈ allowedTypes`、`startTime` 落在该用户的贡献时段并集内）—— 明细不再自己拼一份，改口径时两边同步。
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
  // uid 与 :id 同待遇：畸形串按「成员不存在」404，不让它静默落进 200 + 全 0
  assertObjectIdLike(targetUid, '成员不存在');
  // 归一成小写 hex（String(ObjectId) 恒小写）：行内 userId 的字符串形与 segs 键都是它，直接拿原串比会对不上大写 hex
  const uid = String(new mongoose.Types.ObjectId(targetUid));

  const segs = await loadSegments(String(c._id));
  // 没有任何加入段（从未加入 / 只有 pending，joinedAt 为空）＝ 不是成员 → 404
  if (!segs.has(uid)) throw new AppError(404, '成员不存在');
  const targetSegs = segs.get(uid)!;
  const stats = (await statsForMembers(c, segs, [uid])).get(uid) ?? emptyStats();

  // 计入判据与汇总**同源**：复用 campaign-stats 的 memberActivityMatch（含 baseMatch + timeOr），
  // 不再手抄 status / vehicleMs / type / 时间窗 —— 未来改口径时此处自动跟随。
  // 上面已 404 掉无加入段的人，match 正常必非 null；这里保留兜底，确保 `$or: []` 永不进 match。
  const match = memberActivityMatch(c, uid, targetSegs);
  if (match === null) {
    return { stats, items: [], total: 0, page: query.page, pageSize: query.pageSize };
  }

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

// ─────────────────────────────────────────────────────────────────────────────
// 管理后台只读接口（Task 7）
//
// 后台要「看得到全站活动」，所以这里**不做成员视角裁剪**：列表下发成员数，详情下发全部成员行。
// 汇总一律复用 `statsForMembers`（与用户端排行榜同一份 service），admin 侧不另写一套判据；
// 状态同样走 `effectiveStatus` 派生（不写库）。两条都只读，不带任何写副作用。
// ─────────────────────────────────────────────────────────────────────────────

/** 后台活动列表一行（列表页够渲染即可，不下发成员明细） */
export interface AdminCampaignRow {
  id: string;
  title: string;
  visibility: 'public' | 'private';
  status: 'active' | 'ended' | 'dissolved';
  allowedTypes: string[];
  memberLimit: number | null;
  startAt: number;
  endAt: number;
  creatorNickname: string;
  creatorUid: number | null;
  joinedCount: number;
  pendingCount: number;
  createdAt: Date;
}

/**
 * `status` 筛选必须与**下发值**同口径：下发走 `effectiveStatus`（派生），而库里的 `status`
 * 只在解散时被写成 'dissolved'，'ended' **从不落库** —— 直接 `filter.status = query.status`
 * 会让 `status=ended` 永远查不到（永空）、`status=active` 把已结束的活动也带出来。
 * 所以这里按有效状态反向构造条件，并把同一个 `now` 传给 `effectiveStatus`，保证一次请求内
 * 筛选与展示不会因「刚好跨过 endAt」而互相矛盾。
 */
function statusFilter(status: string, now: number): Record<string, unknown> {
  switch (status) {
    case 'dissolved':
      return { status: 'dissolved' };
    case 'ended':
      return { $or: [{ status: 'ended' }, { status: 'active', endAt: { $lte: now } }] };
    default:
      return { status: 'active', endAt: { $gt: now } }; // 'active'
  }
}

/**
 * 后台活动列表：分页 + status/visibility 过滤。
 * `status` 过滤按**有效状态**反向构造条件（见 `statusFilter`），与下发的 `effectiveStatus` 同口径，
 * 且筛选与展示共用同一个 `now`，不会因「刚好跨过 endAt」而出现「列表显示 ended、筛 ended 却筛不到」。
 */
export async function adminListCampaigns(query: {
  page: number;
  pageSize: number;
  status?: string;
  visibility?: string;
}): Promise<{ items: AdminCampaignRow[]; total: number; page: number; pageSize: number }> {
  const now = Date.now();
  const filter: Record<string, unknown> = {};
  if (query.status) Object.assign(filter, statusFilter(query.status, now));
  if (query.visibility) filter.visibility = query.visibility;

  const [total, docs] = await Promise.all([
    CampaignModel.countDocuments(filter),
    CampaignModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .lean(),
  ]);
  const items: AdminCampaignRow[] = [];
  for (const c of docs as CampaignDoc[]) {
    const [creator, counts] = await Promise.all([
      UserModel.findById(c.creatorId).select('nickname uid').lean(),
      memberCounts(c._id),
    ]);
    items.push({
      id: String(c._id),
      title: c.title,
      visibility: c.visibility,
      status: effectiveStatus(c, now),
      allowedTypes: c.allowedTypes,
      memberLimit: c.memberLimit ?? null,
      startAt: c.startAt,
      endAt: c.endAt,
      creatorNickname: creator?.nickname || '微信用户',
      creatorUid: creator?.uid ?? null,
      joinedCount: counts.joined,
      pendingCount: counts.pending,
      createdAt: c.createdAt,
    });
  }
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * 后台活动详情：活动自身字段 + 成员列表（含各人汇总，与用户端排行榜同源）。
 *
 * 成员列表取「加入过的行」（`joinedAt` 非空），即**含已离开/被踢的历史成员**（state 一并下发），
 * 后台需要看得到这类痕迹；pending 申请人不在其中（未加入，无贡献时段）。
 */
export async function adminGetCampaign(id: string) {
  const c = await loadCampaignOr404(id);
  const members = await CampaignMemberModel.find({ campaignId: c._id, joinedAt: { $ne: null } })
    .sort({ joinedAt: 1 })
    .lean();
  const uids = members.map((m) => String(m.userId));
  const users = await UserModel.find({ _id: { $in: uids } })
    .select('nickname uid')
    .lean();
  const uMap = new Map(users.map((u) => [String(u._id), u]));
  const segs = await loadSegments(String(c._id));
  const stats = await statsForMembers(c, segs, uids);
  return {
    id: String(c._id),
    title: c.title,
    description: c.description,
    visibility: c.visibility,
    allowedTypes: c.allowedTypes,
    memberLimit: c.memberLimit,
    startAt: c.startAt,
    endAt: c.endAt,
    status: effectiveStatus(c),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    members: members.map((m) => {
      const s = stats.get(String(m.userId))!;
      return {
        userId: String(m.userId),
        role: m.role,
        state: m.state,
        name: uMap.get(String(m.userId))?.nickname || '微信用户',
        uid: uMap.get(String(m.userId))?.uid ?? null,
        joinedAt: m.joinedAt,
        leftAt: m.leftAt,
        count: s.count,
        distance: s.distance,
        duration: s.duration,
      };
    }),
  };
}
