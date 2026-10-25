/**
 * 商品与兑换：固定商品、补签卡兑换、兑换记录。
 *
 * 口径（需求 §7/§8）：
 * - 商品只有一张补签卡，价格/有效期全部取自 POINTS 配置，避免服务端与前端各写一份；
 * - 兑换幂等键 `exchange:${userId}:${requestId}`：先查兑换记录短路重放；并发同一 requestId
 *   由账本 idemKey + 兑换记录唯一索引 (userId, requestId) 双重兜底，只扣一次分、只留一张卡；
 * - 扣分走账本 debitPoints（余额闸门），余额不足由账本抛 400，文案带当前值与所需值；
 * - 先扣分再发卡：并发落败方会先发出一张无人认领的卡，必须撤回，否则重放会白得一张卡；
 * - 兑换记录状态实时推导：卡仍是 unused 但已过 expiresAt 时返回 expired，不依赖离线结算任务。
 */
import { POINTS } from '../config/points.js';
import { AppError } from '../utils/app-error.js';
import { bjDateStr } from '../utils/bj-time.js';
import { PointCardModel, PointExchangeModel } from '../models/point.model.js';
import { debitPoints, getBalance } from './points-ledger.js';

export interface ItemDto {
  key: string;
  name: string;
  subtitle: string;
  price: number;
  validDays: number;
  description: string;
}

export type CardStatus = 'unused' | 'used' | 'expired';

export interface ExchangeDto {
  id: string;
  itemKey: string;
  cost: number;
  cardId: string;
  status: CardStatus;
  statusText: string;
  usedForDate: string;
  expiresAt: number;
  createdAt: number;
}

export interface ExchangeResult {
  cardId: string;
  balance: number;
}

const DAY_MS = 86400000;
const ITEM_KEY = 'makeup_card';
const DUPLICATE_KEY = 11000;

const STATUS_TEXT: Record<CardStatus, string> = {
  unused: '未使用',
  used: '已使用',
  expired: '已过期',
};

function isDuplicateKey(e: unknown): boolean {
  return (e as { code?: number } | null)?.code === DUPLICATE_KEY;
}

/** 卡状态：used/expired 以落库为准；unused 但已过有效期按过期展示 */
function cardStatus(card: { status?: string; expiresAt?: number }, now: number): CardStatus {
  if (card.status === 'used') return 'used';
  if (card.status === 'expired') return 'expired';
  return (card.expiresAt ?? 0) <= now ? 'expired' : 'unused';
}

/** 商品列表：固定一张补签卡 */
export function getItems(): ItemDto[] {
  return [{
    key: ITEM_KEY,
    name: '补签卡',
    subtitle: '恢复连续打卡记录',
    price: POINTS.MAKEUP_CARD_PRICE,
    validDays: POINTS.MAKEUP_CARD_VALID_DAYS,
    description: '每张仅可使用一次；仅用于补签昨天；兑换后 30 天内有效',
  }];
}

/**
 * 兑换补签卡。
 * - 同一 (userId, requestId) 视为同一次点击：直接返回原卡与当前余额，不再扣分/发卡；
 * - 每次兑换只发一张卡，有效期 = 兑换时刻 + MAKEUP_CARD_VALID_DAYS 天。
 */
export async function exchangeMakeupCard(
  userId: string,
  requestId: string,
  now = Date.now(),
): Promise<ExchangeResult> {
  const rid = String(requestId ?? '').trim();
  if (!rid) throw new AppError(400, '缺少兑换请求 ID');

  const exists = await PointExchangeModel.findOne({ userId, requestId: rid }).lean();
  if (exists) return { cardId: String(exists.cardId), balance: await getBalance(userId, now) };

  await debitPoints(userId, {
    type: 'exchange',
    title: '兑换补签卡',
    points: POINTS.MAKEUP_CARD_PRICE,
    bizDate: bjDateStr(now),
    refType: 'item',
    refId: ITEM_KEY,
    // 明细表 idemKey 全局唯一，必须带 userId
    idemKey: `exchange:${userId}:${rid}`,
  }, now);

  const card = await PointCardModel.create({
    userId,
    itemKey: ITEM_KEY,
    status: 'unused',
    expiresAt: now + POINTS.MAKEUP_CARD_VALID_DAYS * DAY_MS,
    createdAt: now,
  });

  let exchange;
  try {
    exchange = await PointExchangeModel.create({
      userId,
      itemKey: ITEM_KEY,
      cost: POINTS.MAKEUP_CARD_PRICE,
      cardId: card._id,
      requestId: rid,
      createdAt: now,
    });
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    // 并发同一 requestId：另一请求已先落兑换记录（账本已按 idemKey 去重，不会重复扣分）。
    // 本次刚发的卡没有记录认领，撤回后返回胜出方那张卡。
    await PointCardModel.deleteOne({ _id: card._id });
    const winner = await PointExchangeModel.findOne({ userId, requestId: rid }).lean();
    if (!winner) throw e;
    return { cardId: String(winner.cardId), balance: await getBalance(userId, now) };
  }

  return { cardId: String(exchange.cardId), balance: await getBalance(userId, now) };
}

/** 兑换记录：按兑换时间倒序，关联卡状态与使用日期 */
export async function listExchanges(userId: string, now = Date.now()): Promise<ExchangeDto[]> {
  const rows = await PointExchangeModel.find({ userId })
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  if (rows.length === 0) return [];

  const cards = await PointCardModel.find({ _id: { $in: rows.map((r) => r.cardId) } })
    .select({ status: 1, expiresAt: 1, usedForDate: 1 })
    .lean();
  const cardById = new Map(cards.map((c) => [String(c._id), c]));

  return rows.map((r) => {
    const card = cardById.get(String(r.cardId));
    // 卡缺失属脏数据：按已过期展示，避免前端出现「未使用」却无法补签
    const status = card ? cardStatus(card, now) : 'expired';
    return {
      id: String(r._id),
      itemKey: r.itemKey,
      cost: r.cost,
      cardId: String(r.cardId),
      status,
      statusText: STATUS_TEXT[status],
      usedForDate: card?.usedForDate ?? '',
      expiresAt: card?.expiresAt ?? 0,
      createdAt: r.createdAt,
    };
  });
}
