/**
 * 商品与兑换：道具目录驱动的商品列表、按 itemKey 泛化的兑换、兑换记录。
 *
 * 口径（spec §6.1/§6.2/§7.3）：
 * - 商品来自 PointItem 目录表（后台可增删改档），只下发在架项；老客户端读 items[0]，
 *   makeup_card 靠 sortOrder 排第一保持兼容；
 * - 兑换按目录 `kind` 分流：virtual 发 PointCard、physical 落 PointOrder + 收货地址快照，
 *   两条链互斥（虚拟绝不落订单，实物绝不发卡）；限购对两类都生效（见 points-orders.limitReached）；
 * - 兑换写序固定：读目录 → 扣库存 → 扣分 → 发卡/落订单 → 落兑换记录。**不变量 A（all-or-nothing）**：
 *   过了库存闸门之后的任何失败，余额、totalSpent、批次、库存、卡/订单、兑换记录都回到调用前——
 *   发卡/落记录/落订单失败时用 points-ledger.reverseDebit 真正撤销扣分（补偿行成对，不进发放/消耗口径）；
 * - 库存闸门：unlimited 分支既不筛 stock 也不 $inc（写成 $or + 无条件 $inc 会把
 *   不限量道具的库存悄悄扣掉）；非 unlimited 用带 stock>0 条件的原子 findOneAndUpdate 抢库存；
 * - 兑换幂等键 `exchange:${userId}:${requestId}`：先查兑换记录短路重放；并发同一 requestId
 *   由账本 idemKey + 兑换记录唯一索引 (userId, requestId) 双重兜底，只扣一次分、只发一张卡、
 *   只扣一次库存——落败方删卡、回补库存，但绝不动那笔真实扣分（它的权益是胜出方的卡）；
 * - 短路重放要确认卡还在：记录指向已删除的卡时丢掉脏记录重跑，账本重放不二次扣分、补发新卡；
 * - benefitDays 发卡时从目录快照：后台把 7 天改成 10 天不该影响已售出的卡；
 * - 兑换记录状态实时推导：卡仍是 unused 但已过 expiresAt 时返回 expired，不依赖离线结算任务。
 */
import { AppError } from '../utils/app-error.js';
import { bjDateStr } from '../utils/bj-time.js';
import {
  PointCardModel, PointExchangeModel, PointItemModel, PointOrderModel, type ItemKind,
} from '../models/point.model.js';
import { debitPoints, getBalance, reverseDebit, type DebitResult } from './points-ledger.js';
import { limitError, limitReached, validateAddress } from './points-orders.js';
import { getMediumUrl, getThumbUrl } from './oss.js';
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
  kind: ItemKind;
  /** 实物详情图：逐张签发缩略档链（与 imageUrl 同口径），虚拟道具恒为空数组 */
  detailImages: string[];
  /** 0 = 不限购；实物默认 1 */
  perUserLimit: number;
  /** 剩余库存（spec §7.3）：unlimited 为 null（端上显示「不限量」），限量道具给实际剩余数 */
  stockLeft: number | null;
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
  /** 虚拟兑换的卡 id；实物兑换没有卡，恒为 undefined */
  cardId?: string;
  /** 实物兑换的订单 id；虚拟兑换恒为 undefined */
  orderId?: string;
  balance: number;
  /**
   * 回滚时库存没能原路退回的张数。>0 表示账实有缺口（卡/分/订单已撤回，但库存少了一张），
   * 调用方必须能看到并人工核对——不再像以前那样只 `.catch(console.error)` 打一行日志。
   */
  refundFailed: number;
}

const DAY_MS = 86400000;
const DUPLICATE_KEY = 11000;

/** 错误文案里回显收到的值：空值写成「空」，对象给 JSON，别把 undefined 直接拼进句子（同 points-grant） */
function shown(value: unknown): string {
  if (value === undefined || value === null || value === '') return '空';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

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
    // 本批次之前入库的目录行物理上没有 kind/detailImages/perUserLimit：按虚拟/无图/不限的
    // 默认口径兜底，别把 undefined 漏给端上（端上会当成实物或者限购 0 张）
    kind: (r.kind ?? 'virtual') as ItemKind,
    // 详情图在商品页整宽渲染（widthFix），w_240 会被拉糊 → 走 medium 档；后台表单的小预览仍是 thumb
    detailImages: (r.detailImages ?? []).map((u: string) => (u ? getMediumUrl(u) : '')),
    perUserLimit: Number(r.perUserLimit ?? 0),
    // spec §7.3：unlimited 下发 null（端上显示「不限量」）；限量道具给实际剩余，别把 undefined 漏给端上
    stockLeft: r.unlimited ? null : Number(r.stock ?? 0),
    // 私有桶裸链进 <img> 会 403；hero 与积分页道具卡都是白底，缩略档（jpg）够用
    imageUrl: r.image ? getThumbUrl(r.image) : '',
  }));
}

