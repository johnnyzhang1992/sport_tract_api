/**
 * 道具卡的激活与权益推导。
 * adFreeUntil 不落字段：激活是唯一写路径、卡行数极小，存一份只会多出一个能和卡脱钩的真相（spec §5.4）。
 */
import { Types } from 'mongoose';
import { PointCardModel, PointItemModel } from '../models/point.model.js';
import { AppError } from '../utils/app-error.js';
import { bjDateStr } from '../utils/bj-time.js';
import { assertObjectIdLike } from '../utils/object-id.js';

const DAY_MS = 86400000;

/** 纯函数：已按 activatedAt 升序（同刻按 _id）排好的免广告卡 → 到期时刻。多张顺延叠加，空窗期不追溯补偿。
 *  adFreeUntilOf 与 Task 8 的名单导出共用这一份算术，不许出现第二份实现。 */
export function replayAdFree(cards: Array<{ activatedAt: number; benefitDays: number }>): number {
  let until = 0;
  for (const c of cards) until = Math.max(until, c.activatedAt || 0) + c.benefitDays * DAY_MS;
  return until;
}

/** adFreeUntil 不落字段：激活是唯一写路径、卡行数极小，存一份只会多出一个能和卡脱钩的真相（spec §5.4） */
export async function adFreeUntilOf(userId: string): Promise<number> {
  const cards = await PointCardModel.find({ userId, status: 'used', benefitDays: { $gt: 0 } })
    .select({ activatedAt: 1, benefitDays: 1 })
    .sort({ activatedAt: 1, _id: 1 }).lean();
  return replayAdFree(cards);
}

/**
 * 激活免广告卡（POST /points/cards/:cardId/activate；补签卡不走这条路，见 POST /points/signin/makeup）。
 * 闸门顺序固定（spec §6.3）：形态 → 归属 404 → 无需激活 400 → 已使用 400 → 过期 400（文案带有效期日期）。
 */
export async function activateCard(userId: string, cardId: string, now = Date.now()) {
  assertObjectIdLike(cardId, '卡不存在');
  const card = await PointCardModel.findById(cardId).lean();
  if (!card || String(card.userId) !== String(userId)) throw new AppError(404, '卡不存在');
  // benefitDays 是 Task 1 才加的字段：老补签卡 .lean() 读出 undefined，`undefined <= 0` 为 false 会放行，
  // 所以判「必须 > 0 才可激活」写成取反形式把缺字段一并挡下（spec §6.3：补签卡不走这条路）
  if (!(card.benefitDays > 0)) throw new AppError(400, '该道具无需激活（补签卡请在补签窗口直接使用）');
  if (card.status !== 'unused') throw new AppError(400, '该卡已使用');
  if (card.expiresAt <= now) throw new AppError(400, `该卡已过期（有效期至 ${bjDateStr(card.expiresAt)}）`);
  // CAS：并发两次点「激活」只有一次能改到行，另一次落进「该卡已使用」
  const updated = await PointCardModel.updateOne(
    { _id: card._id, status: 'unused' },
    { $set: { status: 'used', activatedAt: now } },
  );
  if (updated.modifiedCount !== 1) throw new AppError(400, '该卡已使用');
  return { cardId: String(card._id), adFreeUntil: await adFreeUntilOf(userId) };
}

/** 持卡数按道具分组：端上「我的补签卡 N 张」与将来的卡包页共用一份口径 */
export async function countUnusedCards(userId: string, now = Date.now()) {
  const rows = await PointCardModel.aggregate<{ _id: string; unused: number }>([
    { $match: { userId: new Types.ObjectId(userId), status: 'unused', expiresAt: { $gt: now } } },
    { $group: { _id: '$itemKey', unused: { $sum: 1 } } },
  ]);
  return rows.map((r) => ({ itemKey: r._id, unused: r.unused }));
}

// ==================== 用户侧卡列表（「我的卡」） ====================

/** 获取来源文案（2026-10-29 需求：发放/赠送/兑换都要留痕且对用户可见——来源就是痕的可见面） */
const SOURCE_TEXT: Record<string, string> = {
  exchange: '兑换获得',
  admin: '后台发放',
  system: '系统赠送',
};

/** 列表专属状态文案： exchanges 页的 unused/used/expired 之外，免广告卡还有激活后的三态 */
const LIST_STATUS_TEXT: Record<string, string> = {
  unused: '待使用',
  used: '已使用',
  active: '生效中',
  queued: '待生效',
  done: '已结束',
  expired: '已过期',
};

