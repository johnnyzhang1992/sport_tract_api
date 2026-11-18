/**
 * 管理端「运动计划」数据页（docs/22 = docs/22-管理端运动计划数据页.md，2026-11-18）：纯只读统计，无写操作。
 *
 * 口径（拍板结论见 docs/22 第〇节）：
 * - 一律 period='daily'（周计划 2026-11-14 下线，存量周快照不进任何指标）；
 * - 渗透率分母 = 近 30 天有 finished 运动的去重用户；
 * - 趋势/达成率用快照（T-1）；「今日有运动」实时聚合；
 * - 「新增计划趋势」按现存计划文档的 createdAt 落桶——闲置取消会删文档，P1 plan_events
 *   上线前这个数偏低（已删的计划不可回补），属已知近似，前端标注。
 */
import { Types } from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import { UserModel } from '../models/user.model.js';
import { ExercisePlanModel } from '../models/exercise-plan.model.js';
import { ExercisePlanPeriodModel } from '../models/exercise-plan-period.model.js';
import { AppError } from '../utils/app-error.js';
import { bjDateStr, bjToday0 } from '../utils/bj-time.js';

const DAY_MS = 86_400_000;
/** 快照日期键（periodKey）只认 YYYY-MM-DD，脏数据跳过（同 TP6 的防御） */
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 目标距离档（米）：阈值语义为「≤2km / 2–5km / 5–10km / >10km」——上限含等号
 * （默认目标 3km 必须落进 2–5km，2000m 整必须落进 ≤2km，不能被 [min,max) 边界挤到下一档）。
 */
const DIST_THRESHOLDS = [2000, 5000, 10000];
const DIST_LABELS = ['≤2km', '2–5km', '5–10km', '>10km'];
/** 目标时长档（分钟）：同上，「≤15 / 15–30 / 30–60 / >60」，30min 整含在 15–30 档 */
const DUR_THRESHOLDS = [15, 30, 60];
const DUR_LABELS = ['≤15min', '15–30min', '30–60min', '>60min'];
/** 完成率分档（近 30 天快照，minRatio = 三项目标里最弱一项的完成比）；[min, max) 左闭右开 */
const COMPLETION_TIERS = [
  { label: '<50%', min: 0, max: 0.5 },
  { label: '50–99%', min: 0.5, max: 1 },
  { label: '100–199%', min: 1, max: 2 },
  { label: '≥200%', min: 2, max: Number.POSITIVE_INFINITY },
];

/** 上限含等号的档位归属：v ≤ thresholds[i] → 第 i 档，超过全部阈值 → 最后一档 */
function thresholdIndex(v: number, thresholds: number[]): number {
  for (let i = 0; i < thresholds.length; i += 1) {
    if (v <= thresholds[i]) return i;
  }
  return thresholds.length;
}

function tierIndex(value: number, tiers: { min: number; max: number }[]): number {
  for (let i = 0; i < tiers.length; i += 1) {
    if (value >= tiers[i].min && value < tiers[i].max) return i;
  }
  return -1;
}

const pct = (part: number, total: number): number => (total > 0 ? Math.round((part / total) * 100) : 0);

/** 每用户快照聚合出的统计口径（列表/详情共用） */
interface UserSnapStats {
  snapshotDays: number;
  achievedTotal: number;
  last30Total: number;
  last30Achieved: number;
  bestStreak: number;
  lastAchievedAt: number;
}

/** 近 30 天有 finished 运动的去重用户（渗透率分母，docs/22 拍板口径） */
async function active30UserIds(now: number): Promise<string[]> {
  const ids = await ActivityModel.distinct('userId', {
    status: 'finished',
    startTime: { $gte: now - 30 * DAY_MS },
  });
  return ids.map((id) => String(id));
}

