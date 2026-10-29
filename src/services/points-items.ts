/**
 * 商品与兑换：道具目录驱动的商品列表、按 itemKey 泛化的兑换、兑换记录。
 *
 * 口径（spec §6.1/§6.2/§7.3）：
 * - 商品来自 PointItem 目录表（后台可增删改档），只下发在架项；老客户端读 items[0]，
 *   makeup_card 靠 sortOrder 排第一保持兼容；
 * - 兑换按目录 `kind` 分流：virtual 发 PointCard、physical 落 PointOrder + 收货地址快照，
 *   两条链互斥（虚拟绝不落订单，实物绝不发卡）；限购对两类都生效（见 points-orders.limitReached）；
 * - 兑换写序固定：读目录 → 限购 → 每日额度 → 库存 → 扣分 → 发卡/落订单 → 落兑换记录。**不变量 A（all-or-nothing）**：
 *   过了每日额度闸门之后的任何失败，余额、totalSpent、批次、库存、额度计数、卡/订单、兑换记录都回到调用前——
 *   发卡/落记录/落订单失败时用 points-ledger.reverseDebit 真正撤销扣分（补偿行成对，不进发放/消耗口径），
 *   并连同 takeDailyQuota 抢到的当日额度一起回补（returnDailyQuota）；
 * - 库存闸门：unlimited 分支既不筛 stock 也不 $inc（写成 $or + 无条件 $inc 会把
 *   不限量道具的库存悄悄扣掉）；非 unlimited 用带 stock>0 条件的原子 findOneAndUpdate 抢库存；
 * - 每日额度闸门（Task 3）：dailyQuota/perUserDaily 走 PointDailyQuota 计数器（行 {key,dateKey,userId}，
 *   userId 空串＝当日总量行），先建基线行再走「不带 upsert 的条件 $inc」，与库存闸门同一原子口径；
 *   dateKey 由调用方 now 派生（不许在闸门里现取 Date.now()）。展示字段 todayLeft 仍读兑换台账（Task 2 数据源）：
 *   台账能数不能原子扣退，强制与展示各走各的源，回补路径两侧一致由 DQ-4/DQ-5 钉住。
 *   超限文案由闸门返回的判别式拦截原因（'total'/'user'）决定，不回读计数器猜分支（DQ-9/DQ-10）；
 *   个人步抛异常时当场退回已抢的总量格（DQ-11），回补失败的格数经 annotateQuotaGap 只写服务端日志与 data（DQ-12，
 *   2026-10-29 起不再对用户可见）；
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
  PointCardModel, PointDailyQuotaModel, PointExchangeModel, PointItemModel,
  PointOrderModel, PointRecordModel, type ItemKind,
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
  /** 每日投放：0 = 不限；>0 = 每个东八区自然日全平台最多兑 N 张，先到先得（闸门＝本文件 takeDailyQuota） */
  dailyQuota: number;
  /** 每人每日上限：0 = 不限；兑换链闸门与 dailyQuota 同走 takeDailyQuota 计数器，展示层不参与扣减 */
  perUserDaily: number;
  /**
   * 今日剩余：dailyQuota = 0（不限）时必须是 null（端上不显示「今日剩余」，0 会被读成「兑完」）；
   * >0 时 = max(0, dailyQuota − 当日已兑条数)。
   * 数据源＝兑换台账（PointRecord 的 type:'exchange' + refType:'item' + refId=itemKey + bizDate=当日东八区），
   * 这是 Task 2 定死的展示口径，Task 3 没有把它改指向计数器（裁定 2）；失败兑换的扣分行会被 reverseDebit
   * 降级成 exchange_reversed，天然不占额度。兑换闸门（takeDailyQuota）另走 PointDailyQuota 计数器——
   * 台账能数不能原子扣退，强制与展示分源，回补后两侧一致由 DQ-4/DQ-5 钉住。
   * 按 item 聚合的是当日全平台已兑数——每人维度是闸门口径，不混进这个展示字段。
   */
  todayLeft: number | null;
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
  // 今日剩余的数据源＝兑换台账（见 ItemDto.todayLeft 注释）：一次分组计数拿全部道具的当日已兑数，
  // 不给每行单独发查询；bizDate 是东八区自然日字符串，与扣分行的写入同一口径（bjDateStr）。
  const today = bjDateStr(Date.now());
  const exchangedAgg = await PointRecordModel.aggregate<{ _id: string; count: number }>([
    { $match: { type: 'exchange', refType: 'item', refId: { $in: rows.map((r) => r.key) }, bizDate: today } },
    { $group: { _id: '$refId', count: { $sum: 1 } } },
  ]);
  const exchangedBy = new Map(exchangedAgg.map((g) => [g._id, Number(g.count)]));
  return rows.map((r) => {
    const dailyQuota = Number(r.dailyQuota ?? 0);
    return {
      key: r.key, name: r.name, subtitle: r.subtitle, price: r.price,
      validDays: r.validDays, description: r.description, notes: r.notes ?? [],
      effect: { kind: r.effect?.kind ?? 'makeup', days: r.effect?.days ?? 0 },
      // 本批次之前入库的目录行物理上没有 kind/detailImages/perUserLimit：按虚拟/无图/不限的
      // 默认口径兜底，别把 undefined 漏给端上（端上会当成实物或者限购 0 张）
      kind: (r.kind ?? 'virtual') as ItemKind,
      // 详情图在商品页整宽渲染（widthFix），w_240 会被拉糊 → 走 medium 档；后台表单的小预览仍是 thumb
      detailImages: (r.detailImages ?? []).map((u: string) => (u ? getMediumUrl(u) : '')),
      perUserLimit: Number(r.perUserLimit ?? 0),
      // 每日投放两字段同 perUserLimit 的惯用法：老行物理缺字段按 0＝不限兜底
      dailyQuota,
      perUserDaily: Number(r.perUserDaily ?? 0),
      // 不限投放下发 null；限量投放扣当日全平台已兑数、封底 0（台账超投也只是脏数据，不出负数）
      todayLeft: dailyQuota > 0 ? Math.max(0, dailyQuota - (exchangedBy.get(r.key) ?? 0)) : null,
      // spec §7.3：unlimited 下发 null（端上显示「不限量」）；限量道具给实际剩余，别把 undefined 漏给端上
      stockLeft: r.unlimited ? null : Number(r.stock ?? 0),
      // 私有桶裸链进 <img> 会 403；hero 与积分页道具卡都是白底，缩略档（jpg）够用
      imageUrl: r.image ? getThumbUrl(r.image) : '',
    };
  });
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