/**
 * 兑换道具（/items/:itemKey/exchange 的服务端；makeup_card 也是它的一个实例）。
 * - 同一 (userId, requestId) 视为同一次点击：直接返回原卡/原订单与当前余额，不再扣分/扣库存；
 * - 虚拟道具：读目录 → 扣库存 → 扣分 → 发卡 → 落兑换记录；扣分之后的失败用 reverseDebit 撤销扣分。
 * - 实物道具：读目录 → 校验地址/限购 → 扣库存 → 扣分 → 落订单（不发卡）；失败走同一条回滚链。
 */
export async function exchangeItem(
  userId: string, itemKey: string, requestId: string, now = Date.now(), address?: unknown,
): Promise<ExchangeResult> {
  const rid = String(requestId ?? '').trim();
  if (!rid) throw new AppError(400, '缺少兑换请求 ID');

  const exists = await PointExchangeModel.findOne({ userId, requestId: rid }).lean();
  if (exists) {
    // M2：兑换记录存在不等于卡还在（脏数据/旧版本回滚删过卡）。卡缺失时丢掉这条记录重跑：
    // 账本同 idemKey 会重放、不会二次扣分，随后补发一张真实存在的卡；绝不再返回死 id。
    const card = await PointCardModel.findById(exists.cardId).select({ _id: 1 }).lean();
    if (card) {
      return { cardId: String(exists.cardId), balance: await getBalance(userId, now), refundFailed: 0 };
    }
    await PointExchangeModel.deleteOne({ _id: exists._id });
  }

  const item = await PointItemModel.findOne({ key: String(itemKey ?? '').trim() }).lean() as ItemDoc | null;
  if (!item) throw new AppError(404, `道具不存在：${itemKey}`);
  if (!item.active) throw new AppError(400, `「${item.name}」已下架`);

  // 实物与虚拟是两条互斥的落库链（实物绝不落 PointCard，虚拟绝不落 PointOrder）
  if (item.kind === 'physical') return exchangePhysical(userId, item, rid, now, address);
  return exchangeVirtual(userId, item, rid, now);
}

/** 库存持有：抢到的那一张 + 回补/回滚/缺口上报。虚拟与实物共用同一份（all-or-nothing 的唯一实现） */
interface StockHold {
  readonly refundFailed: number;
  rollback(): Promise<void>;
  rethrowWithRefund(e: unknown): never;
}

/**
 * 库存闸门（虚拟/实物共用）：unlimited 只过闸门不落写；限量用带 stock>0 条件的原子 findOneAndUpdate。
 * 返回 null 表示库存已空（调用方按「已兑完」回 400，此时未扣分也未落单）。
 */
async function takeStock(item: ItemDoc): Promise<StockHold | null> {
  // unlimited 分支既不筛 stock 也不 $inc —— 写成 $or + 无条件 $inc 会把不限量道具的库存悄悄扣掉
  const gate = item.unlimited ? { _id: item._id } : { _id: item._id, stock: { $gt: 0 } };
  // $set:{} 是无操作原子更新（裸 {} 会被驱动当成替换文档）；unlimited 只过闸门不落写
  const write = item.unlimited ? { $set: {} } : { $inc: { stock: -1 } };
  const taken = await PointItemModel.findOneAndUpdate(gate, write, { returnDocument: 'after' }).lean();
  if (!taken) return null;

  let refundFailed = 0;
  // 回补成功与否要返回值：以前 `.catch(console.error)` 把库存缺口吞成一行日志，
  // 账实不符（卡/订单撤了、库存没退）没有任何调用方能看见（与 points-grant 的 refundFailed 同一口径）。
  const backStock = async (): Promise<boolean> => {
    if (item.unlimited) return true;
    try {
      const res = await PointItemModel.updateOne({ _id: item._id }, { $inc: { stock: 1 } });
      // matchedCount=0：目录行并发消失，这一张也没退回去，同样算缺口
      return (res?.matchedCount ?? 0) > 0;
    } catch (e) {
      console.error('[points] 库存回补失败', item.key, e);
      return false;
    }
  };
  /**
   * 回滚有缺口时再抛：保留原状态码与主文案（前端可能按「积分不足」引导去赚分），
   * 把缺口同时写进 message 尾注与 data.refundFailed，异常路径也不许静默。
   */
  const rethrowWithRefund = (e: unknown): never => {
    if (refundFailed === 0) throw e;
    const note = `（另：库存回补失败 ${refundFailed} 张，请人工核对）`;
    if (e instanceof AppError) {
      throw new AppError(e.statusCode, `${e.message}${note}`, { ...(e.extra ?? {}), refundFailed });
    }
    const err = e as Error;
    if (err && typeof err.message === 'string') err.message = `${err.message}${note}`;
    throw err;
  };
  return {
    get refundFailed() { return refundFailed; },
    rollback: async () => {
      if (!(await backStock())) refundFailed += 1;
    },
    rethrowWithRefund,
  };
}

