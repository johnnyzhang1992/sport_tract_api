/**
 * 七格规划（需求 §4 改版）：窗口 = [今天-6, 今天]，最后一格必含今天；
 * 窗口内「断签 ≤2 天」的漏签日标成可补格，起点按最早可补日 / 当前连签段起点取最早，
 * 且被窗口左界（今天-6）兜住（窗口必须罩住今天，起点不会滑到今天之后）。
 * 段长只数窗口内的日子（Ruling 2026-10-25，spec §4.1 第 3/4 条）：左界截到今天-6、右界截到今天，
 * 不往窗口外读，所以调用方只需读 [今天-6, 今天] 这 7 天的行。
 * 纯函数：不查库。
 */
import { rewardForStreakDay, shiftDateKey } from './points-domain.js';

export { shiftDateKey } from './points-domain.js';

export const WINDOW_DAYS = 7;
export const MAX_GAP_DAYS = 2;

export type CellState = 'signed' | 'today' | 'makeup' | 'missed' | 'future';

export interface SignedRow {
  dateKey: string;
  streakDay: number;
}

export interface SigninCell {
  dateKey: string;
  state: CellState;
  streakDay: number;
  reward: number;
  /** 仅 makeup 格：补上这一天之后，今天那格能拿几分（弹窗文案用，前端不自己推） */
  todayRewardAfter?: number;
}

export function windowStartKey(todayKey: string): string {
  return shiftDateKey(todayKey, -(WINDOW_DAYS - 1));
}

export function planSigninCells(rows: SignedRow[], todayKey: string): SigninCell[] {
  const signed = new Map<string, number>();
  for (const r of rows) if (r.dateKey <= todayKey) signed.set(r.dateKey, r.streakDay);

  /** 以 key 结尾的连续已签天数（extra 视作「假想已签」，用于算补完后的位置）。
   *  只用于没有行的格（today/makeup/future）——那些格没有库存值可取，只能按行存在性现算。 */
  const streakAt = (key: string, extra: string[] = []): number => {
    let n = 0;
    let cur = key;
    while (signed.has(cur) || extra.includes(cur)) {
      n += 1;
      cur = shiftDateKey(cur, -1);
    }
    return n;
  };
  /** key 这天若签到，会排在连续段第几天 */
  const positionIfSigned = (key: string, extra: string[] = []): number =>
    streakAt(shiftDateKey(key, -1), extra) + 1;

  const left = windowStartKey(todayKey);
  /**
   * 含 d 的未签段长度（spec §4.1 第 3 条）：向两侧数没有签到行的日子，
   * 左界截到窗口左缘 `left`、右界截到今天（今天没签不算漏签日），遇到已签日即停。
   * 超过 MAX_GAP_DAYS 就提前退出——调用方只读窗口内的行，窗外无从判断也无需判断。
   */
  const gapRunLength = (d: string): number => {
    let n = 1;
    for (let cur = shiftDateKey(d, -1); cur >= left && !signed.has(cur); cur = shiftDateKey(cur, -1)) {
      n += 1;
      if (n > MAX_GAP_DAYS) return n;
    }
    for (let cur = shiftDateKey(d, 1); cur < todayKey && !signed.has(cur); cur = shiftDateKey(cur, 1)) {
      n += 1;
      if (n > MAX_GAP_DAYS) return n;
    }
    return n;
  };

  // 全空窗口（全新用户）不用另设闸门：段长=6 > MAX_GAP_DAYS，天然没有可补格（spec §4.1 第 5 条）。
  const makeupable = new Set<string>();
  for (let i = WINDOW_DAYS - 1; i >= 1; i -= 1) {
    const d = shiftDateKey(todayKey, -i);
    if (!signed.has(d) && gapRunLength(d) <= MAX_GAP_DAYS) makeupable.add(d);
  }

  // 当前连签段起点（§4.3）：从今天往回最晚的已签日出发，回走到断口；库里没行时取今天
  let lastSigned: string | null = null;
  for (const k of signed.keys()) if (lastSigned === null || k > lastSigned) lastSigned = k;
  let runStart = todayKey;
  if (lastSigned !== null) {
    let cur = lastSigned;
    while (signed.has(cur)) cur = shiftDateKey(cur, -1);
    runStart = shiftDateKey(cur, 1);
  }
  // dateKey 是 'YYYY-MM-DD' 串，取最早一日必须按字符串比，Math.min 会算出 NaN
  const startCand = [runStart, ...makeupable].reduce((a, b) => (a < b ? a : b));
  const start = startCand < left ? left : startCand;

  const todayPos = positionIfSigned(todayKey);
  const cells: SigninCell[] = [];
  for (let i = 0; i < WINDOW_DAYS; i += 1) {
    const dateKey = shiftDateKey(start, i);
    const stored = signed.get(dateKey);
    if (stored !== undefined) {
      // signed 格有意取库存 streakDay 现算分值（spec §6.1）：窗口内按行存在性递推会把连签 30 天
      // 截成 1..7，反而毁掉每日分值与「已连续 N 天」文案；失真只来自交错写，下一次写路径的
      // reconcileStreaks 会把库存修回来（Task 2 负责收敛）。
      cells.push({ dateKey, state: 'signed', streakDay: stored, reward: rewardForStreakDay(stored) });
    } else if (dateKey === todayKey) {
      cells.push({ dateKey, state: 'today', streakDay: todayPos, reward: rewardForStreakDay(todayPos) });
    } else if (dateKey < todayKey) {
      if (makeupable.has(dateKey)) {
        const pos = positionIfSigned(dateKey);
        cells.push({
          dateKey,
          state: 'makeup',
          streakDay: pos,
          reward: rewardForStreakDay(pos),
          todayRewardAfter: rewardForStreakDay(positionIfSigned(todayKey, [dateKey])),
        });
      } else {
        cells.push({ dateKey, state: 'missed', streakDay: 0, reward: 0 });
      }
    } else {
      // 未来格：以今天格的位置起（今天已签则以今天实际 streakDay）按一路签下去预测
      const base = signed.has(todayKey) ? (signed.get(todayKey) as number) : todayPos;
      const pos = base + (i - daysBetween(start, todayKey));
      cells.push({ dateKey, state: 'future', streakDay: pos, reward: rewardForStreakDay(pos) });
    }
  }
  return cells;
}

/** 两个 dateKey 相差的自然天数（b - a，可为负） */
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}
