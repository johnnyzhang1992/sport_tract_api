/**
 * 商品与兑换：道具目录驱动的商品列表、按 itemKey 泛化的兑换、兑换记录。
 *
 * 口径（spec §6.1/§6.2/§7.3）：
 * - 商品来自 PointItem 目录表（后台可增删改档），只下发在架项；老客户端读 items[0]，
 *   makeup_card 靠 sortOrder 排第一保持兼容；
 * - 兑换写序固定：读目录 → 扣库存 → 扣分 → 发卡 → 落兑换记录，失败按逆序回滚。
 *   先扣库存后扣分：退分会在账本留下补偿明细，而回补库存只是一次 $inc；
 * - 库存闸门：unlimited 分支既不筛 stock 也不 $inc（写成 $or + 无条件 $inc 会把
 *   不限量道具的库存悄悄扣掉）；非 unlimited 用带 stock>0 条件的原子 findOneAndUpdate 抢库存；
 * - 兑换幂等键 `exchange:${userId}:${requestId}`：先查兑换记录短路重放；并发同一 requestId
 *   由账本 idemKey + 兑换记录唯一索引 (userId, requestId) 双重兜底，只扣一次分、只发一张卡、
 *   只扣一次库存——落败方删卡、退分（其扣分走账本重放实际未落账）、回补库存；
 * - benefitDays 发卡时从目录快照：后台把 7 天改成 10 天不该影响已售出的卡；
 * - 兑换记录状态实时推导：卡仍是 unused 但已过 expiresAt 时返回 expired，不依赖离线结算任务。
 */
import { AppError } from '../utils/app-error.js';
import { bjDateStr } from '../utils/bj-time.js';
import { PointCardModel, PointExchangeModel, PointItemModel } from '../models/point.model.js';
import { debitPoints, getBalance } from './points-ledger.js';
import { getThumbUrl } from './oss.js';
import type { ItemDoc } from './points-catalog.js';