/** 虚拟道具：校验卡有效期 → 限购 → 扣库存 → 扣分 → 发卡 → 落兑换记录（扣分后失败退分 + 回补库存） */
async function exchangeVirtual(
  userId: string, item: ItemDoc, rid: string, now: number,
): Promise<ExchangeResult> {
  // 有效期先归一：存量目录行可能没有 validDays / 被写脏，`undefined * DAY_MS` 会发出 expiresAt=NaN 的卡。
  // 校验必须在库存闸门之前——不然坏目录行会先扣库存再报错（与 points-grant 的发卡校验同一口径）。
  const validDays = Number(item.validDays);
  if (!Number.isFinite(validDays) || validDays <= 0) {
    throw new AppError(400, `「${item.name}」的卡有效期不合法（validDays=${shown(item.validDays)}，应为正数）`);
  }
  // 权益天数同样归一：effect.days 被写脏成 NaN 时，Mongoose 会在发卡那一步抛 ValidationError（500），
  // 且扣分已经发生。校验同样排在库存闸门之前。
  const benefitDays = item.effect?.kind === 'ad_free' ? Number(item.effect.days) : 0;
  if (!Number.isFinite(benefitDays) || benefitDays < 0) {
    throw new AppError(400,
      `「${item.name}」的权益天数不合法（effect.days=${shown(item.effect?.days)}，应为非负数）`);
  }
  // 限购先于库存闸门：超限不能扣库存，也不能留下任何待回滚状态
  if (await limitReached(userId, item, now)) throw await limitError(userId, item);

  const hold = await takeStock(item);
  if (!hold) throw new AppError(400, `「${item.name}」已兑完（当前库存 0）`);

  let debit: DebitResult;
  try {
    // 闸门 2：余额（沿用账本，失败文案已带当前值与所需值）
    debit = await debitPoints(userId, {
      type: 'exchange', title: `兑换${item.name}`, points: item.price,
      bizDate: bjDateStr(now), refType: 'item', refId: item.key,
      // 明细表 idemKey 全局唯一，必须带 userId
      idemKey: `exchange:${userId}:${rid}`,
    }, now);
  } catch (e) {
    await hold.rollback();
    if (!isInsufficientBalance(e)) hold.rethrowWithRefund(e);
    // 余额恰好够一次的连点：A 扣光余额后、兑换记录落库前，B 会先撞余额闸门。
    // 补查在途记录：命中说明是同一笔点击，返回 A 那张卡（不再扣分/发卡）；否则才是真的余额不足。
    const inFlight = await findInFlightExchange(userId, rid);
    if (!inFlight) hold.rethrowWithRefund(e);
    return { cardId: String(inFlight.cardId), balance: await getBalance(userId, now), refundFailed: hold.refundFailed };
  }

  /**
   * 补偿这次真实扣分（账本重放不算）：余额/totalSpent/批次一起回滚，并留下 ±撤销对。
   * 重放（duplicated）绝不退钱——那笔钱属于另一个请求已经发出的卡/订单。
   */
  const undoDebit = async () => {
    if (!debit.duplicated) await reverseDebit(userId, debit, bjDateStr(now), now);
  };

  let card;
  try {
    card = await PointCardModel.create({
      userId,
      itemKey: item.key,
      status: 'unused',
      source: 'exchange',
      // 发卡时固化权益天数：后台把 7 天改成 10 天不该影响已售出的卡
      benefitDays,
      expiresAt: now + validDays * DAY_MS,
      createdAt: now,
    });
  } catch (e) {
    // M1：扣分已经落账，发卡失败必须把这次扣分真正撤销，否则用户被扣分却没有卡。
    await hold.rollback();
    await undoDebit();
    hold.rethrowWithRefund(e);
  }

  try {
    const exchange = await PointExchangeModel.create({
      userId, itemKey: item.key, cost: item.price, cardId: card._id, requestId: rid, createdAt: now,
    });
    // 余额直接用 debitPoints 的 balanceAfter：不再在成功路径多调一次 getBalance（它会写库结算）。
    return { cardId: String(exchange.cardId), balance: debit.balance, refundFailed: hold.refundFailed };
  } catch (e) {
    // 兑换记录没落下（含并发 E11000 落败）：本次刚发的卡无人认领，一律撤回并回补库存。
    // S4：删卡失败不能阻断库存回补与胜者查询——只记日志，后面照常退库存/找 winner。
    try {
      await PointCardModel.deleteOne({ _id: card._id });
    } catch (delErr) {
      console.error('[points] 撤回兑换卡失败', item.key, String(card._id), delErr);
    }
    await hold.rollback();
    if (!isDuplicateKey(e)) {
      await undoDebit();
      hold.rethrowWithRefund(e);
    }
    // 并发同一 requestId：另一请求已先落兑换记录（账本已按 idemKey 去重，不会重复扣分），
    // 返回胜出方那张卡。胜者的卡就是这笔扣分的权益，本次无论是否重放都不能退钱。
    const winner = await PointExchangeModel.findOne({ userId, requestId: rid }).lean();
    if (!winner) {
      await undoDebit();
      hold.rethrowWithRefund(e);
    }
    return { cardId: String(winner.cardId), balance: await getBalance(userId, now), refundFailed: hold.refundFailed };
  }
}

