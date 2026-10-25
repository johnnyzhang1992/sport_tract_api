/**
 * streakDay 递推不变式的守门人（设计 §6.1，Ruling 2026-10-25 修订）。
 *
 * 不变式：窗口内每一行的 streakDay 必须等于「前一天有行 ? 前一天+1 : 库存值本身」。
 * 关键在锚点（D1）：一段连签的**第一行**（昨天没行，或昨天出窗）以它自己的库存 streakDay 为准——
 * 连签 30 天的人在窗口里看到的可能是第 24..29 天，把锚点当成第 1 天就会把后面全算小、
 * 补签位置与封顶跟着错。只有「接在前一天行之后」的相对关系可以从窗口内校验。
 * 唯一的破坏来源是并发：signIn 在昨天还没行时把今天算成第 1 天，随后补签把昨天插进来。
 * 这里把偏离的行 $set 回来，并返回「名义分值差额之和」供调用方发一条 makeup_topup。
 * 差额按 max(0, reward(to) − reward(from)) 全额计，**不封顶在 1**（D2，spec §4.2）：
 * 一次补签可以把今天从位置 1 顶到位置 4（PS6 的 3 分差额就是这件事），封顶 1 会少发；
 * 负差（库存值偏大）只把行校回来、不扣用户已拿到的分。
 * 只看窗口内（今天-6..今天）：补签只会往窗口里插天，错位不可能发生在窗口外；
 * 窗口左界的行由锚点规则自洽，不需要多读窗外一天当种子。
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
  const rows = await PointSigninModel.find({ userId, dateKey: { $gte: left, $lte: todayKey } })
    .sort({ dateKey: 1 }).select({ dateKey: 1, streakDay: 1 }).lean();
  const byKey = new Map(rows.map((r) => [r.dateKey, r.streakDay]));
  const fixes: StreakFix[] = [];
  let prev = 0; // 昨天在校正后的链条里的位置；0 = 昨天没行
  for (let cur = left; cur <= todayKey; cur = shiftDateKey(cur, 1)) {
    const stored = byKey.get(cur);
    if (stored === undefined) { prev = 0; continue; }
    const expected = prev > 0 ? prev + 1 : stored; // 段首（含窗口左界）以库存值为锚
    if (stored !== expected) {
      // 带 CAS 的 $set：并发另一路也在改这一行时，谁后写谁读到最新值再校，不会互相抹
      const cas = await PointSigninModel.updateOne(
        { userId, dateKey: cur, streakDay: stored },
        { $set: { streakDay: expected } },
      );
      // 只有 CAS 命中（modifiedCount === 1，这次写真正落了 expected）才记这份 fix：
      // 两个 trigger 竞同一错位时，败者再记一份会让同一欠分被两个幂等键各付一次（RK9）；
      // 未命中的行已被并发改动，值归位与差额交给胜者/下一次写路径，这里不重复计。
      if (cas.modifiedCount === 1) {
        fixes.push({ dateKey: cur, from: stored, to: expected });
      }
    }
    prev = expected;
  }
  const topUpPoints = fixes.reduce(
    (sum, f) => sum + Math.max(0, rewardForStreakDay(f.to) - rewardForStreakDay(f.from)), 0);
  return { fixes, topUpPoints };
}

/**
 * 校正 + 发差额（D3：差额的唯一出口，补签流程不再自己算差额）。
 * trigger 是「引起这次重排的那一天」（补签日 / 今天），
 * 幂等键按 trigger 区分：同一天补两个漏签日要各发一次差额（RK7）。
 * 记录类型与键前缀统一为 makeup_topup（spec §6.1：idemKey = {userId}:makeup_topup:{触发日}）。
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
    idemKey: `${userId}:makeup_topup:${trigger}`,
  }, now);
  return c.credited;
}