/** 每用户快照统计：计数走聚合，连续段/最近达成走一次有序游标（数据量 = 快照总数，P0 可接受） */
async function perUserSnapStats(now: number): Promise<Map<string, UserSnapStats>> {
  const last30Start = now - 30 * DAY_MS;
  const grouped = await ExercisePlanPeriodModel.aggregate<{
    _id: Types.ObjectId;
    total: number;
    achieved: number;
    last30Total: number;
    last30Achieved: number;
  }>([
    { $match: { period: 'daily', periodKey: { $regex: DATE_KEY_RE } } },
    {
      $group: {
        _id: '$userId',
        total: { $sum: 1 },
        achieved: { $sum: { $cond: ['$allAchieved', 1, 0] } },
        last30Total: { $sum: { $cond: [{ $gte: ['$windowStart', last30Start] }, 1, 0] } },
        last30Achieved: {
          $sum: { $cond: [{ $and: [{ $gte: ['$windowStart', last30Start] }, '$allAchieved'] }, 1, 0] },
        },
      },
    },
  ]);
  const out = new Map<string, UserSnapStats>();
  for (const g of grouped) {
    out.set(String(g._id), {
      snapshotDays: g.total,
      achievedTotal: g.achieved,
      last30Total: g.last30Total,
      last30Achieved: g.last30Achieved,
      bestStreak: 0,
      lastAchievedAt: 0,
    });
  }
  // 连续达成（连续自然日全达成）与最近达成日：按用户+窗口正序扫一遍
  const rows = await ExercisePlanPeriodModel.find({ period: 'daily', periodKey: { $regex: DATE_KEY_RE } })
    .select({ userId: 1, windowStart: 1, allAchieved: 1 })
    .sort({ userId: 1, windowStart: 1 })
    .lean();
  let curUid = '';
  let run = 0;
  for (const r of rows) {
    const uid = String(r.userId);
    if (uid !== curUid) {
      curUid = uid;
      run = 0;
    }
    const stats = out.get(uid);
    if (!stats) continue; // 聚合里没有（理论不会发生，防御脏数据）
    if (r.allAchieved) {
      // 连续 = 窗口起点恰好差一天（东八区 0 点对齐）
      run = run > 0 && stats.lastAchievedAt > 0 && r.windowStart - stats.lastAchievedAt === DAY_MS ? run + 1 : 1;
      stats.bestStreak = Math.max(stats.bestStreak, run);
      stats.lastAchievedAt = r.windowStart;
    }
  }
  return out;
}

/** 汇总卡（docs/22 §3.1）：渗透率/有效计划/今日有运动/昨日与近 7 日达成率 */
export async function adminPlanOverview(now = Date.now()) {
  const today0 = bjToday0(now);
  const yesterdayKey = bjDateStr(today0 - DAY_MS);
  const weekStart = today0 - 6 * DAY_MS;

  const [active30Ids, plans, snapUserIds] = await Promise.all([
    active30UserIds(now),
    ExercisePlanModel.find({}).select({ userId: 1, createdAt: 1 }).lean(),
    ExercisePlanPeriodModel.distinct('userId', { period: 'daily' }),
  ]);
  const planUserIds = new Set<string>([
    ...plans.map((p) => String(p.userId)),
    ...snapUserIds.map((id) => String(id)),
  ]);
  // 渗透率：分子分母必须同窗口（曾建计划是全历史口径，直接相除会 >100%——
  // 历史用户流失后就溢出了）。改为「近 30 天活跃用户中建过计划的比例」。
  const penetrationUsers = active30Ids.filter((id) => planUserIds.has(id)).length;

  // 今日有运动：现存计划用户里今天有 finished 运动的去重人数（实时聚合）
  const todayMoved = planUserIds.size
    ? (
        await ActivityModel.distinct('userId', {
          status: 'finished',
          startTime: { $gte: today0, $lt: today0 + DAY_MS },
          userId: { $in: [...planUserIds].map((id) => new Types.ObjectId(id)) },
        })
      ).length
    : 0;

  // 昨日 / 近 7 日达成率（快照口径，T-1）
  const [yesterdayRow] = await ExercisePlanPeriodModel.aggregate<{ total: number; achieved: number }>([
    { $match: { period: 'daily', periodKey: yesterdayKey } },
    { $group: { _id: null, total: { $sum: 1 }, achieved: { $sum: { $cond: ['$allAchieved', 1, 0] } } } },
  ]);
  const [weekRow] = await ExercisePlanPeriodModel.aggregate<{ total: number; achieved: number }>([
    { $match: { period: 'daily', periodKey: { $regex: DATE_KEY_RE }, windowStart: { $gte: weekStart, $lt: today0 + DAY_MS } } },
    { $group: { _id: null, total: { $sum: 1 }, achieved: { $sum: { $cond: ['$allAchieved', 1, 0] } } } },
  ]);

  return {
    planUsers: planUserIds.size,
    active30Users: active30Ids.length,
    /** 渗透率 = 近 30 天活跃 ∩ 建过计划 ÷ 近 30 天活跃（分子分母同窗口，恒 ≤100%） */
    penetrationUsers,
    penetration: pct(penetrationUsers, active30Ids.length),
    activePlans: plans.length,
    todayMoved,
    yesterday: {
      total: yesterdayRow?.total || 0,
      achieved: yesterdayRow?.achieved || 0,
      rate: pct(yesterdayRow?.achieved || 0, yesterdayRow?.total || 0),
    },
    last7: {
      total: weekRow?.total || 0,
      achieved: weekRow?.achieved || 0,
      rate: pct(weekRow?.achieved || 0, weekRow?.total || 0),
    },
  };
}

