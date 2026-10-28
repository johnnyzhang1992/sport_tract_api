/**
 * 签到与补签。
 *
 * 规则（需求 §4 改版 / 设计 2026-10-25）：
 * - 连续签到第 N 天得 `min(N, 7)` 分；第 8 天起每天 7 分，直到断签才从第 1 天重算；
 * - 断签判定只看「昨天有没有签到行」：有则 streak = 昨天 + 1，没有则从 1 起；
 * - 签到行以 (userId, dateKey) 唯一键落库，重复签到返回 alreadySigned、不再发当天分，
 *   但仍跑一次差额校正（同一天重试也是「下一次写」，设计 §6.1）；
 * - 补签**按日期逐格**：窗口（今天-6..今天）内、没签到行、且所在未签段 ≤2 天的日子才可补，
 *   一格一张卡（服务端挑最早过期的可用卡，客户端不传卡 id），今天已签照样能补（口径 3）；
 * - 补签写一条 source='makeup' 的行，插入后整条链按 §4.2 递推重排，重排欠分由收尾的
 *   `creditStreakTopUp` 一次补发（差额的唯一出口，本流程不自己算差额，Ruling D3）。
 *
 * 幂等键带 userId 前缀：明细表的 idemKey 是全局唯一索引，不带用户前缀时第二个用户在同一天
 * 签到会被误判成重放（credited 0）。
 */
