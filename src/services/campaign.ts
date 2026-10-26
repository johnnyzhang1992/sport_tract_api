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
  typeSummaryForMembers,
  dailyDistanceForMembers,
  dailyDistanceByType,
  type CampaignDoc,
  type MemberStats,
  excludedCountForMembers,
} from './campaign-stats.js';
import { assertObjectIdLike } from '../utils/object-id.js';
import { getAvatarUrl } from './oss.js';
import { bjDateStr, bjDayStart, bjToday0 } from '../utils/bj-time.js';
import { config } from '../config/index.js';
import { checkText } from './wechat-sec.js';
import { AppError } from '../utils/app-error.js';
import { ACTIVITY_TYPES } from '../config/constants.js';
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
  /** 被 driftScore 门禁排除的轨迹条数（数据保留但不计入活动；0/缺省不展示）。
   *  没有它用户会困惑「我明明跑了 21 公里，活动里怎么只算 12」。 */
  excludedCount?: number;
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
  status: 'upcoming' | 'active' | 'ended' | 'dissolved';
  creatorId: string;
  myState: MyState;
  canJoin: boolean;
  /** 以下仅「成员」分支下发 */
  totals?: MemberStats;
  members?: MemberRow[];
  myPanel?: MemberStats & {
    streak: number;
    /** 我的距离名次（1 起；并列按加入时间） */
    rank: number;
    /** 当前 joined 成员数 */
    members: number;
    /** 距第一名还差多少米 */
    gapToLeader: number;
    /** 距上一名还差多少米（第一名没有上一名，给 0；比距榜首更贴近「再追一点就能升一名」） */
    gapToPrev: number;
    /** 我的距离占全队累计距离的比例（0-1） */
    share: number;
  };
}

/**
 * 派生状态：三档全按 now 算，都不写库（避免并发写）。
 * 优先级 dissolved > ended > upcoming > active —— 结束判据走在前面，
 * 一个 startAt 与 endAt 都已过期的活动是「已结束」而不是「从未开始过」。
 */