// ==================== 每日投放闸门（Task 3）：dailyQuota / perUserDaily ====================

/**
 * 基线行：$setOnInsert 只建行、永不碰已有计数；并发首建撞 {key,dateKey,userId} 唯一索引时
 * 败者拿 E11000——行已在了，直接吃掉（与 points-ledger.ensureAccount 同款）。
 * 没有那条 unique 这步就不成立：两个并发首次会各插一行基线，条件闸门只守得住其中一份。
 */
async function ensureQuotaRow(key: string, dateKey: string, userId: string): Promise<void> {
  try {
    await PointDailyQuotaModel.updateOne(
      { key, dateKey, userId },
      { $setOnInsert: { count: 0 } },
      { upsert: true },
    );
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
  }
}

/**
 * 原子抢一格（brief Step 3 的两个可选实现里选了「先建基线行、再走不带 upsert 的条件更新」）：
 * $lt 条件 + upsert 会在条件不命中时插一行而不是拒绝（Step 3 的注意项），所以这里绝不带 upsert——
 * 条件 findOneAndUpdate 不命中返回 null 就是「兑完」，与 takeStock 的 { stock: { $gt: 0 } } 同一原子口径，
 * 并发下服务端逐条排队执行条件 $inc，count 不可能越过 cap。
 */
