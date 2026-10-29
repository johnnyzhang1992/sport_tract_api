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
 * - 本文件建发分查询 + 结算数学（门槛/并列全发/每人 3 榜上限）+ 台账抢锁原语 + **Task 7 的
 *   结算编排（settlePeriod / settleDueForUser）与 §4.8 定稿文案工具（boardLabel / boardPeriodTag）**。
 *   **不改 leaderboard() 的展示口径**（榜面与发分结果可能不一致，由规则页文案说明），
 *   也不做省份过滤（发分是全平台口径）。
 */
import type { Types } from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import {
  BoardSettlementModel,
  BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID,
  type BoardSettlement,
} from '../models/point.model.js';
import {
  ACTIVITY_TYPES,
  ACTIVITY_TYPE_META,
  DRIFT_SCORE_PB_GATE,
  MIN_PLAUSIBLE_PACE_SEC_PER_KM,
} from '../config/constants.js';
import { BOARD_REWARDS } from '../config/points.js';
import { creditPoints } from './points-ledger.js';
import { createNotification } from './notification.js';
import { bjDateStr, bjIsoWeekStart, bjMonthStart, bjYearMonth, bjYearStart, BJ_OFFSET_MS } from '../utils/bj-time.js';
import { AppError } from '../utils/app-error.js';
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

/**
 * 台账行的读取形状（lean）。**字段派生自模型导出的 infer 类型**（Task 6 评审收尾）：
 * schema 加字段时这里不再"手抄漂移"；_id/时间戳是 lean 读回来一定有的运行字段，补进交集。
 */
export type BoardSettlementRow = BoardSettlement & {
  _id: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
};

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
 * flipBoardSettlementToCredited 才算真正取得发放权。崩溃遗留的 pending 行不再永远占键
 * （Task 7 评审裁定 1 收口）：
 * - 失败路径由 settlePeriod 调 releaseBoardSettlementPending 当场删行；
 * - 当场删行也没删掉的（进程整个没了），updatedAt 落后超过 pendingStaleMs（10min）的
 *   pending 行在这里被**超时接管**（CAS 条件 status=pending，接管动作只刷新 rank/points
 *   并续期 updatedAt，状态照旧 pending——发放凭据仍然只有 flip 能给）。
 * 双接管也发不出两笔钱：creditPoints 对同一 idemKey 幂等（BS-1c 钉窗口，SP-11 端到端钉接管）。
 *
 * existing 只在 won=false 时回读，且可能是 null：败者撞键之后、回读之前那一行被删掉（后台清理）。
 * 调用方只许拿它做留痕/对账，不许拿它当「一定有一行」的依据再往下发钱。
 */
export async function claimBoardSettlement(
  key: BoardSettlementKey,
  reward: { rank: number; points: number },
  /** 结算侧的（可为假的）当前时刻；超时接管窗口与它比，测试才能用受控时钟演"进程死在半路" */
  now = Date.now(),
): Promise<{ won: boolean; existing: BoardSettlementRow | null }> {
  try {
    await BoardSettlementModel.create({ ...key, ...reward, status: 'pending' });
    return { won: true, existing: null };
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    const staleBefore = new Date(now - BOARD_REWARDS.pendingStaleMs);
    const taken = await BoardSettlementModel.findOneAndUpdate(
      { ...boardRowFilter(key), status: 'pending', updatedAt: { $lt: staleBefore } },
      { $set: { rank: reward.rank, points: reward.points } },
      { returnDocument: 'after' },
    ).lean();
    if (taken) return { won: true, existing: null };
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
    .findOneAndUpdate({ ...boardRowFilter(key), status: 'pending' }, { $set: set }, { returnDocument: 'after' })
    .lean()) as BoardSettlementRow | null;
}

/**
 * 释放发放锁（Task 7 评审裁定 1-i）：把**自己刚落下、还没翻牌**的那行 pending 删掉，
 * 让下一次重试能重新 create 抢锁。条件 deleteOne 只吃 status='pending'——
 * credited/skipped/revoked 是判决/终态，release 是失败路径，不是撤回工具（撤回归 Task 10），
 * 误删一行 credited 就等于给同一笔奖励开了二次发放的口子。
 * 返回 true＝删掉了自己那行；false＝行不存在或已离开 pending（不必然是错，别拿它当发放依据）。
 */
