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
 * - 第五道（2026-10-29 主人定稿）：表内类型（当前仅游泳）另有**整场平均速度上限**
 *   （config/constants.ts 的 MAX_AVG_SPEED_MPS_BY_TYPE，当前只有 swimming 一档），用 $expr 判
 *   distance <= 上限 × duration。骑行**故意不限速**（「骑行可能是自行车也可能是摩托车，
 *   不做速度追责」），勿把 cycling 补进表里；只作用于本聚合，入库/展示榜/排行榜不套。
 * - 本文件建发分查询 + 结算数学（门槛/并列全发/每人 3 榜上限）+ 台账抢锁原语 + **Task 7 的
 *   结算编排（settlePeriod / settleDueForUser）与 §4.8 定稿文案工具（boardLabel / boardPeriodTag）**
 *   + **Task 10 的后台面（listBoardSettlements 台账列表 / revokeBoardSettlement 撤回）**。
 *   两侧共用的判别式＝thresholdSkipReason / SETTLED_MARKER_REASON（写侧唯一出口）与
 *   models/point.model.ts 的 isBoardLevelRow / isThresholdSkip / isSettledMarker（读侧谓词）：
 *   status='skipped' 的哨兵行是**缓存不是发放**，列表默认排除、撤回直接拒绝。
 *   热路径（修复轮 1）：门槛占位 + 完成标记让已评估过的单元在聚合之前短路（有效期 24h，过期重评）。
 *   **2026-10-30 积压修复**：F1 通知改「即时发送 + 台账盖戳 + 崩溃后补投」（deliverPendingBoardNotifications，
 *   修复轮 1 起投递带 Notification.dedupeKey 幂等键、盖戳只是扫描优化；
 *   挂在 settleDueForUser 尾部）；F3 撤回后第 4 名补位（settlePeriod 剔除 revoked 用户 + revoke 重算本榜）；
 *   F4 余额不足扣到 0、差额记 shortfall（不再拒单）。
 *   **不改 leaderboard() 的展示口径**（榜面与发分结果可能不一致，由规则页文案说明），
 *   也不做省份过滤（发分是全平台口径）。
 */
import { Types } from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import {
  BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID,
  BOARD_SETTLEMENT_PERIODS,
  BOARD_SETTLEMENT_SETTLED_MARKER_REASON_PREFIX,
  BOARD_SETTLEMENT_STATUSES,
  BOARD_SETTLEMENT_THRESHOLD_SKIP_REASON_PREFIX,
  BoardSettlementModel,
  isBoardLevelRow,
  isSettledMarker,
  isThresholdSkip,
  PointAccountModel,
  PointRecordModel,
  type BoardSettlement,
  type BoardSettlementStatus,
} from '../models/point.model.js';
import { UserModel } from '../models/user.model.js';
import {
  ACTIVITY_TYPES,
  ACTIVITY_TYPE_META,
  DRIFT_SCORE_PB_GATE,
  MAX_AVG_SPEED_MPS_BY_TYPE,
  MIN_PLAUSIBLE_PACE_SEC_PER_KM,
  type ActivityType,
} from '../config/constants.js';
import { BOARD_REWARDS } from '../config/points.js';
import { isBoardRewardsEnabled } from './board-switch.js';
import { creditPoints, debitPoints } from './points-ledger.js';
import { createNotification } from './notification.js';
import { bjDateStr, bjIsoWeekStart, bjMonthStart, bjYearMonth, bjYearStart, BJ_OFFSET_MS } from '../utils/bj-time.js';
import { AppError } from '../utils/app-error.js';
import { assertObjectIdLike, isObjectIdLike } from '../utils/object-id.js';
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

/** 表内类型的速度上限（m/s）；不在表内＝该类型不做速度判据（当前骑行故意豁免） */
function maxAvgSpeedMps(type: string): number | undefined {
  // hasOwnProperty 而不是直接下标：type 来自库里的历史字符串，不能让 'constructor' 之类撞到原型
  return Object.prototype.hasOwnProperty.call(MAX_AVG_SPEED_MPS_BY_TYPE, type)
    ? MAX_AVG_SPEED_MPS_BY_TYPE[type as ActivityType]
    : undefined;
}

/**
 * 整场平均速度判据（发分口径，只对 MAX_AVG_SPEED_MPS_BY_TYPE 里的类型生效）：
 * 保留 distance <= 上限 × duration 的行。
 * - `duration` 是秒、已扣暂停（models/activity.model.ts:59）。
 * - duration 缺失或 <=0 ⇒ 速度不可验证 ⇒ **排除**（$gt 先兜住），不按"缺字段＝可信"放行：
 *   能算出距离却算不出时长的行本身就是坏数据（导入/老文档 duration 默认 0）。
 *   影响面：只读取证（dev 库 swimming 共 11 行、0 行 finished、其中 10 行 duration=0 且全部
 *   非 finished）⇒ 现有已完成数据一条都不受影响，见 swim-speed-gate-report.md；
 *   不接受"0 时长换距离"。
 * - 上限判据是 <=：恰在「上限 × duration」上仍可信，超 1 米即剔除（SB-3 钉边界）。
 */
function speedCapMatch(type: string): Record<string, unknown> | null {
  const maxSpeed = maxAvgSpeedMps(type);
  if (maxSpeed === undefined) return null;
  return {
    $expr: {
      $and: [
        { $gt: ['$duration', 0] },
        { $lte: ['$distance', { $multiply: [maxSpeed, '$duration'] }] },
      ],
    },
  };
}

/**
 * 该类型的可信判据：配速判据只对会算配速的类型加（见文件头）。
 * 加了它就要接受：跑步/步行等短行（distance < MIN_PACE_DISTANCE_M，pace.ts 里 avgPace 也是
 * null）继续被挡在发分之外——短到跑不出可信配速的轨迹不发分，是有意的。
 * 速度上限同理按类型生效，且只加 $expr——type/status/startTime 仍在 $match 顶层可走索引。
 */
function trustedMatch(type: string) {
  const base = hasNoPace(type)
    ? BASE_TRUSTED_MATCH
    : { ...BASE_TRUSTED_MATCH, avgPace: { $gte: MIN_PLAUSIBLE_PACE_SEC_PER_KM } };
  const speedCap = speedCapMatch(type);
  return speedCap ? { ...base, ...speedCap } : base;
}

/**
 * 发分聚合的 $match（导出给 EXPLAIN 取证共用：测试不许另抄一份过滤器形状）。
 * 能进索引的只有 type/status 两个等值 + startTime 区间；四道可信判据都是文档内过滤
 * （对应 models/activity.model.ts 的 {type,status,startTime} 索引，IDX-1 用 EXPLAIN 钉住）。
 */
export function trustedBoardMatch(type: string, startMs: number, endMs: number): Record<string, unknown> {
  return { ...trustedMatch(type), type, startTime: { $gte: startMs, $lt: endMs } };
}

