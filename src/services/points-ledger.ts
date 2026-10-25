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
import { Types } from 'mongoose';
import { POINTS } from '../config/points.js';
import { expireAtFor } from '../utils/points-domain.js';
import { bjDateStr } from '../utils/bj-time.js';
import { AppError } from '../utils/app-error.js';
import { PointAccountModel, PointLotModel, PointRecordModel } from '../models/point.model.js';

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

/** 该业务日已入账的积分（只算正数明细，过期/扣减不算） */
async function earnedToday(userId: string, bizDate: string): Promise<number> {
  const rows = await PointRecordModel.aggregate<{ _id: null; sum: number }>([
    { $match: { userId: new Types.ObjectId(userId), bizDate, delta: { $gt: 0 } } },
    { $group: { _id: null, sum: { $sum: '$delta' } } },
  ]);
  return rows[0]?.sum ?? 0;
}

/**
 * 结算该用户所有已过期批次：批次 remaining 清零 → 扣余额 → 写一条 expire 明细。
 * 批次用带 remaining>0 条件的原子更新「认领」，并发重复调用只会有一个执行扣减。
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

    const account = await PointAccountModel.findOne({ userId }).lean();
    const balanceAfter = (account?.balance ?? 0) - claimed.remaining;

    try {
      await PointRecordModel.create({
        userId,
        type: 'expire',
        title: '积分过期',
        delta: -claimed.remaining,
        balanceAfter,
        bizDate: bjDateStr(now),
        refType: 'lot',
        refId: String(lot._id),
        idemKey: `expire:${lot._id}`,
        createdAt: now,
      });
    } catch (e) {
      if (isDuplicateKey(e)) continue; // 这条批次之前已结算过（明细已存在），不再扣余额
      // 明细写失败：把批次剩余还回去，避免「批次清零但余额没扣」的丢分
      await PointLotModel.updateOne({ _id: lot._id }, { $inc: { remaining: claimed.remaining } });
      throw e;
    }

    await PointAccountModel.updateOne({ userId }, { $inc: { balance: -claimed.remaining } });
  }
}

/** 发放积分：idemKey 幂等 + 每日上限（按 bizDate 汇总正数明细）+ 生成批次 */
export async function creditPoints(userId: string, input: CreditInput, now = Date.now()): Promise<CreditResult> {
  await settleExpired(userId, now);

  const dup = await PointRecordModel.findOne({ idemKey: input.idemKey }).lean();
  if (dup) return { credited: 0, balance: await getBalance(userId, now), duplicated: true, capped: false };

  const requested = Math.trunc(input.points);
  if (!Number.isFinite(requested) || requested <= 0) throw new AppError(400, '积分数必须为正整数');

  const used = await earnedToday(userId, input.bizDate);
  const credited = Math.min(requested, Math.max(0, POINTS.DAILY_CAP - used));
  if (credited <= 0) return { credited: 0, balance: await getBalance(userId, now), duplicated: false, capped: true };

  // 先原子加余额，拿到 pre-image 作为 balanceAfter；明细写失败再回滚
  const before = await PointAccountModel.findOneAndUpdate(
    { userId },
    { $inc: { balance: credited, totalEarned: credited } },
    { upsert: true, returnDocument: 'before' },
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
    await PointRecordModel.deleteOne({ _id: record._id });
    throw e;
  }

  return { credited, balance: balanceAfter, duplicated: false, capped: credited < requested };
}

/** 扣减积分：余额闸门（原子条件更新，禁止负余额）+ 明细 + 批次 FIFO 扣减 */
export async function debitPoints(userId: string, input: DebitInput, now = Date.now()): Promise<DebitResult> {
  await settleExpired(userId, now);

  const dup = await PointRecordModel.findOne({ idemKey: input.idemKey }).lean();
  if (dup) return { balance: dup.balanceAfter, recordId: String(dup._id) };

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
      const again = await PointRecordModel.findOne({ idemKey: input.idemKey }).lean();
      if (again) return { balance: again.balanceAfter, recordId: String(again._id) };
    }
    throw e;
  }

  // FIFO：按到期时间升序消耗批次
  let left = points;
  const lots = await PointLotModel.find({ userId, remaining: { $gt: 0 } })
    .sort({ expireAt: 1, _id: 1 })
    .select({ _id: 1, remaining: 1 })
    .lean();
  for (const lot of lots) {
    if (left <= 0) break;
    const use = Math.min(lot.remaining, left);
    await PointLotModel.updateOne({ _id: lot._id }, { $inc: { remaining: -use } });
    left -= use;
  }

  return { balance: balanceAfter, recordId: String(record._id) };
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
): Promise<{ items: PointRecordDto[]; total: number; balance: number }> {
  await settleExpired(userId, now);

  const safePage = Math.max(1, Math.trunc(page) || 1);
  const safeSize = Math.min(50, Math.max(1, Math.trunc(pageSize) || 20));
  const [rows, total, account] = await Promise.all([
    PointRecordModel.find({ userId })
      .sort({ createdAt: -1, _id: -1 })
      .skip((safePage - 1) * safeSize)
      .limit(safeSize)
      .lean(),
    PointRecordModel.countDocuments({ userId }),
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

  return { items, total, balance: account?.balance ?? 0 };
}
