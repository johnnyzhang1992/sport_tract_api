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
  /**
   * 该日**实际入账**分（Ruling 2026-10-25，spec §5.1）：`signIn` 落的是被 `POINTS.DAILY_CAP`
   * 截断后的实发值，与名义分 `min(streakDay, 7)` 可以不同，格子必须报实际值。
   * 缺省（调用方没读这一列 / 旧数据）才回落名义值；`0` 是「那天确实一分没拿到」，如实报 0。
   */
  points?: number;
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
  const signed = new Map<string, SignedRow>();
  for (const r of rows) if (r.dateKey <= todayKey) signed.set(r.dateKey, r);

  /**
   * key 这天（`extra` 是「假想已签」的日子，用来算补完之后今天能排第几）在新链条上的位置。
   * 锚点口径（Ruling 2026-10-25）：先往左走到段首，段首若是真实签到行就取它的**库存 `streakDay`**
   * ——连签 30 天的人段首可能在窗口外，按「窗口里有行的天数」现数会把第 24 天数成第 1 天，
   * 补签的分值与封顶都会跟着算小；段首是空档之后第一天（或假想日本身）才按 1 起。
   * 库存值可信：写路径每次收尾都用同一个锚点口径校正（`reconcileStreaks`，设计 §6.1）。
   */
  const positionIfSigned = (key: string, extra: string[] = []): number => {
    let start = key;
    let prev = shiftDateKey(start, -1);
    while (signed.has(prev) || extra.includes(prev)) {
      start = prev;
      prev = shiftDateKey(start, -1);
    }
    const anchor = signed.has(start) ? (signed.get(start) as SignedRow).streakDay : 1;
    return anchor + daysBetween(start, key);
  };

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
    const row = signed.get(dateKey);
    if (row !== undefined) {
      // 已签格照库存值下发：窗口里重算会把连签 30 天压成 1..7（§6.1 说收敛由写路径负责）。
      // 分值取该日实际入账的 `points`（§5.1：被每日上限截断过就不能虚报），没带这一列才回落名义值。
      cells.push({
        dateKey,
        state: 'signed',
        streakDay: row.streakDay,
        reward: row.points ?? rewardForStreakDay(row.streakDay),
      });
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
      const base = signed.has(todayKey) ? (signed.get(todayKey) as SignedRow).streakDay : todayPos;
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