export async function releaseBoardSettlementPending(key: BoardSettlementKey): Promise<boolean> {
  const r = await BoardSettlementModel.deleteOne({ ...boardRowFilter(key), status: 'pending' });
  return r.deletedCount === 1;
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

/**
 * 这个榜这一期的「人数不够」占位还作不作数？——**skipped 是缓存，不是判决**（评审裁定 2）：
 * 导入/回填行没有 startTime 上限，占位落下之后参与人数 9→11 真实可能发生。
 * 有效期内（skippedFreshMs=24h）命中即整榜跳过（8 个聚合省掉）；过期后返回 false 让
 * settlePeriod 重算门槛。Task 10 另有后台"删占位"的逃生口，本函数不等它。
 * 读不到 updatedAt 的行（理论不该有——schema 开了 timestamps）保守当作新鲜占位：
 * 最多多跳一次重算，不会把钱发重。
 */
export async function isBoardSettlementSkipped(
  key: BoardSettlementBoardKey,
  now = Date.now(),
): Promise<boolean> {
  const row = await BoardSettlementModel
    .findOne({ ...key, userId: BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID, status: 'skipped' })
    .select({ updatedAt: 1, createdAt: 1 })
    .lean();
  if (!row) return false;
  const ts = row.updatedAt ?? row.createdAt;
  if (!ts) return true;
  return now - new Date(ts).getTime() < BOARD_REWARDS.skippedFreshMs;
}

/* ==========================================================================
 * 结算编排（Task 7）：settlePeriod 是"一个周期单元"的 8 步（spec §4.2），
 * settleDueForUser 是懒结算入口（C2：只评估该用户有可信行的到期单元，
 * 但每一脚做的是**全榜**结算——第一个触发的人替所有 qualify 的人干活）。
 *
 * 时序闸门（C1）：单元过滞后界才许结——周＝次周一 00:00（东八）、月＝次月 1 日、年＝次年 1 月 1 日。
 * 界与"窗口终点"是同一个东八零点（周榜 Mon..Sun 的自然右界就是下周一 00:00），
 * 判据一律 `dueMs <= now`（§4.8 规则页文案"上周的周榜在下周一到账"钉的就是边界当刻起可结）。
 * ========================================================================== */

const DAY_MS = 86_400_000;

/** 周期中文标签（§4.8「周榜/月榜/年榜」；服务端此前没有这份表，唯一事实源在此） */
export const PERIOD_LABEL: Record<BoardPeriod, string> = { week: '周榜', month: '月榜', year: '年榜' };

/** 运动类型中文名：直接派生自 ACTIVITY_TYPE_META.label（再抄一份字面量＝漂移之源，PB-10 同一条纪律） */
export const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  ACTIVITY_TYPES.map((t) => [t, ACTIVITY_TYPE_META[t].label]),
);

/** periodKey 规范形态 → 窗口起点（epoch ms）。脏形态直接炸：键拼错一次＝同一期两套键双发（模型注释钉过） */
export function periodStartMsFromKey(period: BoardPeriod, periodKey: string): number {
  if (period === 'week') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodKey)) {
      throw new AppError(500, `非法榜单 periodKey（周规范形态＝该周周一日期串）：${periodKey}`);
    }
    const ms = Date.parse(`${periodKey}T00:00:00+08:00`);
    if (Number.isNaN(ms)) throw new AppError(500, `非法榜单 periodKey（周）：${periodKey}`);
    return ms;
  }
  if (period === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(periodKey);
    if (!m) throw new AppError(500, `非法榜单 periodKey（月规范形态 '2026-10'）：${periodKey}`);
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, 1) - BJ_OFFSET_MS;
  }
  if (!/^\d{4}$/.test(periodKey)) throw new AppError(500, `非法榜单 periodKey（年规范形态 '2026'）：${periodKey}`);
  return Date.UTC(Number(periodKey), 0, 1) - BJ_OFFSET_MS;
}

/** 下一期起点＝滞后/结算界（周＝+7 天、月＝次月 1 日、年＝次年 1 月 1 日；均东八 00:00） */
export function settleBoundaryMs(period: BoardPeriod, periodKey: string): number {
  const startMs = periodStartMsFromKey(period, periodKey);
  if (period === 'week') return startMs + 7 * DAY_MS;
  if (period === 'month') {
    const b = new Date(startMs + BJ_OFFSET_MS);
    return Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, 1) - BJ_OFFSET_MS;
  }
  return Date.UTC(bjYearMonth(startMs).y + 1, 0, 1) - BJ_OFFSET_MS;
}

