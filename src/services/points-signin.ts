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
import { PointCardModel, PointSigninModel } from '../models/point.model.js';
import { creditPoints, getBalance } from './points-ledger.js';

export interface SigninState {
  todaySigned: boolean;
  streakDay: number;
  todayReward: number;
  nextReward: number;
  canMakeUp: boolean;
  makeupDate: string;
  cards: number;
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
 * 签到状态。
 * - `streakDay` 是「当前连签天数」：今天签过取今天的行，否则取昨天的行（今天还没签到，连签停在昨天），
 *   两者都没有则为 0；
 * - `nextReward` 是「下一次签到的得分」：今天签过就是明天的（连签 7 天时为 7，不是 8），
 *   今天没签就是今天能拿的。
 */
export async function getSigninState(userId: string, now = Date.now()): Promise<SigninState> {
  const todayKey = bjDateStr(now);
  const yKey = previousDateKey(todayKey);
  const [today, yesterday, dayBefore, cards] = await Promise.all([
    PointSigninModel.findOne({ userId, dateKey: todayKey }).lean(),
    PointSigninModel.findOne({ userId, dateKey: yKey }).lean(),
    PointSigninModel.findOne({ userId, dateKey: previousDateKey(yKey) }).lean(),
    PointCardModel.countDocuments({ userId, status: 'unused', expiresAt: { $gt: now } }),
  ]);
  const baseStreak = today?.streakDay ?? yesterday?.streakDay ?? 0;
  const canMakeUp = !today && !yesterday && !!dayBefore && cards > 0;
  return {
    todaySigned: !!today,
    streakDay: baseStreak,
    todayReward: today?.points ?? 0,
    nextReward: rewardForStreakDay(baseStreak + 1),
    canMakeUp,
    makeupDate: canMakeUp ? yKey : '',
    cards,
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

  return { ...(await state()), alreadySigned: false, credited: c.credited };
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
  await PointSigninModel.updateOne({ _id: row._id }, { $set: { points: credited } });

  return {
    alreadySigned: false,
    credited,
    balance: await getBalance(userId, now),
    ...(await getSigninState(userId, now)),
  };
}