/** 某类型某窗口 [startMs, endMs) 内「可信总距离」降序的用户榜（发分口径，比展示多四道判据） */
export async function trustedBoardRows(
  type: string,
  startMs: number,
  endMs: number,
): Promise<BoardCandidate[]> {
  const rows = await ActivityModel.aggregate<{ _id: Types.ObjectId; distance: number }>([
    { $match: trustedBoardMatch(type, startMs, endMs) },
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

/**
 * 已经计入上限的榜（上一/几轮 pass 已落定在台账上的 credited/revoked 行）。
 * 只占「每人 3 榜」的名额，不在本轮发分——revoked 也算占用：它的唯一键仍在，本轮重算也抢不到发放权。
 * points 是台账上的既发分值，随种子一起带过来做审计/排查；选榜**不用它排序**：
 * 已发的榜砍不掉，名额只按「几个榜」扣，不按分值重排。
 */
export interface SeededBoard {
  userId: string;
  type: string;
  points: number;
}

export interface PlanOpts {
  /** 各周期 TOP1/2/3 分值（spec §3 D4：周 50/30/20、月 100/80/50、年 500/400/300） */
  rewards: Record<BoardPeriod, [number, number, number]>;
  /** 单榜参与人数**严格大于**该值才发（D2「超过 10 人才发」；恰好 10 人不发＝产品拍板） */
  minParticipants: number;
  /** 同一期每人最多计 N 个榜（D5，取分值最高的 N 个） */
  perUserBoards: number;
  /**
   * 本轮之前已计入的榜（终审 must-fix #1）。本函数保持纯：台账由调用方（settlePeriod）读好传进来。
   * 为什么必须有：结算 pass 只重算「没有新鲜完成标记」的榜，上一轮已 credited 的榜会被 24h 标记短路；
   * 若上限只在本轮算出的结果里数，同一用户就能在下一轮再拿一个新榜（第 4 个），
   * 而台账里那 3 个还在——上限被跨轮次绕过。
   */
  seeded?: readonly SeededBoard[];
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
  /** 门槛判据的参与人数（缺省＝rows.length）。撤回补位时传「剔除 revoked 前的原始参与人数」 */
  participants: number = rows.length,
): BoardReward[] {
  if (participants <= opts.minParticipants) return [];
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
 * - `seeded`（终审 must-fix #1）：台账上已 credited/revoked 的榜先占名额——它们是既成事实、砍不掉，
 *   所以每人的**剩余名额 = N − 已计入数**，本轮新算出的榜只按分值降序（同分 type 码点升序）填剩余名额。
 *   同一 (人,榜) 既在台账又在候选里时只按台账算一个榜（本轮那条必然抢不到发放权）。
 */
export function flattenWithPerUserCap(
  perBoard: ReadonlyMap<string, BoardReward[]>,
  perUserBoards: number,
  seeded: readonly SeededBoard[] = [],
): BoardReward[] {
  const all: BoardReward[] = [];
  for (const rows of perBoard.values()) for (const r of rows) all.push(r);

  const seededPairs = new Set<string>();
  const seededCount = new Map<string, number>();
  for (const s of seeded) {
    seededPairs.add(`${s.userId}\u0000${s.type}`);
    seededCount.set(s.userId, (seededCount.get(s.userId) ?? 0) + 1);
  }
  // 已在台账上的 (人,榜) 不再参与本轮候选：同一行抢锁必然 won=false（credited/revoked 是终态），
  // 留在候选里只会跟它自己争一个名额。
  const fresh = all.filter((r) => !seededPairs.has(`${r.userId}\u0000${r.type}`));

  const byUser = new Map<string, BoardReward[]>();
  for (const r of fresh) {
    const list = byUser.get(r.userId);
    if (list) list.push(r);
    else byUser.set(r.userId, [r]);
  }

  const keep = new Set<BoardReward>();
  const limit = Math.max(0, perUserBoards);
  for (const [userId, list] of byUser) {
    const remaining = Math.max(0, limit - (seededCount.get(userId) ?? 0));
    for (const r of pickBestBoards(list).slice(0, remaining)) keep.add(r);
  }
  return fresh.filter((r) => keep.has(r));
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
  boards: Array<{ type: string; rows: BoardCandidate[]; participants?: number }>,
  opts: PlanOpts,
): BoardReward[] {
  const reward = opts.rewards[period];
  const perBoard = new Map<string, BoardReward[]>();
  for (const b of boards) {
    // 同一个 type 传两次＝后写的榜覆盖先写的（不是双发）；调用方按 ACTIVITY_TYPES 传 8 个
    // 互不相同的类型，真传重了属于上游 bug，这里不静默合并两份榜
    // participants 只影响门槛判据（撤回补位时＝剔除 revoked 前的原始参与人数），名次/分值算法不变
    perBoard.set(b.type, planOneBoard(b.type, b.rows, reward, opts, b.participants));
  }
  return flattenWithPerUserCap(perBoard, opts.perUserBoards, opts.seeded ?? []);
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
 * 整榜级占位行的 reason（写侧唯一出口，Task 10 评审强制项）：前缀常量＝机器可辨的判别式
 * （models/point.model.ts 的 isThresholdSkip 认它），后面跟人读的中文留给台账页。
 * 拼这条串的地方只许有本函数——写侧改了前缀而读侧没跟上，列表与撤回的排除逻辑会静默失效。
 */
export function thresholdSkipReason(participants: number, minParticipants: number): string {
  return `${BOARD_SETTLEMENT_THRESHOLD_SKIP_REASON_PREFIX} 参与人数 ${participants} 未过门槛 ${minParticipants}，本期不发`;
}

/** 完成标记行的 reason（写侧唯一出口，与 markBoardSettled 同一条纪律） */
export const SETTLED_MARKER_REASON = `${BOARD_SETTLEMENT_SETTLED_MARKER_REASON_PREFIX} 已完成结算（完成占位：有效期内不重扫，过期重算可补发迟到者）`;

/**
 * 整榜级占位：某榜没越过人数门槛时写一行 skipped（哨兵 userId、rank/points 均 0）。
 * 作用不是记账而是**占位**：下一次懒结算先 isBoardSettlementSkipped()，命中就整榜跳过，
 * 不必每次页面浏览都重跑一遍发分口径的聚合（一榜一个 aggregate，一期 8 个榜）。
 * 返回 false＝已有占位行（含并发撞键），是安静跳过不是抛错。
 * 修复轮 1（Important 1 的伴生漏洞）：撞键＝"重算后同结论"，这里要**续期**占位的 updatedAt
 * （TTL 从本次评估重起）——否则占位过期后每次进页都会重聚合、重落又撞键，"每单元每天 ≤1 次全扫"
 * 只对新鲜占位成立。续期只动时间戳：不覆盖 reason（BS-4 的台账留痕纪律）、不新增行（撞键败者路径）。
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
    await BoardSettlementModel.updateOne(
      { ...key, userId: BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID, status: 'skipped' },
      { $set: { updatedAt: new Date() } },
    );
    return false;
  }
}

/**
 * 完成标记（修复轮 1 / Important 1）：一个"过了人数门槛且本轮已全部落定"的榜，
 * 落一行同形的哨兵占位（userId 哨兵、rank/points 0、status skipped、reason 记"已完成结算"）。
 * 读路径就是 isBoardSettlementSkipped：标记有效期内整榜跳过——已结算的单元不再
 * 每次进页重聚合 8 个榜然后输掉抢锁（评审实测：301 人 dev 数据 19 个到期单元 ⇒ 首载 ~152 个聚合，
 * 且过门槛的榜永远没有短路，修复前探针 pass1=8/pass2=8/pass3=8）。
 * 与门槛占位同一条纪律：**是缓存不是判决**——skippedFreshMs（24h）过期后该榜重新评估，
 * 迟到赢家（回填导入把排名搅了）照旧补发（SP-15 第 5 步钉这条链）。
 * 撞键（已有门槛占位或上一轮遗留）＝把 reason 更新为完成留痕并续期 TTL——
 * 两条写路径都是唯一键/CAS 安全，不存在 find-then-insert 窗口（spec §4.2 ⚠）。
 */
export async function markBoardSettled(key: BoardSettlementBoardKey): Promise<void> {
  const reason = SETTLED_MARKER_REASON;
  try {
    await BoardSettlementModel.create({
      ...key,
      userId: BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID,
      rank: 0,
      points: 0,
      status: 'skipped',
      reason,
    });
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    await BoardSettlementModel.findOneAndUpdate(
      { ...key, userId: BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID, status: 'skipped' },
      { $set: { reason, updatedAt: new Date() } },
    );
  }
}

/**
 * 这个榜这一期的整榜占位（门槛跳过 or 已完成结算，见 recordBoardSettlementSkipped / markBoardSettled）
 * 还作不作数？——**占位是缓存，不是判决**（评审裁定 2 + 修复轮 1 Important 1）：
 * 导入/回填行没有 startTime 上限，占位落下之后参与人数 9→11 真实可能发生。
 * 有效期内（skippedFreshMs=24h）命中即整榜跳过（8 个聚合省掉）；过期后返回 false 让
 * settlePeriod 重算门槛。Task 10 没有交付"删占位"接口（brief 只有列表 + 撤回）：不等 TTL 的
 * 逃生口是手工删掉该榜的哨兵行（`{type,period,periodKey,userId=哨兵}`）后重跑 settlePeriod，
 * 本函数不等它、也不给任何绕过 freshness 的缝（绕过＝每次进页重扫，正是这条缓存要挡的）。
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

/** periodKey 规范形态 → 窗口起点（epoch ms）。脏形态直接炸：键拼错一次＝同一期两套键双发（模型注释钉过）。
 * 修复轮 1（评审 Important 2）：**严格**校验——Task 10（后台）被要求信任本函数，这里放过一个脏键
 * 就是放过去一个「窗口重叠、idemKey 不同」的双发单元：
 * - 周的键必须真实存在且是东八区周一（V8 把 2026-02-30 静默滚成 3-02，恰好又是周一，能骗过日期分量检查；
 *   周二的键差一天，窗口与真周一那期大面积重叠）；
 * - 月的月份必须在 01–12（Date.UTC 会把 13 月滚进次年 1 月、00 月滚进上一年 12 月，键与窗口错位）；
 * - 年必须是 4 位数字（'26' 会被 Date.UTC 当公元 26 年）。
 * 一律抛 AppError，绝不为脏输入算出任何窗口。 */
export function periodStartMsFromKey(period: BoardPeriod, periodKey: string): number {
  if (period === 'week') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodKey)) {
      throw new AppError(500, `非法榜单 periodKey（周规范形态＝该周周一日期串）：${periodKey}`);
    }
    const ms = Date.parse(`${periodKey}T00:00:00+08:00`);
    if (Number.isNaN(ms)) throw new AppError(500, `非法榜单 periodKey（周）：${periodKey}`);
    // 日期必须真实存在：V8 会把 2-30 滚成 3-02——回读东八日期串不等于原串就是滚日（PK-2）
    if (bjDateStr(ms) !== periodKey) {
      throw new AppError(500, `非法榜单 periodKey（周日期不存在，会被静默滚日）：${periodKey}`);
    }
    // 周一闸门：与 bjIsoWeekStart 的派生唯一口径对照（settleDueForUser 自己产的都是周一，这里不为它设防，
    // 为信任本函数的调用方设防）
    if (bjIsoWeekStart(ms) !== ms) {
      throw new AppError(500, `非法榜单 periodKey（周规范形态＝该周周一，收到非周一）：${periodKey}`);
    }
    return ms;
  }
  if (period === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(periodKey);
    if (!m) throw new AppError(500, `非法榜单 periodKey（月规范形态 '2026-10'）：${periodKey}`);
    const month = Number(m[2]);
    if (month < 1 || month > 12) {
      throw new AppError(500, `非法榜单 periodKey（月份须在 01–12）：${periodKey}`);
    }
    return Date.UTC(Number(m[1]), month - 1, 1) - BJ_OFFSET_MS;
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
 * 速度上限表不在这里复刻：枚举只是性能闸门（真实裁决在聚合的 $expr），多枚举一个单元
 * 最多多跑一次 $match，不会多发一分钱。
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
      // 结算起点之前的单元连枚举都不进（终审 must-fix #4）：懒结算不会为历史期反复触发 8 个聚合，
      // 也不会在旧单元上留下任何台账行。见 settlePeriod 同一条闸门的注释。
      if (dueMs < BOARD_REWARDS.settleFrom) continue;
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

/** 到账通知正文（§4.8 第 3 条逐字）：即时发送与崩溃后补投共用同一份，绝不各拼一套 */
function creditNotificationContent(
  row: { type: string; period: BoardPeriod; periodKey: string; rank: number; points: number },
): string {
  return `恭喜获得「${TYPE_LABEL[row.type] ?? row.type}·${PERIOD_LABEL[row.period]}」第 ${row.rank} 名奖励 +${row.points} 积分（${boardLabel(row.period, row.periodKey)}）。`;
}

/** 到账通知标题（§4.8 第 3 条） */
const CREDIT_NOTIFICATION_TITLE = '榜单积分奖励到账';
/** 撤回通知标题（§4.8 第 4 条） */
const REVOKE_NOTIFICATION_TITLE = '榜单积分奖励调整';

/**
 * 榜单通知的投递幂等键（修复轮 1 / I-1）：一个台账行的一个方向对应唯一一条通知。
 * `board:credit:{type}:{period}:{periodKey}:{userId}` / `board:revoke:...`。
 * 即时发送与崩溃后补投共用同一个键，所以「发成功但盖戳丢了」与「盖戳前行已崩」都能靠
 * Notification 的 partial unique 索引收敛：重试要么新建、要么撞键当成已发送。
 */
export function boardNotificationDedupeKey(
  kind: 'credit' | 'revoke',
  r: { type: string; period: BoardPeriod; periodKey: string; userId: string },
): string {
  return `board:${kind}:${r.type}:${r.period}:${r.periodKey}:${r.userId}`;
}

/**
 * 撤回通知正文（§4.8 第 4 条逐字）：即时发送与崩溃后补投共用。
 * 余额不足时（shortfall > 0）在**同一句**末尾追加差额子句（2026-10-30 新增文案，待主人确认）：
 * `（余额不足，实际扣回 X 分，差额 Y 分未追回）`。X = points − shortfall（实际扣回），
 * Y = shortfall。shortfall=0 时输出与旧版逐字节一致。
 */
function revokeNotificationContent(
  row: {
    type: string;
    period: BoardPeriod;
    periodKey: string;
    rank: number;
    points: number;
    reason?: string;
    shortfall?: number;
  },
): string {
  const typeLabel = TYPE_LABEL[row.type] ?? row.type;
  const base = `「${typeLabel}·${PERIOD_LABEL[row.period]}」第 ${row.rank} 名奖励 +${row.points} 积分已撤回 −${row.points} 积分（${boardLabel(row.period, row.periodKey)}）。原因：${row.reason ?? ''}`;
  const shortfall = Number(row.shortfall ?? 0);
  if (shortfall <= 0) return base;
  return `${base}（余额不足，实际扣回 ${row.points - shortfall} 分，差额 ${shortfall} 分未追回）`;
}

/**
 * 单条到账通知（§4.8 第 3 条逐字），带投递幂等键。返回是否真的发出去了（含"同键已存在"的
 * 幂等成功）——调用方据此尝试盖 notifiedAt；盖戳只是扫描优化，丢了也不影响不重发。
 * 通知失败不回滚钱：钱与台账此刻已成对，通知缺席是运营事故，大声留痕后由
 * deliverPendingBoardNotifications 在下一次页面访问时补投（同一 dedupeKey 兜住重复）。
 */
async function notifyReward(
  notify: NonNullable<SettleDeps['notify']>,
  r: BoardReward,
  period: BoardPeriod,
  periodKey: string,
): Promise<boolean> {
  try {
    await notify({
      userId: r.userId,
      category: 'reward',
      published: true,
      title: CREDIT_NOTIFICATION_TITLE,
      content: creditNotificationContent({ type: r.type, period, periodKey, rank: r.rank, points: r.points }),
    }, boardNotificationDedupeKey('credit', { type: r.type, period, periodKey, userId: r.userId }));
    return true;
  } catch (e) {
    console.error('[points-board] 到账通知发送失败（发放已落定，通知缺席需补发）', { userId: r.userId, type: r.type, period, periodKey }, e);
    return false;
  }
}

/**
 * 给台账行盖「通知已投递」的时刻。修复轮 1 / I-1 之后它**只是补投扫描的优化**：
 * 键的唯一性由 Notification.dedupeKey 决定，盖戳写失败/丢失只会让补投多扫一次（然后撞键
 * 识别为已发送），不会重发。字段只有 null → now 一个方向：已盖过戳的行绝不回退。
 * 同时清空重试计划字段（lastError/nextAttemptAt）：投出去了就不该再显示「卡住」。
 * attempts 保留（运维审计：这一条重试过几次）。
 * 写失败只留痕不抛。
 */
async function markBoardNotified(
  rowId: Types.ObjectId | string,
  field: 'notifiedAt' | 'revokeNotifiedAt',
  now: number,
): Promise<void> {
  try {
    await BoardSettlementModel.updateOne(
      { _id: rowId, [field]: null },
      { $set: { [field]: now, lastError: '', nextAttemptAt: null } },
    );
  } catch (e) {
    console.error('[points-board] 写通知投递标记失败（不影响幂等：补投会撞去重键识别为已发送）', { rowId, field }, e);
  }
}

/**
 * 通知出箱的重试计划（2026-10-31，为订阅消息预留；当前通道仍只有 inapp）。
 * 失败退避表固定为 1m/5m/15m/1h/6h；第 5 次失败即放弃（不再重试，lastError 留证）。
 * 放弃与未知通道都把 nextAttemptAt 推到远期哨兵——drain 的 `nextAttemptAt <= now` 永远不命中。
 * 不用 `attempts < 5` 当查询条件：那会把 attempts 插进索引第二段，索引就不再是选定形状；
 * 停投语义只由 nextAttemptAt 表达（运维手工清掉该字段即可让一行复活）。
 */
export const BOARD_NOTIFICATION_MAX_ATTEMPTS = 5;
export const BOARD_NOTIFICATION_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 3600_000, 6 * 3600_000] as const;
/** 放弃后的 nextAttemptAt 偏移：100 年，远超任何真实时钟，等价于「永不再投」 */
export const BOARD_NOTIFICATION_GIVE_UP_OFFSET_MS = 100 * 365 * 24 * 3600_000;
export const BOARD_NOTIFICATION_LAST_ERROR_MAX = 200;

/** 第 n 次失败后的退避（超出表长按最后一档：调用方在 MAX 次时已放弃，不会走到这里） */
export function boardNotificationBackoffMs(attempts: number): number {
  const i = Math.min(Math.max(1, Math.trunc(attempts)), BOARD_NOTIFICATION_BACKOFF_MS.length) - 1;
  return BOARD_NOTIFICATION_BACKOFF_MS[i];
}

/** 错误文案落库前收口：单行、去首尾空白、截断到 200 字（DTO 会直接展示） */
function deliveryErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/\s+/g, ' ').trim().slice(0, BOARD_NOTIFICATION_LAST_ERROR_MAX);
}

/** 记一次投递失败/终止：单独 try/catch，写失败只留痕——绝不让它抛回 drain */
async function recordDeliveryFailure(
  rowId: Types.ObjectId | string,
  patch: { attempts: number; lastError: string; nextAttemptAt: number },
): Promise<void> {
  try {
    await BoardSettlementModel.updateOne({ _id: rowId }, { $set: patch });
  } catch (e) {
    console.error('[points-board] 写通知重试计划字段失败（下轮会按旧值重试，不丢通知）', { rowId }, e);
  }
}

/** 补投侧依赖注入口：只有测试会传（演「发送挂了」），生产走默认 createNotification */
export interface DeliveryDeps {
  notify?: typeof createNotification;
}

/**
 * 崩溃遗留通知的补投（F1，2026-10-30 产品拍板；修复轮 1 / I-1 改为**幂等去重键**投递）：
 * 扫 `status='credited' && notifiedAt==null` 与 `status='revoked' && revokeNotifiedAt==null` 两类行，
 * 逐行直接调 createNotification（带 `board:credit|revoke:…` 去重键）。
 * - **不再认领**：两条并发补投各发一次 create，唯一索引只会留一行，败者撞 E11000 被
 *   createNotification 当成「已发送」返回既有行。因此没有「认领后崩掉 → 永远不发」的丢件窗口；
 * - **不再退回**：发送抛错就留 null，按重试计划退避后再试；成功（含幂等命中）后盖戳，盖戳丢失也只是
 *   多扫一次。at-least-once + 键去重 = 恰好一条。
 * - **通道**：目前只投 `inapp`（老行缺字段按 inapp）。未知通道的行不静默跳过：记 lastError、
 *   点满 attempts、nextAttemptAt 推远后离开队列（后台 DTO 可见），不会每次进页都重扫/重刷日志。
 * 正文算不出的脏行（历史手工行/夹具行）仍然盖戳跳过，否则会永远占据补投队列前 20 名。
 * 返回本次投递/失败条数（运维与测试用）。
 */
export async function deliverPendingBoardNotifications(
  limit = 20,
  now = Date.now(),
  deps: DeliveryDeps = {},
): Promise<{ delivered: number; failed: number }> {
  const notify = deps.notify ?? createNotification;
  // 实际下发的过滤器（2026-10-31）：主分支 = inapp（$in 兜住老行缺字段）+ 已到期
  // （nextAttemptAt 为 null 或 <= now）；未知通道分支只捞 lastError 为空的行（标记一次即离开）。
  // 索引 {status,channel,notifiedAt,nextAttemptAt} 照主分支的等值前缀 + 区间收尾选定；
  // 撤回侧仍由既有的 {status,revokeNotifiedAt} 服务（量级小，不为它再建第二条）。
  const inapp = { channel: { $in: ['inapp', null] } };
  const rows = (await BoardSettlementModel.find({
    $or: [
      { status: 'credited', notifiedAt: null, ...inapp, nextAttemptAt: { $lte: now } },
      { status: 'credited', notifiedAt: null, ...inapp, nextAttemptAt: null },
      { status: 'revoked', revokeNotifiedAt: null, ...inapp, nextAttemptAt: { $lte: now } },
      { status: 'revoked', revokeNotifiedAt: null, ...inapp, nextAttemptAt: null },
      { status: 'credited', notifiedAt: null, channel: { $nin: ['inapp', null] }, lastError: '' },
      { status: 'revoked', revokeNotifiedAt: null, channel: { $nin: ['inapp', null] }, lastError: '' },
    ],
  })
    .sort({ _id: 1 })
    .limit(Math.max(0, Math.trunc(limit)))
    .lean()) as BoardSettlementRow[];
  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    const creditSide = row.status === 'credited';
    const field = creditSide ? 'notifiedAt' : 'revokeNotifiedAt';
    // 未知通道：不静默丢弃。选择「记录并停投」而不是 throw：drain 挂在页面请求上，
    // throw 只会让同一条坏行每次进页都在日志里刷一遍，还会顺带跳过本次后面排队的行；
    // 落到台账（attempts 点满 + nextAttemptAt 推远）才可运维、可手工复活。
    if (row.channel != null && row.channel !== 'inapp') {
      failed += 1;
      const lastError = deliveryErrorText(`不支持的投递通道「${String(row.channel)}」（当前只支持 inapp）`);
      await recordDeliveryFailure(row._id, {
        attempts: BOARD_NOTIFICATION_MAX_ATTEMPTS,
        lastError,
        nextAttemptAt: now + BOARD_NOTIFICATION_GIVE_UP_OFFSET_MS,
      });
      console.error('[points-board] 榜单通知出箱遇到未知通道，已记录并停止重试', {
        id: String(row._id), status: row.status, channel: row.channel, lastError,
      });
      continue;
    }
    // 正文先算：脏 periodKey 的遗留行（历史手工行/夹具行）永远算不出 boardLabel，
    // 这类行重试多少次都不会成功——**盖戳跳过**而不是留 null，
    // 否则它会永远占着补投队列的前 20 名，把真需要补的行饿死。
    let content: string;
    try {
      content = creditSide
        ? creditNotificationContent({
          type: row.type,
          period: row.period,
          periodKey: row.periodKey,
          rank: Number(row.rank),
          points: Number(row.points),
        })
        : revokeNotificationContent({
          type: row.type,
          period: row.period,
          periodKey: row.periodKey,
          rank: Number(row.rank),
          points: Number(row.points),
          reason: row.reason ?? '',
          shortfall: Number(row.shortfall ?? 0),
        });
    } catch (e) {
      failed += 1;
      await markBoardNotified(row._id, field, now);
      console.error('[points-board] 榜单通知补投跳过：正文无法生成（periodKey 不是规范形态的遗留行，重试也不会成功）', {
        id: String(row._id), period: row.period, periodKey: row.periodKey,
      }, e);
      continue;
    }
    const dedupeKey = boardNotificationDedupeKey(creditSide ? 'credit' : 'revoke', {
      type: String(row.type),
      period: row.period,
      periodKey: String(row.periodKey),
      userId: String(row.userId),
    });
    try {
      await notify({
        userId: String(row.userId),
        category: 'reward',
        published: true,
        title: creditSide ? CREDIT_NOTIFICATION_TITLE : REVOKE_NOTIFICATION_TITLE,
        content,
      }, dedupeKey);
      delivered += 1;
      await markBoardNotified(row._id, field, now);
    } catch (e) {
      failed += 1;
      const attempts = Number(row.attempts ?? 0) + 1;
      const lastError = deliveryErrorText(e) || '未知错误';
      const giveUp = attempts >= BOARD_NOTIFICATION_MAX_ATTEMPTS;
      await recordDeliveryFailure(row._id, {
        attempts,
        lastError,
        nextAttemptAt: giveUp
          ? now + BOARD_NOTIFICATION_GIVE_UP_OFFSET_MS
          : now + boardNotificationBackoffMs(attempts),
      });
      console.error(
        giveUp
          ? '[points-board] 榜单通知补投连续失败达到上限，放弃重试（lastError 留证、notifiedAt 仍为空；可手工清 nextAttemptAt 复活）'
          : '[points-board] 榜单通知补投失败（记录 attempts/nextAttemptAt，到期后再试）',
        { id: String(row._id), status: row.status, attempts },
        e,
      );
    }
  }
  return { delivered, failed };
}

