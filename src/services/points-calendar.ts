/**
 * 签到月历（积分页半屏日历的数据源）：逐日下发状态与分值，**含首尾补位的相邻月日期**。
 *
 * 端上是七列栅格，月初与月末各差几天，那几格用相邻月份的日期填满（2026-10-28 用户点名
 * 「日历保持完整，其他月份的日期也填满」）。所以这里前后各多发 6 天：只发当月的话，
 * 补位格要么留空、要么画成「没签」的灰圈——上月 28 号明明签过就变说谎，状态必须一起给。
 *
 * 判据只有唯一来源：某天能不能补，取 `getSigninState` 下发的 cells（内部由 `planSigninCells`
 * 算「窗口内 + 未签段达标」），这里不重算一遍。重算就会把历史月份的漏签日标成可补，
 * 用户点上去只能吃补签接口的 400（2026-10-28 定：端上不做禁用，那就更不能错标）。
 * 补签窗口跨月时（今天 11-02、窗口含 10-27）也照同一份 cells 标，端上不做第二套判断。
 *
 * 状态口径与七格一致：signed（已签，下发库存 streakDay 不重算）/ today（今天还没签）/
 * makeup（窗口内可补）/ missed（漏签且不可补）/ future（未来日，分值是「一路签下去」的名义推算）。
 */
import { AppError } from '../utils/app-error.js';
import { bjDateStr } from '../utils/bj-time.js';
import { daysBetween, rewardForStreakDay, shiftDateKey } from '../utils/points-domain.js';
import { PointSigninModel } from '../models/point.model.js';
import { getSigninState } from './points-signin.js';

export type CalendarState = 'signed' | 'today' | 'makeup' | 'missed' | 'future';

export interface CalendarDay {
  dateKey: string;
  state: CalendarState;
  streakDay: number;
  reward: number;
}

export interface SigninCalendar {
  month: string;
  today: string;
  days: CalendarDay[];
}

const MONTH_RE = /^\d{4}-\d{2}$/;

/** 首尾各多发的天数：七列栅格两边最多各差 6 天，端上不必自己推星期 */
const PAD_DAYS = 6;

/** 当月所有 dateKey（升序）。Date(y, m, 0) = 当月最后一天，m 传 1 基月份。 */
function monthDateKeys(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const dim = new Date(y, m, 0).getDate();
  return Array.from({ length: dim }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

export async function getSigninCalendar(
  userId: string, month: string, now = Date.now(),
): Promise<SigninCalendar> {
  const todayKey = bjDateStr(now);
  const raw = String(month ?? '').trim();
  const key = raw || todayKey.slice(0, 7);
  // 只校验形状不够：`2026-13` 会被 Date 卷成次年 1 月，端上拿到的是"有 31 天的 13 月"
  if (!MONTH_RE.test(key) || Number(key.slice(5)) < 1 || Number(key.slice(5)) > 12) {
    throw new AppError(400, `月份格式必须是 YYYY-MM（收到「${month}」）`);
  }

  const monthKeys = monthDateKeys(key);
  // 查询与下发都扩到「当月 ± PAD_DAYS」：端上的补位格要能查到相邻月那几天的真实状态
  const dates = [
    ...Array.from({ length: PAD_DAYS }, (_, i) => shiftDateKey(monthKeys[0], -(PAD_DAYS - i))),
    ...monthKeys,
    ...Array.from({ length: PAD_DAYS }, (_, i) => shiftDateKey(monthKeys[monthKeys.length - 1], i + 1)),
  ];
  const [rows, state] = await Promise.all([
    PointSigninModel.find({ userId, dateKey: { $gte: dates[0], $lte: dates[dates.length - 1] } })
      .select({ dateKey: 1, streakDay: 1 }).lean(),
    // 只借它的 cells 当判据，顺带拿到今天的位置
    getSigninState(userId, now),
  ]);
  const stored = new Map(rows.map((r) => [r.dateKey, r.streakDay]));
  const cellByKey = new Map(state.cells.map((c) => [c.dateKey, c]));
  const todayCell = cellByKey.get(todayKey);
  // 未来日推算基准：今天接得上的链长（今天有行取今天库存值，没签取「今天若签」的位置）
  const base = stored.get(todayKey) ?? todayCell?.streakDay ?? state.streakDay;

  const days = dates.map<CalendarDay>((dateKey) => {
    const s = stored.get(dateKey);
    if (s !== undefined) return { dateKey, state: 'signed', streakDay: s, reward: rewardForStreakDay(s) };
    if (dateKey > todayKey) {
      const pos = base + daysBetween(todayKey, dateKey);
      return { dateKey, state: 'future', streakDay: pos, reward: rewardForStreakDay(pos) };
    }
    if (dateKey === todayKey) {
      return { dateKey, state: 'today', streakDay: base, reward: rewardForStreakDay(base) };
    }
    const cell = cellByKey.get(dateKey);
    if (cell?.state === 'makeup') {
      return { dateKey, state: 'makeup', streakDay: cell.streakDay, reward: cell.reward };
    }
    return { dateKey, state: 'missed', streakDay: 0, reward: 0 };
  });

  return { month: key, today: todayKey, days };
}
