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
 * - 本文件建发分查询 + 结算数学（门槛/并列全发/每人 3 榜上限）+ 台账抢锁原语（Task 6 末尾一段）。
 *   发分本身（creditPoints/通知/文案）仍是 Task 7 的 settlePeriod，本文件不含任何结算编排。
 *   **不改 leaderboard() 的展示口径**（榜面与发分结果可能不一致，由规则页文案说明），
 *   也不做省份过滤（发分是全平台口径）。
 */
import type { Types } from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import {
  BoardSettlementModel,
  BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID,
  type BoardSettlementStatus,
} from '../models/point.model.js';
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
 * 结算数学（Task 5）：门槛 → 名次/并列（全发）→ 每人 3 榜上限。
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
}

/**
 * 单榜结算：门槛 → 并列名次 → 并列组整组照发。
 *
 * - 门槛：rows.length **>** minParticipants 才发（一个用户一行，rows.length 就是参与人数）。
 * - 并列：同距离＝同名次同分值（D10「并列都发」），名次按竞赛排名跳过（1,1,3）。
 * - 每人只在本榜拿一条，所以 out.length 就是"已发放的条数"；闸门 `out.length < 3` 让
 *   TOP3 之外只有并列组能把条数推过 3（并列不许砍人）。
 */
function planOneBoard(
  type: string,
  rows: BoardCandidate[],
  reward: [number, number, number],
  opts: PlanOpts,
): BoardReward[] {
  if (rows.length <= opts.minParticipants) return [];
  // 并列全发，无单榜总额上限（2026-10-29 用户裁定）——勿再引入 cap/截断，周榜 5 人并列第 1 就发 5×50＝250
  // 只按距离降序做一次**稳定**排序：并列的定义是「距离相等」，同距离的行必须相邻才认得出。
  // 除距离外不加任何第二把尺（不比 createdAt、不比 userId 大小）——同分行原样保留调用方给的先后。
  const sorted = [...rows].sort((a, b) => b.distance - a.distance);
  const out: BoardReward[] = [];
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
    for (const t of tied) out.push({ userId: t.userId, type, rank, points });
    i += tied.length;
  }
  return out;
}

/**
 * 每人 3 榜上限（D5）：把各榜结果摊平，同一用户在同期最多保留**分值最高的 N 个榜**，
 * 第 N+1 个起一条不发。
 *
 * - 只数"真拿到分的榜"：在某个榜排到第 4 名（压根没进 perBoard）不占额度；
 *   没过人数门槛的榜发的是空数组，同样不占额度（PR-7 钉这条顺序）。
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

/* ==========================================================================
 * 台账抢锁原语（Task 6）：只交付「一张表 + 四个原语」，不含结算编排。
 *
 * planPeriodRewards 算的是「该发谁」；「这笔到底发没发过」一律由 boardsettlements 那行台账裁决
 * （见 models/point.model.ts 的注释）。Task 7 的 settlePeriod 循环体应当是：
 *   claimBoardSettlement(...) → won 才 creditPoints(...) → flipBoardSettlementToCredited(key, recordId)
 * 摘掉任意一步的症状（每条都在 test/points-board.test.ts 里复现过红，见 task-6-report 的变异矩阵）：
 * - 少抢锁、或不把 E11000 当败者路径吃掉：并发两个请求各领一次发放权（双发），
 *   或整批结算被一条重复键异常打断（M1/M3）；
 * - 翻牌的条件里少了 status='pending'：同一行能被领两次发放权（M2）；
 * - 干脆不翻牌：钱发出去了但台账永远停在 pending，Task 10 的撤回与对账拿不到终态。
 *
 * E11000 的口径沿用本仓约定（points-ledger.ts:69 / points-tasks.ts:44 / points-items.ts:119 同一份）：
 * 撞唯一键是**预期的败者路径**，吃掉它并回传已存在的行，绝不冒成异常——一期是 8 个榜 × 多名次的
 * 批量结算，一条重复如果炸出来会把整批打断（brief 里 BS-1 的「必须是 no-op 不是 error」）。
 * ========================================================================= */

const DUPLICATE_KEY = 11000;

/** 与仓内其它四处同名的私有判定：只有 E11000 才是「别人已经占了这一行」，其它错误照抛 */
function isDuplicateKey(e: unknown): boolean {
  return (e as { code?: number } | null)?.code === DUPLICATE_KEY;
}

/** 台账一行的定位键＝那条唯一索引的四元组，一个不少也不能多 */
export interface BoardSettlementKey {
  /** 榜单的运动类型（trustedBoardRows 的入参那个 type） */
  type: string;
  period: BoardPeriod;
  /** 周＝该周周一 '2026-10-19'，月＝'2026-10'，年＝'2026' */
  periodKey: string;
  userId: string;
}