async function bumpQuota(key: string, dateKey: string, userId: string, cap: number): Promise<boolean> {
  const row = await PointDailyQuotaModel.findOneAndUpdate(
    { key, dateKey, userId, count: { $lt: cap } },
    { $inc: { count: 1 } },
    { returnDocument: 'after' },
  ).lean();
  return row !== null;
}

/** 撤销一格：count>0 条件是脏双退的自保（误调两次不能把计数器凿成负数）。
 * 返回是否真退回去——吞自家异常不许盖住原始失败，但缺口要能上报（见 annotateQuotaGap），
 * 只留一行 console.error 就是永久无声少发（修复轮 1 finding 3）。 */
async function undoQuota(key: string, dateKey: string, userId: string): Promise<boolean> {
  try {
    await PointDailyQuotaModel.updateOne(
      { key, dateKey, userId, count: { $gt: 0 } },
      { $inc: { count: -1 } },
    );
    return true;
  } catch (e) {
    console.error('[points] 每日额度回补失败', key, dateKey, userId, e);
    return false;
  }
}

/**
 * 额度回补缺口的运维可见化（与库存链 backStock→refundFailed→rethrowWithRefund 同一口径的镜像）。
 * 2026-10-29 主人定稿：这条尾注**不再对用户可见**——客户端只渲染 e.message，兑换失败本身足够，
 * 「（另：每日额度回补失败 N 格，请人工核对）」是运维话术，用户看了只会困惑。
 * 因此：状态码与主文案逐字不动；缺口只写一条结构化服务端日志（itemKey/userId/dateKey/failedSlots），
 * 并继续挂在 data.quotaRefundFailed 上供后台日志与测试取证（error-handler 会把 extra 放进 data，
 * 端上不读这个字段）。注意 stop 的是额度链这一条；库存链 refundFailed 的尾注是更早的既有行为，保持原样。
 * 无缺口时原样返回 e，调用方（hold.rethrowWithRefund / throw）拿到的是没被改过的错误。
 */
function annotateQuotaGap(
  e: unknown, quotaRefundFailed: number,
  ctx: { itemKey: string; userId: string; dateKey: string },
): unknown {
  if (quotaRefundFailed === 0) return e;
  console.error('[points] 每日额度回补失败（用户不可见，需人工核对）', {
    itemKey: ctx.itemKey,
    userId: ctx.userId,
    dateKey: ctx.dateKey,
    failedSlots: quotaRefundFailed,
    original: e instanceof Error ? { name: e.name, message: e.message } : String(e),
  });
  if (e instanceof AppError) {
    return new AppError(e.statusCode, e.message, { ...(e.extra ?? {}), quotaRefundFailed });
  }
  return e;
}

/** 闸门拦截方（修复轮 1 finding 1）：'total'＝当日全平台投放被抢光，'user'＝只剩每人每日上限被撞到。
 * 文案句子由这一步实际决定，不再回读计数器猜分支——猜分支在并发回补时会把总量文案降级成
 * 个人文案，拼出批准文案明令禁止的「每人每日限 0 张」（DQ-9 钉住）。 */
type QuotaBlockedBy = 'total' | 'user';

/**
 * 抢当日额度：总量行（userId=''）与个人行都要过，任一失败即回滚已抢的那一行（brief 接口）。
 * 返回 true＝抢到（链继续），'total'/'user'＝被哪一步拦下（调用方据此出 400 文案）。
 * 为什么强制口径走计数器而不复用台账（todayLeft 的数据源）：台账只能数、不能原子地「先扣再核、失败退回」，
 * 裁定 2 定死两侧分工——闸门扣计数器，展示读台账，回补路径两侧一致由 DQ-4/DQ-5 钉住。
 * dateKey 一律 bjDateStr(now) 从调用方传入的时刻派生，不在闸门里现取 Date.now()（裁定 3）：
 * 展示路径读挂钟、写链带 now，闸门若也读挂钟就会在 UTC+8 零点前后与写入行错位。
 * 两字段都是 0（未配置限量投放）时整个闸门直通且不落任何计数器行——上线前的目录行行为零变化。
 */