/**
 * 一个周期单元（某 period 某 periodKey 的整期 8 榜）：滞后闸门 → 占位缓存 → 门槛 → 聚合 →
 * plan（纯函数，Task 5）→ 逐条「抢锁 → 发分 → 翻牌 → 定向通知（成功盖 notifiedAt）」→ 完成标记（修复轮 1：
 * 已落定的榜留哨兵占位，下一次进页在聚合之前短路；标记过期后仍会重评，迟到赢家补发）。
 * 被撤回过的获奖者不进榜（F3 补位），聚合结果里的名次因此整体前移。
 *
 * - idemKey `${userId}:board:${type}:${period}:${periodKey}` 与台账唯一键同形：台账管"谁拿到发放权"，
 *   creditPoints 的幂等管"钱只落一次"——两层各自能独立兜双发（SP-3/SP-14）。
 * - `ignoreDailyCap: true`：spec §4.2「不占每日上限 100」，年榜 500 一笔不许被截（CR2/SP-7）。
 * - 翻牌前断言 `credited === points`（裁定 4）：不等＝钱账漂移，不静默翻牌，释放锁并 error 级留痕。
 * - 失败路径（裁定 1）：release 删 pending 让重试重领；绝不把失败写成 skipped（那是门槛缓存语义）。
 * - 单条 reward 失败只影响该条（catch 住），整批不中断——一次 pass 里 24 条奖励，一条炸不能带走其余人。
 */
