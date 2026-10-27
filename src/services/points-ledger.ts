/**
 * 积分账本：发放、扣减、批次 FIFO、过期结算与明细。
 *
 * 不变量（需求 §6.2）：
 * - 余额 = 未过期批次 remaining 之和；任何扣减都不允许把余额扣成负数；
 * - Σ(明细.delta，含 expire) = 账户余额，balanceAfter 逐条连续；
 * - 同一 idemKey 只落一条明细，重放返回 duplicated（发放）或原明细（扣减）。
 *
 * 并发口径：账户增减走 findOneAndUpdate 的原子 $inc（读到的 pre-image 即 balanceAfter 的依据），
 * 明细失败时回滚这次 $inc；明细的唯一键兜底同 idemKey 并发双写。
 */
import { POINTS } from '../config/points.js';
import { expireAtFor } from '../utils/points-domain.js';
import { bjDateStr } from '../utils/bj-time.js';
import { AppError } from '../utils/app-error.js';
import { PointAccountModel, PointDailyModel, PointLotModel, PointRecordModel } from '../models/point.model.js';

export interface CreditInput {
  type: string;
  title: string;
  points: number;
  bizDate: string;
  refType?: string;
  refId?: string;
  idemKey: string;
}

export interface DebitInput {
  type: string;
  title: string;
  points: number;
  bizDate: string;
  refType?: string;
  refId?: string;
  idemKey: string;
}

export interface CreditResult {
  credited: number;
  balance: number;
  duplicated: boolean;
  capped: boolean;
}

export interface DebitResult {
  balance: number;
  recordId: string;
  /** 本次调用是否只是账本重放（true = 没有真正扣分，补偿时绝不能退这笔钱） */
  duplicated: boolean;
  /** 本次实际扣到的批次数（含金额），补偿时按此原路还回批次 */
  points: number;
  lotUses: { lotId: string; use: number }[];
}

export interface PointRecordDto {
  id: string;
  type: string;
  title: string;
  delta: number;
  balanceAfter: number;
  bizDate: string;
  refType: string;
  refId: string;
  createdAt: number;
}

const DUPLICATE_KEY = 11000;

function isDuplicateKey(e: unknown): boolean {
  return (e as { code?: number } | null)?.code === DUPLICATE_KEY;
}