export function effectiveStatus(c: CampaignDoc, now = Date.now()): 'upcoming' | 'active' | 'ended' | 'dissolved' {
  if (c.status === 'dissolved') return 'dissolved';
  if (c.status === 'ended') return 'ended';
  if (now >= c.endAt) return 'ended';
  return now < c.startAt ? 'upcoming' : 'active';
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

/** 防刷：每用户滚动 1 小时 / 东八自然日各有一档创建上限，另限同时存在的未开始+进行中活动数。 */
async function assertCanCreate(creatorId: mongoose.Types.ObjectId): Promise<void> {
  const now = Date.now();
  const [live, recentHour, recentDay] = await Promise.all([
    // status='dissolved' 与已过期（endAt <= now）都不占；'ended' 从不落库，按 endAt 判即可
    CampaignModel.countDocuments({
      creatorId,
      status: 'active',
      endAt: { $gt: new Date(now) },
    }),
    CampaignModel.countDocuments({
      creatorId,
      createdAt: { $gte: new Date(now - 3600000) },
    }),
    CampaignModel.countDocuments({
      creatorId,
      createdAt: { $gte: new Date(bjToday0(now)) },
    }),
  ]);
  if (live >= config.campaignActiveLimit) {
    throw new AppError(
      409,
      `当前还有 ${live} 个未开始/进行中的活动，最多同时保留 ${config.campaignActiveLimit} 个，请先结束或解散部分活动`,
    );
  }
  if (recentHour >= config.campaignCreateHourlyLimit) {
    throw new AppError(
      429,
      `最近 1 小时已创建 ${recentHour} 个活动，每小时最多创建 ${config.campaignCreateHourlyLimit} 个，请稍后再试`,
    );
  }
  if (recentDay >= config.campaignCreateDailyLimit) {
    throw new AppError(
      429,
      `今天已创建 ${recentDay} 个活动，每天最多创建 ${config.campaignCreateDailyLimit} 个，请明天再试`,
    );
  }
}

/** 建活动：发起人自动成为 joined 成员；日期按东八区日边界落库（endDate 含当日 → 左闭右开） */
/**
 * 活动最长跨度（含首尾的日历日）。
 * 一年以上的「组队运动」没有意义；这条也给趋势图的桶数封了顶（366 天 → 53 个周桶），
 * X 轴标签的排字才有确定上限。
 */
const MAX_CAMPAIGN_SPAN_DAYS = 365;

/**
 * 跨度闸门，创建与编辑共用。
 * 放在 service 而不是 schema：编辑请求里**没有** startDate（改开始日会让已计入的轨迹洗牌，
 * 故意禁掉），判据只能用库里那个 `c.startAt`，schema 看不见它。
 * endAt 是「结束日 24:00」的左闭右开值，所以两数之差就是含首尾的天数。
 */
function assertCampaignSpan(startAt: number, endAt: number): void {
  const span = Math.round((endAt - startAt) / DAY_MS);
  if (span > MAX_CAMPAIGN_SPAN_DAYS) {
    // 提示要能照着改：对象 + 实际值 + 上限（全站惯例）
    throw new AppError(
      400,
      `活动最长 ${MAX_CAMPAIGN_SPAN_DAYS} 天：${bjDateStr(startAt)} ~ ${bjDateStr(endAt - 1)} 跨 ${span} 天`,
    );
  }
}

export async function createCampaign(
  creatorId: string,
  input: CreateCampaignInput,
  /** 仅供测试注入替身；生产调用点只传两个参数，走真实 checkText */
  check: (text: string, openid?: string) => Promise<{ risky: boolean }> = checkText,
): Promise<CampaignDetailDto> {
  const ocid = new mongoose.Types.ObjectId(creatorId);
  await assertCanCreate(ocid);
  const startAt = bjDayStart(Date.parse(`${input.startDate}T00:00:00+08:00`));
  const endAt = bjDayStart(Date.parse(`${input.endDate}T00:00:00+08:00`)) + DAY_MS;
  assertCampaignSpan(startAt, endAt);

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
 * 未开始（upcoming）与进行中（active）都可改 —— 还没开赛正是最该调时间的阶段；
 * 进行中可以把 `endAt` 往后推（延期），已结束的不行——过期即定稿。
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
  if (status !== 'active' && status !== 'upcoming') {
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
    // 同一条跨度上限：不然「建的时候拦住、编辑绕过去」就形同没有
    assertCampaignSpan(c.startAt, endAt);
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
    // 三段式排序，必须在 skip/limit 之前生效（否则翻页序与整表序不一致）：
    //   ① 未开始（startAt 升序 —— 快开赛的在前）
    //   ② 进行中（endAt 升序 —— 快结束的在前）
    //   ③ 已结束（endAt 降序 —— 刚结束的在前）
    // 已解散的已在上面的 filter 里排除，不再参与排序。
    // 档位与 effectiveStatus 同口径（共用一个 now）；同档同键再按 createdAt 倒序兜底。
    CampaignModel.aggregate<CampaignDoc>([
      { $match: filter },
      {
        $addFields: {
          _ended: { $or: [{ $eq: ['$status', 'ended'] }, { $lte: ['$endAt', now] }] },
        },
      },
      {
        $addFields: {
          _tier: {
            $cond: [
              { $eq: ['$_ended', true] },
              2,
              { $cond: [{ $gt: ['$startAt', now] }, 0, 1] },
            ],
          },
        },
      },
      // 未开始取 startAt、进行中取 endAt、已结束取 -endAt，统一成升序即
      // 「未开始快开赛在前 / 进行中快结束在前 / 已结束刚结束在前」
      {
        $addFields: {
          _endKey: {
            $switch: {
              branches: [
                { case: { $eq: ['$_tier', 0] }, then: '$startAt' },
                { case: { $eq: ['$_tier', 1] }, then: '$endAt' },
              ],
              default: { $multiply: ['$endAt', -1] },
            },
          },
        },
      },
      { $sort: { _tier: 1, _endKey: 1, createdAt: -1 } },
      { $skip: skip },
      { $limit: query.pageSize },
      { $project: { _tier: 0, _endKey: 0, _ended: 0 } },
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
    .select('avatarUrl avatarPreset nickname')
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
          // 端上两级兜底都落空时拿首字画占位圆，所以昵称必须跟着行下来
          nickname: u?.nickname || '',
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

/** 类型筛选：必须是合法运动类型，且落在活动白名单内（白名单为空 = 不限） */
function assertCampaignType(c: CampaignDoc, type?: string) {
  if (!type) return;
  if (!(ACTIVITY_TYPES as readonly string[]).includes(type)) {
    throw new AppError(400, '运动类型不合法');
  }
  if (c.allowedTypes.length > 0 && !c.allowedTypes.includes(type as never)) {
    throw new AppError(400, '该运动类型不在活动范围内');
  }
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
  memberAvatars: { avatarUrl: string; avatarPreset: string; nickname: string }[],
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
  // 与 joinCampaign 的闸门同口径：未开始也能报名。只判 active 会让未开始活动落到
  // 「canJoin=false」，端上按最后一条分支显示成「人数已满」。
  const canJoin =
    (status === 'active' || status === 'upcoming') &&
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
  // 被 driftScore 门禁排除的条数（成员面板「N 条未计入」说明的数据来源）
  const excluded = await excludedCountForMembers(c, uids);

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
      excludedCount: excluded.get(String(m.userId)) ?? 0,
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
  // 底部悬浮面板（仅本人）：次数 / 连续运动天数 / 距离 / 时长 + 我的位置（距离口径）
  const myStats = stats.get(viewerId) ?? emptyStats();
  const streak = await streakForUser(c, segs.get(viewerId) ?? [], viewerId);
  const ranked = [...memberList].sort(byDistanceThenJoin);
  const myIdx = ranked.findIndex((m) => m.userId === viewerId);
  const leaderDistance = ranked[0]?.distance ?? 0;
  // 上一名＝排在我前面的那一位；我第一（或查不到自己）时没有上一名，给 0 与 gapToLeader 同口径
  const prevDistance = myIdx > 0 ? ranked[myIdx - 1].distance : myStats.distance;
  return {
    ...base,
    canJoin,
    totals,
    members: memberList,
    myPanel: {
      ...myStats,
      streak,
      rank: myIdx >= 0 ? myIdx + 1 : ranked.length,
      members: ranked.length,
      gapToLeader: Math.max(0, leaderDistance - myStats.distance),
      gapToPrev: Math.max(0, prevDistance - myStats.distance),
      share: totals.distance > 0 ? myStats.distance / totals.distance : 0,
    },
  };
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

/**
 * 活动内成员闸门（排行榜 / 成员明细共用）：只有**当前 joined** 的成员能看活动内数据。
 * 认的是「现在是不是成员」——从未加入、待审批、已退出、被移出一律 403（成员数据不外泄的
 * 对象是非成员，不是队友）。抽成一处是为了这两处闸门不会各自漂移：放宽时就该一起放宽。
 */
async function assertJoinedMember(
  campaignId: mongoose.Types.ObjectId,
  viewerId: string,
  message: string,
): Promise<void> {
  const mine = await CampaignMemberModel.find({
    campaignId,
    userId: new mongoose.Types.ObjectId(viewerId),
  }).lean();
  if (myStateOf(mine) !== 'joined') throw new AppError(403, message);
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
  // 未开始也可加入：报名早于开赛是常态。开赛前加入的这段空窗不计里程，由计入窗口下限
  // max(startAt, joinedAt) 保证（campaign-stats.ts timeOr），不在这里挡。
  const campStatus = effectiveStatus(c);
  if (campStatus !== 'active' && campStatus !== 'upcoming') {
    throw new AppError(403, '活动已结束或已解散');
  }
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
  if (status !== 'active' && status !== 'upcoming') {
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
  /** 当前排序指标的值（距离米 / 次数 / 时长秒） */
  value: number;
}

export type LeaderMetric = 'distance' | 'count' | 'duration';

export interface LeaderboardMy {
  rank: number;
  value: number;
  total: number;
  leaderValue: number;
  gapToLeader: number;
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
  query: { page: number; pageSize: number; metric?: LeaderMetric; type?: string },
): Promise<{
  rows: LeaderRow[];
  total: number;
  page: number;
  pageSize: number;
  metric: LeaderMetric;
  type: string;
  my: LeaderboardMy;
}> {
  const c = await loadCampaignOr404(id);
  await assertJoinedMember(c._id, viewerId, '只有活动成员可以查看排行榜');
  assertCampaignType(c, query.type);
  const metric: LeaderMetric = query.metric ?? 'distance';

  const members = await CampaignMemberModel.find({ campaignId: c._id, state: 'joined' })
    .select('userId joinedAt')
    .lean();
  const uids = members.map((m) => String(m.userId));
  const stats = await statsForMembers(c, await loadSegments(String(c._id)), uids, query.type);
  const valueOf = (s: MemberStats) =>
    metric === 'count' ? s.count : metric === 'duration' ? s.duration : s.distance;

  // 指标优先，平手退回距离→加入时间（列表卡片头像的同一条排序）
  const ranked = [...members].sort((x, y) => {
    const xs = stats.get(String(x.userId))!;
    const ys = stats.get(String(y.userId))!;
    return (
      valueOf(ys) - valueOf(xs) ||
      byDistanceThenJoin(
        { distance: xs.distance, joinedAt: x.joinedAt ?? null },
        { distance: ys.distance, joinedAt: y.joinedAt ?? null },
      )
    );
  });

  const total = ranked.length;
  const from = (query.page - 1) * query.pageSize;
  const pageRows = ranked.slice(from, from + query.pageSize);

  const users = await UserModel.find({ _id: { $in: pageRows.map((m) => m.userId) } })
    .select('nickname avatarUrl avatarPreset')
    .lean();
  const uMap = new Map(users.map((u) => [String(u._id), u]));

  const myIdx = ranked.findIndex((m) => String(m.userId) === viewerId);
  const myStats = stats.get(viewerId) ?? emptyStats();
  const leaderStats = ranked.length > 0 ? stats.get(String(ranked[0].userId)) ?? emptyStats() : emptyStats();
  const myValue = valueOf(myStats);
  const leaderValue = valueOf(leaderStats);

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
        value: valueOf(s),
      };
    }),
    total,
    page: query.page,
    pageSize: query.pageSize,
    metric,
    type: query.type || '',
    my: {
      rank: myIdx >= 0 ? myIdx + 1 : total,
      value: myValue,
      total,
      leaderValue,
      gapToLeader: Math.max(0, leaderValue - myValue),
    },
  };
}

/** 逐桶距离 → 累计距离（趋势图两档共用；返回新数组） */
function cumsum(values: number[]): number[] {
  let sum = 0;
  return values.map((v) => (sum += v));
}

/** 趋势图一条线：按人档＝一个成员（`userId` + 昵称）；按类型档＝一个运动类型（`type`） */
export interface TrendSeries {
  userId?: string;
  /** 按类型档的类型 key；中文名走端上 TYPE_LABEL，服务端不再另存一份文案 */
  type?: string;
  name?: string;
  isMe: boolean;
  /** 累计距离（米） */
  values: number[];
}

export interface CampaignTrendDto {
  metric: 'distance';
  /** 分档：person＝前三名 + 我（缺省，老端形状不变）；type＝全队每个运动类型一条线 */
  by: 'person' | 'type';
  /** 日期桶粒度：跨度 ≤31 天按日，否则按周（周桶标签＝该周首日） */
  bucket: 'day' | 'week';
  /** MM-DD */
  labels: string[];
  series: TrendSeries[];
}

/**
 * 活动内每日累计距离趋势，两档共用同一条时间轴与同一套计入判据：
 * - `by=person`：前三名 + 我（已在前三时不重复）。排名用**当前 type 筛选后**的距离，
 *   保证「趋势里的前三」就是图表指标下的前三。
 * - `by=type`：全队（所有 joined 成员）按运动类型分线，一条线＝一类。
 *
 * 两档的逐日距离都出自 campaign-stats 里同一组零件（贡献时段并集 + `baseMatch` + 东八日表达式），
 * 所以「各类型线终点相加」必然等于「全队汇总」的运动距离，两处不会分叉。
 * 时间轴从开赛日到今天（或结束日）止；未开赛没有桶，端上据此收起图表。
 */
export async function campaignTrend(
  id: string,
  viewerId: string,
  query: { type?: string; by?: 'person' | 'type' },
): Promise<CampaignTrendDto> {
  const c = await loadCampaignOr404(id);
  await assertJoinedMember(c._id, viewerId, '只有活动成员可以查看趋势');
  assertCampaignType(c, query.type);

  const segs = await loadSegments(String(c._id));
  const members = await CampaignMemberModel.find({ campaignId: c._id, state: 'joined' })
    .select('userId joinedAt')
    .lean();
  const uids = members.map((m) => String(m.userId));
  const by = query.by ?? 'person';

  // 东八日桶：开赛日 → min(昨天/今天, 结束日前一日)
  const from = bjDayStart(c.startAt);
  const lastMs = Math.min(c.endAt - 1, Date.now());
  const dayCount = lastMs < from ? 0 : Math.round((bjDayStart(lastMs) - from) / DAY_MS) + 1;
  const bucket = dayCount > 31 ? 'week' : 'day';
  const bucketCount = bucket === 'week' ? Math.ceil(dayCount / 7) : dayCount;
  // 标签给的是「MM/DD」：分隔符跟 App 其它日期展示一致（斜杠），端上原样画在 X 轴上
  const labels = Array.from({ length: bucketCount }, (_, i) =>
    bjDateStr(from + i * (bucket === 'week' ? 7 : 1) * DAY_MS).slice(5).replace('-', '/'),
  );
  /** 东八日串 → 桶下标；落在时间轴外返回 -1（调用方丢弃） */
  const bucketOf = (date: string): number => {
    const dayIdx = Math.round((bjDayStart(Date.parse(`${date}T00:00:00+08:00`)) - from) / DAY_MS);
    if (dayIdx < 0 || dayIdx >= dayCount) return -1;
    return bucket === 'week' ? Math.floor(dayIdx / 7) : dayIdx;
  };

  if (by === 'type') {
    const acc = new Map<string, number[]>();
    for (const r of await dailyDistanceByType(c, segs, uids, query.type)) {
      const b = bucketOf(r.date);
      if (b < 0) continue;
      let values = acc.get(r.type);
      if (!values) {
        values = labels.map(() => 0);
        acc.set(r.type, values);
      }
      values[b] += r.distance;
    }
    const series: TrendSeries[] = [...acc].map(([type, values]) => ({
      type,
      isMe: false,
      values: cumsum(values),
    }));
    // 图例按累计距离降序（与全站 chip「按量排序」同一条惯例）；终点值就在最后一格
    series.sort(
      (x, y) => (y.values[y.values.length - 1] ?? 0) - (x.values[x.values.length - 1] ?? 0),
    );
    return { metric: 'distance', by, bucket, labels, series };
  }

  const stats = await statsForMembers(c, segs, uids, query.type);
  const ranked = [...members].sort((x, y) => {
    const xs = stats.get(String(x.userId)) ?? emptyStats();
    const ys = stats.get(String(y.userId)) ?? emptyStats();
    return byDistanceThenJoin(
      { distance: xs.distance, joinedAt: x.joinedAt ?? null },
      { distance: ys.distance, joinedAt: y.joinedAt ?? null },
    );
  });
  const picked = ranked.slice(0, 3).map((m) => String(m.userId));
  if (uids.includes(viewerId) && !picked.includes(viewerId)) picked.push(viewerId);

  const users = await UserModel.find({ _id: { $in: picked } }).select('nickname').lean();
  const nameMap = new Map(users.map((u) => [String(u._id), u.nickname]));
  const series: TrendSeries[] = picked.map((uid) => ({
    userId: uid,
    name: nameMap.get(uid) || '微信用户',
    isMe: uid === viewerId,
    values: labels.map(() => 0),
  }));
  if (bucketCount === 0 || picked.length === 0) {
    return { metric: 'distance', by, bucket, labels, series };
  }

  const idxByUid = new Map(picked.map((uid, i) => [uid, i]));
  for (const r of await dailyDistanceForMembers(c, segs, picked, query.type)) {
    const i = idxByUid.get(r.userId);
    if (i === undefined) continue;
    const b = bucketOf(r.date);
    if (b < 0) continue;
    series[i].values[b] += r.distance;
  }
  for (const s of series) s.values = cumsum(s.values);
  return { metric: 'distance', by, bucket, labels, series };
}

/**
 * 成员明细（活动内成员可见，含发起人 / 队友 / 本人）：概况 + 分页轨迹列表。
 *
 * 权限与存在性：viewer 必须是**当前 joined 的成员**（非成员 403，与排行榜同一道闸门）；
 * `uid` 与 `:id` 同待遇——畸形串走 404 闸门（本仓硬性惯例），
 * 且目标在本活动**没有任何加入段**（从未加入 / 只有 pending）也 404，而不是 200 + 全 0。
 * 「是成员但还没有轨迹」不受影响：有加入段即照常 200 + 全 0。
 *
 * 明细的**计入判据与 campaign-stats 同口径**（否则弹窗里的条数/距离会和汇总对不上）：
 * 判据由 `memberActivityMatch` 单点提供（`status='finished'`、`vehicleMs: { $not: { $gt: 0 } }`、
 * `type ∈ allowedTypes`、`startTime` 落在该用户的贡献时段并集内）—— 明细不再自己拼一份，改口径时两边同步。
 */
export async function memberDetail(
  id: string,
  viewerId: string,
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
  await assertJoinedMember(c._id, viewerId, '只有活动成员可以查看成员明细');
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
  status: 'upcoming' | 'active' | 'ended' | 'dissolved';
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
 * 只在解散时被写成 'dissolved'，'ended' / 'upcoming' **从不落库** —— 直接 `filter.status = query.status`
 * 会让 `status=ended` 永远查不到（永空）、`status=active` 把已结束和未开始的都带出来。
 * 所以这里按有效状态反向构造条件，并把同一个 `now` 传给 `effectiveStatus`，保证一次请求内
 * 筛选与展示不会因「刚好跨过 startAt / endAt」而互相矛盾。
 */
function statusFilter(status: string, now: number): Record<string, unknown> {
  switch (status) {
    case 'dissolved':
      return { status: 'dissolved' };
    case 'ended':
      return { $or: [{ status: 'ended' }, { status: 'active', endAt: { $lte: now } }] };
    case 'upcoming':
      return { status: 'active', endAt: { $gt: now }, startAt: { $gt: now } };
    default:
      // 'active'：已开赛且未结束
      return { status: 'active', endAt: { $gt: now }, startAt: { $lte: now } };
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
export async function adminGetCampaign(
  id: string,
  query: { page?: number; pageSize?: number } = {},
) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  const c = await loadCampaignOr404(id);
  // 次键 _id：同刻加入的多行必须有确定顺序，否则翻页会漏/重
  const members = await CampaignMemberModel.find({ campaignId: c._id, joinedAt: { $ne: null } })
    .sort({ joinedAt: 1, _id: 1 })
    .lean();
  const membersTotal = members.length;
  const from = (page - 1) * pageSize;
  const pageMembers = members.slice(from, from + pageSize);
  const uids = members.map((m) => String(m.userId));
  const users = await UserModel.find({ _id: { $in: uids } })
    .select('nickname uid')
    .lean();
  const uMap = new Map(users.map((u) => [String(u._id), u]));
  const segs = await loadSegments(String(c._id));
  const stats = await statsForMembers(c, segs, uids);
  // 汇总与排行榜只算当前在队（成员表则刻意含历史段）；排行复用同一条 byDistanceThenJoin，与小程序榜一致
  const joined = members.filter((m) => m.state === 'joined');
  const joinedUids = joined.map((m) => String(m.userId));
  const typeSummary = await typeSummaryForMembers(c, segs, joinedUids);
  // 逐日距离趋势（全队合计，活动跨度内每天一行；管理端详情页图表用）
  const dailyRows = await dailyDistanceForMembers(c, segs, joinedUids);
  const byDate = new Map<string, number>();
  for (const r of dailyRows) byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.distance);
  const trend = [...byDate.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([date, distance]) => ({ date, distance }));
  // 按成员统计被 driftScore 门禁排除的条数（成员表「异常数量」列）
  const excluded = await excludedCountForMembers(c, uids);
  const totals = joined.reduce(
    (acc, m) => {
      const st = stats.get(String(m.userId));
      return {
        count: acc.count + (st?.count ?? 0),
        distance: acc.distance + (st?.distance ?? 0),
        duration: acc.duration + (st?.duration ?? 0),
      };
    },
    { count: 0, distance: 0, duration: 0 },
  );
  const excludedTotal = joinedUids.reduce((sum, uid) => sum + (excluded.get(uid) ?? 0), 0);
  // 末位成员（在队、距离最少）：管理端详情页一键看 TA 的全部轨迹
  const lastPlace = joined.length
    ? [...joined]
        .map((m) => ({ m, s: stats.get(String(m.userId)) ?? { count: 0, distance: 0, duration: 0 } }))
        .sort((x, y) => x.s.distance - y.s.distance)[0]
    : null;
  const leaderboard = [...joined]
    .map((m) => ({ m, s: stats.get(String(m.userId))! }))
    .sort((x, y) =>
      byDistanceThenJoin(
        { distance: x.s.distance, joinedAt: x.m.joinedAt ?? null },
        { distance: y.s.distance, joinedAt: y.m.joinedAt ?? null },
      ),
    )
    .slice(0, 10)
    .map(({ m, s }, i) => ({
      rank: i + 1,
      userId: String(m.userId),
      name: uMap.get(String(m.userId))?.nickname || '微信用户',
      distance: s.distance,
      count: s.count,
      duration: s.duration,
    }));
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
    typeSummary,
    trend,
    totals,
    excludedTotal,
    lastPlace: lastPlace
      ? {
          userId: String(lastPlace.m.userId),
          name: uMap.get(String(lastPlace.m.userId))?.nickname || '微信用户',
          distance: lastPlace.s.distance,
        }
      : null,
    leaderboard,
    membersTotal,
    membersPage: page,
    membersPageSize: pageSize,
    members: pageMembers.map((m) => {
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
        excludedCount: excluded.get(String(m.userId)) ?? 0,
      };
    }),
  };
}