/**
 * §4.8 定稿文案，两套形态**同一模块、不许互相统一**（SP-6 各自钉死）：
 * 通知正文用这个：周展开成「2026/10/19 至 2026/10/25 这一周」（日期内 '/'、区间「至」）。
 */
export function boardLabel(period: BoardPeriod, periodKey: string): string {
  if (period === 'week') {
    const start = periodStartMsFromKey('week', periodKey);
    const end = start + 6 * DAY_MS; // 周日＝窗口最后一天的 00:00
    return `${bjDateStr(start).replace(/-/g, '/')} 至 ${bjDateStr(end).replace(/-/g, '/')} 这一周`;
  }
  if (period === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(periodKey);
    if (!m) throw new AppError(500, `非法榜单 periodKey（月）：${periodKey}`);
    return `${Number(m[1])}年${Number(m[2])}月`; // 月不补零：'2027-01' → 「2027年1月」
  }
  if (!/^\d{4}$/.test(periodKey)) throw new AppError(500, `非法榜单 periodKey（年）：${periodKey}`);
  return `${Number(periodKey)}年`;
}

/** 积分流水标题后缀用这个：周是 8 位无分隔紧凑形态 `20261019周`（用户 2026-10-28 指定）；月/年与正文同式 */
export function boardPeriodTag(period: BoardPeriod, periodKey: string): string {
  if (period === 'week') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodKey)) throw new AppError(500, `非法榜单 periodKey（周）：${periodKey}`);
    return `${periodKey.replace(/-/g, '')}周`;
  }
  return boardLabel(period, periodKey);
}

/** 懒结算单元：一个 (period, periodKey) 及其窗口/滞后界（epoch ms） */
export interface SettleUnit {
  period: BoardPeriod;
  periodKey: string;
  startMs: number;
  /** 发分聚合窗口右界（＝滞后界） */
  endMs: number;
  dueMs: number;
}

/**
 * 候选行的可信判定（内存版）：与 trustedMatch() 的四道判据同源同口径。
 * **只用来筛"这个用户够格让哪些周期单元进结算候选"**（C2：没可信行的人排不上名，
 * 也就不该为那个单元触发 8 个聚合）；发不发分、发给谁，裁决权全在 trustedBoardRows+planPeriodRewards。
 */
function isTrustedRow(r: { type: string; vehicleMs?: number; driftScore?: number; corrected?: boolean; avgPace?: number | null }): boolean {
  if ((r.vehicleMs ?? 0) > 0) return false;
  if ((r.driftScore ?? 0) > DRIFT_SCORE_PB_GATE) return false;
  if (r.corrected === false) return false;
  if (!hasNoPace(r.type)) {
    if (typeof r.avgPace !== 'number' || r.avgPace < MIN_PLAUSIBLE_PACE_SEC_PER_KM) return false;
  }
  return true;
}

/**
 * 该用户的到期单元清单（C2 懒结算入口的枚举部分）：
 * 只枚举**该用户有可信 finished 行**的周/月/年单元（否则他不可能在榜上），再按滞后界筛掉未到期——
 * 这挡住的是"每次进页面全平台 8 类型 × 全部历史周期"的扫描放大。
 * 每个单元里 settlePeriod 照旧做全榜结算：qualify 的别人也一并拿到钱（先到先得地替大家干活）。
 */
export async function computeSettleUnits(userId: string, now: number): Promise<SettleUnit[]> {
  const rows = await ActivityModel.find({ userId, status: 'finished', startTime: { $lt: now } })
    .select({ startTime: 1, type: 1, vehicleMs: 1, driftScore: 1, corrected: 1, avgPace: 1 })
    .lean();
  const units: SettleUnit[] = [];
  const seen = new Set<string>();
  for (const period of ['week', 'month', 'year'] as BoardPeriod[]) {
    for (const r of rows) {
      if (!isTrustedRow(r)) continue;
      const startMs = period === 'week' ? bjIsoWeekStart(r.startTime) : period === 'month' ? bjMonthStart(r.startTime) : bjYearStart(r.startTime);
      let periodKey: string;
      if (period === 'week') periodKey = bjDateStr(startMs);
      else if (period === 'month') {
        const { y, m } = bjYearMonth(startMs);
        periodKey = `${y}-${String(m).padStart(2, '0')}`;
      } else periodKey = String(bjYearMonth(startMs).y);
      const mark = `${period}:${periodKey}`;
      if (seen.has(mark)) continue;
      const dueMs = settleBoundaryMs(period, periodKey);
      if (dueMs > now) continue; // C1：滞后界未到（含正在进行中的当前周/月/年）
      seen.add(mark);
      units.push({ period, periodKey, startMs, endMs: dueMs, dueMs });
    }
  }
  return units;
}

