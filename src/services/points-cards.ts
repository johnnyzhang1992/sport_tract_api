/**
 * 道具卡的激活与权益推导。
 * adFreeUntil 不落字段：激活是唯一写路径、卡行数极小，存一份只会多出一个能和卡脱钩的真相（spec §5.4）。
 */
import { Types } from 'mongoose';
import { PointCardModel } from '../models/point.model.js';
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