/* ==========================================================================
 * 上榜通知（2026-11-05 产品裁定）：周榜/月榜的前 N 名各发一条「你上榜了」。
 *
 * 三条口径：
 * 1. **前 10 名**（与 leaderboard 展示的默认条数一致），并列全含（与发分的并列口径一致）；
 * 2. **与发分开关解耦**（2026-11-09 二次确认，曾短暂改为跟随开关后撤销）：关闸时没人收到
 *    到账通知，前 3 名也要发；开闸时前 3 名/被撤回者已有到账（撤回）通知，上榜通知把他们
 *    排除——同一件事不发两条；判定依据是**台账里真有 credited/revoked 行**（真的发过通知），
 *    不是只看开关：某个榜没过参与人数门槛时没人拿到奖励，那个榜的前 3 名照常收上榜通知；
 * 3. **每人每周期一条汇总**（一个人可能同时在多个榜上榜，不能按榜轰炸），年榜不发。
 *
 * 幂等：Notification.dedupeKey 的唯一索引（一个周期单元 + 一个人 = 一条），
 * createNotification 撞键时返回既有行，所以重复 pass / 并发 pass 都不会重发。
 * ========================================================================== */

/** 上榜名次口径：与 leaderboard 展示的默认条数一致（榜单上看得到的人才收到通知） */
export const ON_THE_LIST_TOP_N = 10;
/** 只对周榜/月榜发上榜通知（年榜不发：产品明确只要周/月） */
export const ON_THE_LIST_PERIODS: readonly BoardPeriod[] = ['week', 'month'];
/** 上榜通知标题：带榜单周期类型（用户要求「[运动榜周榜]上榜通知」形态） */
export function onTheListTitle(period: BoardPeriod): string {
  return `[运动榜${PERIOD_LABEL[period]}]上榜通知`;
}

export function boardOnTheListDedupeKey(
  period: BoardPeriod,
  periodKey: string,
  userId: string,
): string {
  return `board:onthelist:${period}:${periodKey}:${userId}`;
}

/** 一条上榜记录：哪个榜、第几名 */
export interface OnTheListEntry {
  type: string;
  rank: number;
}

/**
 * 每榜前 N 名（含并列）→ 按用户汇总。纯函数：不碰库、不碰时钟。
 * 与 planOneBoard 的并列口径一致：距离相等即同名次、并全部收下（即便因此超过 N 条）。
 */
export function planOnTheList(
  boards: ReadonlyArray<{ type: string; rows: BoardCandidate[] }>,
  topN = ON_THE_LIST_TOP_N,
): Map<string, OnTheListEntry[]> {
  const out = new Map<string, OnTheListEntry[]>();
  for (const board of boards) {
    const sorted = [...board.rows].sort((a, b) => b.distance - a.distance);
    let i = 0;
    while (i < sorted.length && i < topN) {
      const rank = i + 1;
      const tied = [sorted[i]];
      for (let j = i + 1; j < sorted.length && sorted[j].distance === tied[0].distance; j += 1) {
        tied.push(sorted[j]);
      }
      for (const t of tied) {
        const list = out.get(t.userId) ?? [];
        list.push({ type: board.type, rank });
        out.set(t.userId, list);
      }
      i += tied.length;
    }
  }
  return out;
}

/**
 * 上榜通知正文：**多行紧凑**（2026-11-09 反馈：去掉段间空行，一行一项直接连排），
 * 逐榜行去掉「·月榜」后缀（周期在「统计周期」行说清），删「最高名次」行（首行即最好成绩）。
 */
export function onTheListContent(
  period: BoardPeriod,
  periodKey: string,
  entries: OnTheListEntry[],
): string {
  // 「这一周」后缀只服务于结算到账文案的口语化（SP-6 两套形态不许互相统一）：
  // 上榜通知的「统计周期」行只要日期区间，局部去掉，不动 boardLabel 本体
  const label = boardLabel(period, periodKey).replace(/ 这一周$/, '');
  const lineOf = (e: OnTheListEntry) => `${TYPE_LABEL[e.type] ?? e.type}榜：第 ${e.rank} 名`;
  // 名次好的排前面：用户最关心的是自己最好那一项
  const sorted = [...entries].sort((a, b) => a.rank - b.rank);
  if (sorted.length === 1) {
    return [
      `恭喜！你在「${TYPE_LABEL[sorted[0].type] ?? sorted[0].type}榜」获得第 ${sorted[0].rank} 名`,
      `统计周期：${label}`,
      '继续加油，下期继续冲榜！',
    ].join('\n');
  }
  return [
    `恭喜！你在本期榜单上榜 ${sorted.length} 项`,
    ...sorted.map((e) => lineOf(e)),
    `统计周期：${label}`,
    '继续加油，下期继续冲榜！',
  ].join('\n');
}

/**
 * 给一个周期单元发上榜通知。**不看 BOARD_REWARDS 开关**（见上方口径 2），
 * 但沿用结算的两道时间闸门：周期没结束不发、早于 settleFrom 的历史单元不发。
 * 永不抛错：通知只是结算的顺带动作，炸了留给下一次进页面重试（幂等键兜住重发）。
 */
