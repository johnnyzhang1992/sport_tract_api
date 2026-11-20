/**
 * 签到格规划（2026-11-20 去掉日期窗口）。
 *
 * **历史**：原先是「七格窗口 [今天-6, 今天]」，窗口外的漏签日一律不可补（标 missed）。
 * 用户裁定取消该限制——**任何过去的漏签日都可以用补签卡补**，理由：
 *   - 补签卡 99 分/张，补回来最多 7 分/天，本身就是净亏，不存在靠补签刷分
 *   - 每日积分上限 100 分，攒够补一年的卡（365 张 = 36135 分）需要连续 361 天不间断，
 *     造假成本比自己老实签还高
 *   - 旧窗口挡的是「忘签几天想补」的正常用户，而不是作弊者
 *
 * **保留的闸门**：至少有一个已签行才谈得上补（`hasAnySigned`）——
 * 新用户不能凭卡从零买连签，这是产品语义（补签 = 接上已有记录），与经济性无关。
 *
 * 现在的可补范围 = `[第一个可补日, 今天]`：从最早的断点开始，跨过所有漏签日到今天。
 * 起点不再有下界，因此调用方要读该用户**全部**签到行（实际量很小：一天一行）。
 * 纯函数：不查库。
 */
import { POINTS } from '../config/points.js';
import { daysBetween, rewardForStreakDay, shiftDateKey } from './points-domain.js';

export { shiftDateKey } from './points-domain.js';

export const WINDOW_DAYS = 7;
const MAX_GAP_DAYS = POINTS.MAX_MAKEUP_GAP_DAYS;

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

/**
 * 展示/可补的最早一日。
 *
 * 已无日期窗口，起点由**数据**决定：从今天往回走到第一个断点（连续已签段之前）即可。
 * 保留本函数是为了给调用方一个「查询下界」——传 null 表示没有已签行，返回今天（无补签可言）。
 *
 * @param earliestSigned 该用户最早的一条签到日期（YYYY-MM-DD），没有则 null
 */
export function windowStartKey(todayKey: string, earliestSigned: string | null = null): string {
  if (!earliestSigned) return todayKey;
  // 起点不早于最早已签日：再往前既无记录也无从补起（没有可接的链条）
  return earliestSigned > todayKey ? todayKey : earliestSigned;
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

  /*
   * 前提闸门（保留）：至少有一个「今天或之前」的已签行才谈得上补。
   * 新用户不能凭卡从零买连签——补签的语义是「接上已有记录」，与经济性无关。
   */
  const hasAnySigned = signed.size > 0;

  /*
   * 可补集合（2026-11-20 去掉日期窗口）：**今天之前、没有签到行的日子全部可补**，
   * 不限于「最早已签日之后」——用户裁定「进入之前的日期也全部可补」。
   * 唯一的闸门是有过签到记录（hasAnySigned），防止新用户凭卡从零买连签。
   *
   * 注意：这里只影响**七格内的 makeup 标记**（展示范围固定最近 7 天）；
   * 7 格外的历史日期由月历接口与 useMakeupCard 直接按日期判定，不经过本函数。
   */
  const makeupable = new Set<string>();
  if (hasAnySigned) {
    for (let cur = shiftDateKey(todayKey, -(WINDOW_DAYS - 1)); cur < todayKey; cur = shiftDateKey(cur, 1)) {
      if (!signed.has(cur)) makeupable.add(cur);
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
  /*
   * 展示范围仍固定为**最近 7 天**（今天 + 前 6 天），与改动前一致。
   *
   * 为什么不铺满全部历史：这 7 格是积分页顶部的「等分横条」（.signin-strip 是 flex:1 等分），
   * 格子数一变就会挤成一团。**可补范围**已经放开到「任意过去日期」，但那由
   * getSigninCalendar 按月判定、由 useMakeupCard 按日期校验，不需要靠这 7 格承载。
   */
  const start = shiftDateKey(todayKey, -(WINDOW_DAYS - 1));

  const todayPos = positionIfSigned(todayKey);
  const cells: SigninCell[] = [];
  for (let i = 0; i < WINDOW_DAYS; i += 1) {
    const dateKey = shiftDateKey(start, i);
    const row = signed.get(dateKey);
    if (row !== undefined) {
      // 已签格照库存值下发：窗口里重算会把连签 30 天压成 1..7（§6.1 说收敛由写路径负责）。
      // 分值一律名义分 min(streakDay,7)（Ruling 2026-10-25 改回名义分，spec §5.1）：补差是
      // 按今天入账的聚合流水（makeup_topup），摊不回该日 points；钱的真相在积分明细页，
      // 格子负责讲规则，被每日上限截断的少见情形也不该让格子少报主路径的补差结果。
      cells.push({ dateKey, state: 'signed', streakDay: row.streakDay, reward: rewardForStreakDay(row.streakDay) });
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
    }
    /*
     * 这里原本还有 future 分支（未来日按「一路签下去」推算分值），用于旧的七格窗口
     * 把窗口右界延伸到未来的场景。2026-11-20 循环改为只到今天，该分支已不可达，故移除。
     * `future` 仍保留在 CellState 类型里：/points/signin/calendar 的跨月补位格会让它复活。
     */
  }
  return cells;
}

/**
 * 某天「若签上」应有的连签位置（第几天）。
 *
 * 给补签写路径用：取消日期窗口后，补签日可能在 7 格之外，拿不到 state.cells，
 * 于是直接按库里的行推算——往左走到段首，段首有库存 streakDay 就取它作锚点，
 * 否则按 1 起（与 planSigninCells 内部 positionIfSigned 同一口径，避免两套算法）。
 *
 * @param rows 该用户今天及之前的全部签到行
 * @param key  要计算的日期
 */
export function streakPositionOf(rows: SignedRow[], key: string): number {
  const signed = new Map<string, SignedRow>();
  for (const r of rows) signed.set(r.dateKey, r);
  let start = key;
  let prev = shiftDateKey(start, -1);
  while (signed.has(prev)) {
    start = prev;
    prev = shiftDateKey(start, -1);
  }
  const anchor = signed.has(start) ? (signed.get(start) as SignedRow).streakDay : 1;
  return anchor + daysBetween(start, key);
}