export interface ItemDto {
  key: string;
  name: string;
  subtitle: string;
  price: number;
  validDays: number;
  description: string;
  notes: string[];
  effect: { kind: 'makeup' | 'ad_free'; days: number };
  imageUrl: string;
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
const DUPLICATE_KEY = 11000;

/**
 * 卡状态文案：兑换记录与管理端发放记录共用这一份（Task 5 的 listIssuances 引用它，
 * 别再抄第二张表——两边文案不一致用户在同一个后台里会看到两种说法）。
 */
export const STATUS_TEXT: Record<CardStatus, string> = {
  unused: '未使用',
  used: '已使用',
  expired: '已过期',
};

function isDuplicateKey(e: unknown): boolean {
  return (e as { code?: number } | null)?.code === DUPLICATE_KEY;
}

/** 账本余额闸门失败（文案形如「积分不足（当前 0，需要 200）」） */
function isInsufficientBalance(e: unknown): boolean {
  return e instanceof AppError && e.statusCode === 400 && e.message.startsWith('积分不足');
}

/** 卡状态：used/expired 以落库为准；unused 但已过有效期按过期展示（管理端发放记录同样引用，不另写一份） */
export function cardStatus(card: { status?: string; expiresAt?: number }, now: number): CardStatus {
  if (card.status === 'used') return 'used';
  if (card.status === 'expired') return 'expired';
  return (card.expiresAt ?? 0) <= now ? 'expired' : 'unused';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 补查在途兑换记录：连点重放的败者可能比胜者「扣分→发卡→落记录」的尾巴早到，
 * 单次查询会误判成真余额不足。有界轮询（上限 ~200ms）：胜者记录终会落下即短路成功；
 * 轮询耗尽仍没有才按真失败抛（PC-5「重放一律短路成功」钉这条）。
 */
async function findInFlightExchange(userId: string, rid: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const row = await PointExchangeModel.findOne({ userId, requestId: rid }).lean();
    if (row) return row;
    await sleep(10);
  }
  return null;
}

/** 用户端商品列表：只下发在架道具，按 sortOrder 升序（老客户端读 items[0]，故 makeup_card 必须排第一） */
export async function listActiveItems(): Promise<ItemDto[]> {
  const rows = await PointItemModel.find({ active: true }).sort({ sortOrder: 1, _id: 1 }).lean();
  return rows.map((r) => ({
    key: r.key, name: r.name, subtitle: r.subtitle, price: r.price,
    validDays: r.validDays, description: r.description, notes: r.notes ?? [],
    effect: { kind: r.effect?.kind ?? 'makeup', days: r.effect?.days ?? 0 },
    // 私有桶裸链进 <img> 会 403；一期端上还不画图，先只给缩略档签名链
    imageUrl: r.image ? getThumbUrl(r.image) : '',
  }));
}

/**
 * 兑换道具（/items/:itemKey/exchange 的服务端；makeup_card 也是它的一个实例）。
 * - 同一 (userId, requestId) 视为同一次点击：直接返回原卡与当前余额，不再扣分/发卡/扣库存；
 * - 写序：读目录 → 扣库存 → 扣分 → 发卡 → 落兑换记录；扣分/发卡/落记录失败按逆序回滚。
 */
export async function exchangeItem(
  userId: string, itemKey: string, requestId: string, now = Date.now(),
): Promise<ExchangeResult> {
  const rid = String(requestId ?? '').trim();
  if (!rid) throw new AppError(400, '缺少兑换请求 ID');

  const exists = await PointExchangeModel.findOne({ userId, requestId: rid }).lean();
  if (exists) return { cardId: String(exists.cardId), balance: await getBalance(userId, now) };

  const item = await PointItemModel.findOne({ key: String(itemKey ?? '').trim() }).lean() as ItemDoc | null;
  if (!item) throw new AppError(404, `道具不存在：${itemKey}`);
  if (!item.active) throw new AppError(400, `「${item.name}」已下架`);

  // 闸门 1：库存。unlimited 分支既不筛 stock 也不 $inc —— 写成 $or + 无条件 $inc 会把不限量道具的库存悄悄扣掉
  const gate = item.unlimited ? { _id: item._id } : { _id: item._id, stock: { $gt: 0 } };
  // $set:{} 是无操作原子更新（裸 {} 会被驱动当成替换文档）；unlimited 只过闸门不落写
  const write = item.unlimited ? { $set: {} } : { $inc: { stock: -1 } };
  const taken = await PointItemModel.findOneAndUpdate(gate, write, { returnDocument: 'after' }).lean();
  if (!taken) throw new AppError(400, `「${item.name}」已兑完（当前库存 0）`);
  const backStock = async () => {
    if (item.unlimited) return;
    await PointItemModel.updateOne({ _id: item._id }, { $inc: { stock: 1 } })
      .catch((e) => console.error('[points] 库存回补失败', item.key, e));
  };

  try {
    // 闸门 2：余额（沿用账本，失败文案已带当前值与所需值）
    await debitPoints(userId, {
      type: 'exchange', title: `兑换${item.name}`, points: item.price,
      bizDate: bjDateStr(now), refType: 'item', refId: item.key,
      // 明细表 idemKey 全局唯一，必须带 userId
      idemKey: `exchange:${userId}:${rid}`,
    }, now);
  } catch (e) {
    await backStock();
    if (!isInsufficientBalance(e)) throw e;
    // 余额恰好够一次的连点：A 扣光余额后、兑换记录落库前，B 会先撞余额闸门。
    // 补查在途记录：命中说明是同一笔点击，返回 A 那张卡（不再扣分/发卡）；否则才是真的余额不足。
    const inFlight = await findInFlightExchange(userId, rid);
    if (!inFlight) throw e;
    return { cardId: String(inFlight.cardId), balance: await getBalance(userId, now) };
  }

  const card = await PointCardModel.create({
    userId,
    itemKey: item.key,
    status: 'unused',
    source: 'exchange',
    // 发卡时固化权益天数：后台把 7 天改成 10 天不该影响已售出的卡
    benefitDays: item.effect?.kind === 'ad_free' ? item.effect.days : 0,
    expiresAt: now + item.validDays * DAY_MS,
    createdAt: now,
  }).catch(async (e: unknown) => { await backStock(); throw e; });

  try {
    const exchange = await PointExchangeModel.create({
      userId, itemKey: item.key, cost: item.price, cardId: card._id, requestId: rid, createdAt: now,
    });
    return { cardId: String(exchange.cardId), balance: await getBalance(userId, now) };
  } catch (e) {
    // 兑换记录没落下（含并发 E11000 落败）：本次刚发的卡无人认领，一律撤回并回补库存，
    // 否则重试等于一次点击消耗两张库存/两张卡。
    await PointCardModel.deleteOne({ _id: card._id });
    await backStock();
    if (!isDuplicateKey(e)) throw e;
    // 并发同一 requestId：另一请求已先落兑换记录（账本已按 idemKey 去重，不会重复扣分），
    // 返回胜出方那张卡。
    const winner = await PointExchangeModel.findOne({ userId, requestId: rid }).lean();
    if (!winner) throw e;
    return { cardId: String(winner.cardId), balance: await getBalance(userId, now) };
  }
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
