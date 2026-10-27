/**
 * 管理端用户积分列表与详情（spec §6.7/§7.1，Task 7）。
 *
 * 列表口径（§6.7）：
 * - 以 `UserModel` 为主体（关键词可搜昵称/UID），积分侧三次聚合成 Map；
 * - **全量组装 → 内存排序 → 再切片**：先切片再排序会把同一批用户排出不同的前后顺序，
 *   翻页就重行/漏行（AU-3 钉这条）；
 * - `lastEarnedAt` 只取 `delta > 0` 的流水，撤回行不参与（AU-2）；
 * - 并列按 uid 升序兜底（再同则按 id），保证两次请求的排序完全一致。
 *
 * 列表行与详情用同一个 `metricsOf` 聚合口径（余额/累计获得/兑换次数都从这一份出）。
 * 详情自己重算一遍就会和列表漂移——AU-6 就是为了抓这个，别把 metricsOf 复制一份。
 */
import { Types } from 'mongoose';
import {
  PointAccountModel, PointCardModel, PointItemModel, PointRecordModel, PointSigninModel,
} from '../models/point.model.js';
import { UserModel } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { isObjectIdLike } from '../utils/object-id.js';
import { userKeywordFilter } from '../utils/user-keyword.js';
import { STATUS_TEXT, cardStatus, type CardStatus } from './points-items.js';
import { SOURCE_TEXT } from './points-grant.js';
import { adFreeUntilOf } from './points-cards.js';
import { listPointRecords } from './points-ledger.js';
import { getSigninState } from './points-signin.js';
import { ROLLBACK_RE } from './points-admin-stats.js';

/** 列表可排序字段白名单（spec §6.7）；非法值 400 并列出允许值 */
export const POINT_USER_SORT_FIELDS = ['balance', 'lastEarnedAt', 'totalEarned', 'exchanges'] as const;
export type PointUserSortField = typeof POINT_USER_SORT_FIELDS[number];

/** 管理端单页上限：用户列表与积分明细都放到 100，用户端明细仍是 50（AU-7） */
const ADMIN_PAGE_SIZE_CAP = 100;

export interface PointsUserRow {
  id: string;
  uid: number;
  nickname: string;
  balance: number;
  totalEarned: number;
  exchanges: number;
  cardsUnused: number;
  lastEarnedAt: number;
}

export interface PointsUserDetail extends PointsUserRow {
  avatarUrl: string;
  /** 撤回（含补签撤回等所有 _rollback 族），与总览 rolledBack 同口径 */
  rolledBack: number;
  spentExchange: number;
  spentExpire: number;
  /** 累计消耗 = 兑换 + 过期（不含撤回；§6.5 的 totalSpent 不能拿来当这个用） */
  totalSpent: number;
  /** 累计签到天数（distinct dateKey，含补签） */
  signinDays: number;
  streakDay: number;
  adFreeUntil: number;
}

export interface PointsUserQuery {
  keyword?: unknown;
  sortBy?: unknown;
  order?: unknown;
  page?: unknown;
  pageSize?: unknown;
}

export interface PointsUserList {
  total: number;
  page: number;
  pageSize: number;
  items: PointsUserRow[];
}

export interface AdminCardRow {
  id: string;
  itemKey: string;
  itemName: string;
  source: string;
  sourceText: string;
  status: CardStatus;
  statusText: string;
  createdAt: number;
  expiresAt: number;
  usedForDate: string;
  activatedAt: number;
  benefitDays: number;
  grantedBy: string;
  note: string;
}

/** 单用户积分指标（列表与详情唯一口径） */
interface UserPointsMetrics {
  balance: number;
  earnedGross: number;
  rolledBack: number;
  spentExchange: number;
  spentExpire: number;
  exchanges: number;
  lastEarnedAt: number;
  cardsUnused: number;
}

const ZERO_METRICS: UserPointsMetrics = {
  balance: 0, earnedGross: 0, rolledBack: 0, spentExchange: 0, spentExpire: 0,
  exchanges: 0, lastEarnedAt: 0, cardsUnused: 0,
};

/** 错误文案里回显收到的值：「空」而不是把 undefined 拼进句子 */
function shown(value: unknown): string {
  if (value === undefined || value === null || value === '') return '空';
  return String(value);
}

function toPositiveInt(value: unknown, fallback: number): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 用户 id 闸门：形态非法 → 400（AU-8 第一段），查无此人 → 404「用户不存在」。
 * 这里刻意不用 assertObjectIdLike（它把畸形串也归成 404）：管理端详情/明细/卡片三条接口
 * 的路径参数是同一个，调用方传错 id 和「人已被删」是两类错误，文案要分得开。
 */
function userIdOf(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!isObjectIdLike(raw)) {
    throw new AppError(400, `用户 ID 不合法（收到「${shown(raw)}」，应为 24 位 ObjectId）`);
  }
  return raw;
}