/** 结算侧依赖注入口：只有测试会传（演"发分炸了/通知挂了/崩在中间"），生产走默认实现 */
export interface SettleDeps {
  credit?: typeof creditPoints;
  notify?: typeof createNotification;
}

/** 到账通知（§4.8 第 3 条逐字）。通知失败不回滚钱——钱与台账此刻已成对，通知缺席是运营事故，大声留痕 */
async function notifyReward(
  notify: NonNullable<SettleDeps['notify']>,
  r: BoardReward,
  period: BoardPeriod,
  periodKey: string,
): Promise<void> {
  try {
    await notify({
      userId: r.userId,
      published: true,
      title: '榜单积分奖励到账',
      content: `恭喜获得「${TYPE_LABEL[r.type] ?? r.type}·${PERIOD_LABEL[period]}」第 ${r.rank} 名奖励 +${r.points} 积分（${boardLabel(period, periodKey)}）。`,
    });
  } catch (e) {
    console.error('[points-board] 到账通知发送失败（发放已落定，通知缺席需补发）', { userId: r.userId, type: r.type, period, periodKey }, e);
  }
}

/**
 * 一个周期单元（某 period 某 periodKey 的整期 8 榜）：滞后闸门 → 占位缓存 → 门槛 → 聚合 →
 * plan（纯函数，Task 5）→ 逐条「抢锁 → 发分 → 翻牌 → 定向通知」。
 *
 * - idemKey `${userId}:board:${type}:${period}:${periodKey}` 与台账唯一键同形：台账管"谁拿到发放权"，
 *   creditPoints 的幂等管"钱只落一次"——两层各自能独立兜双发（SP-3/SP-14）。
 * - `ignoreDailyCap: true`：spec §4.2「不占每日上限 100」，年榜 500 一笔不许被截（CR2/SP-7）。
 * - 翻牌前断言 `credited === points`（裁定 4）：不等＝钱账漂移，不静默翻牌，释放锁并 error 级留痕。
 * - 失败路径（裁定 1）：release 删 pending 让重试重领；绝不把失败写成 skipped（那是门槛缓存语义）。
 * - 单条 reward 失败只影响该条（catch 住），整批不中断——一次 pass 里 24 条奖励，一条炸不能带走其余人。
 */