export async function notifyOnTheListOfBoards(
  period: BoardPeriod,
  periodKey: string,
  endMs: number,
  now = Date.now(),
  deps: SettleDeps = {},
): Promise<{ notified: number }> {
  // 口径 2：与发分开关解耦——关闸也发上榜通知（发分才看开关，见 settlePeriod）
  if (!ON_THE_LIST_PERIODS.includes(period)) return { notified: 0 };
  const boundaryMs = settleBoundaryMs(period, periodKey);
  if (now < boundaryMs) return { notified: 0 }; // 周期还没结束
  if (boundaryMs < BOARD_REWARDS.settleFrom) return { notified: 0 }; // 上线前的单元不发（与发分同口径）
  const startMs = periodStartMsFromKey(period, periodKey);
  const boards: Array<{ type: string; rows: BoardCandidate[] }> = [];
  for (const type of ACTIVITY_TYPES) {
    const rows = await trustedBoardRows(type, startMs, endMs);
    // 参与人数门槛与发分同口径：两三个人的榜不值得发「你上榜了」
    if (rows.length <= BOARD_REWARDS.minParticipants) continue;
    boards.push({ type, rows });
  }
  if (!boards.length) return { notified: 0 };
  const recipients = planOnTheList(boards);
  if (!recipients.size) return { notified: 0 };
  // 台账里真有 credited/revoked 行的＝已发过到账（撤回）通知，不再发上榜通知
  const rewarded = new Set<string>(
    (await BoardSettlementModel.find({ period, periodKey, status: { $in: ['credited', 'revoked'] } })
      .select({ userId: 1 })
      .lean()).map((r) => String(r.userId)),
  );
  const notify = deps.notify ?? createNotification;
  let notified = 0;
  for (const [userId, entries] of recipients) {
    if (rewarded.has(userId)) continue;
    try {
      await notify({
        userId,
        category: 'sports',
        published: true,
        title: onTheListTitle(period),
        content: onTheListContent(period, periodKey, entries),
      }, boardOnTheListDedupeKey(period, periodKey, userId));
      notified += 1;
    } catch (e) {
      console.error('[points-board] 上榜通知发送失败（下次进页面重试，幂等键兜住重发）', { userId, period, periodKey }, e);
    }
  }
  return { notified };
}

export async function settlePeriod(
  period: BoardPeriod,
  periodKey: string,
  /** 聚合窗口右界（[startMs, endMs)）：懒结算传 computeSettleUnits 算出的滞后界 */
  endMs: number,
  now = Date.now(),
  deps: SettleDeps = {},
): Promise<{ credited: number; skippedTypes: string[] }> {
  if (!(await isBoardRewardsEnabled())) return { credited: 0, skippedTypes: [] }; // C5 后台开关（DB）：SP-4
  const startMs = periodStartMsFromKey(period, periodKey); // 脏 periodKey 在这里炸，不许算出错窗口
  const boundaryMs = settleBoundaryMs(period, periodKey);
  if (now < boundaryMs) return { credited: 0, skippedTypes: [] }; // C1 滞后闸门：SP-5
  // 结算起点闸门（终审 must-fix #4）：窗口终点（= 滞后界 = 该期结束那一瞬）早于 settleFrom 的单元
  // **永不结算**——开关一拨不会把上线前的周/月/年榜整片补发。这里在**任何聚合/台账写入之前**返回：
  // 不落门槛占位、不落完成标记、不落发放行，所以没有任何一条路径能让旧单元日后自己变成"可发"；
  // 懒结算侧 computeSettleUnits 也不枚举它们（连尝试都不尝试）。唯一能改变结论的动作是运维
  // 显式把 BOARD_SETTLE_FROM 往前调（那是人的决定，不是这里能拦的事故）。
  if (boundaryMs < BOARD_REWARDS.settleFrom) return { credited: 0, skippedTypes: [] };
  const credit = deps.credit ?? creditPoints;
  const notify = deps.notify ?? createNotification;
  const opts: PlanOpts = {
    rewards: BOARD_REWARDS.rewards,
    minParticipants: BOARD_REWARDS.minParticipants,
    perUserBoards: BOARD_REWARDS.perUserBoards,
  };
  const boards: Array<{ type: string; rows: BoardCandidate[]; participants: number }> = [];
  const skippedTypes: string[] = [];
  // 补位（F3，2026-10-30 产品拍板「第 4 名补位」）：被**运营撤回**过的获奖者要从榜上剔除。
  // 为什么必须剔除而不是靠抢锁败者路径：撤回行的唯一键仍在，plan 若把他算成第 1 名，
  // 他抢锁必败 ⇒ 第 2/3 名不动、第 4 名永远等不到补位。剔除后名次整体前移（4th→3rd），
  // 榜首变成原来的第 2 名（他已有 credited 终态，抢锁安静跳过），第 4 名这次能拿到发放权。
  // 每单元只读一次（读索引 {period,periodKey,status}），按榜分组成 Set 后逐榜过滤。
  const revokedByBoard = new Map<string, Set<string>>();
  for (const r of await BoardSettlementModel.find({ period, periodKey, status: 'revoked' })
    .select({ type: 1, userId: 1 })
    .lean()) {
    const type = String(r.type);
    const set = revokedByBoard.get(type) ?? new Set<string>();
    set.add(String(r.userId));
    revokedByBoard.set(type, set);
  }
  for (const type of ACTIVITY_TYPES) {
    const boardKey = { type, period, periodKey };
    if (await isBoardSettlementSkipped(boardKey, now)) {
      skippedTypes.push(type);
      continue; // 占位有效期内：整榜跳过，连聚合都省（§4.2 第 2 步的"避免每次进页重算"）
    }
    const allRows = await trustedBoardRows(type, startMs, endMs);
    // 名次按剔除 revoked 后的名单判，门槛按**结算当刻的原始参与人数**判：
    // 门槛是当期参与事实，不因事后除名而失效（11 人参与、撤 1 人仍算 11 人参与，第 4 名该补位）。
    const banned = revokedByBoard.get(type);
    const rows = banned ? allRows.filter((r) => !banned.has(r.userId)) : allRows;
    if (allRows.length <= opts.minParticipants) {
      await recordBoardSettlementSkipped(boardKey, thresholdSkipReason(allRows.length, opts.minParticipants));
      skippedTypes.push(type);
      continue;
    }
    boards.push({ type, rows, participants: allRows.length });
  }
  // 每人 3 榜上限要跨轮次生效（终审 must-fix #1）：本轮可能只重算「没有新鲜完成标记」的少数榜
  // （上一轮已发的那 3 个榜被 24h 标记短路，根本不在 boards 里）。只在本轮结果里数名额，
  // 同一用户就能在下一轮再拿一个新榜 = 第 4 个。把台账上已 credited/revoked 的行作为
  // 「已占名额」喂给纯函数 planPeriodRewards；读过滤器命中 {period,periodKey,status} 读索引。
  const seeded: SeededBoard[] = (await BoardSettlementModel
    .find({ period, periodKey, status: { $in: ['credited', 'revoked'] } })
    .select({ userId: 1, type: 1, points: 1 })
    .lean())
    .map((r) => ({ userId: String(r.userId), type: String(r.type), points: Number(r.points ?? 0) }));
  const rewards = planPeriodRewards(period, boards, { ...opts, seeded });
  const bizDate = bjDateStr(now);
  let credited = 0;
  // 修复轮 1（Important 1）：本轮没落定的榜（发分失败被释放/发放锁被别的请求持有中/翻牌竞态落空）
  // 不进完成标记——下一次进页重评该榜；撞已 credited/revoked 的终态行算"已落定"。
  const unsettledTypes = new Set<string>();
  for (const r of rewards) {
    const key: BoardSettlementKey = { type: r.type, period, periodKey, userId: r.userId };
    const { won, existing } = await claimBoardSettlement(key, { rank: r.rank, points: r.points }, now);
    if (!won) {
      // 败者：已发/已撤——终态，安静跳过；锁仍被并发请求持有（pending/行被删）则该榜本轮未完
      if (!existing || existing.status === 'pending') unsettledTypes.add(r.type);
      continue;
    }
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
        // 修复轮 1（评审 Minor 5）：补翻牌前先核对那条流水的分值——流水 delta ≠ 台账要标 credited 的
        // points 就是钱账漂移（外部改分/上游截断遗留），"补翻牌"会把漂移洗成平账（SP-17）。
        const dupRecord = c.recordId
          ? await PointRecordModel.findById(c.recordId).select({ delta: 1 }).lean()
          : null;
        if (!dupRecord || dupRecord.delta !== r.points) {
          console.error('[points-board] 补翻牌金额核对失败（既有流水与台账应发分值不等或流水缺失），拒绝翻牌并释放锁待人工对账', {
            key, recordId: c.recordId, expected: r.points, actualDelta: dupRecord?.delta,
          });
          await releaseBoardSettlementPending(key);
          unsettledTypes.add(r.type);
          continue;
        }
        const recovered = await flipBoardSettlementToCredited(key, c.recordId ?? undefined);
        if (!recovered) {
          console.error('[points-board] 重复发放未能补翻牌（行已不在 pending：并发补完或后台撤回）', { key, recordId: c.recordId });
          unsettledTypes.add(r.type);
          continue;
        }
        credited += 1;
        // F1：通知带 dedupeKey 发送（重复视为已发送）；盖戳失败/丢失只影响扫描，不影响不重发
        if (await notifyReward(notify, r, period, periodKey)) {
          await markBoardNotified(recovered._id, 'notifiedAt', now);
        }
        continue;
      }
      if (c.credited !== r.points) {
        // 裁定 4：钱账漂移——ignoreDailyCap 之下这本不该可达，走到这里就是上游（额度/明细）出错
        console.error('[points-board] 榜单结算金额不符：台账 points 与实际入账不等，拒绝翻牌并释放锁待重试（钱账漂移！）', {
          key, expected: r.points, credited: c.credited, capped: c.capped, recordId: c.recordId,
        });
        await releaseBoardSettlementPending(key);
        unsettledTypes.add(r.type);
        continue;
      }
      const flipped = await flipBoardSettlementToCredited(key, c.recordId ?? undefined);
      if (!flipped) {
        // 钱已到账而翻牌落空：行不是 pending 了（接管/撤回竞态）。不删行、不重试——大声停在这里等对账
        console.error('[points-board] 发放已落账但翻牌未命中（pending 行在翻牌前已易主），台账/流水需人工对账', key);
        unsettledTypes.add(r.type);
        continue;
      }
      credited += 1;
      if (await notifyReward(notify, r, period, periodKey)) {
        await markBoardNotified(flipped._id, 'notifiedAt', now);
      }
    } catch (e) {
      // 裁定 1：credit/翻牌炸了 ⇒ 释放锁。credit 内部对"已落账"有自己的回滚，走到 catch 就说明
      // 这笔钱没有以本次尝试的名义入账；删行让下一次进页面能重新抢锁再试（idemKey 兜住万一落账成功的双发）。
      let released = false;
      try {
        released = await releaseBoardSettlementPending(key);
      } catch (re) {
        console.error('[points-board] 释放发放锁本身失败（行卡 pending，等超时接管窗口重领）', key, re);
      }
      unsettledTypes.add(r.type);
      console.error('[points-board] 榜单发分失败，锁已按失败路径处理', { key, released }, e);
    }
  }
  // 完成标记（修复轮 1 / Important 1）：本轮过门槛且全部落定的榜各留一行哨兵占位——
  // 下一次 settleDueForUser 走到 isBoardSettlementSkipped 即整榜短路，不再重聚合＋输抢锁。
  // 有未落定条目的榜不标（留给下轮重评）；写路径撞唯一键走续期分支，无 find-then-insert 窗口。
  for (const b of boards) {
    if (!unsettledTypes.has(b.type)) await markBoardSettled({ type: b.type, period, periodKey });
  }
  return { credited, skippedTypes };
}

