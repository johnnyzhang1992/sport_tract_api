/**
 * 榜单发分专用的可信轨迹聚合（spec §7：发分口径比展示榜多四道防刷判据）。
 * - 四道判据：疑似搭车（vehicleMs>0）、漂移超标（driftScore>DRIFT_SCORE_PB_GATE）、
 *   配速不合理（avgPace<MIN_PLAUSIBLE_PACE_SEC_PER_KM）、未纠偏（corrected:false），
 *   任一命中都不计入发分距离。
 * - vehicleMs/driftScore/corrected 用 $not/$gt（或 $ne）惯用法（与 leaderboard.ts :260、
 *   :279-281 同源）：缺字段的老文档＝可信，判据写成 $lte/$gte-缺省可省形态会把它们全排掉。
 * - avgPace 对「会算配速」的类型是强要求（$gte，缺失/null 不计），与上面相反——没有可信
 *   配速就不发分，这个不对称是 spec 拍板的，test/points-board.test.ts BR-2/BR-2b 分别钉两侧。
 * - 但配速判据必须按类型生效：游泳/骑行的 avgPace 由 utils/pace.ts 设计为恒 null，
 *   若照旧套 $gte 就把这两类永久挡在发分之外（榜面永远空、§4.8「各运动类型的全国榜按
 *   总距离排名，前三名获得积分」变假话）。豁免表用 pace.ts 导出的 NO_PACE_TYPES/hasNoPace，
 *   不在本文件另抄一份，其余三道判据对所有类型一律照旧生效。
 * - 本文件建发分查询 + 结算数学（门槛/并列/每人 3 榜上限/单榜总额截断）；发分接线与台账是后续任务。
 *   **不改 leaderboard() 的展示口径**（榜面与发分结果可能不一致，由规则页文案说明），
 *   也不做省份过滤（发分是全平台口径）。
 */
import type { Types } from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import { DRIFT_SCORE_PB_GATE, MIN_PLAUSIBLE_PACE_SEC_PER_KM } from '../config/constants.js';
import { hasNoPace } from '../utils/pace.js';

export interface BoardCandidate {
  userId: string;
  distance: number;
}

/** 与类型无关的三道判据（缺字段＝可信） */
const BASE_TRUSTED_MATCH = {
  status: 'finished',
  vehicleMs: { $not: { $gt: 0 } },
  driftScore: { $not: { $gt: DRIFT_SCORE_PB_GATE } },
  corrected: { $ne: false },
};

/**
 * 该类型的可信判据：配速判据只对会算配速的类型加（见文件头）。
 * 加了它就要接受：跑步/步行等短行（distance < MIN_PACE_DISTANCE_M，pace.ts 里 avgPace 也是
 * null）继续被挡在发分之外——短到跑不出可信配速的轨迹不发分，是有意的。
 */
function trustedMatch(type: string) {
  return hasNoPace(type)
    ? BASE_TRUSTED_MATCH
    : { ...BASE_TRUSTED_MATCH, avgPace: { $gte: MIN_PLAUSIBLE_PACE_SEC_PER_KM } };
}

/** 某类型某窗口 [startMs, endMs) 内「可信总距离」降序的用户榜（发分口径，比展示多四道判据） */
export async function trustedBoardRows(
  type: string,
  startMs: number,
  endMs: number,
): Promise<BoardCandidate[]> {
  const rows = await ActivityModel.aggregate<{ _id: Types.ObjectId; distance: number }>([
    { $match: { ...trustedMatch(type), type, startTime: { $gte: startMs, $lt: endMs } } },
    { $group: { _id: '$userId', distance: { $sum: '$distance' } } },
    { $sort: { distance: -1 } },
  ]);
  return rows.map((r) => ({ userId: String(r._id), distance: r.distance }));
}

/* ==========================================================================
 * 结算数学（Task 5）：门槛 → 名次/并列 → 单榜总额上限 → 每人 3 榜上限。
 * 纯函数，不碰库、不碰时钟：输入是 trustedBoardRows 出来的行，输出是「谁、哪个榜、
 * 第几名、发多少」。发分本身（幂等抢锁 + 流水 + 通知）是 Task 7 的 settlePeriod。
 * ========================================================================= */

/** 一条发放结果：一个用户在某个榜上的一个名次 */
export interface BoardReward {
  userId: string;
  /** 榜单所属运动类型（同一期内区分「哪个榜」的唯一标识） */
  type: string;
  /** 竞赛排名（并列后名次跳过：1,1,1,4） */
  rank: number;
  points: number;
}

export type BoardPeriod = 'week' | 'month' | 'year';

export interface PlanOpts {
  /** 各周期 TOP1/2/3 分值（spec §3 D4：周 50/30/20、月 100/80/50、年 500/400/300） */
  rewards: Record<BoardPeriod, [number, number, number]>;
  /** 单榜参与人数**严格大于**该值才发（D2「超过 10 人才发」；恰好 10 人不发＝产品拍板） */
  minParticipants: number;
  /** 同一期每人最多计 N 个榜（D5，取分值最高的 N 个） */
  perUserBoards: number;
  /** 单榜发放总额 ≤ 该榜 TOP3 之和 × 该系数（D10 保留意见；产品要调就调这个数字） */
  perBoardCapFactor: number;
}

