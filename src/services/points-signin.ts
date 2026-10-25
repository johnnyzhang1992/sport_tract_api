/**
 * 签到与补签。
 *
 * 规则（需求 §4）：
 * - 连续签到第 N 天得 `min(N, 7)` 分；第 8 天起每天 7 分，直到断签才从第 1 天重算；
 * - 断签判定只看「昨天有没有签到行」：有则 streak = 昨天 + 1，没有则从 1 起；
 * - 签到行以 (userId, dateKey) 唯一键落库，重复签到返回 alreadySigned 且不再发分；
 * - 补签卡只能补「昨天」，且必须满足：今天还没签到、昨天没签、前天已签；
 *   补签同样写入一条 source='makeup' 的签到行，因此今天再签到会自然接上昨天补出来的连签。
 *
 * 幂等键带 userId 前缀：明细表的 idemKey 是全局唯一索引，不带用户前缀时第二个用户在同一天
 * 签到会被误判成重放（credited 0）。
 */
import { AppError } from '../utils/app-error.js';
import { bjDateStr } from '../utils/bj-time.js';
import { isObjectIdLike } from '../utils/object-id.js';
import { previousDateKey, rewardForStreakDay } from '../utils/points-domain.js';
import { planSigninCells, windowStartKey, type SigninCell } from '../utils/points-window.js';
import { PointCardModel, PointSigninModel } from '../models/point.model.js';
import { creditPoints, getBalance } from './points-ledger.js';
import { creditStreakTopUp } from './points-streak.js';

export interface SigninState {
  todaySigned: boolean;
  streakDay: number;
  todayReward: number;
  nextReward: number;
  cards: number;
  cells: SigninCell[];
}

export interface SigninResult extends SigninState {
  alreadySigned: boolean;
  credited: number;
  balance: number;
}

const DUPLICATE_KEY = 11000;

function isDuplicateKey(e: unknown): boolean {
  return (e as { code?: number } | null)?.code === DUPLICATE_KEY;
}

/**
 * 签到状态（spec §5.1）：下发七格 `cells`，可补与否只看 `state === 'makeup'`
 * （旧字段 canMakeUp/makeupDate 已删，前端不再自己推当前格）。
 * - `streakDay` 取窗口内最右一个已签格的库存值（今天签过就是今天的行）；
 * - `nextReward` 是「下一次签到的得分」：今天签过就是明天的（连签 7 天时为 7，不是 8），
 *   今天没签就是今天能拿的；
 * - 读接口只 dryRun：本函数不写库，错位由写路径（signIn / useMakeupCard）收尾的
 *   `reconcileStreaks` 校正（设计 §6.1）。
 */
export async function getSigninState(userId: string, now = Date.now()): Promise<SigninState> {
  const todayKey = bjDateStr(now);
  // 只读窗口这 7 天：段长判定截在窗口内（spec §4.1 第 4 条 / Ruling 2026-10-25），窗外的行不参与
  const [rows, cards] = await Promise.all([
    PointSigninModel.find({ userId, dateKey: { $gte: windowStartKey(todayKey), $lte: todayKey } })
      .select({ dateKey: 1, streakDay: 1 }).lean(),
    PointCardModel.countDocuments({ userId, status: 'unused', expiresAt: { $gt: now } }),
  ]);
  const cells = planSigninCells(rows, todayKey);
  const today = cells.find((c) => c.dateKey === todayKey)!;
  const signed = today.state === 'signed';
  const last = [...cells].reverse().find((c) => c.state === 'signed');
  return {
    todaySigned: signed,
    streakDay: last?.streakDay ?? 0,
    todayReward: signed ? today.reward : 0,
    nextReward: rewardForStreakDay(today.streakDay + (signed ? 1 : 0)),
    cards,
    cells,
  };
}

export async function signIn(userId: string, now = Date.now()): Promise<SigninResult> {
  const todayKey = bjDateStr(now);
  const state = async () =>
    ({ alreadySigned: false, credited: 0, balance: await getBalance(userId, now), ...(await getSigninState(userId, now)) });

  const exists = await PointSigninModel.findOne({ userId, dateKey: todayKey }).lean();
  if (exists) return { ...(await state()), alreadySigned: true };

  const yesterday = await PointSigninModel.findOne({ userId, dateKey: previousDateKey(todayKey) }).lean();
  const streakDay = yesterday ? yesterday.streakDay + 1 : 1;

  // 先占「今日签到」这一行（唯一键），并发重复提交只有一个能往下发分
  const row = await PointSigninModel.create({
    userId, dateKey: todayKey, streakDay, points: 0, source: 'sign', createdAt: now,
  }).catch((e) => {
    if (isDuplicateKey(e)) return null;
    throw e;
  });
  if (!row) return { ...(await state()), alreadySigned: true };

  const c = await creditPoints(userId, {
    type: 'signin',
    title: `连续签到第 ${streakDay} 天`,
    points: rewardForStreakDay(streakDay),
    bizDate: todayKey,
    refType: 'signin',
    refId: todayKey,
    idemKey: `${userId}:signin:${todayKey}`,
  }, now);
  // 实际入账可能被每日上限截断，签到行记实际得分而不是名义得分
  await PointSigninModel.updateOne({ _id: row._id }, { $set: { points: c.credited } });
  // 若这次签到正好落在「刚被补签重排」的窗口里，把偏离的 streakDay 校正回来并补差额；
  // 幂等键用今天，天然一天一次。
  const toppedUp = await creditStreakTopUp(userId, todayKey, now);
  return {
    ...(await state()),
    alreadySigned: false,
    credited: c.credited + toppedUp,
    balance: await getBalance(userId, now),
  };
}