/**
 * 懒结算入口（挂 Task 9 的积分页/榜单页请求上）：**永不抛错**——结算只是页面数据的顺带动作，
 * 炸了不能把用户的积分页变 500。所有异常在单元粒度被吞并 error 留痕，下后进页面自动重试。
 * 返回 void：调用方不需要（也不该）拿结算结果做用户可见判断。
 */
export async function settleDueForUser(userId: string, now: number = Date.now()): Promise<void> {
  // C5：发分开关关着时不做结算（连聚合都不做）。
  // 但**上榜通知与这个开关解耦**（关闸时没人收到到账通知，前 3 名也要发上榜通知），
  // 所以这里不再直接 return，只把“发分”这一步跳过；上榜通知照常走下面的单元循环。
  const rewardsEnabled = await isBoardRewardsEnabled();
  try {
    const units = await computeSettleUnits(userId, now);
    for (const u of units) {
      if (rewardsEnabled) {
        try {
          await settlePeriod(u.period, u.periodKey, u.endMs, now);
        } catch (e) {
          console.error('[points-board] 懒结算单元失败（下后进页面重试）', { userId, period: u.period, periodKey: u.periodKey }, e);
        }
      }
      // 上榜通知：发分开关关着也要发（见 notifyOnTheListOfBoards 的口径 2）
      try {
        await notifyOnTheListOfBoards(u.period, u.periodKey, u.endMs, now);
      } catch (e) {
        console.error('[points-board] 上榜通知单元失败（下后进页面重试）', { userId, period: u.period, periodKey: u.periodKey }, e);
      }
    }
  } catch (e) {
    console.error('[points-board] settleDueForUser 入口异常（吞掉：挂在页面请求上不能变 500）', { userId }, e);
  }
  // F1：任何一次页面访问都顺带把「进程崩在翻牌与通知之间」遗留的定向通知补投掉。
  // 放在结算循环之后、单独 try/catch：结算单元全炸了也不耽误补通知，且本入口依旧永不抛错。
  try {
    await deliverPendingBoardNotifications(20, now);
  } catch (e) {
    console.error('[points-board] 补投崩溃遗留的榜单通知失败（下后进页面重试）', { userId }, e);
  }
}

/* ==========================================================================
 * 后台面（Task 10）：发放台账列表 + 撤回（备注必填 + 定向通知）。
 *
 * 与结算侧的分工：结算侧写行、翻牌、发钱；这里**只读台账 + 撤一笔已确认的发放**。
 * 三条纪律：
 * 1. **整榜级占位行不是发放行**（status='skipped' + 哨兵 userId，两类见 thresholdSkipReason /
 *    SETTLED_MARKER_REASON）：列表默认视图按发放态 $in 过滤（结构性排除），撤回对它们直接 400
 *    拒绝——不是静默成功，也不是"扣 0 分"空转；判据走 isBoardLevelRow 谓词，reason 认不出常量的
 *    历史整榜行同样按整榜行处理（结构优先于自由文本）。
 * 2. **撤回必须成对**（照 points-signin 的 makeup_reward_rollback 形状：先落反向流水，再翻台账，
 *    最后发通知）：反向流水用 debitPoints 的余额闸门（**禁止扣成负数**）+ 行级 idemKey
 *    `${userId}:board_rollback:${type}:${period}:${periodKey}`（与发放侧 idemKey 同形），
 *    所以并发双撤最多扣一次；台账行**不删**（唯一键继续占位，懒结算不会再发）。
 *    2026-10-30 产品拍板（F4）：余额不足不再拒单——扣 min(余额, 应扣)，扣到 0 就不落扣款流水，
 *    差额记台账 shortfall；余额 ≥ 应扣时行为与旧版逐字节一致。
 * 3. **审计链要留全**：台账行的 recordId 指向原流水，撤回后不清空；反向流水的 refId/idemKey
 *    指回同一个榜单单元，人是「流水 → 台账行 → 通知」三头都能对上的（本仓没有事务，成对靠顺序 + 幂等键）。
 *
 * 通知（§4.8 第 4 条）走**定向** userId；发通知失败不回滚钱——与到账通知同一条纪律，大声留痕，
 * 并靠台账的 revokeNotifiedAt=null 让下一次页面访问补投（F1）。
 * ========================================================================== */

/** 撤回写出的反向流水类型（`_rollback` 结尾＝points-admin-stats 的撤回族口径，总览自动归类） */
export const BOARD_REVOKE_ROLLBACK_TYPE = 'board_reward_rollback';
/** 备注长度上限：它会原文出现在用户收到的通知里，不能当自由长文塞（也防把 5000 字的通知撑爆） */
export const BOARD_REVOKE_NOTE_MAX = 200;

/** 发放行的三个态：整榜级占位行永远是 skipped，天然不在这个集合里（默认视图的排除靠它 + 谓词双保险） */
const PAYOUT_STATUSES: BoardSettlementStatus[] = ['pending', 'credited', 'revoked'];