async function loadUser(userId: string) {
  const user = await UserModel.findById(userId).lean();
  if (!user) throw new AppError(404, '用户不存在');
  return user;
}

/**
 * 批量取积分指标：三条聚合各扫一次，按 userId 合并。
 * - 余额来自 PointAccount（§6.5：流通余额 = Σ account.balance），不逐用户 getBalance，
 *   否则列表 N 次查询还会顺手结算过期，列表与详情的「读时点」就对不齐了；
 * - `lastEarnedAt` 的 `$cond` 把负 delta 折成 0：`$max` 因此只可能取到发放行的 createdAt（AU-2）；
 * - 持卡未使用按 status=unused 且未过期计数（与 §6.5 的持卡未使用人数同口径）。
 */
async function metricsOf(ids: Types.ObjectId[], now: number): Promise<Map<string, UserPointsMetrics>> {
  const out = new Map<string, UserPointsMetrics>();
  for (const id of ids) out.set(String(id), { ...ZERO_METRICS });
  if (ids.length === 0) return out;

  const [records, accounts, cards] = await Promise.all([
    PointRecordModel.aggregate<{
      _id: Types.ObjectId; earnedGross: number; rolledBack: number; spentExchange: number;
      spentExpire: number; exchanges: number; lastEarnedAt: number;
    }>([
      { $match: { userId: { $in: ids } } },
      {
        $group: {
          _id: '$userId',
          earnedGross: { $sum: { $cond: [{ $gt: ['$delta', 0] }, '$delta', 0] } },
          rolledBack: { $sum: { $cond: [{ $regexMatch: { input: '$type', regex: ROLLBACK_RE.source } }, { $multiply: ['$delta', -1] }, 0] } },
          spentExchange: { $sum: { $cond: [{ $eq: ['$type', 'exchange'] }, { $multiply: ['$delta', -1] }, 0] } },
          spentExpire: { $sum: { $cond: [{ $eq: ['$type', 'expire'] }, { $multiply: ['$delta', -1] }, 0] } },
          exchanges: { $sum: { $cond: [{ $eq: ['$type', 'exchange'] }, 1, 0] } },
          lastEarnedAt: { $max: { $cond: [{ $gt: ['$delta', 0] }, '$createdAt', 0] } },
        },
      },
    ]),
    PointAccountModel.aggregate<{ _id: Types.ObjectId; balance: number }>([
      { $match: { userId: { $in: ids } } },
      { $group: { _id: '$userId', balance: { $sum: '$balance' } } },
    ]),
    PointCardModel.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { userId: { $in: ids }, status: 'unused', expiresAt: { $gt: now } } },
      { $group: { _id: '$userId', n: { $sum: 1 } } },
    ]),
  ]);

  const at = (id: Types.ObjectId) => out.get(String(id))!;
  for (const r of records) {
    Object.assign(at(r._id), {
      earnedGross: r.earnedGross,
      rolledBack: r.rolledBack,
      spentExchange: r.spentExchange,
      spentExpire: r.spentExpire,
      exchanges: r.exchanges,
      lastEarnedAt: r.lastEarnedAt,
    });
  }
  for (const a of accounts) at(a._id).balance = a.balance;
  for (const c of cards) at(c._id).cardsUnused = c.n;
  return out;
}

/** 单用户指标：详情走这里（内部仍是 metricsOf，口径与列表一字不差） */
async function pointsOfUser(userId: string, now: number): Promise<UserPointsMetrics> {
  const map = await metricsOf([new Types.ObjectId(userId)], now);
  return map.get(userId) ?? { ...ZERO_METRICS };
}

/** 列表行与详情共用的字段映射：两边都从这里取，别各拼一份 */
function toRow(
  user: { _id: unknown; uid?: number | null; nickname?: string },
  m: UserPointsMetrics,
): PointsUserRow {
  return {
    id: String(user._id),
    uid: Number(user.uid ?? 0),
    nickname: String(user.nickname ?? ''),
    balance: m.balance,
    totalEarned: m.earnedGross,
    exchanges: m.exchanges,
    cardsUnused: m.cardsUnused,
    lastEarnedAt: m.lastEarnedAt,
  };
}

