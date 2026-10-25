/**
 * 七格规划（需求 §4 改版）：窗口 = [今天-6, 今天]，最后一格必含今天；
 * 窗口内「断签 ≤2 天」的漏签日标成可补格，起点按最早可补日 / 当前连签段起点取最早，
 * 且被窗口左界（今天-6）兜住（窗口必须罩住今天，起点不会滑到今天之后）。
 * 纯函数：不查库。调用方需读 [今天-6-PROBE_DAYS, 今天] 的行，段长才不会被窗口左边界骗过。
 */
import { POINTS } from '../config/points.js';
import { rewardForStreakDay, shiftDateKey } from './points-domain.js';

export { shiftDateKey } from './points-domain.js';

export const WINDOW_DAYS = 7;
export const MAX_GAP_DAYS = 2;
/** 段长判定要往窗口左边界之外多读的天数：>MAX_GAP_DAYS 即判不可补，探 3 天足够 */
export const PROBE_DAYS = MAX_GAP_DAYS + 1;
void POINTS; // brief 口径声明本模块 Consumes POINTS；分值封顶由 rewardForStreakDay 承担，此处保留引用待后续任务取用

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

  /** 以 key 结尾的连续已签天数（extra 视作「假想已签」，用于算补完后的位置）；
   *  只认「有没有行」，行里的 streakDay 可能是并发失真值，分值位置按本函数现算（设计 §6.1 读路径口径）。 */
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
  const probeFloor = shiftDateKey(left, -PROBE_DAYS);
  // 再往下一天只为核验「边界上有没有已签日」（锚点恰好落在 probeFloor 前一天时也要抓到，见 MW7）；
  // 那以下没有行可读，左侧探到那里还没遇到已签日，就按「段头空白」处理（见下），不再多看。
  const scanFloor = shiftDateKey(probeFloor, -1);
  /**
   * 含 d 的未签段信息（段内不含今天）：
   * - 左侧探到已签日（anchored）：段长 = 左侧探过的漏签日 + d + 右侧连续漏签日；
   * - 左侧探到 scanFloor 也没已签日（段头空白：那之前用户没签过）：左侧不计，
   *   该日先进 headWindowDays，由「窗口内段头总长 + 连签链是否已断」两条件再判（见下）。
   */
  const gapRunOf = (d: string): { length: number; anchored: boolean } => {
    let leftMissed = 0;
    let anchored = false;
    for (let cur = shiftDateKey(d, -1); cur >= scanFloor; cur = shiftDateKey(cur, -1)) {
      if (signed.has(cur)) {
        anchored = true;
        break;
      }
      leftMissed += 1;
    }
    let n = 1;
    for (let cur = shiftDateKey(d, 1); cur < todayKey && !signed.has(cur); cur = shiftDateKey(cur, 1)) {
      n += 1;
    }
    return { length: anchored ? n + leftMissed : n, anchored };
  };

  const hasSignedInWindow = [...signed.keys()].some((k) => k >= left && k <= todayKey);
  const makeupable = new Set<string>();
  const headWindowDays: string[] = [];
  if (hasSignedInWindow) {
    for (let i = WINDOW_DAYS - 1; i >= 1; i -= 1) {
      const d = shiftDateKey(todayKey, -i);
      if (signed.has(d)) continue;
      const run = gapRunOf(d);
      if (!run.anchored) {
        headWindowDays.push(d);
        continue;
      }
      if (run.length <= MAX_GAP_DAYS) makeupable.add(d);
    }
    // 段头空白（首个已签日之前的漏签日）：窗口内合计 ≤MAX_GAP_DAYS 天、且连签链已断（昨天没签）时，
    // 才视同真实漏签段（用户算例：漏 19 签 20-23、24 又漏 → 19 可补；MW1/MW7）。
    // 链没断（昨天签了）时段头算「还没开始签」，不开补签入口（MW2：漏 19/20、签满 21-24 → 无补签格）。
    const chainBroken = !signed.has(shiftDateKey(todayKey, -1));
    if (chainBroken && headWindowDays.length <= MAX_GAP_DAYS) {
      for (const d of headWindowDays) makeupable.add(d);
    }
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
  const candidates = [runStart, ...makeupable];
  const startCand = candidates.reduce((a, b) => (a < b ? a : b));
  const start = startCand < left ? left : startCand;

  const todayPos = positionIfSigned(todayKey);
  const cells: SigninCell[] = [];
  for (let i = 0; i < WINDOW_DAYS; i += 1) {
    const dateKey = shiftDateKey(start, i);
    const stored = signed.get(dateKey);
    if (stored !== undefined) {
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