/** 列表行（Task 11 直接渲染，不再自己拼文案/判按钮） */
export interface BoardSettlementListRow {
  id: string;
  type: string;
  /** 中文名（TYPE_LABEL），未知类型回落裸值 */
  typeLabel: string;
  period: BoardPeriod;
  periodKey: string;
  /** boardLabel 形态（通知正文那套）；脏 periodKey 回落裸 periodKey，列表不为它 500 */
  periodLabel: string;
  /** '骑行·周榜' 一类的榜单标识 */
  board: string;
  /** 整榜级占位行＝null：哨兵 userId 绝不外泄成「某个用户」 */
  userId: string | null;
  uid: number;
  nickname: string;
  rank: number;
  points: number;
  /** 坏账差额（F4 minor）：撤回时没能追回的分（points − 实际扣回）；未撤回/无差额＝0 */
  shortfall: number;
  /** 投递通道（当前只有 inapp；'subscribe' 等第三方通道为订阅消息预留） */
  channel: string;
  /** 通知投递已失败次数（成功不清零；达到上限即放弃） */
  attempts: number;
  /** 最后一次投递失败原因（空串＝没失败过或已成功清空）——运维据此看「卡在哪」 */
  lastError: string;
  /** 下次可投时刻（ms）；null＝立即可投；放弃的行是远期哨兵（可手工清字段复活） */
  nextAttemptAt: number | null;
  status: BoardSettlementStatus;
  /** 判别式：payout / threshold_skip / settled_marker / board_level（reason 不认识的整榜行） */
  kind: 'payout' | 'threshold_skip' | 'settled_marker' | 'board_level';
  boardLevel: boolean;
  /** 只有「发放行且 credited」才允许撤回（后台按它渲染按钮，服务端再独立拒一次） */
  canRevoke: boolean;
  /** skipped＝占位 reason（带常量前缀）；revoked＝后台撤回备注原文 */
  reason: string;
  /** 原流水（revoked 之后仍保留，审计链） */
  recordId: string | null;
  revokedBy: string;
  revokedAt: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * 入参归一 + 校验（全部在查库之前）：query 全是字符串，形态非法一律 400 并点名收到的值。
 * 返回的 filter 前缀刻意只做等值（{period, periodKey, status, type, userId}），
 * 与 schema 里那条读索引的键序一一对应（AB-10 用 EXPLAIN 钉住）。
 */
function toListQuery(q: BoardSettlementListQuery): {
  p: number; ps: number; filter: Record<string, unknown>; payoutRowsOnly: boolean;
} {
  const p = Math.max(1, Math.trunc(Number(q.page) || 1) || 1);
  const ps = Math.min(100, Math.max(1, Math.trunc(Number(q.pageSize) || 20) || 20));

  const status = String(q.status ?? '').trim();
  if (status && !(BOARD_SETTLEMENT_STATUSES as readonly string[]).includes(status)) {
    throw new AppError(400, `筛选状态只能是 ${BOARD_SETTLEMENT_STATUSES.join(' / ')}（收到「${shown(status)}」）`);
  }
  const period = String(q.period ?? '').trim();
  if (period && !(BOARD_SETTLEMENT_PERIODS as readonly string[]).includes(period)) {
    throw new AppError(400, `筛选周期只能是 ${BOARD_SETTLEMENT_PERIODS.join(' / ')}（收到「${shown(period)}」）`);
  }
  const type = String(q.type ?? '').trim();
  if (type && !(ACTIVITY_TYPES as readonly string[]).includes(type)) {
    throw new AppError(400, `筛选运动类型不合法（收到「${shown(type)}」，只认 ${ACTIVITY_TYPES.join(' / ')}）`);
  }
  const rawUserId = String(q.userId ?? '').trim();
  if (rawUserId && !isObjectIdLike(rawUserId)) {
    throw new AppError(400, `用户 ID 不合法（收到「${shown(rawUserId)}」，应为 24 位 ObjectId）`);
  }
  const periodKey = String(q.periodKey ?? '').trim();
  // periodKey 必须与 period 同传：新读索引的前缀是 {period, periodKey}，只给 periodKey 落不到索引上，
  // 而且同一形态串（'2026'）在周/月/年三种 period 下是三个不同的单元，不带 period 的键本身就有歧义。
  if (periodKey && !period) {
    throw new AppError(400, `筛选 periodKey 必须同时给出 period（${shown(periodKey)}）：台账读索引的前缀是 {period, periodKey}`);
  }
  if (periodKey) {
    // Task 7 交接第 3 条：管理端**必须**先过 periodStartMsFromKey 再拿去查（脏键＝别的窗口）
    try {
      periodStartMsFromKey(period as BoardPeriod, periodKey);
    } catch (e) {
      throw new AppError(400, `榜单 periodKey 不是规范形态（period=${period}，收到「${shown(periodKey)}」）：${(e as Error).message}`);
    }
  }

  const filter: Record<string, unknown> = {};
  if (period) filter.period = period;
  if (periodKey) filter.periodKey = periodKey;
  // 显式 status 才按值筛；缺省＝只看发放行（skipped 的两类整榜占位行结构性排除）
  filter.status = status ? status : { $in: PAYOUT_STATUSES };
  if (type) filter.type = type;
  if (rawUserId) filter.userId = new Types.ObjectId(rawUserId);
  return { p, ps, filter, payoutRowsOnly: !status };
}

/** 导出给服务内部与 EXPLAIN 取证共用：列表线上真实下发的过滤器形状（别在测试里另抄一份） */
export function boardSettlementListFilter(q: Pick<BoardSettlementListQuery, 'period' | 'periodKey' | 'status' | 'type' | 'userId'>): Record<string, unknown> {
  return toListQuery(q).filter;
}

/**
 * 台账列表（GET /admin/points/board-settlements）：按 _id 倒序（＝落库/结算顺序）翻页，稳定不跳行。
 * total 跟着筛选条件走；整榜级行的 userId 一律下发 null（哨兵 id 不出后台）。
 */
export async function listBoardSettlements(q: BoardSettlementListQuery): Promise<{
  total: number; page: number; pageSize: number; payoutRowsOnly: boolean; items: BoardSettlementListRow[];
}> {
  const { p, ps, filter, payoutRowsOnly } = toListQuery(q);
  const [rows, total] = await Promise.all([
    BoardSettlementModel.find(filter).sort({ _id: -1 }).skip((p - 1) * ps).limit(ps).lean<BoardSettlementRow[]>(),
    BoardSettlementModel.countDocuments(filter),
  ]);
  // 真人行才 join 用户信息（缺文档＝删号/未补号：昵称空串、uid 0，行本身保留——台账不能因为用户没了就少行）
  const realIds = [...new Set(rows.filter((r) => !isBoardLevelRow(r)).map((r) => String(r.userId)))];
  const users = new Map<string, { uid: number; nickname: string }>();
  if (realIds.length > 0) {
    const found = await UserModel.find({ _id: { $in: realIds.map((id) => new Types.ObjectId(id)) } })
      .select({ uid: 1, nickname: 1 }).lean();
    for (const u of found) users.set(String(u._id), { uid: Number(u.uid ?? 0), nickname: String(u.nickname ?? '') });
  }
  const items = rows.map((row) => toListRow(row, users));
  return { total, page: p, pageSize: ps, payoutRowsOnly, items };
}

/** 一行台账 → DTO：kind/boardLevel/canRevoke 三项都由谓词派生（不重复写判据） */
function toListRow(row: BoardSettlementRow, users: Map<string, { uid: number; nickname: string }>): BoardSettlementListRow {
  const boardLevel = isBoardLevelRow(row);
  const kind = boardLevel
    ? (isThresholdSkip(row) ? 'threshold_skip' : isSettledMarker(row) ? 'settled_marker' : 'board_level')
    : 'payout';
  let periodLabel = row.periodKey;
  try {
    periodLabel = boardLabel(row.period, row.periodKey);
  } catch {
    // 脏 periodKey（历史/手工行）只影响展示，不许把整页列表打成 500
  }
  return {
    id: String(row._id),
    type: row.type,
    typeLabel: TYPE_LABEL[row.type] ?? row.type,
    period: row.period,
    periodKey: row.periodKey,
    periodLabel,
    board: `${TYPE_LABEL[row.type] ?? row.type}·${PERIOD_LABEL[row.period] ?? row.period}`,
    userId: boardLevel ? null : String(row.userId),
    uid: users.get(String(row.userId))?.uid ?? 0,
    nickname: users.get(String(row.userId))?.nickname ?? '',
    rank: row.rank,
    points: row.points,
    shortfall: Number(row.shortfall ?? 0),
    // 老行没有 channel 字段：与 drain 的读口径一致，按 inapp 下发
    channel: row.channel == null ? 'inapp' : String(row.channel),
    attempts: Number(row.attempts ?? 0),
    lastError: row.lastError ?? '',
    nextAttemptAt: row.nextAttemptAt == null ? null : Number(row.nextAttemptAt),
    status: row.status as BoardSettlementStatus,
    kind,
    boardLevel,
    canRevoke: !boardLevel && row.status === 'credited',
    reason: row.reason ?? '',
    recordId: row.recordId ? String(row.recordId) : null,
    revokedBy: row.revokedBy ?? '',
    revokedAt: Number(row.revokedAt ?? 0),
    createdAt: row.createdAt ? new Date(row.createdAt).getTime() : 0,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).getTime() : 0,
  };
}

/** 列表查询入参（路由把 query 原样递过来，全是 string|undefined） */
export interface BoardSettlementListQuery {
  page?: string | number;
  pageSize?: string | number;
  type?: string;
  period?: string;
  periodKey?: string;
  userId?: string;
  /** 'skipped'＝显式要整榜级行；缺省＝只看发放行 */
  status?: string;
}

export interface BoardSettlementRevokeInput {
  note?: unknown;
}

export interface RevokeDeps {
  notify?: typeof createNotification;
}

export interface BoardSettlementRevokeResult {
  id: string;
  status: BoardSettlementStatus;
  userId: string;
  type: string;
  period: BoardPeriod;
  periodKey: string;
  rank: number;
  points: number;
  /** 原流水（保持不变，审计链） */
  recordId: string;
  /** 本次落下的反向流水 pointrecords._id；余额 0 时跳过扣减 ⇒ null（幂等重放时是同一笔） */
  rollbackRecordId: string | null;
  /** 撤回后的余额（**当前**余额：幂等重放也不再返回旧流水的 balanceAfter） */
  balance: number;
  /** 实际扣回的金额（＝min(应扣, 余额)；余额 0 时是 0） */
  deducted: number;
  /** 没能扣回的差额（＝points − deducted）：后台对账与通知里的「差额」用它 */
  shortfall: number;
  /**
   * 补位结果（F3）：本次撤回后重算**这一个榜**新拿到发放权的人（第 4 名补到第 3 名…）。
   * 被撤者永远不会出现在这里（他的台账行是 revoked，重算时被排除在榜外）。
   */
  promoted: { userId: string; rank: number; points: number }[];
  note: string;
  revokedBy: string;
  revokedAt: number;
  /** 通知落空时为 null（钱与台账照样成对，缺席的通知由补投任务兜底，见 notifiedAt 字段） */
  notification: { id: string; title: string; content: string } | null;
}