export interface UserCardDto {
  id: string;
  itemKey: string;
  name: string;
  /** 'makeup' | 'ad_free'（目录 effect.kind；目录行被删则按 benefitDays 推断） */
  kind: 'makeup' | 'ad_free';
  status: string;
  statusText: string;
  benefitDays: number;
  /** 卡本身的兑换/发放有效期：未激活的卡过了它就作废 */
  expiresAt: number;
  /** 免广告卡激活后的实际生效窗口（顺延重放，与 replayAdFree 同一算术的逐卡展开） */
  startAt?: number;
  endAt?: number;
  /** 补签卡使用日期 */
  usedForDate?: string;
  /** 获取来源：exchange=兑换 / admin=后台发放 / system=系统赠送 */
  source: string;
  sourceText: string;
  createdAt: number;
}

/**
 * 用户全部道具卡（兑换 + 后台发放/系统赠送都在内），端上「我的卡」区直接渲染。
 * - 补签卡沿用 exchanges 口径：unused / used（有 usedForDate）/ expired；
 * - 免广告卡比 exchanges 多两态：激活后按顺延重放展开出逐卡窗口——active（生效中）/
 *   queued（已激活但排在前面的卡还没用完）/ done（窗口已过）。startAt = max(前一张的 endAt, 自己的
 *   activatedAt)、endAt = startAt + benefitDays，与 replayAdFree 的 until 递推逐项一致（TC-L4 钉）。
 * - 卡不在兑换记录里出现（后台发放不落 exchange），这里是它们唯一的用户侧出口。
 */
export async function listCards(userId: string, now = Date.now()): Promise<UserCardDto[]> {
  const rows = await PointCardModel.find({ userId })
    .select({ itemKey: 1, status: 1, benefitDays: 1, expiresAt: 1, usedForDate: 1, activatedAt: 1, source: 1, createdAt: 1 })
    .sort({ createdAt: 1, _id: 1 })
    .lean();
  if (rows.length === 0) return [];

  const items = await PointItemModel.find({ key: { $in: [...new Set(rows.map((r) => r.itemKey))] } })
    .select({ key: 1, name: 1, 'effect.kind': 1 })
    .lean();
  const itemByKey = new Map(items.map((it) => [it.key, it]));

  // 免广告已激活卡先按激活序重放窗口（同 adFreeUntilOf 的排序口径：activatedAt 升序、同刻按 _id）
  const windowById = new Map<string, { startAt: number; endAt: number }>();
  let cursor = 0;
  for (const c of [...rows].filter((r) => r.benefitDays > 0 && r.status === 'used')
    .sort((a, b) => (a.activatedAt ?? 0) - (b.activatedAt ?? 0) || String(a._id).localeCompare(String(b._id)))) {
    const startAt = Math.max(cursor, c.activatedAt ?? 0);
    const endAt = startAt + c.benefitDays * DAY_MS;
    windowById.set(String(c._id), { startAt, endAt });
    cursor = endAt;
  }

  const out = rows.map((r) => {
    const cat = itemByKey.get(r.itemKey);
    const kind: UserCardDto['kind'] = cat?.effect?.kind === 'ad_free' || r.benefitDays > 0 ? 'ad_free' : 'makeup';
    let status: string;
    let startAt: number | undefined;
    let endAt: number | undefined;
    if (kind === 'ad_free') {
      if (r.status === 'used') {
        ({ startAt, endAt } = windowById.get(String(r._id))!);
        status = now < startAt ? 'queued' : now < endAt ? 'active' : 'done';
      } else {
        status = r.expiresAt <= now ? 'expired' : 'unused';
      }
    } else {
      // 补签卡三态与 exchanges 的 cardStatus 同口径
      status = r.status === 'used' ? 'used' : r.expiresAt <= now ? 'expired' : 'unused';
    }
    return {
      id: String(r._id),
      itemKey: r.itemKey,
      name: cat?.name ?? r.itemKey,
      kind,
      status,
      statusText: LIST_STATUS_TEXT[status] ?? status,
      benefitDays: r.benefitDays ?? 0,
      expiresAt: r.expiresAt,
      ...(startAt !== undefined ? { startAt, endAt } : {}),
      ...(r.usedForDate ? { usedForDate: r.usedForDate } : {}),
      source: r.source ?? 'exchange',
      sourceText: SOURCE_TEXT[r.source] ?? r.source ?? '兑换获得',
      createdAt: r.createdAt,
    };
  });

  // 待用的排前面（能操作的在最上），其余按拿到的先后倒序
  const rank = (c: UserCardDto) => (c.status === 'unused' ? 0 : c.status === 'active' ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
}