async function takeDailyQuota(item: ItemDoc, userId: string, now: number): Promise<true | QuotaBlockedBy> {
  const dailyQuota = Number(item.dailyQuota ?? 0);
  const perUserDaily = Number(item.perUserDaily ?? 0);
  if (dailyQuota <= 0 && perUserDaily <= 0) return true;
  const dateKey = bjDateStr(now);
  if (dailyQuota > 0) {
    await ensureQuotaRow(item.key, dateKey, '');
    if (!(await bumpQuota(item.key, dateKey, '', dailyQuota))) return 'total';
  }
  if (perUserDaily > 0) {
    try {
      await ensureQuotaRow(item.key, dateKey, userId);
      if (!(await bumpQuota(item.key, dateKey, userId, perUserDaily))) {
        if (dailyQuota > 0) await undoQuota(item.key, dateKey, ''); // 个人满而总量未满：刚抢的总量格让给下一位（DQ-2）
        return 'user';
      }
    } catch (e) {
      // 总量格已抢到手、个人步炸在半路：此刻 exchange 链还没拿到 releaseQuota，谁都退不了这一格——
      // 不在这当场退回就是永久悬空（修复轮 1 finding 2，DQ-11 钉住）。退失败也点名，不吞（finding 3 同一口径），
      // 但点名只进服务端日志与 data，不再拼进用户可见文案（2026-10-29 定稿）。
      if (dailyQuota > 0 && !(await undoQuota(item.key, dateKey, ''))) {
        throw annotateQuotaGap(e, 1, { itemKey: item.key, userId, dateKey });
      }
      throw e;
    }
  }
  return true;
}

/**
 * 兑换链失败补偿的镜像：抢到手之后任何一步没成，把那一格原路退回（与 takeStock 的 hold.rollback 同一职责）。
 * 返回回补失败的格数（0＝干净）——调用方累积后经 annotateQuotaGap 上报（日志 + data，不进用户文案），不许只留日志。
 */
async function returnDailyQuota(item: ItemDoc, userId: string, now: number): Promise<number> {
  const dateKey = bjDateStr(now);
  let failed = 0;
  if (Number(item.dailyQuota ?? 0) > 0 && !(await undoQuota(item.key, dateKey, ''))) failed += 1;
  if (Number(item.perUserDaily ?? 0) > 0 && !(await undoQuota(item.key, dateKey, userId))) failed += 1;
  return failed;
}

/**
 * 超限 400 文案（对象 + 实际值 + 上限 + 刷新时间，全仓文案纪律）——两句都是 spec §4.8 批准原文，逐字不许改写：
 * - 'total'（当日投放被抢光）→ 「「${name}」今日 ${N} 张已兑完（每人每日限 ${M} 张），明日 00:00 刷新」，
 *   N＝配置的当日投放数；perUserDaily=0（不限）时括号整段省略——「每人每日限 0 张」是批准口径明令禁止的；
 * - 'user'（只剩每人每日上限被撞到）→ 「「${name}」今日已兑 ${K} 张（每人每日限 ${M} 张），明日 00:00 刷新」，
 *   K＝该用户当日个人计数（计数器同源，不是平台计数，DQ-10 钉住）。
 * 句子由 takeDailyQuota 的判别式拦截原因决定，不猜分支：个人步只在 perUserDaily>0 时执行，
 * 'user' 分支的 M 恒 >0、括号永不缺席；'total' 分支根本不读计数器，并发回补改不了文案走向（DQ-9 钉住）。
 */