/** 整榜级（skipped）占位行的键：没有 userId，由哨兵值补上 */
export type BoardSettlementBoardKey = Omit<BoardSettlementKey, 'userId'>;

/** 台账行的读取形状（lean）。抢锁失败时把它带回给调用方留痕/对账 */
export interface BoardSettlementRow {
  _id: Types.ObjectId;
  type: string;
  period: BoardPeriod;
  periodKey: string;
  userId: Types.ObjectId;
  rank: number;
  points: number;
  status: BoardSettlementStatus;
  reason: string;
  recordId: Types.ObjectId | null;
}

function boardRowFilter(key: BoardSettlementKey): Record<string, unknown> {
  return { type: key.type, period: key.period, periodKey: key.periodKey, userId: key.userId };
}

async function findBoardSettlementRow(filter: Record<string, unknown>): Promise<BoardSettlementRow | null> {
  return (await BoardSettlementModel.findOne(filter).lean()) as BoardSettlementRow | null;
}

/**
 * 抢锁：为「某榜 · 某期 · 某人」落一行 status='pending' 的台账。
 * - won=true → 本次调用拿到发放权（这一行刚由本次插入，别的请求必然撞键）；
 * - won=false → 已经有行（并发对手刚抢到 / 上一期已发过 / 已跳过 / 已撤回），
 *   本次**安静跳过**并把 existing 带回：既不能再发一笔，也不能抛错。
 *
 * pending 是「锁持有中」的中间态：拿到 won 不等于发完了钱，还要走
 * flipBoardSettlementToCredited 才算真正取得发放权（崩在中间留下的 pending 行会继续占键，
 * 这是已知敞口，Task 7 要在失败路径处理：删行或加超时接管，BS-1b 末尾把现状钉着）。
 *
 * existing 只在 won=false 时回读，且可能是 null：败者撞键之后、回读之前那一行被删掉（后台清理）。
 * 调用方只许拿它做留痕/对账，不许拿它当「一定有一行」的依据再往下发钱。
 */
export async function claimBoardSettlement(
  key: BoardSettlementKey,
  reward: { rank: number; points: number },
): Promise<{ won: boolean; existing: BoardSettlementRow | null }> {
  try {
    await BoardSettlementModel.create({ ...key, ...reward, status: 'pending' });
    return { won: true, existing: null };
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    return { won: false, existing: await findBoardSettlementRow(boardRowFilter(key)) };
  }
}

/**
 * 翻牌：pending → credited，条件里带 status='pending'。
 * 返回 null 表示一行都没被翻动：这行已经不是 pending（并发对手翻走了 / 运营已撤回 /
 * 上次留下的终态行），调用方必须放弃发放——「一次抢锁只许发一笔」的第二道闸。
 * recordId 一并写入：Task 10 撤回时按它反向冲销 pointrecords 那笔流水。
 */
export async function flipBoardSettlementToCredited(
  key: BoardSettlementKey,
  /** pointrecords._id。Task 7 从 creditPoints 落下的流水拿（现签名只回 credited/balance，见报告接口缺口） */
  recordId?: string | Types.ObjectId,
): Promise<BoardSettlementRow | null> {
  const set: Record<string, unknown> = { status: 'credited' };
  if (recordId) set.recordId = recordId;
  return (await BoardSettlementModel
    .findOneAndUpdate({ ...boardRowFilter(key), status: 'pending' }, { $set: set }, { new: true })
    .lean()) as BoardSettlementRow | null;
}

/**
 * 整榜级占位：某榜没越过人数门槛时写一行 skipped（哨兵 userId、rank/points 均 0）。
 * 作用不是记账而是**占位**：下一次懒结算先 isBoardSettlementSkipped()，命中就整榜跳过，
 * 不必每次页面浏览都重跑一遍发分口径的聚合（一榜一个 aggregate，一期 8 个榜）。
 * 返回 false＝已有占位行（含并发撞键），是安静跳过不是抛错。
 */
export async function recordBoardSettlementSkipped(key: BoardSettlementBoardKey, reason: string): Promise<boolean> {
  try {
    await BoardSettlementModel.create({
      ...key,
      userId: BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID,
      rank: 0,
      points: 0,
      status: 'skipped',
      reason,
    });
    return true;
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    return false;
  }
}

/** 这个榜这一期是否已经判定过「人数不够」——命中就整榜跳过，不用重算聚合 */
export async function isBoardSettlementSkipped(key: BoardSettlementBoardKey): Promise<boolean> {
  return (await BoardSettlementModel.exists({
    ...key,
    userId: BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID,
    status: 'skipped',
  })) !== null;
}