export async function settlePeriod(
  period: BoardPeriod,
  periodKey: string,
  /** 聚合窗口右界（[startMs, endMs)）：懒结算传 computeSettleUnits 算出的滞后界 */
  endMs: number,
  now = Date.now(),
  deps: SettleDeps = {},
): Promise<{ credited: number; skippedTypes: string[] }> {
  if (!BOARD_REWARDS.enabled) return { credited: 0, skippedTypes: [] }; // C5 灰度开关：SP-4
  const startMs = periodStartMsFromKey(period, periodKey); // 脏 periodKey 在这里炸，不许算出错窗口
  if (now < settleBoundaryMs(period, periodKey)) return { credited: 0, skippedTypes: [] }; // C1 滞后闸门：SP-5
  const credit = deps.credit ?? creditPoints;
  const notify = deps.notify ?? createNotification;
  const opts: PlanOpts = {
    rewards: BOARD_REWARDS.rewards,
    minParticipants: BOARD_REWARDS.minParticipants,
    perUserBoards: BOARD_REWARDS.perUserBoards,
  };
  const boards: Array<{ type: string; rows: BoardCandidate[] }> = [];
  const skippedTypes: string[] = [];
  for (const type of ACTIVITY_TYPES) {
    const boardKey = { type, period, periodKey };
    if (await isBoardSettlementSkipped(boardKey, now)) {
      skippedTypes.push(type);
      continue; // 占位有效期内：整榜跳过，连聚合都省（§4.2 第 2 步的"避免每次进页重算"）
    }
    const rows = await trustedBoardRows(type, startMs, endMs);
    if (rows.length <= opts.minParticipants) {
      await recordBoardSettlementSkipped(boardKey, `参与人数 ${rows.length} 未过门槛 ${opts.minParticipants}，本期不发`);
      skippedTypes.push(type);
      continue;
    }
    boards.push({ type, rows });
  }
  const rewards = planPeriodRewards(period, boards, opts);
  const bizDate = bjDateStr(now);
  let credited = 0;
  for (const r of rewards) {
    const key: BoardSettlementKey = { type: r.type, period, periodKey, userId: r.userId };
    const { won } = await claimBoardSettlement(key, { rank: r.rank, points: r.points }, now);
    if (!won) continue; // 败者：已发/已撤/他人持有新鲜锁——安静跳过，一条重复键不许打断整批
    try {
      const c = await credit(r.userId, {
        type: 'board_reward',
        // §4.8 第 5 条：骑行·周榜第 1 名·20261207周
        title: `${TYPE_LABEL[r.type] ?? r.type}·${PERIOD_LABEL[period]}第 ${r.rank} 名·${boardPeriodTag(period, periodKey)}`,
        points: r.points,
        bizDate,
        refType: 'board',
        refId: `${r.type}:${period}:${periodKey}`,
        idemKey: `${r.userId}:board:${r.type}:${period}:${periodKey}`,
        ignoreDailyCap: true,
      }, now);
      if (c.duplicated) {
        // 上一次尝试把钱落了、死在翻牌之前（SP-14 的现场）：这笔发放的流水就是 recordId，
        // 补翻牌继续走——不重新发钱、也不再按 idemKey 反查（recordId 是返回值带的，裁定 3）。
        const recovered = await flipBoardSettlementToCredited(key, c.recordId ?? undefined);
        if (!recovered) {
          console.error('[points-board] 重复发放未能补翻牌（行已不在 pending：并发补完或后台撤回）', { key, recordId: c.recordId });
          continue;
        }
        credited += 1;
        await notifyReward(notify, r, period, periodKey);
        continue;
      }
      if (c.credited !== r.points) {
        // 裁定 4：钱账漂移——ignoreDailyCap 之下这本不该可达，走到这里就是上游（额度/明细）出错
        console.error('[points-board] 榜单结算金额不符：台账 points 与实际入账不等，拒绝翻牌并释放锁待重试（钱账漂移！）', {
          key, expected: r.points, credited: c.credited, capped: c.capped, recordId: c.recordId,
        });
        await releaseBoardSettlementPending(key);
        continue;
      }
      const flipped = await flipBoardSettlementToCredited(key, c.recordId ?? undefined);
      if (!flipped) {
        // 钱已到账而翻牌落空：行不是 pending 了（接管/撤回竞态）。不删行、不重试——大声停在这里等对账
        console.error('[points-board] 发放已落账但翻牌未命中（pending 行在翻牌前已易主），台账/流水需人工对账', key);
        continue;
      }
      credited += 1;
      await notifyReward(notify, r, period, periodKey);
    } catch (e) {
      // 裁定 1：credit/翻牌炸了 ⇒ 释放锁。credit 内部对"已落账"有自己的回滚，走到 catch 就说明
      // 这笔钱没有以本次尝试的名义入账；删行让下一次进页面能重新抢锁再试（idemKey 兜住万一落账成功的双发）。
      let released = false;
      try {
        released = await releaseBoardSettlementPending(key);
      } catch (re) {
        console.error('[points-board] 释放发放锁本身失败（行卡 pending，等超时接管窗口重领）', key, re);
      }
      console.error('[points-board] 榜单发分失败，锁已按失败路径处理', { key, released }, e);
    }
  }
  return { credited, skippedTypes };
}

/**
 * 懒结算入口（挂 Task 9 的积分页/榜单页请求上）：**永不抛错**——结算只是页面数据的顺带动作，
 * 炸了不能把用户的积分页变 500。所有异常在单元粒度被吞并 error 留痕，下后进页面自动重试。
 * 返回 void：调用方不需要（也不该）拿结算结果做用户可见判断。
 */
export async function settleDueForUser(userId: string, now: number = Date.now()): Promise<void> {
  if (!BOARD_REWARDS.enabled) return; // C5：开关关闭连查询都不做（SP-4）
  try {
    const units = await computeSettleUnits(userId, now);
    for (const u of units) {
      try {
        await settlePeriod(u.period, u.periodKey, u.endMs, now);
      } catch (e) {
        console.error('[points-board] 懒结算单元失败（下后进页面重试）', { userId, period: u.period, periodKey: u.periodKey }, e);
      }
    }
  } catch (e) {
    console.error('[points-board] settleDueForUser 入口异常（吞掉：挂在页面请求上不能变 500）', { userId }, e);
  }
}