export interface AdminPlanTrendQuery {
  days?: number;
}

/** 趋势（docs/22 §3.2 图①②）：近 7/30/90 天，达成率按快照，新增计划按现存文档 createdAt */
export async function adminPlanTrend(q: AdminPlanTrendQuery, now = Date.now()) {
  const days = [7, 30, 90].includes(Number(q.days)) ? Number(q.days) : 30;
  const today0 = bjToday0(now);
  const labels: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) labels.push(bjDateStr(today0 - i * DAY_MS));
  const startLabel = labels[0];

  const [snapRows, planRows] = await Promise.all([
    ExercisePlanPeriodModel.aggregate<{
      _id: string;
      total: number;
      achieved: number;
      dist: number;
      dur: number;
      cnt: number;
    }>([
      {
        $match: { period: 'daily', periodKey: { $gte: startLabel, $lte: labels[labels.length - 1], $regex: DATE_KEY_RE } },
      },
      {
        $group: {
          _id: '$periodKey',
          total: { $sum: 1 },
          achieved: { $sum: { $cond: ['$allAchieved', 1, 0] } },
          dist: { $sum: { $cond: ['$achieved.distance', 1, 0] } },
          dur: { $sum: { $cond: ['$achieved.duration', 1, 0] } },
          cnt: { $sum: { $cond: ['$achieved.count', 1, 0] } },
        },
      },
    ]),
    ExercisePlanModel.aggregate<{ _id: string; count: number }>([
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+08:00' } },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const snapByKey = new Map(snapRows.map((r) => [r._id, r]));
  const newByKey = new Map(planRows.map((r) => [r._id, r.count]));
  const achieveRate: number[] = [];
  const distRate: number[] = [];
  const durRate: number[] = [];
  const cntRate: number[] = [];
  const newPlans: number[] = [];
  for (const label of labels) {
    const s = snapByKey.get(label);
    achieveRate.push(pct(s?.achieved || 0, s?.total || 0));
    distRate.push(pct(s?.dist || 0, s?.total || 0));
    durRate.push(pct(s?.dur || 0, s?.total || 0));
    cntRate.push(pct(s?.cnt || 0, s?.total || 0));
    newPlans.push(newByKey.get(label) || 0);
  }
  return {
    days,
    labels,
    newPlans,
    newPlansNote: '仅现存计划（闲置取消会删文档，P1 事件采集前为近似值）',
    achieveRate,
    distRate,
    durRate,
    cntRate,
  };
}

/** 分布（docs/22 §3.2 图③④）：目标三档位（现存计划）+ 完成率分档（近 30 天快照） */
export async function adminPlanDistribution(now = Date.now()) {
  const last30Start = bjToday0(now) - 29 * DAY_MS;
  const [plans, snaps] = await Promise.all([
    ExercisePlanModel.find({}).select({ targets: 1 }).lean(),
    ExercisePlanPeriodModel.find({
      period: 'daily',
      periodKey: { $regex: DATE_KEY_RE },
      windowStart: { $gte: last30Start },
    })
      .select({ targets: 1, progress: 1 })
      .lean(),
  ]);

  const bucket = (labels: string[]) => labels.map((label) => ({ label, count: 0 }));
  const distTiers = bucket(DIST_LABELS);
  const durTiers = bucket(DUR_LABELS);
  const cntTiers = bucket(['1次', '2次', '3次及以上']);
  for (const p of plans) {
    const distM = p.targets?.distanceM || 0;
    if (distM > 0) {
      const i = thresholdIndex(distM, DIST_THRESHOLDS);
      if (i >= 0) distTiers[i].count += 1;
    }
    const durMin = p.targets?.durationMin || 0;
    if (durMin > 0) {
      const i = thresholdIndex(durMin, DUR_THRESHOLDS);
      if (i >= 0) durTiers[i].count += 1;
    }
    const cnt = p.targets?.count || 0;
    if (cnt > 0) cntTiers[Math.min(cnt, 3) - 1].count += 1;
  }

  const completionTiers = bucket(COMPLETION_TIERS.map((t) => t.label));
  for (const s of snaps) {
    // 完成率 = 三项已设目标里最弱一项的完成比（与小程序 overStreak 同口径）
    let minRatio = Number.POSITIVE_INFINITY;
    if ((s.targets?.distanceM || 0) > 0) minRatio = Math.min(minRatio, (s.progress?.distanceM || 0) / s.targets!.distanceM);
    if ((s.targets?.durationMin || 0) > 0) minRatio = Math.min(minRatio, (s.progress?.durationSec || 0) / (s.targets!.durationMin * 60));
    if ((s.targets?.count || 0) > 0) minRatio = Math.min(minRatio, (s.progress?.count || 0) / s.targets!.count);
    if (!Number.isFinite(minRatio)) continue; // 三项目标全为 0 的脏快照不进分档
    const i = tierIndex(minRatio, COMPLETION_TIERS);
    if (i >= 0) completionTiers[i].count += 1;
  }

  return {
    distTiers,
    durTiers,
    cntTiers,
    completionTiers,
    completionSampleDays: 30,
  };
}

export interface AdminPlanUsersQuery {
  page?: number;
  pageSize?: number;
  /** active=进行中（有计划文档）/ cancelled=已取消（无文档但有快照） */
  status?: string;
  /** 目标距离档 t1~t4 */
  distTier?: string;
  /** createdAt（默认）/ rate30 / achieved / streak */
  sortBy?: string;
  order?: string;
}

/** 用户计划列表（docs/22 §3.3）：计划文档 ∪ 快照用户，JS 内存组装后分页（P0 数据量可接受） */
export async function adminPlanUsers(q: AdminPlanUsersQuery, now = Date.now()) {
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));
  if (q.status && !['active', 'cancelled'].includes(q.status)) {
    throw new AppError(400, 'status 不合法：仅支持 active / cancelled');
  }
  if (q.distTier && !['t1', 't2', 't3', 't4'].includes(q.distTier)) {
    throw new AppError(400, 'distTier 不合法：仅支持 t1~t4');
  }
  // 组合筛选语义（docs/22）：cancelled 的用户没有计划文档 → 没有目标档位可言，
  // 两个一起传必然 0 结果，与其让用户以为「没人」不如直接拒绝（前端也应禁用该组合）。
  if (q.status === 'cancelled' && q.distTier) {
    throw new AppError(400, '已取消的计划没有目标档位：status=cancelled 与 distTier 不能同时筛选');
  }

  const [plans, snapStats] = await Promise.all([
    ExercisePlanModel.find({}).select({ userId: 1, targets: 1, createdAt: 1, updatedAt: 1 }).lean(),
    perUserSnapStats(now),
  ]);
  const planByUid = new Map(plans.map((p) => [String(p.userId), p]));

  // 行集合 = 有计划或有过快照的用户
  const uids = new Set<string>([...planByUid.keys(), ...snapStats.keys()]);
  const distTierIdx = q.distTier ? Number(q.distTier.slice(1)) - 1 : -1;
  const rows: Array<{
    userId: string;
    status: 'active' | 'cancelled';
    targets: { distanceM: number; durationMin: number; count: number };
    createdAt: number;
    changed: boolean;
    snapshotDays: number;
    achievedTotal: number;
    rate30: number;
    bestStreak: number;
    lastAchievedAt: number;
  }> = [];
  for (const uid of uids) {
    const plan = planByUid.get(uid);
    const stats = snapStats.get(uid) ?? {
      snapshotDays: 0,
      achievedTotal: 0,
      last30Total: 0,
      last30Achieved: 0,
      bestStreak: 0,
      lastAchievedAt: 0,
    };
    const status = plan ? 'active' : 'cancelled';
    if (q.status && q.status !== status) continue;
    const distanceM = plan?.targets?.distanceM || 0;
    if (distTierIdx >= 0 && (!plan || thresholdIndex(distanceM, DIST_THRESHOLDS) !== distTierIdx)) continue;
    rows.push({
      userId: uid,
      status,
      targets: {
        distanceM,
        durationMin: plan?.targets?.durationMin || 0,
        count: plan?.targets?.count || 0,
      },
      createdAt: plan ? new Date(plan.createdAt).getTime() : 0,
      changed: plan ? Boolean(plan.updatedAt) && new Date(plan.updatedAt).getTime() - new Date(plan.createdAt).getTime() > 60_000 : false,
      snapshotDays: stats.snapshotDays,
      achievedTotal: stats.achievedTotal,
      rate30: pct(stats.last30Achieved, stats.last30Total),
      bestStreak: stats.bestStreak,
      lastAchievedAt: stats.lastAchievedAt,
    });
  }

  const sortKey = q.sortBy?.trim() || 'createdAt';
  if (!['createdAt', 'rate30', 'achieved', 'streak'].includes(sortKey)) {
    throw new AppError(400, 'sortBy 不合法：仅支持 createdAt / rate30 / achieved / streak');
  }
  const dir = q.order === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const va =
      sortKey === 'rate30' ? a.rate30 : sortKey === 'achieved' ? a.achievedTotal : sortKey === 'streak' ? a.bestStreak : a.createdAt;
    const vb =
      sortKey === 'rate30' ? b.rate30 : sortKey === 'achieved' ? b.achievedTotal : sortKey === 'streak' ? b.bestStreak : b.createdAt;
    return (va - vb) * dir || (a.userId < b.userId ? -1 : 1);
  });

  const total = rows.length;
  const items = rows.slice((page - 1) * pageSize, page * pageSize);
  const users = await UserModel.find({ _id: { $in: items.map((i) => new Types.ObjectId(i.userId)) } })
    .select({ nickname: 1, avatarUrl: 1 })
    .lean();
  const userById = new Map(users.map((u) => [String(u._id), u]));

  return {
    total,
    page,
    pageSize,
    items: items.map((i) => ({
      ...i,
      nickname: userById.get(i.userId)?.nickname || '',
      avatarUrl: userById.get(i.userId)?.avatarUrl || '',
    })),
  };
}