/**
 * 单榜结算：门槛 → 并列名次 → 总额上限截断。
 *
 * - 门槛：rows.length **>** minParticipants 才发（一个用户一行，rows.length 就是参与人数）。
 * - 并列：同距离＝同名次同分值（D10「并列都发」），名次按竞赛排名跳过（1,1,3）。
 * - 每人只在本榜拿一条，所以 out.length 就是"已发放的条数"；闸门 `out.length < 3` 让
 *   TOP3 之外只有并列组能把条数推过 3（并列不许砍人）。
 * - 总额上限：cap = TOP3 之和 × perBoardCapFactor；判据是 `>`（恰好顶格照发）。
 *   超限的并列组**整组**丢弃并就地停榜——不留组内先后的部分发放，否则同分的人
 *   一个拿钱一个不拿，直接违反「并列都发」；停榜而不是继续发后面的人，是因为
 *   差名次不该比被截掉的好名次先拿到钱。
 */
function planOneBoard(
  type: string,
  rows: BoardCandidate[],
  reward: [number, number, number],
  opts: PlanOpts,
): BoardReward[] {
  if (rows.length <= opts.minParticipants) return [];
  const cap = (reward[0] + reward[1] + reward[2]) * opts.perBoardCapFactor;
  // 只按距离降序做一次**稳定**排序：并列的定义是「距离相等」，同距离的行必须相邻才认得出。
  // 除距离外不加任何第二把尺（不比 createdAt、不比 userId 大小）——同分行原样保留调用方给的先后。
  const sorted = [...rows].sort((a, b) => b.distance - a.distance);
  const out: BoardReward[] = [];
  let spent = 0;
  let i = 0;
  while (i < sorted.length && out.length < 3) {
    const rank = i + 1;
    // 走到这里 rank 只会是 1..3（每组至少发一条，闸门在 out.length），
    // Math.min 是兜底：分值表只有三档，别让哪天动动手就把下标越界发成 undefined
    const points = reward[Math.min(rank - 1, 2)];
    const tied = [sorted[i]];
    for (let j = i + 1; j < sorted.length && sorted[j].distance === tied[0].distance; j += 1) {
      tied.push(sorted[j]);
    }
    if (spent + tied.length * points > cap) break;
    for (const t of tied) out.push({ userId: t.userId, type, rank, points });
    spent += tied.length * points;
    i += tied.length;
  }
  return out;
}

/**
 * 每人 3 榜上限（D5）：把各榜结果摊平，同一用户在同期最多保留**分值最高的 N 个榜**，
 * 第 N+1 个起一条不发。
 *
 * - 只数"真拿到分的榜"：在某个榜排到第 4 名（压根没进 perBoard）不占额度；
 *   被总额上限截断的榜发的是空数组，同样不占额度（PR-7 钉这条顺序）。
 * - 选榜排序键：**分值降序 → type 名码点升序**。用码点而不是 localeCompare，是因为后者
 *   随运行环境的区域设置变；结算必须可重放（同一批输入两次跑逐字节相同，台账与撤回才对得上）。
 *   这个顺序是裁定里"分值相同必须可重放"的显式选择：按 type 名（码点）升序保留。
 * - 保留标记用对象身份而不是 `type:userId` 拼键：上游 $group 保证一个用户在一个榜里只有一行，
 *   但真出现重复行时拼键会把重复的一起放过（上限该数"榜"还是数"条"就说不清了）。
 * - 输出顺序＝榜的入参顺序 → 榜内名次顺序，不随分值重排（Task 7 逐条发分时对账更好做）。
 */
export function flattenWithPerUserCap(
  perBoard: ReadonlyMap<string, BoardReward[]>,
  perUserBoards: number,
): BoardReward[] {
  const all: BoardReward[] = [];
  for (const rows of perBoard.values()) for (const r of rows) all.push(r);

  const byUser = new Map<string, BoardReward[]>();
  for (const r of all) {
    const list = byUser.get(r.userId);
    if (list) list.push(r);
    else byUser.set(r.userId, [r]);
  }

  const keep = new Set<BoardReward>();
  const limit = Math.max(0, perUserBoards);
  for (const list of byUser.values()) {
    for (const r of pickBestBoards(list).slice(0, limit)) keep.add(r);
  }
  return all.filter((r) => keep.has(r));
}

/** 分值降序 → type 码点升序（稳定：同分值同 type 的行保持原顺序） */
function pickBestBoards(list: BoardReward[]): BoardReward[] {
  return [...list].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (a.type === b.type) return 0;
    return a.type < b.type ? -1 : 1;
  });
}

/**
 * 一个周期（week/month/year）一整期 8 个榜的结算：返回该发的每一条。
 * 入参 boards 的 rows 已由 trustedBoardRows 过完四道防刷判据并按 Σ距离降序；
 * 本函数**不再做任何可信过滤**，也不按距离以外的字段重排（见 planOneBoard 的注释）。
 */
export function planPeriodRewards(
  period: BoardPeriod,
  boards: Array<{ type: string; rows: BoardCandidate[] }>,
  opts: PlanOpts,
): BoardReward[] {
  const reward = opts.rewards[period];
  const perBoard = new Map<string, BoardReward[]>();
  for (const b of boards) {
    // 同一个 type 传两次＝后写的榜覆盖先写的（不是双发）；调用方按 ACTIVITY_TYPES 传 8 个
    // 互不相同的类型，真传重了属于上游 bug，这里不静默合并两份榜
    perBoard.set(b.type, planOneBoard(b.type, b.rows, reward, opts));
  }
  return flattenWithPerUserCap(perBoard, opts.perUserBoards);
}
