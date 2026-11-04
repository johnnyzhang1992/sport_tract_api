/**
 * 权益唯一读取层（spec §5.4）：会员订单与积分道具卡两条来源在这一个函数里汇成一个读数。
 *
 * 纪律：判据处不许再出现第二份算式。登录响应、积分汇总、广告组件、照片闸门、GPX 打包闸门
 * 五处全部改读这里（Task 6 一次改完，不留「有的页面还自己算」的尾巴）。
 *
 * 不落任何派生字段（与 points-cards.ts 的 adFreeUntil 同一纪律）：真相只有「订单行的区间」与
 * 「卡的激活时刻」，多存一份到期时间就多出第二个能互相矛盾的真相。
 */
import { Types } from 'mongoose';
import { XpayOrderModel } from '../models/xpay-order.model.js';
import { PointCardModel } from '../models/point.model.js';
import { replayAdFree } from './points-cards.js';
import { MAX_USER_PHOTOS } from '../config/constants.js';
import { isObjectIdLike } from '../utils/object-id.js';
import type { PaidProductPerks } from '../models/paid-product.model.js';

/** 计入会员的行（spec §5.3）：refunding 不中断权益——受理退款后用户仍应能用到账期结束 */
export const MEMBER_COUNTING_STATUS = ['delivered', 'refunding', 'refunded'] as const;

export interface MembershipRow {
  periodStart: number;
  periodEnd: number;
  /** 退款受理时刻；0＝未截断（spec §7.5「权益按时间截断」） */
  truncatedAt: number;
  perksSnapshot: PaidProductPerks;
}

export interface Entitlements {
  memberActive: boolean;
  memberUntil: number;
  /** = max(会员中给了 adFree 的那几笔的到期, 积分免广告卡回放) —— 两条来源各自回放后取 max */
  adFreeUntil: number;
  photoQuotaLimit: number;
  canExportBundle: boolean;
  /** 本计划只出读数，端上开关在第二份（订阅消息）计划里做 */
  canSubscribeNotice: boolean;
}

function effectiveEnd(r: Pick<MembershipRow, 'periodStart' | 'periodEnd' | 'truncatedAt'>): number {
  if (r.periodEnd <= 0 || r.periodStart <= 0) return 0;
  if (r.truncatedAt <= 0) return r.periodEnd;
  // 退款受理时刻不晚于起点＝这笔从未生效就被退掉：一天都不给。
  // 少了这一句，「还没生效的顺延单退款」会把会员到期白送到它的起点。
  if (r.truncatedAt <= r.periodStart) return 0;
  return Math.min(r.periodEnd, r.truncatedAt);
}

/**
 * 纯函数：会员到期时刻＝各笔有效区间末尾的最大值。
 * 「顺延」在发货时算好并落进快照（Task 9），这里只做并集——
 * 只有快照形态能让 iOS 问询在 3 秒内答完，也才能在退款截断后保住已用掉的天数。
 */
export function replayMembership(rows: MembershipRow[]): number {
  let until = 0;
  for (const r of rows) until = Math.max(until, effectiveEnd(r));
  return until;
}

type OrderRowFetcher = (userId: Types.ObjectId) => Promise<MembershipRow[]>;
type CardFetcher = (userId: Types.ObjectId) => Promise<Array<{ activatedAt: number; benefitDays: number }>>;

const defaultOrderRows: OrderRowFetcher = async (userId) => {
  const rows = await XpayOrderModel.find({ userId, status: { $in: [...MEMBER_COUNTING_STATUS] } })
    .select({ periodStart: 1, periodEnd: 1, truncatedAt: 1, perksSnapshot: 1 })
    .lean();
  return rows.map((r) => {
    const p = (r.perksSnapshot ?? {}) as Partial<PaidProductPerks>;
    return {
      periodStart: Number(r.periodStart ?? 0) || 0,
      periodEnd: Number(r.periodEnd ?? 0) || 0,
      truncatedAt: Number(r.truncatedAt ?? 0) || 0,
      perksSnapshot: {
        adFree: p.adFree === true,
        exportBundle: p.exportBundle === true,
        photoQuota: Number(p.photoQuota ?? 0) || 0,
        subscribeNotice: p.subscribeNotice === true,
      },
    };
  });
};

const defaultCards: CardFetcher = async (userId) => {
  const cards = await PointCardModel.find({ userId, status: 'used', benefitDays: { $gt: 0 } })
    .select({ activatedAt: 1, benefitDays: 1 }).lean();
  return cards.map((c) => ({ activatedAt: Number(c.activatedAt) || 0, benefitDays: Number(c.benefitDays) || 0 }));
};