/**
 * 实物道具：地址校验 → 限购 → 扣库存 → 扣分 → 落订单（不发卡）。
 * 地址/限购在库存闸门之前，非法输入不动余额与库存；扣分之后的失败用 reverseDebit 撤销并回补库存，
 * 与虚拟兑换复用同一套 all-or-nothing 逆序链。
 */
async function exchangePhysical(
  userId: string, item: ItemDoc, rid: string, now: number, addressInput: unknown,
): Promise<ExchangeResult> {
  // 幂等短路要排在校验之前：重试的地址可能已被客户端清空，但订单已经存在，直接返回原订单
  const existing = await PointOrderModel.findOne({ userId, requestId: rid }).lean();
  if (existing) {
    return { orderId: String(existing._id), balance: await getBalance(userId, now), refundFailed: 0 };
  }

  const address = validateAddress(addressInput);
  if (await limitReached(userId, item, now)) throw await limitError(userId, item);

  const hold = await takeStock(item);
  if (!hold) throw new AppError(400, `「${item.name}」已兑完（当前库存 0）`);

  let debit: DebitResult;
  try {
    debit = await debitPoints(userId, {
      type: 'exchange', title: `兑换${item.name}`, points: item.price,
      bizDate: bjDateStr(now), refType: 'item', refId: item.key,
      idemKey: `exchange:${userId}:${rid}`,
    }, now);
  } catch (e) {
    await hold.rollback();
    if (!isInsufficientBalance(e)) hold.rethrowWithRefund(e);
    // 与虚拟路径同理：余额刚够一次的连点，胜者订单可能还没落库，补查在途订单
    const inFlight = await findInFlightOrder(userId, rid);
    if (!inFlight) hold.rethrowWithRefund(e);
    return { orderId: String(inFlight._id), balance: await getBalance(userId, now), refundFailed: hold.refundFailed };
  }

  const undoDebit = async () => {
    if (!debit.duplicated) await reverseDebit(userId, debit, bjDateStr(now), now);
  };

  try {
    const order = await PointOrderModel.create({
      userId,
      itemKey: item.key,
      // 下单快照：之后后台改名/改价都不追认到已落订单
      itemName: item.name,
      cost: item.price,
      address,
      status: 'pending_ship',
      requestId: rid,
      createdAt: now,
      updatedAt: now,
    });
    // 余额直接用 debitPoints 的 balanceAfter，与虚拟路径同一口径
    return { orderId: String(order._id), balance: debit.balance, refundFailed: hold.refundFailed };
  } catch (e) {
    await hold.rollback();
    if (!isDuplicateKey(e)) {
      await undoDebit();
      hold.rethrowWithRefund(e);
    }
    // 并发同一 requestId：另一请求已落订单（账本按 idemKey 去重，本次未真实扣分），返回胜出方订单。
    // 胜者订单就是这笔扣分的权益，本次绝不能退钱。
    const winner = await PointOrderModel.findOne({ userId, requestId: rid }).lean();
    if (!winner) {
      await undoDebit();
      hold.rethrowWithRefund(e);
    }
    return { orderId: String(winner._id), balance: await getBalance(userId, now), refundFailed: hold.refundFailed };
  }
}

/** 补查在途实物订单（同 findInFlightExchange：连点败者可能比胜者落库早到） */
async function findInFlightOrder(userId: string, rid: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const row = await PointOrderModel.findOne({ userId, requestId: rid }).lean();
    if (row) return row;
    await sleep(10);
  }
  return null;
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