import { AppError } from '../utils/app-error.js';
import { POINTS } from '../config/points.js';
import { bjDateStr } from '../utils/bj-time.js';
import { previousDateKey, rewardForStreakDay } from '../utils/points-domain.js';
import { planSigninCells, windowStartKey, WINDOW_DAYS, type SigninCell } from '../utils/points-window.js';
import { PointCardModel, PointSigninModel } from '../models/point.model.js';
import { creditPoints, debitPoints, getBalance } from './points-ledger.js';
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
 * - `streakDay`（前端「已连续 N 天」的唯一来源）**只报接得上的那条链**：今天签了取今天的库存值，
 *   今天没签但昨天签了取昨天的，昨天也没签就是 0。窗口里最右的已签格如果隔着断口，那是「上一段链
 *   的长度」，报出去会和同一屏的「今天签到得 1 分」自相矛盾（Ruling 2026-10-25）；
 * - 格子与 `todayReward` 的分值一律是**名义规则分** `min(streakDay, 7)`（Ruling 2026-10-25 改回
 *   名义分，spec §5.1）：补差是按今天入账的聚合流水，摊不回每日行的 `points`，钱的真相在积分明细页；
 *   投影也因此只读 `dateKey`/`streakDay` 两列；
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
  // 接得上 = 今天有行就接今天，否则昨天有行接昨天；再往后隔着断口就不算「当前连签」
  const yesterday = cells.find((c) => c.dateKey === previousDateKey(todayKey));
  const chain = signed ? today : yesterday?.state === 'signed' ? yesterday : undefined;
  return {
    todaySigned: signed,
    streakDay: chain?.streakDay ?? 0,
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
  // 「今天已经签了」的两条早退路（读到已有行 / 抢唯一键输了）：不发当天分，但**仍要跑一次校正**。
  // 上一次可能崩在「今天的行与当天分已落库、差额没发成」的夹缝里，不补就把欠分锁到明天（spec §6.1，
  // Ruling 2026-10-25「下一次写必须包括同一天重试」）。creditStreakTopUp 按 trigger 幂等、
  // 链条已正时返回 0，重复调用一分都多发不了。
  const alreadySigned = async (): Promise<SigninResult> => {
    // 崩溃恢复（审计 Finding 1）：行已落库但当天分没发成（进程崩在占位与发分两步之间）→
    // 重试补发。creditPoints 同 idemKey 天然幂等：已付过返回 duplicated 0，不会双发；
    // 被当日上限截断的行 points 也是 0，重跑同样安全（再次截断/重复，credited 0）。
    // 注：makeup 行只会落在过去日期，不会与今天的 sign 行混淆。
    const unpaid = await PointSigninModel.findOne({
      userId, dateKey: todayKey, source: 'sign', points: 0,
    }).select({ _id: 1, streakDay: 1 }).lean();
    let backCredit = 0;
    if (unpaid) {
      const c = await creditPoints(userId, {
        type: 'signin',
        title: `连续签到第 ${unpaid.streakDay} 天`,
        points: rewardForStreakDay(unpaid.streakDay),
        bizDate: todayKey,
        refType: 'signin',
        refId: todayKey,
        idemKey: `${userId}:signin:${todayKey}`,
      }, now);
      if (c.credited > 0) {
        backCredit = c.credited;
        await PointSigninModel.updateOne({ _id: unpaid._id }, { $set: { points: c.credited } });
      }
    }
    const toppedUp = await creditStreakTopUp(userId, todayKey, now);
    return { ...(await state()), alreadySigned: true, credited: backCredit + toppedUp };
  };

  const exists = await PointSigninModel.findOne({ userId, dateKey: todayKey }).lean();
  if (exists) return alreadySigned();

  const yesterday = await PointSigninModel.findOne({ userId, dateKey: previousDateKey(todayKey) }).lean();
  const streakDay = yesterday ? yesterday.streakDay + 1 : 1;

  // 先占「今日签到」这一行（唯一键），并发重复提交只有一个能往下发分
  const row = await PointSigninModel.create({
    userId, dateKey: todayKey, streakDay, points: 0, source: 'sign', createdAt: now,
  }).catch((e) => {
    if (isDuplicateKey(e)) return null;
    throw e;
  });
  if (!row) return alreadySigned();

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

export interface MakeupResult extends SigninResult {
  /** 重排差额实际入账（被每日上限截断时是实发值，§5.2） */
  toppedUp: number;
  /** 本次消耗掉的卡（服务端自己挑的，客户端不传卡 id） */
  cardId: string;
}

/**
 * 用一张补签卡补窗口内的某个漏签日（设计 §4.1/§4.2/§6）。
 *
 * 判定只有一个来源：`getSigninState` 下发的 `cells` 里这一格是不是 `state === 'makeup'`
 * ——「窗口内」「没签到行」「所在未签段 ≤2 天」都在 `planSigninCells` 里算过，这里不重算一遍。
 *
 * 落库顺序（不用事务，先占位、失败逆序回滚、每步带条件）：
 * 1. 占住 `d` 的签到行（唯一键冲突 = 这一天已被并发补上/签上 → 400「该日已签到」）；
 * 2. 原子扣卡 `unused → used(usedForDate=d)`，服务端按最早过期挑卡；抢不到卡 → 只撤回第 1 步的行；
 * 3. 发 `makeup_reward`（bizDate=d，不占今天额度）；实发 0（当日上限已满 / 重放）视为失败 → 退卡 + 撤行；
 * 4. 把行的 `points` 写成实发分；
 * 5. 收尾 `creditStreakTopUp(userId, d)`：重排窗口内的 streakDay 并一次补发差额（Ruling D3：
 *    差额只有一个出口，本函数不自己算「受影响日」）。
 * 第 3~5 步任一抛错按逆序回滚：扣回已发的当天分（`debitPoints`）→ 卡退回 unused → 撤本次的占位行。
 *
 * trigger 必须是**补签日**而不是今天：今天的 `{userId}:makeup_topup:{今天}` 已被 `signIn` 占用，
 * 同一天用第二张卡时两份欠分会互相吞掉一条流水（PS4c 钉这条）。
 *
 * 已接受风险（§5.2/§6.1，设计认下、别在这里补救）：第 5 步被 DAILY_CAP 截断或抛错时，
 * `reconcileStreaks` 写过的 streakDay 不跟着回滚（读路径永不下修），少发的差额找不回来，
 * 响应里的 `credited/toppedUp` 报的就是实际入账值。
 */
export async function useMakeupCard(
  userId: string, dateKey: string, now = Date.now(),
): Promise<MakeupResult> {
  const todayKey = bjDateStr(now);
  const key = String(dateKey ?? '').trim();
  // 三条拒绝文案各自说清「对象 + 实际值 + 限制」，尾巴统一留「该日期不能补签」保住老客户端的匹配
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    throw new AppError(400, `日期格式必须是 YYYY-MM-DD（收到「${key}」）：该日期不能补签`);
  }
  if (key >= todayKey) {
    throw new AppError(400, `只能补今天之前的日期（今天 ${todayKey}，收到 ${key}）：该日期不能补签`);
  }
  if (key < windowStartKey(todayKey)) {
    throw new AppError(400,
      `已超出近 ${WINDOW_DAYS} 天补签窗口（窗口起点 ${windowStartKey(todayKey)}，收到 ${key}）：该日期不能补签`);
  }

  const state = await getSigninState(userId, now);
  const cell = state.cells.find((c) => c.dateKey === key);
  // 崩溃恢复（审计 Finding 1）：残留的 makeup 行（points=0）说明上次流程没走完——
  // 正常路径 credited<=0 会连卡带行一起回滚，不会留这种行；先于「已签到」判定处理。
  const stale = await PointSigninModel.findOne({
    userId, dateKey: key, source: 'makeup', points: 0,
  }).lean();
  if (cell?.state === 'signed' && !stale) throw new AppError(400, '该日已签到，无需补签');
  if (cell?.state !== 'makeup' && !stale) {
    // 段长上限读配置不写死：2026-10-25 放宽到 7（= 窗口大小）后，旧文案里的「2 天」就成了谎话
    throw new AppError(400, state.cells.some((c) => c.state === 'signed')
      ? `该日所在未签段超过上限 ${POINTS.MAX_MAKEUP_GAP_DAYS} 天（收到 ${key}）：该日不能补签`
      : `窗口内还没有签到记录，补签只能接在已有记录上（收到 ${key}）：该日不能补签`);
  }
  if (state.cards <= 0 && !stale) throw new AppError(400, '没有可用的补签卡，请先兑换');

  // 残留恢复：卡已扣（usedForDate=key）→ 从发分步续跑（卡不再扣；credit 同 idemKey 幂等，
  // 上次已发过则返回 duplicated 0——被每日上限卡住的极窄角落走 400 提示人工）；
  // 卡未扣 → 清残留行走正常流程（下方占位 create 才不会撞唯一键）
  if (stale) {
    const consumed = await PointCardModel.findOne({ userId, status: 'used', usedForDate: key }).lean();
    if (consumed) {
      const c = await creditPoints(userId, {
        type: 'makeup_reward',
        title: `补签 ${key}`,
        points: rewardForStreakDay(stale.streakDay),
        bizDate: key,
        refType: 'signin',
        refId: key,
        idemKey: `${userId}:makeup:${key}:${stale._id}`,
      }, now);
      if (c.credited <= 0) throw new AppError(400, '补签未入账积分（可能已达每日上限），请联系客服处理');
      await PointSigninModel.updateOne({ _id: stale._id }, { $set: { points: c.credited } });
      const toppedUp = await creditStreakTopUp(userId, key, now);
      const after = await getSigninState(userId, now);
      return {
        ...after,
        alreadySigned: after.todaySigned,
        credited: c.credited,
        toppedUp,
        cardId: String(consumed._id),
        balance: await getBalance(userId, now),
      };
    }
    await deleteOwnRow(stale._id);
  }

  // 残留恢复路径下 cell 可能缺（行已存在→signed 格），位置以残留行库存值为准
  const streakDay = cell?.streakDay ?? stale?.streakDay ?? 1;
  // 1) 先占这一行：同一天双击/两路并发只有一路能往下发分
  const row = await PointSigninModel.create({
    userId, dateKey: key, streakDay, points: 0, source: 'makeup', createdAt: now,
  }).catch((e: unknown) => {
    if (isDuplicateKey(e)) return null;
    throw e;
  });
  if (!row) throw new AppError(400, '该日已签到，无需补签');

  // 2) 扣卡：条件写（unused 才挑得动），最早过期优先 —— 与 summary 的挑卡口径一致
  const card = await PointCardModel.findOneAndUpdate(
    { userId, status: 'unused', expiresAt: { $gt: now } },
    { $set: { status: 'used', usedForDate: key } },
    { sort: { expiresAt: 1, _id: 1 }, returnDocument: 'after' },
  ).lean().catch(async (e: unknown) => {
    // 这一枪本身报错（网络/校验）：先把刚占的行撤回再冒泡，否则库里留一条 0 分补签行、卡却还在
    await deleteOwnRow(row._id);
    throw e;
  });
  if (!card) {
    // 卡数是开头那次 count 看到的，扣的这一刻已被并发用掉/刚好过期：只撤回本次占的行
    await deleteOwnRow(row._id);
    throw new AppError(400, '没有可用的补签卡，请先兑换');
  }

  // 逆序回滚，每步只动本次刚写的行/卡（条件写，别把并发另一路的成果抹掉）
  const rollback = async () => {
    await PointCardModel.updateOne(
      { _id: card._id, status: 'used', usedForDate: key },
      { $set: { status: 'unused', usedForDate: '' } },
    ).catch((e: unknown) => logRollbackFailure('退卡', e));
    await deleteOwnRow(row._id);
  };

  let credited = 0;
  let toppedUp = 0;
  try {
    const c = await creditPoints(userId, {
      type: 'makeup_reward',
      title: `补签 ${key}`,
      points: rewardForStreakDay(streakDay),
      bizDate: key, // 补签当天分记在它自己那天：不占今天额度（设计 §2 口径 2）
      refType: 'signin',
      refId: key,
      // 键带本次占位行的 _id：行被唯一索引钉死，同日重放照样挡得住；
      // 而回滚成功（行已删、卡已退回）后的重试是「另一次占位行」，不能被上一次已撤回的发放判成重放，
      // 否则那天永远补不上、退回的卡成了废卡。
      idemKey: `${userId}:makeup:${key}:${row._id}`,
    }, now);
    credited = c.credited;
    if (credited <= 0) {
      // 重放或当天额度已满：卡没白花、账上没多钱，400 让用户稍后再试
      throw new AppError(400, '补签未入账积分（可能已达每日上限），补签卡未消耗');
    }
    // 实际入账可能被每日上限截断，行记实发而不是名义分
    await PointSigninModel.updateOne({ _id: row._id }, { $set: { points: credited } });
    toppedUp = await creditStreakTopUp(userId, key, now);
  } catch (e) {
    if (credited > 0) {
      // 已入账的当天分要扣回去，否则回滚后账上多一笔、卡却还在（钱是今天还的 → bizDate 今天）
      await debitPoints(userId, {
        type: 'makeup_reward_rollback', title: `撤回补签 ${key}`, points: credited,
        bizDate: todayKey, refType: 'signin', refId: key,
        idemKey: `${userId}:makeup_rollback:${key}:${row._id}`,
      }, now).catch((de: unknown) => logRollbackFailure('扣回补签分', de));
    }
    await rollback();
    throw e;
  }

  const after = await getSigninState(userId, now);
  return {
    ...after,
    alreadySigned: after.todaySigned,
    credited,
    toppedUp,
    cardId: String(card._id),
    balance: await getBalance(userId, now),
  };
}

/** 只撤本次刚写的那一行（按 _id 删；删不到也算成功——它可能已被并发路径清掉） */
async function deleteOwnRow(id: unknown): Promise<void> {
  await PointSigninModel.deleteOne({ _id: id }).catch((e: unknown) => logRollbackFailure('撤补签行', e));
}

/** 补偿动作自己失败时不能盖掉原始错误（调用方拿到的仍是失败原因），但也不能无声吞账本脏数据 */
function logRollbackFailure(step: string, e: unknown): void {
  console.error(`[points-makeup] 回滚「${step}」失败:`, (e as Error)?.message ?? e);
}