async function dailyQuotaError(
  item: ItemDoc, userId: string, now: number, blockedBy: QuotaBlockedBy,
): Promise<AppError> {
  const dailyQuota = Number(item.dailyQuota ?? 0);
  const perUserDaily = Number(item.perUserDaily ?? 0);
  if (blockedBy === 'total') {
    const perUserNote = perUserDaily > 0 ? `（每人每日限 ${perUserDaily} 张）` : '';
    return new AppError(400, `「${item.name}」今日 ${dailyQuota} 张已兑完${perUserNote}，明日 00:00 刷新`);
  }
  const mine = await PointDailyQuotaModel.findOne(
    { key: item.key, dateKey: bjDateStr(now), userId },
  ).select({ count: 1 }).lean();
  return new AppError(400,
    `「${item.name}」今日已兑 ${Number(mine?.count ?? 0)} 张（每人每日限 ${perUserDaily} 张），明日 00:00 刷新`);
}

/** 虚拟道具：校验卡有效期 → 限购 → 每日额度 → 扣库存 → 扣分 → 发卡 → 落兑换记录（额度抢到手后任何失败回补额度 + 退分 + 回补库存） */
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

  // 闸门顺序固定（裁定 1）：限购 → 每日额度 → 库存 → 扣分（原「兑换满 180 天」已由产品去掉，不许加回）
  const blocked = await takeDailyQuota(item, userId, now);
  // 文案由实际拦下闸门的那一步决定（'total'/'user'），不回读计数器猜分支（finding 1）
  if (blocked !== true) throw await dailyQuotaError(item, userId, now, blocked);
  // 额度抢在库存与扣分之前：此后任何一步失败——库存空、扣分失败、发卡/落记录失败，
  // 乃至同 requestId 重放落败（权益属于胜者那一单）——都要把手里这格原路退回；
  // releaseQuota 幂等，一个请求至多退一次；退不回去的格数累积进 quotaRefundFailed，
  // 由 annotateQuotaGap 在每一个异常出口上报（日志 + data.quotaRefundFailed；finding 3，与库存 refundFailed 同一口径）。
  let quotaHeld = true;
  let quotaRefundFailed = 0;
  const releaseQuota = async (): Promise<void> => {
    if (!quotaHeld) return;
    quotaHeld = false;
    quotaRefundFailed += await returnDailyQuota(item, userId, now);
  };
  // annotateQuotaGap 的运维上下文：缺口日志要能定位「哪个道具、谁、哪一天、几格」
  const quotaCtx = { itemKey: item.key, userId, dateKey: bjDateStr(now) };

  const hold = await takeStock(item);
  if (!hold) {
    await releaseQuota();
    throw annotateQuotaGap(new AppError(400, `「${item.name}」已兑完（当前库存 0）`), quotaRefundFailed, quotaCtx);
  }

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
    await releaseQuota();
    if (!isInsufficientBalance(e)) hold.rethrowWithRefund(annotateQuotaGap(e, quotaRefundFailed, quotaCtx));
    // 余额恰好够一次的连点：A 扣光余额后、兑换记录落库前，B 会先撞余额闸门。
    // 补查在途记录：命中说明是同一笔点击，返回 A 那张卡（不再扣分/发卡）；否则才是真的余额不足。
    const inFlight = await findInFlightExchange(userId, rid);
    if (!inFlight) hold.rethrowWithRefund(annotateQuotaGap(e, quotaRefundFailed, quotaCtx));
    // 短路重放成功也是「本次没产出新兑换」：胜者那一击自带额度格，本请求的这格必须退回
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
    await releaseQuota();
    await undoDebit();
    hold.rethrowWithRefund(annotateQuotaGap(e, quotaRefundFailed, quotaCtx));
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
    // 本 catch 的三个出口（非重复键抛错 / 胜者重放返回 / 找不到胜者抛错）都不是「本次兑换成了」：
    // 重放路径的权益属于胜者那一单，胜者自己占过格，这里占的一格必须退。
    await releaseQuota();
    if (!isDuplicateKey(e)) {
      await undoDebit();
      hold.rethrowWithRefund(annotateQuotaGap(e, quotaRefundFailed, quotaCtx));
    }
    // 并发同一 requestId：另一请求已先落兑换记录（账本已按 idemKey 去重，不会重复扣分），
    // 返回胜出方那张卡。胜者的卡就是这笔扣分的权益，本次无论是否重放都不能退钱。
    const winner = await PointExchangeModel.findOne({ userId, requestId: rid }).lean();
    if (!winner) {
      await undoDebit();
      hold.rethrowWithRefund(annotateQuotaGap(e, quotaRefundFailed, quotaCtx));
    }
    return { cardId: String(winner.cardId), balance: await getBalance(userId, now), refundFailed: hold.refundFailed };
  }
}