let orderRows: OrderRowFetcher = defaultOrderRows;
let cards: CardFetcher = defaultCards;

/** 测试注入点（照 services/geo.ts:65-74 的先例）；传 null 恢复真实取数 */
export function __setEntitlementFetchersForTest(
  f: { orderRows?: OrderRowFetcher; adFreeCards?: CardFetcher } | null,
): void {
  orderRows = f?.orderRows ?? defaultOrderRows;
  cards = f?.adFreeCards ?? defaultCards;
}

/** 单条来源坏了按「该来源无权益」降级并留日志（spec §9：宁可少给，不可错给） */
async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[entitlements] ${label} 查询失败，按无权益降级:`, (e as Error).message);
    return fallback;
  }
}

export async function entitlementsOf(userId: string, now = Date.now()): Promise<Entitlements> {
  const empty: Entitlements = {
    memberActive: false, memberUntil: 0, adFreeUntil: 0,
    photoQuotaLimit: MAX_USER_PHOTOS, canExportBundle: false, canSubscribeNotice: false,
  };
  // 畸形 id 不进查询（否则 mongoose 抛 CastError，症状是「降级」而不是「这个用户没有权益」）
  if (!isObjectIdLike(userId)) return empty;
  const oid = new Types.ObjectId(userId);

  const [rows, cardRows] = await Promise.all([
    safe('会员订单', () => orderRows(oid), [] as MembershipRow[]),
    safe('免广告卡', () => cards(oid), [] as Array<{ activatedAt: number; benefitDays: number }>),
  ]);

  const memberUntil = replayMembership(rows);
  const adFreeFromMember = replayMembership(rows.filter((r) => r.perksSnapshot.adFree));
  const adFreeFromCards = replayAdFree(cardRows);

  // 打包/照片只认「此刻正在生效」的那一笔：排在未来的顺延单不该提前给权益
  const covering = rows.filter((r) => r.periodStart <= now && effectiveEnd(r) > now);
  const photoQuota = covering.reduce((m, r) => Math.max(m, r.perksSnapshot.photoQuota), 0);

  return {
    memberActive: memberUntil > now,
    memberUntil,
    adFreeUntil: Math.max(adFreeFromMember, adFreeFromCards),
    photoQuotaLimit: photoQuota > 0 ? photoQuota : MAX_USER_PHOTOS,
    canExportBundle: covering.some((r) => r.perksSnapshot.exportBundle),
    canSubscribeNotice: covering.some((r) => r.perksSnapshot.subscribeNotice),
  };
}

export async function membershipUntilOf(userId: string): Promise<number> {
  if (!isObjectIdLike(userId)) return 0;
  const rows = await safe('会员订单', () => orderRows(new Types.ObjectId(userId)), [] as MembershipRow[]);
  return replayMembership(rows);
}

/**
 * 批量判定「此刻是付费会员」的用户集合（榜单头像徽标用）。
 * 只认会员订单（含退款截断），不含积分免广告卡——徽标语义是「会员」，不是「免广告」。
 */
export async function activeMemberUserIds(
  userIds: Array<string | Types.ObjectId>,
  now = Date.now(),
): Promise<Set<string>> {
  const ids = [...new Set(userIds.map(String))].filter(isObjectIdLike).map((id) => new Types.ObjectId(id));
  if (!ids.length) return new Set();
  const rows = await safe(
    '会员订单批量',
    async () => {
      const docs = await XpayOrderModel.find({
        userId: { $in: ids },
        status: { $in: [...MEMBER_COUNTING_STATUS] },
      })
        .select({ userId: 1, periodStart: 1, periodEnd: 1, truncatedAt: 1 })
        .lean();
      return docs.map((r) => ({
        userId: String(r.userId),
        periodStart: Number(r.periodStart) || 0,
        periodEnd: Number(r.periodEnd) || 0,
        truncatedAt: Number(r.truncatedAt) || 0,
      }));
    },
    [] as Array<{ userId: string; periodStart: number; periodEnd: number; truncatedAt: number }>,
  );
  const out = new Set<string>();
  for (const r of rows) {
    // periodStart 为 0＝还没排进会员链（未发货），不参与
    if (r.periodStart > 0 && r.periodStart <= now && effectiveEnd(r) > now) out.add(r.userId);
  }
  return out;
}