/** 用户计划详情（docs/22 §3.4）：目标 + 近 3 个月逐日快照 + 汇总口径 */
export async function adminPlanUserDetail(userId: string, now = Date.now()) {
  if (!Types.ObjectId.isValid(userId)) throw new AppError(400, 'userId 不合法');
  const uid = new Types.ObjectId(userId);
  const [user, plan] = await Promise.all([
    UserModel.findById(uid).select({ nickname: 1, avatarUrl: 1 }).lean(),
    ExercisePlanModel.findOne({ userId: uid }).select({ targets: 1, activeFrom: 1, createdAt: 1, updatedAt: 1 }).lean(),
  ]);
  if (!user) throw new AppError(404, '用户不存在');

  const since = now - 90 * DAY_MS;
  const snaps = await ExercisePlanPeriodModel.find({
    userId: uid,
    period: 'daily',
    periodKey: { $regex: DATE_KEY_RE },
    windowStart: { $gte: since },
  })
    .select({ periodKey: 1, windowStart: 1, targets: 1, progress: 1, achieved: 1, allAchieved: 1 })
    .sort({ windowStart: -1 })
    .lean();

  // TODO(P1): 这里为了一个用户跑了全站快照扫描（perUserSnapStats 是全站聚合）。
  // 建计划用户到 5k+ 时改为只查该用户的快照聚合（详见 docs/22「已知限制」）。
  const stats = (await perUserSnapStats(now)).get(userId) ?? {
    snapshotDays: 0,
    achievedTotal: 0,
    last30Total: 0,
    last30Achieved: 0,
    bestStreak: 0,
    lastAchievedAt: 0,
  };

  return {
    user: { id: userId, nickname: user.nickname || '', avatarUrl: user.avatarUrl || '' },
    plan: plan
      ? {
          targets: {
            distanceM: plan.targets?.distanceM || 0,
            durationMin: plan.targets?.durationMin || 0,
            count: plan.targets?.count || 0,
          },
          activeFrom: Number(plan.activeFrom) || 0,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
        }
      : null,
    totals: {
      snapshotDays: stats.snapshotDays,
      achievedTotal: stats.achievedTotal,
      rate30: pct(stats.last30Achieved, stats.last30Total),
      bestStreak: stats.bestStreak,
      lastAchievedAt: stats.lastAchievedAt,
    },
    calendar: snaps.map((s) => ({
      date: s.periodKey,
      targets: {
        distanceM: s.targets?.distanceM || 0,
        durationMin: s.targets?.durationMin || 0,
        count: s.targets?.count || 0,
      },
      progress: {
        distanceM: s.progress?.distanceM || 0,
        durationSec: s.progress?.durationSec || 0,
        count: s.progress?.count || 0,
      },
      achieved: {
        distance: Boolean(s.achieved?.distance),
        duration: Boolean(s.achieved?.duration),
        count: Boolean(s.achieved?.count),
      },
      allAchieved: Boolean(s.allAchieved),
    })),
  };
}