/** 管理端用户积分列表：全量组装 → 排序 → 切片（顺序不能换，AU-3 钉这条） */
export async function pointsAdminUsers(q: PointsUserQuery = {}): Promise<PointsUserList> {
  const field = String(q.sortBy ?? '').trim();
  if (field && !(POINT_USER_SORT_FIELDS as readonly string[]).includes(field)) {
    throw new AppError(400, `sortBy 不合法：${field}（仅支持 ${POINT_USER_SORT_FIELDS.join(' / ')}）`);
  }
  const key = (field || 'balance') as PointUserSortField;
  const dir = String(q.order ?? '').trim() === 'asc' ? 1 : -1;
  const p = Math.max(1, toPositiveInt(q.page, 1));
  const ps = Math.min(ADMIN_PAGE_SIZE_CAP, toPositiveInt(q.pageSize, 20));

  const filter = userKeywordFilter(q.keyword);
  const users = await UserModel.find(filter ?? {}).select({ _id: 1, uid: 1, nickname: 1 }).lean();
  const now = Date.now();
  const metrics = await metricsOf(users.map((u) => u._id), now);
  const rows = users.map((u) => toRow(u, metrics.get(String(u._id)) ?? ZERO_METRICS));

  rows.sort((a, b) => {
    const diff = (a[key] ?? 0) - (b[key] ?? 0);
    if (diff !== 0) return dir * diff;
    // 并列按 uid 升序（与排序方向无关）：两次请求的先后必须一致，否则翻页会重行/漏行
    if (a.uid !== b.uid) return a.uid - b.uid;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const total = rows.length;
  // 切片在排序之后：先切会把「本页内顺序」当成全局顺序，跨页既重又漏
  const items = rows.slice((p - 1) * ps, p * ps);
  return { total, page: p, pageSize: ps, items };
}

/** 详情概况（spec §7.1）：列表同口径 + 签到天数/当前连续/adFreeUntil */
export async function pointsAdminUserDetail(id: unknown): Promise<PointsUserDetail> {
  const userId = userIdOf(id);
  const user = await loadUser(userId);
  const now = Date.now();
  const [metrics, signinDays, signinState, adFreeUntil] = await Promise.all([
    pointsOfUser(userId, now),
    PointSigninModel.distinct('dateKey', { userId: user._id }),
    getSigninState(userId, now),
    adFreeUntilOf(userId),
  ]);
  return {
    ...toRow(user, metrics),
    avatarUrl: String(user.avatarUrl ?? ''),
    rolledBack: metrics.rolledBack,
    spentExchange: metrics.spentExchange,
    spentExpire: metrics.spentExpire,
    totalSpent: metrics.spentExchange + metrics.spentExpire,
    signinDays: signinDays.length,
    streakDay: signinState.streakDay,
    adFreeUntil,
  };
}

/**
 * 用户积分明细：复用 listPointRecords，管理端单页上限 100（用户端不传，仍是 50）。
 * 先校验用户存在，免得对一个不存在的 id 返回空列表（运营分不清「没流水」和「人没了」）。
 */
export async function pointsAdminUserRecords(
  id: unknown,
  page: unknown = 1,
  pageSize: unknown = 20,
  type?: unknown,
): Promise<{ items: Awaited<ReturnType<typeof listPointRecords>>['items']; total: number; balance: number; page: number; pageSize: number }> {
  const userId = userIdOf(id);
  await loadUser(userId);
  const p = Math.max(1, toPositiveInt(page, 1));
  const ps = toPositiveInt(pageSize, 20);
  const r = await listPointRecords(
    userId, p, ps, Date.now(), type ? String(type) : undefined, ADMIN_PAGE_SIZE_CAP,
  );
  return { ...r, page: p };
}

/** 用户全部道具卡（含手动发放，所以页签叫「道具记录」）；状态实时推导，与兑换记录同口径 */
export async function pointsAdminUserCards(id: unknown): Promise<AdminCardRow[]> {
  const userId = userIdOf(id);
  await loadUser(userId);
  const cards = await PointCardModel.find({ userId }).sort({ createdAt: -1, _id: -1 }).lean();
  const keys = [...new Set(cards.map((c) => String(c.itemKey ?? 'makeup_card')))];
  const items = keys.length
    ? await PointItemModel.find({ key: { $in: keys } }).select({ key: 1, name: 1 }).lean()
    : [];
  const nameOf = new Map(items.map((it) => [String(it.key), String(it.name ?? '')]));
  const now = Date.now();
  return cards.map((c) => {
    // 老行物理缺 source（10-27 之前写入）按兑换归类，与发放记录同一口径（GR-6）
    const source = String(c.source ?? 'exchange');
    const status = cardStatus(c, now);
    return {
      id: String(c._id),
      itemKey: String(c.itemKey ?? 'makeup_card'),
      itemName: nameOf.get(String(c.itemKey ?? 'makeup_card')) ?? '',
      source,
      sourceText: SOURCE_TEXT[source] ?? '',
      status,
      statusText: STATUS_TEXT[status],
      createdAt: Number(c.createdAt ?? 0),
      expiresAt: Number(c.expiresAt ?? 0),
      usedForDate: String(c.usedForDate ?? ''),
      activatedAt: Number(c.activatedAt ?? 0),
      benefitDays: Number(c.benefitDays ?? 0),
      grantedBy: String(c.grantedBy ?? ''),
      note: String(c.note ?? ''),
    };
  });
}