export async function useMakeupCard(userId: string, cardId: string, now = Date.now()): Promise<SigninResult> {
  const todayKey = bjDateStr(now);
  const yKey = previousDateKey(todayKey);
  const dayBeforeKey = previousDateKey(yKey);
  const [today, yesterday, dayBefore] = await Promise.all([
    PointSigninModel.findOne({ userId, dateKey: todayKey }).lean(),
    PointSigninModel.findOne({ userId, dateKey: yKey }).lean(),
    PointSigninModel.findOne({ userId, dateKey: dayBeforeKey }).lean(),
  ]);
  if (today) throw new AppError(400, '今天已签到，补签需在今日签到前完成');
  if (yesterday) throw new AppError(400, '昨天已签到，无需补签');
  if (!dayBefore) throw new AppError(400, '前天没有签到记录，补签卡只能补前一天且需前天已签到');
  if (!isObjectIdLike(cardId)) throw new AppError(400, '补签卡不可用或已过期');

  const streakDay = dayBefore.streakDay + 1;
  // 先占「昨天」这一行：防止两张卡（或同卡双击）并发补同一天重复发分、重复烧卡
  const row = await PointSigninModel.create({
    userId, dateKey: yKey, streakDay, points: 0, source: 'makeup', createdAt: now,
  }).catch((e) => {
    if (isDuplicateKey(e)) return null;
    throw e;
  });
  if (!row) throw new AppError(400, '昨天已签到，无需补签');

  // 与签到串行化：开头读 today 到今天补签落库之间，并发 signIn 可能刚建了今天的行
  // （它当时看不到昨天，streakDay 会是 1）。此时继续补签会留下「今天=1、昨天=3」的错位连签，
  // 所以先撤回刚占的补签行，按「今天已签到」拒绝，卡不动。
  const todayAfterClaim = await PointSigninModel.findOne({ userId, dateKey: todayKey }).lean();
  if (todayAfterClaim) {
    await PointSigninModel.deleteOne({ _id: row._id });
    throw new AppError(400, '今天已签到，补签需在今日签到前完成');
  }

  const card = await PointCardModel.findOneAndUpdate(
    { _id: cardId, userId, status: 'unused', expiresAt: { $gt: now } },
    { $set: { status: 'used', usedForDate: yKey } },
    { returnDocument: 'after' },
  ).lean();
  if (!card) {
    // 卡不可用：把刚占的补签行撤回，避免用户白白多出一条 0 分的补签
    await PointSigninModel.deleteOne({ _id: row._id });
    throw new AppError(400, '补签卡不可用或已过期');
  }

  let credited = 0;
  try {
    const c = await creditPoints(userId, {
      type: 'makeup_reward',
      title: `补签 ${yKey}`,
      points: rewardForStreakDay(streakDay),
      bizDate: yKey,
      refType: 'signin',
      refId: yKey,
      idemKey: `${userId}:makeup:${yKey}`,
    }, now);
    credited = c.credited;
  } catch (e) {
    // 发分失败：撤回补签行并把卡退回未使用，用户可原卡重试（重复键已由账本兜底）
    await Promise.all([
      PointSigninModel.deleteOne({ _id: row._id }),
      PointCardModel.updateOne({ _id: card._id }, { $set: { status: 'unused', usedForDate: '' } }),
    ]);
    throw e;
  }
  // credited 为 0（账本判重放或当日已达上限）：不留 0 分补签行、也不能白烧卡。
  // 与发分失败同一处理：撤回补签行 + 卡退回未使用，400 让用户稍后重试。
  if (credited <= 0) {
    await Promise.all([
      PointSigninModel.deleteOne({ _id: row._id }),
      PointCardModel.updateOne({ _id: card._id }, { $set: { status: 'unused', usedForDate: '' } }),
    ]);
    throw new AppError(400, '补签未入账积分（可能已达每日上限），补签卡未消耗');
  }

  await PointSigninModel.updateOne({ _id: row._id }, { $set: { points: credited } });

  return {
    alreadySigned: false,
    credited,
    balance: await getBalance(userId, now),
    ...(await getSigninState(userId, now)),
  };
}
