/**
 * streakDay 递推不变式的守门人（设计 §6.1）。
 *
 * 不变式：窗口内每一行的 streakDay 必须等于「前一自然日有行 ? 那一天库存值+1 : 1」。
 * 唯一的破坏来源是并发：signIn 在昨天还没行时把今天算成第 1 天，随后补签把昨天插进来。
 * 这里把偏离的行 $set 回来，并返回「被顶高行的名义分增量」供调用方发一条 makeup_topup。
 *
 * 两条口径（RK2/RK3 钉死）：
 * - 只校正窗口内（今天-6..今天）的行；窗口左缘外只多读一天当「种子」——
 *   连续链跨窗时窗口首行的前一天在窗外，递推必须从它的库存值起步，
 *   否则连签 30 天会被窗口左缘错校成 1..7（spec §6.1：signed 格取库存值，窗外不动）。
 * - 比对基准是「前一天的库存值」（不是本次校正后的期望值），也不级联：
 *   补一个漏签日只让下游「该顶到的位置 +1」，下游每行只跟自己的左邻居比一次。
 *
 * 差额口径：每条向上的校正至多补 1 分（一次被并发漏掉的 +1 重排的名义分增量，
 * §4.2「差额值为 0 或 1」）；封顶后（如 7→8）名义分不变，贡献 0，不写空流水。
 */
import { PointSigninModel } from '../models/point.model.js';
import { rewardForStreakDay, shiftDateKey } from '../utils/points-domain.js';
import { bjDateStr } from '../utils/bj-time.js';
import { WINDOW_DAYS } from '../utils/points-window.js';
import { creditPoints } from './points-ledger.js';

export interface StreakFix {
  dateKey: string;
  from: number;
  to: number;
}

export interface ReconcileResult {
  fixes: StreakFix[];
  topUpPoints: number;
}

export async function reconcileStreaks(userId: string, now = Date.now()): Promise<ReconcileResult> {
  const todayKey = bjDateStr(now);
  const left = shiftDateKey(todayKey, -(WINDOW_DAYS - 1));
  const seedKey = shiftDateKey(left, -1);
  // 多读左邻一天只为取种子；校正与 fixes 一律只发生在窗口内（RK5）
  const rows = await PointSigninModel.find({ userId, dateKey: { $gte: seedKey, $lte: todayKey } })
    .sort({ dateKey: 1 }).select({ dateKey: 1, streakDay: 1 }).lean();
  const byKey = new Map(rows.map((r) => [r.dateKey, r.streakDay]));
  const fixes: StreakFix[] = [];
  let prev = byKey.get(seedKey) ?? 0;
  for (let cur = left; cur <= todayKey; cur = shiftDateKey(cur, 1)) {
    const stored = byKey.get(cur);
    if (stored === undefined) { prev = 0; continue; } // 断签重开：链条从零起
    const expected = prev + 1;
    if (stored !== expected) {
      // 带 CAS 的 $set：并发另一路也在改这一行时，谁后写谁读到最新值再校，不会互相抹
      await PointSigninModel.updateOne(
        { userId, dateKey: cur, streakDay: stored },
        { $set: { streakDay: expected } },
      );
      fixes.push({ dateKey: cur, from: stored, to: expected });
    }
    prev = stored; // 比对基准取库存值本身，不级联下游
  }
  const topUpPoints = fixes.reduce(
    (sum, f) => sum + Math.max(0, Math.min(1, rewardForStreakDay(f.to) - rewardForStreakDay(f.from))), 0);
  return { fixes, topUpPoints };
}

/**
 * 校正 + 发差额。trigger 是「引起这次重排的那一天」（补签日 / 今天），
 * 幂等键按 trigger 区分：同一天补两个漏签日要各发一次差额（RK7）。
 */
export async function creditStreakTopUp(
  userId: string, trigger: string, now = Date.now(),
): Promise<number> {
  const { fixes, topUpPoints } = await reconcileStreaks(userId, now);
  if (topUpPoints <= 0 || !fixes.length) return 0;
  const c = await creditPoints(userId, {
    type: 'makeup_topup',
    title: `补签 ${trigger}：${fixes.length} 天连签重排补差`,
    points: topUpPoints,
    bizDate: bjDateStr(now),
    refType: 'signin',
    refId: trigger,
    idemKey: `${userId}:streak_topup:${trigger}`,
  }, now);
  return c.credited;
}