function shown(value: unknown): string {
  if (value === undefined || value === null || value === '') return '空';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * 后台撤回（POST /admin/points/board-settlements/:id/revoke）。
 * 闸门顺序（每一步都在写库之前，任何一条被拒都不留下流水/通知/状态变更）：
 * id 形态 → 备注必填 → 行存在 → 整榜级 → pending/revoked → 分值与流水凭据（存在性 + type/refId/userId/delta 对账）
 * → 钱（扣 min(余额, 应扣)）→ 翻牌 → 通知 → 补位（删本榜完成标记 + 重算这一期）。
 * 余额不足**不是**闸门（F4）：扣到 0、差额记 shortfall，撤回照样生效。
 */
export async function revokeBoardSettlement(
  id: string,
  input: BoardSettlementRevokeInput,
  opts: { adminId?: string; now?: number; deps?: RevokeDeps } = {},
): Promise<BoardSettlementRevokeResult> {
  assertObjectIdLike(id, '发放台账不存在');
  const rawNote = typeof input?.note === 'string' ? input.note.trim() : '';
  if (!rawNote) throw new AppError(400, '撤回备注必填：它会原文出现在用户收到的通知里');
  if (rawNote.length > BOARD_REVOKE_NOTE_MAX) {
    throw new AppError(400, `撤回备注不能超过 ${BOARD_REVOKE_NOTE_MAX} 字（当前 ${rawNote.length}）`);
  }

  const row = (await BoardSettlementModel.findById(id).lean()) as BoardSettlementRow | null;
  if (!row) throw new AppError(404, '发放台账不存在');

  // 1) 整榜级占位行（门槛占位 / 完成标记 / reason 认不出的异类整榜行）不是发放记录：直接拒。
  //    判据是结构（哨兵 userId + status='skipped'），不看 reason 文本——静默"撤回一笔 0 分"
  //    会给一个不存在的用户发通知，比拒单危险得多。
  if (isBoardLevelRow(row) || row.status === 'skipped') {
    const kind = isThresholdSkip(row) ? '门槛占位' : isSettledMarker(row) ? '完成标记' : '未分类';
    throw new AppError(400, `整榜级占位行不是发放记录，不能撤回（${kind}，id=${id}）`);
  }
  if (row.status === 'revoked') throw new AppError(400, `该发放记录已撤回（status=revoked），不能重复撤回（id=${id}）`);
  if (row.status === 'pending') {
    throw new AppError(400, `该行还在结算中（status=pending），发放未确认，不能撤回（id=${id}）；等它翻牌或超时接管后再看`);
  }
  if (row.status !== 'credited') throw new AppError(400, `台账行状态不合法（status=${shown(row.status)}），不能撤回（id=${id}）`);
  const points = Number(row.points);
  if (!Number.isInteger(points) || points <= 0) {
    throw new AppError(400, `台账行的分值不合法（points=${shown(row.points)}），不能自动撤回，请人工对账（id=${id}）`);
  }
  if (!row.recordId) throw new AppError(400, `台账行缺少流水凭据（recordId 为空），不能自动撤回，请人工对账（id=${id}）`);
  if (!row.periodKey) throw new AppError(400, `台账行缺少 periodKey，不能撤回（id=${id}）`);

  // 文案派生（脏 periodKey 在这里就拒，别让 boardLabel 的 500 冒到后台）。
  // label 本身在 revokeNotificationContent 里现拼（即时发送与补投共用一份），这里只做一次校验。
  let tag: string;
  try {
    tag = boardPeriodTag(row.period, row.periodKey);
    boardLabel(row.period, row.periodKey);
  } catch (e) {
    throw new AppError(400, `台账行的 periodKey 不是规范形态（${shown(row.periodKey)}），不能自动撤回，请人工对账：${(e as Error).message}`);
  }
  const typeLabel = TYPE_LABEL[row.type] ?? row.type;
  const refId = `${row.type}:${row.period}:${row.periodKey}`;

  // 2) 原流水核对：撤回是对着那笔 board_reward 冲销，钱账对不上就停手（人工对账），别扣无凭据的分
  //    修复轮 1（评审 Important 1）：金额也进对账判据——扣的是 row.points，凭据却是那条流水的 delta；
  //    两者不等＝钱账漂移（外部改分/上游截断遗留），扣下去要么多扣用户的分、要么撤得比发出来的还少。
  //    到账侧的补翻牌早就钉了同一条不变式（:705 的 dupRecord.delta !== r.points），撤回侧此前漏了，
  //    会让「台账 points ≠ 原流水 delta」的行带着不属于自己的扣款金额通过闸门。
  const original = await PointRecordModel.findById(row.recordId).lean();
  if (!original) {
    throw new AppError(400, `台账行的原流水已不存在（recordId=${row.recordId}），不能自动撤回，请人工对账（id=${id}）`);
  }
  if (original.type !== 'board_reward' || original.refId !== refId || String(original.userId) !== String(row.userId)
    || Number(original.delta) !== points) {
    throw new AppError(400, `台账行与原流水对不上（流水 type=${original.type} refId=${original.refId} userId=${original.userId} delta=${Number(original.delta)}，`
      + `台账 refId=${refId} userId=${row.userId} points=${points}），不能自动撤回，请人工对账（id=${id}）`);
  }

  const now = opts.now ?? Date.now();
  const notify = opts.deps?.notify ?? createNotification;
  const userId = String(row.userId);

  // 3) 余额不足时扣到 0（2026-10-30 产品拍板 F4：余额不能变负，也不许因此拒单）
  //    扣减金额 = min(余额, 应扣)；扣 0 分时**整段跳过扣减**（账本里不留 delta=0 的流水）。
  //    预读余额只用来算「这次最多能扣多少」，真正的闸门仍是 debitPoints 的原子条件
  //    （balance >= points）——预读与扣减之间被并发花光时它抛「积分不足」，这里重读余额再试
  //    （最多 3 枪；仍抢不到就把异常照抛，绝不为了"成功"去扣一笔没核对的账）。
  //    修复轮 1（F4 minor）：3 枪都输在抢锁上时 debit 仍是 null，若余额此刻 > 0 就说明不是
  //    「被花光」而是「一直抢不到」——必须抛错（重读一次确认），不能静默按 0 扣、把差额记成坏账。
  let balance = (await PointAccountModel.findOne({ userId }).select({ balance: 1 }).lean())?.balance ?? 0;
  let debit: Awaited<ReturnType<typeof debitPoints>> | null = null;
  let lastRaceErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const deductible = Math.min(balance, points);
    if (deductible <= 0) break;
    try {
      debit = await debitPoints(userId, {
        type: BOARD_REVOKE_ROLLBACK_TYPE,
        // §4.8 第 5 条的形态 + 「撤回」前缀（与补签那条 makeup_reward_rollback 同一命名法）
        title: `撤回${typeLabel}·${PERIOD_LABEL[row.period]}第 ${row.rank} 名·${tag}`,
        points: deductible,
        bizDate: bjDateStr(now),
        refType: 'board',
        refId,
        idemKey: `${userId}:board_rollback:${row.type}:${row.period}:${row.periodKey}`,
      }, now);
      break;
    } catch (e) {
      const insufficient = e instanceof AppError && e.statusCode === 400 && /积分不足/.test(e.message);
      if (!insufficient) throw e;
      lastRaceErr = e;
      balance = (await PointAccountModel.findOne({ userId }).select({ balance: 1 }).lean())?.balance ?? 0;
    }
  }
  if (!debit && balance > 0) {
    // 重读一次确认：余额仍 > 0 ⇒ 异常照抛（与注释同一取向），绝不按 0 扣、静默少收差额
    balance = (await PointAccountModel.findOne({ userId }).select({ balance: 1 }).lean())?.balance ?? 0;
    if (balance > 0) {
      throw lastRaceErr instanceof Error
        ? lastRaceErr
        : new AppError(400, `积分扣减连续抢锁失败（余额 ${balance}，应扣 ${points}），撤回未生效，请重试`);
    }
  }
  // 重放（duplicated）时 debit.points 是那笔既有流水的实际扣减额，差额因此可重算、不双扣
  const deducted = debit ? debit.points : 0;
  const shortfall = points - deducted;

  // 4) 翻牌：credited → revoked。条件写 + **不动 recordId**（审计链），也不删行（唯一键继续占位）。
  //    shortfall 一并落台账：补投的撤回通知要还原「实际扣回 / 差额」，后台对账也读它。
  const flipped = (await BoardSettlementModel.findOneAndUpdate(
    { _id: row._id, status: 'credited' },
    { $set: { status: 'revoked', reason: rawNote, revokedBy: String(opts.adminId ?? ''), revokedAt: now, shortfall } },
    { returnDocument: 'after' },
  ).lean()) as BoardSettlementRow | null;
  if (!flipped) {
    // 钱已按幂等键扣了、行却不是 credited：并发另一路刚撤完（或状态被别的入口改过）。大声留痕等对账
    console.error('[points-board] 撤回归档落空（行已不是 credited），反向流水已落账需人工核对', {
      id, userId, refId, rollbackRecordId: debit?.recordId ?? null, deducted,
    });
    throw new AppError(400, `撤回未生效：该行状态已变更（并发撤回或别的入口改过），请刷新后核对（id=${id}）`);
  }

  // 5) 定向通知（§4.8 第 4 条逐字；余额不足时追加差额子句）。失败不回滚钱——与到账通知同一条纪律，
  //    且台账的 revokeNotifiedAt 留 null，下一次进页面由 deliverPendingBoardNotifications 补投。
  const content = revokeNotificationContent({
    type: row.type,
    period: row.period,
    periodKey: row.periodKey,
    rank: row.rank,
    points,
    reason: rawNote,
    shortfall,
  });
  let notification: BoardSettlementRevokeResult['notification'] = null;
  let notified = false;
  try {
    const n = await notify(
      { userId, category: 'reward', published: true, title: REVOKE_NOTIFICATION_TITLE, content },
      boardNotificationDedupeKey('revoke', { type: row.type, period: row.period, periodKey: row.periodKey, userId }),
    );
    notification = { id: n.id, title: n.title, content: n.content };
    notified = true;
  } catch (e) {
    console.error('[points-board] 撤回通知发送失败（撤回已落定，通知缺席需补发）', { id, userId, refId, note: rawNote }, e);
  }
  if (notified) await markBoardNotified(flipped._id, 'revokeNotifiedAt', now);

  // 6) 补位（F3，2026-10-30 产品拍板「第 4 名补位」）：撤掉一个奖 ⇒ 这个榜的名次前移，
  //    下一个够格的人要拿到钱。两步：
  //    a) 删掉**这个榜**的新鲜完成标记——它记的是「这一榜已结算完」，现在结论变了；
  //       其他 7 个榜的标记原样保留，重算时整榜短路（只有被撤的榜跑聚合）。
  //    b) 用同一套 settlePeriod 重算这一期：revoked 用户被排除在榜外、已有 credited 的人撞终态，
  //       所以只有被补位的那位真的拿到新发放。补位失败不回滚撤回（钱已扣、行已翻），只留痕。
  const body = { type: row.type, period: row.period, periodKey: row.periodKey };
  const promoted: BoardSettlementRevokeResult['promoted'] = [];
  try {
    await BoardSettlementModel.deleteOne({ ...body, userId: BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID });
    const creditedBefore = new Set((await BoardSettlementModel.find({ ...body, status: 'credited' })
      .select({ userId: 1 })
      .lean()).map((r) => String(r.userId)));
    const deps: SettleDeps = opts.deps?.notify ? { notify: opts.deps.notify } : {};
    await settlePeriod(row.period, row.periodKey, settleBoundaryMs(row.period, row.periodKey), now, deps);
    const creditedAfter = await BoardSettlementModel.find({ ...body, status: 'credited' })
      .select({ userId: 1, rank: 1, points: 1 })
      .sort({ rank: 1, _id: 1 })
      .lean();
    for (const r of creditedAfter) {
      if (creditedBefore.has(String(r.userId))) continue;
      promoted.push({ userId: String(r.userId), rank: Number(r.rank), points: Number(r.points) });
    }
  } catch (e) {
    console.error('[points-board] 撤回后补位重算失败（名额暂空，下一次进页面重算或人工补发）', { id, userId, refId }, e);
  }

  // 重放（duplicated）时 debit.balance 是**那笔旧流水落账时**的 balanceAfter，用户之后进出过分
  // 就过期了——回包要报当前余额（修复轮 1 / F4 minor），只有本次真正扣款才信 debit.balance。
  const balanceAfter = debit && !debit.duplicated
    ? debit.balance
    : ((await PointAccountModel.findOne({ userId }).select({ balance: 1 }).lean())?.balance ?? 0);
  return {
    id: String(row._id),
    status: 'revoked',
    userId,
    type: row.type,
    period: row.period,
    periodKey: row.periodKey,
    rank: row.rank,
    points,
    recordId: String(row.recordId),
    rollbackRecordId: debit?.recordId ?? null,
    balance: balanceAfter,
    deducted,
    shortfall,
    promoted,
    note: rawNote,
    revokedBy: String(opts.adminId ?? ''),
    revokedAt: now,
    notification,
  };
}