/**
 * 实物道具：地址校验 → 限购 → 每日额度 → 扣库存 → 扣分 → 落订单（不发卡）。
 * 地址/限购在库存闸门之前，非法输入不动余额与库存；额度抢到手后的失败连同扣分一起走同一条回滚链回补额度，
 * 与虚拟兑换复用同一套 all-or-nothing 逆序链与同一份 takeDailyQuota/returnDailyQuota 实现。
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

  // 与虚拟链同一套闸门与顺序（裁定 1）：限购 → 每日额度 → 库存 → 扣分；文案同样由拦截步决定（finding 1）
  const blocked = await takeDailyQuota(item, userId, now);
  if (blocked !== true) throw await dailyQuotaError(item, userId, now, blocked);
  // 与虚拟链同一套回补与上报（finding 3）：退不回去的格数累积后经 annotateQuotaGap 走日志与 data
  let quotaHeld = true;
  let quotaRefundFailed = 0;
  const releaseQuota = async (): Promise<void> => {
    if (!quotaHeld) return;
    quotaHeld = false;
    quotaRefundFailed += await returnDailyQuota(item, userId, now);
  };
  // annotateQuotaGap 的运维上下文：缺口日志要能定位「哪个道具、谁、哪一天、几格」
  const quotaCtx = { itemKey: item.key, userId, dateKey: bjDateStr(now) };

  const hold = await takeStock(item);
  if (!hold) {
    await releaseQuota();
    throw annotateQuotaGap(new AppError(400, `「${item.name}」已兑完（当前库存 0）`), quotaRefundFailed, quotaCtx);
  }

  let debit: DebitResult;
  try {
    debit = await debitPoints(userId, {
      type: 'exchange', title: `兑换${item.name}`, points: item.price,
      bizDate: bjDateStr(now), refType: 'item', refId: item.key,
      idemKey: `exchange:${userId}:${rid}`,
    }, now);
  } catch (e) {
    await hold.rollback();
    await releaseQuota();
    if (!isInsufficientBalance(e)) hold.rethrowWithRefund(annotateQuotaGap(e, quotaRefundFailed, quotaCtx));
    // 与虚拟路径同理：余额刚够一次的连点，胜者订单可能还没落库，补查在途订单
    const inFlight = await findInFlightOrder(userId, rid);
    if (!inFlight) hold.rethrowWithRefund(annotateQuotaGap(e, quotaRefundFailed, quotaCtx));
    // 短路重放：订单是胜者那一击落的，额度格也是胜者占的——本次这格退回去
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
    // 与虚拟链同口径：本 catch 的出口（抛错/胜者重放）都不是本次兑换成了，额度格一律退
    await releaseQuota();
    if (!isDuplicateKey(e)) {
      await undoDebit();
      hold.rethrowWithRefund(annotateQuotaGap(e, quotaRefundFailed, quotaCtx));
    }
    // 并发同一 requestId：另一请求已落订单（账本按 idemKey 去重，本次未真实扣分），返回胜出方订单。
    // 胜者订单就是这笔扣分的权益，本次绝不能退钱。
    const winner = await PointOrderModel.findOne({ userId, requestId: rid }).lean();
    if (!winner) {
      await undoDebit();
      hold.rethrowWithRefund(annotateQuotaGap(e, quotaRefundFailed, quotaCtx));
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