/** 账户不存在时补一行零余额账户；并发 upsert 撞唯一键时退化为读取 */
async function ensureAccount(userId: string) {
  try {
    return await PointAccountModel.findOneAndUpdate(
      { userId },
      { $setOnInsert: { balance: 0, totalEarned: 0, totalSpent: 0 } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    return PointAccountModel.findOne({ userId }).lean();
  }
}

/**
 * 当日已入账计数器（原子 $inc 预占）：替代旧的「聚合读 → 算剩余」check-then-act——
 * 那个口径在并发窗口里会让同日不同类型的发放各自读到旧值、合计突破 DAILY_CAP。
 * 预占后若超限/最终没入账，由调用方退回差额（见 creditPoints）。
 */
async function bumpDailyEarned(userId: string, bizDate: string, amount: number): Promise<number> {
  try {
    const row = await PointDailyModel.findOneAndUpdate(
      { userId, bizDate },
      { $inc: { earned: amount } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
    return row?.earned ?? amount;
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    // 并发首笔 upsert 撞唯一键：退化为普通自增重试一次
    const again = await PointDailyModel.findOneAndUpdate(
      { userId, bizDate },
      { $inc: { earned: amount } },
      { returnDocument: 'after' },
    ).lean();
    return again?.earned ?? amount;
  }
}

function refundDailyEarned(userId: string, bizDate: string, amount: number): Promise<void> {
  if (amount <= 0) return Promise.resolve();
  return PointDailyModel.updateOne({ userId, bizDate }, { $inc: { earned: -amount } }).then(() => undefined);
}

/**
 * 结算该用户所有已过期批次：认领批次 → 带余额闸门扣减余额 → 写一条 expire 明细。
 * - 批次用带 remaining>0 条件的原子更新「认领」，并发重复调用只会有一个执行扣减；
 * - 余额扣减带 `balance >= expiring` 条件（且 expiring = min(批次剩余, 当前余额)），
 *   并发扣减把余额花光时不会把账户扣成负数；条件不匹配则把批次剩余还回去，下次再结算；
 * - 若批次剩余大于余额（历史脏数据 / 并发窗口留下的孤儿批次），按余额封顶结算，
 *   差额直接核销（批次清零、不写负数明细），避免余额被扣成负数。
 */
export async function settleExpired(userId: string, now = Date.now()): Promise<void> {
  const lots = await PointLotModel.find({ userId, remaining: { $gt: 0 }, expireAt: { $lte: now } })
    .sort({ expireAt: 1, _id: 1 })
    .select({ _id: 1, remaining: 1 })
    .lean();
  if (lots.length === 0) return;

  await ensureAccount(userId);
  for (const lot of lots) {
    const claimed = await PointLotModel.findOneAndUpdate(
      { _id: lot._id, remaining: { $gt: 0 } },
      { $set: { remaining: 0 } },
      { returnDocument: 'before' },
    ).lean();
    if (!claimed || claimed.remaining <= 0) continue;

    const account = await PointAccountModel.findOne({ userId }).select({ balance: 1 }).lean();
    const available = account?.balance ?? 0;
    if (available <= 0) continue; // 余额已被并发扣减花光：批次没有可扣的余额，清零核销即可

    const expiring = Math.min(claimed.remaining, available);
    const after = await PointAccountModel.findOneAndUpdate(
      { userId, balance: { $gte: expiring } },
      { $inc: { balance: -expiring } },
      { returnDocument: 'after' },
    ).lean();
    if (!after) {
      // 条件不匹配（余额刚被并发扣减花掉）：批次剩余还回去，留给下一次结算
      await PointLotModel.updateOne({ _id: lot._id }, { $inc: { remaining: claimed.remaining } });
      continue;
    }

    try {
      await PointRecordModel.create({
        userId,
        type: 'expire',
        title: '积分过期',
        delta: -expiring,
        balanceAfter: after.balance,
        bizDate: bjDateStr(now),
        refType: 'lot',
        refId: String(lot._id),
        idemKey: `expire:${lot._id}`,
        createdAt: now,
      });
    } catch (e) {
      // 撤回本次扣减；重复键说明这条批次之前已结算过（明细已存在），回滚后跳过
      await PointAccountModel.updateOne({ userId }, { $inc: { balance: expiring } });
      if (isDuplicateKey(e)) continue;
      // 明细写失败：把批次剩余还回去，避免「批次清零但余额没扣」的丢分
      await PointLotModel.updateOne({ _id: lot._id }, { $inc: { remaining: claimed.remaining } });
      throw e;
    }
  }
}

/** 发放积分：idemKey 幂等 + 每日上限（按 bizDate 汇总正数明细）+ 生成批次 */
export async function creditPoints(userId: string, input: CreditInput, now = Date.now()): Promise<CreditResult> {
  await settleExpired(userId, now);

  const dup = await PointRecordModel.findOne({ idemKey: input.idemKey }).lean();
  if (dup) return { credited: 0, balance: await getBalance(userId, now), duplicated: true, capped: false };

  const requested = Math.trunc(input.points);
  if (!Number.isFinite(requested) || requested <= 0) throw new AppError(400, '积分数必须为正整数');

  // 每日上限：先原子预占请求数，再按超限差额退回——并发窗口内合计仍 ≤ DAILY_CAP
  const provisional = await bumpDailyEarned(userId, input.bizDate, requested);
  const over = Math.max(0, provisional - POINTS.DAILY_CAP);
  const credited = requested - over;
  if (credited <= 0) {
    await refundDailyEarned(userId, input.bizDate, requested);
    return { credited: 0, balance: await getBalance(userId, now), duplicated: false, capped: true };
  }
  if (over > 0) await refundDailyEarned(userId, input.bizDate, over);

  // 先确保账户存在：否则新用户的首笔并发发放会在 upsert 阶段撞唯一键（E11000）冒到调用方
  await ensureAccount(userId);
  // 再原子加余额，拿到 pre-image 作为 balanceAfter；明细写失败再回滚
  const before = await PointAccountModel.findOneAndUpdate(
    { userId },
    { $inc: { balance: credited, totalEarned: credited } },
    { returnDocument: 'before' },
  ).lean();
  const balanceAfter = (before?.balance ?? 0) + credited;

  const expireAt = expireAtFor(now);
  let record;
  try {
    record = await PointRecordModel.create({
      userId,
      type: input.type,
      title: input.title,
      delta: credited,
      balanceAfter,
      bizDate: input.bizDate,
      refType: input.refType ?? '',
      refId: input.refId ?? '',
      idemKey: input.idemKey,
      expireAt,
      createdAt: now,
    });
  } catch (e) {
    await PointAccountModel.updateOne({ userId }, { $inc: { balance: -credited, totalEarned: -credited } });
    await refundDailyEarned(userId, input.bizDate, credited);
    // 并发同 idemKey：另一个请求已入账，本次按重复处理
    if (isDuplicateKey(e)) return { credited: 0, balance: await getBalance(userId, now), duplicated: true, capped: false };
    throw e;
  }

  try {
    await PointLotModel.create({
      userId,
      recordId: record._id,
      earned: credited,
      remaining: credited,
      earnedAt: now,
      expireAt,
    });
  } catch (e) {
    // 批次写失败：撤销本次发放，避免余额没有对应批次（永不过期/无法 FIFO 扣减）
    await PointAccountModel.updateOne({ userId }, { $inc: { balance: -credited, totalEarned: -credited } });
    await refundDailyEarned(userId, input.bizDate, credited);
    await PointRecordModel.deleteOne({ _id: record._id });
    throw e;
  }

  return { credited, balance: balanceAfter, duplicated: false, capped: credited < requested };
}

/** 扣减积分：余额闸门（原子条件更新，禁止负余额）+ 明细 + 批次 FIFO 扣减 */
export async function debitPoints(userId: string, input: DebitInput, now = Date.now()): Promise<DebitResult> {
  await settleExpired(userId, now);

  // 只看「扣减」明细：同一个 key 若被发放用过（正数 delta），不能当成这次扣减的重放
  const dup = await PointRecordModel.findOne({ idemKey: input.idemKey, delta: { $lt: 0 } }).lean();
  if (dup) {
    return {
      balance: dup.balanceAfter, recordId: String(dup._id), duplicated: true,
      points: Math.abs(dup.delta), lotUses: [],
    };
  }

  const points = Math.trunc(input.points);
  if (!Number.isFinite(points) || points <= 0) throw new AppError(400, '积分数必须为正整数');

  await ensureAccount(userId);
  const before = await PointAccountModel.findOneAndUpdate(
    { userId, balance: { $gte: points } },
    { $inc: { balance: -points, totalSpent: points } },
    { returnDocument: 'before' },
  ).lean();
  if (!before) {
    const account = await PointAccountModel.findOne({ userId }).lean();
    throw new AppError(400, `积分不足（当前 ${account?.balance ?? 0}，需要 ${points}）`);
  }
  const balanceAfter = before.balance - points;

  let record;
  try {
    record = await PointRecordModel.create({
      userId,
      type: input.type,
      title: input.title,
      delta: -points,
      balanceAfter,
      bizDate: input.bizDate,
      refType: input.refType ?? '',
      refId: input.refId ?? '',
      idemKey: input.idemKey,
      createdAt: now,
    });
  } catch (e) {
    await PointAccountModel.updateOne({ userId }, { $inc: { balance: points, totalSpent: -points } });
    if (isDuplicateKey(e)) {
      const again = await PointRecordModel.findOne({ idemKey: input.idemKey, delta: { $lt: 0 } }).lean();
      if (again) {
        return {
          balance: again.balanceAfter, recordId: String(again._id), duplicated: true,
          points: Math.abs(again.delta), lotUses: [],
        };
      }
    }
    throw e;
  }

  // FIFO：按到期时间升序消耗批次；每次扣减带 remaining >= use 条件，避免并发下把批次扣成负数
  let left = points;
  const lotUses: { lotId: string; use: number }[] = [];
  const lots = await PointLotModel.find({ userId, remaining: { $gt: 0 } })
    .sort({ expireAt: 1, _id: 1 })
    .select({ _id: 1, remaining: 1 })
    .lean();
  for (const lot of lots) {
    if (left <= 0) break;
    const use = Math.min(lot.remaining, left);
    const applied = await PointLotModel.updateOne(
      { _id: lot._id, remaining: { $gte: use } },
      { $inc: { remaining: -use } },
    );
    if (applied.modifiedCount === 1) {
      left -= use;
      lotUses.push({ lotId: String(lot._id), use });
    }
  }
  if (left > 0) {
    // 理论不可达（不变量：批次 remaining 之和 = 余额 ≥ 本次扣减）；出现即批次账实不符，
    // 靠 settleExpired 的余额闸门兜底不会扣成负数，但必须留痕告警
    console.error('[points-ledger] FIFO 批次扣减残留：余额已扣但批次不足', {
      userId, points, residue: left,
    });
  }

  return { balance: balanceAfter, recordId: String(record._id), duplicated: false, points, lotUses };
}

/** 撤销类型：兑换失败时把扣分原路退回。既不进「发放」，也不进「消耗」（见 points-admin-stats）。 */
export const EXCHANGE_REFUND_TYPE = 'exchange_refund';
/** 被撤销的原始扣分行降级成这个类型：保留审计痕迹，但不再计入 exchange 口径，也不再占用原 idemKey */
export const EXCHANGE_REVERSED_TYPE = 'exchange_reversed';

/**
 * 撤销一笔真实扣分（M1/M2 的 all-or-nothing 补偿）。
 * - 账户：balance / totalSpent 同时回滚，不会只加余额留下「花过钱」的假消耗；
 * - 批次：按 debitPoints 返回的 lotUses 原路 $inc，剩余量与调用前一致；
 * - 账本：写一条 +N 的 exchange_refund（Σdelta 仍等于余额），并把原扣分行降级成
 *   exchange_reversed + 换 idemKey —— 这样同一个 requestId 重试时能重新走一次真实扣分，
 *   而不是命中旧扣分行白拿一张卡；
 * - 幂等：补偿行已存在（同一 recordId 重复调用）直接返回它的 balanceAfter。
 *
 * 只用于「刚扣完就失败」的请求内补偿，不做跨进程崩溃恢复。
 */
export async function reverseDebit(userId: string, debit: DebitResult, bizDate: string, now = Date.now()): Promise<number> {
  if (debit.duplicated || debit.points <= 0) return debit.balance;

  const original = await PointRecordModel.findById(debit.recordId).lean();
  if (!original) return (await PointAccountModel.findOne({ userId }).lean())?.balance ?? 0;
  const refundKey = `refund:${debit.recordId}`;
  const existing = await PointRecordModel.findOne({ idemKey: refundKey }).lean();
  if (existing) return existing.balanceAfter;

  const after = await PointAccountModel.findOneAndUpdate(
    { userId },
    { $inc: { balance: debit.points, totalSpent: -debit.points } },
    { returnDocument: 'after' },
  ).lean();
  if (!after) throw new AppError(500, '积分账户不存在，无法撤销本次扣减');
  const balanceAfter = after.balance;

  for (const use of debit.lotUses) {
    await PointLotModel.updateOne({ _id: use.lotId }, { $inc: { remaining: use.use } });
  }

  // 先把原扣分行降级：释放原 idemKey，重试才能重新扣分；改名失败就不写补偿行，避免账实错位
  const demoted = await PointRecordModel.updateOne(
    { _id: debit.recordId, type: { $ne: EXCHANGE_REVERSED_TYPE } },
    { $set: { type: EXCHANGE_REVERSED_TYPE, idemKey: `reversed:${debit.recordId}` } },
  );
  if ((demoted?.matchedCount ?? 0) === 0) {
    await PointAccountModel.updateOne({ userId }, { $inc: { balance: -debit.points, totalSpent: debit.points } });
    for (const use of debit.lotUses) {
      await PointLotModel.updateOne({ _id: use.lotId }, { $inc: { remaining: -use.use } });
    }
    throw new AppError(500, '撤销扣分失败：原扣分明细状态异常');
  }

  try {
    await PointRecordModel.create({
      userId,
      type: EXCHANGE_REFUND_TYPE,
      title: `撤销${original.title}`,
      delta: debit.points,
      balanceAfter,
      bizDate,
      refType: original.refType ?? '',
      refId: original.refId ?? '',
      idemKey: refundKey,
      createdAt: now,
    });
  } catch (e) {
    // 补偿行没落下：账户/批次回滚，并把原扣分行恢复成 exchange（否则余额已复原、账本却少一条）
    await PointAccountModel.updateOne({ userId }, { $inc: { balance: -debit.points, totalSpent: debit.points } });
    for (const use of debit.lotUses) {
      await PointLotModel.updateOne({ _id: use.lotId }, { $inc: { remaining: -use.use } });
    }
    await PointRecordModel.updateOne(
      { _id: debit.recordId, type: EXCHANGE_REVERSED_TYPE },
      { $set: { type: original.type, idemKey: original.idemKey } },
    );
    if (isDuplicateKey(e)) {
      const again = await PointRecordModel.findOne({ idemKey: refundKey }).lean();
      if (again) return again.balanceAfter;
    }
    throw e;
  }

  return balanceAfter;
}

/** 余额（先结算过期）；没有账户视为 0 */
export async function getBalance(userId: string, now = Date.now()): Promise<number> {
  await settleExpired(userId, now);
  const account = await PointAccountModel.findOne({ userId }).lean();
  return account?.balance ?? 0;
}

/** 明细分页：按 createdAt 倒序（同刻用 _id 兜底），返回当前余额；先结算过期 */
export async function listPointRecords(
  userId: string,
  page = 1,
  pageSize = 20,
  now = Date.now(),
  /** 明细类型筛选（如 'exchange' = 兑换记录）；不传 = 全部 */
  type?: string,
  /**
   * 单页上限。用户端不传 → 50，行为与之前一致；管理端传 100（spec §7.1）。
   * 上限由调用方显式放开，不靠 route 先 Math.min 一遍——route 忘了夹就等于没有闸门。
   */
  pageSizeCap = 50,
): Promise<{ items: PointRecordDto[]; total: number; balance: number; pageSize: number }> {
  await settleExpired(userId, now);

  const safePage = Math.max(1, Math.trunc(page) || 1);
  const safeSize = Math.min(pageSizeCap, Math.max(1, Math.trunc(pageSize) || 20));
  // 类型筛选（2026-10-26）：积分明细页「兑换记录」入口按 type=exchange 过滤
  const filter: Record<string, unknown> = { userId };
  if (type) filter.type = type;
  const [rows, total, account] = await Promise.all([
    PointRecordModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((safePage - 1) * safeSize)
      .limit(safeSize)
      .lean(),
    PointRecordModel.countDocuments(filter),
    PointAccountModel.findOne({ userId }).select({ balance: 1 }).lean(),
  ]);

  const items: PointRecordDto[] = rows.map((r) => ({
    id: String(r._id),
    type: r.type,
    title: r.title,
    delta: r.delta,
    balanceAfter: r.balanceAfter,
    bizDate: r.bizDate,
    refType: r.refType ?? '',
    refId: r.refId ?? '',
    createdAt: r.createdAt,
  }));

  return { items, total, balance: account?.balance ?? 0, pageSize: safeSize };
}
