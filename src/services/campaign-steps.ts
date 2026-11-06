import { Types } from 'mongoose';
import { WerunDayModel } from '../models/werun-day.model.js';
import { dailyDistanceByType, type CampaignDoc, type Segment } from './campaign-stats.js';
import { bjDateStr } from '../utils/bj-time.js';
import { streakDays } from '../utils/campaign-streak.js';

const DAY_MS = 86_400_000;
/** 一天步数最多能支撑的距离 = 步数 × 最大步幅 × 容差 */
const STRIDE_M: Record<string, number> = {
  running: 2.0,
  hiking: 1.5,
  mountaineering: 1.5,
  walking: 1.2,
};
const TOLERANCE = 1.25;

export interface StepStats {
  step: number;
  /** 有步数记录的天数 */
  days: number;
}

export type DayStepStatus = 'match' | 'low' | 'noSteps' | 'noTrack' | 'stepOnly';

export interface DayStepRow {
  date: string;
  dateText: string;
  distance: number;
  step: number | null;
  status: DayStepStatus;
  statusText: string;
}

export interface MemberDayStepResult {
  summary: {
    distance: number;
    step: number;
    days: number;
    matchedDays: number;
    lowDays: number;
    noStepDays: number;
  };
  items: DayStepRow[];
  total: number;
  page: number;
  pageSize: number;
}

function dateMs(date: string): number {
  return Date.parse(`${date}T00:00:00+08:00`);
}

function addDay(date: string, n: number): string {
  return bjDateStr(dateMs(date) + n * DAY_MS);
}

function weekdayText(date: string): string {
  const d = new Date(`${date}T00:00:00+08:00`);
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getUTCDay()];
}

/**
 * 成员在活动内的「按天贡献窗口」：
 * - 加入当天算全天；退出当天不计；
 * - 只到 min(活动结束, now) 的前一天（未来日期不参与）。
 */
export function membershipDays(campaign: CampaignDoc, segs: Segment[], now = Date.now()): string[] {
  const cap = Math.min(campaign.endAt, now);
  if (cap <= campaign.startAt || segs.length === 0) return [];
  const lastDate = bjDateStr(cap - 1);
  const set = new Set<string>();
  for (const s of segs) {
    const startMs = Math.max(campaign.startAt, s.joinedAt);
    const endMs = Math.min(campaign.endAt, s.leftAt ?? campaign.endAt);
    if (endMs <= startMs) continue;
    const start = bjDateStr(startMs);
    // 退出当天不计入：leftAt 落在哪一天，就把那一整天排除；
    // 活动 endAt 是「结束日 24:00」，同样减一天得到最后一天。
    const end = addDay(bjDateStr(endMs), -1);
    if (start > lastDate) continue;
    const boundedEnd = end > lastDate ? lastDate : end;
    for (let d = start; d <= boundedEnd; d = addDay(d, 1)) set.add(d);
  }
  return [...set].sort();
}

async function loadStepRows(
  userIds: string[],
  campaign: CampaignDoc,
  now: number,
): Promise<Array<{ userId: string; date: string; step: number }>> {
  if (userIds.length === 0) return [];
  const startDate = bjDateStr(campaign.startAt);
  const cap = Math.min(campaign.endAt, now);
  if (cap <= campaign.startAt) return [];
  const endDate = bjDateStr(cap - 1);
  const rows = await WerunDayModel.find({
    userId: { $in: userIds.map((id) => new Types.ObjectId(id)) },
    date: { $gte: startDate, $lte: endDate },
  }).select({ userId: 1, date: 1, step: 1 }).lean();
  return rows.map((r) => ({ userId: String(r.userId), date: r.date, step: Number(r.step) || 0 }));
}

/** 每个成员在贡献窗口内的步数合计 */
export async function stepStatsForMembers(
  campaign: CampaignDoc,
  segmentsByUser: Map<string, Segment[]>,
  userIds: string[],
  now = Date.now(),
): Promise<Map<string, StepStats>> {
  const out = new Map<string, StepStats>();
  const daySets = new Map<string, Set<string>>();
  for (const uid of userIds) {
    out.set(uid, { step: 0, days: 0 });
    daySets.set(uid, new Set(membershipDays(campaign, segmentsByUser.get(uid) ?? [], now)));
  }
  const rows = await loadStepRows(userIds, campaign, now);
  for (const r of rows) {
    const days = daySets.get(r.userId);
    if (!days || !days.has(r.date)) continue;
    const s = out.get(r.userId)!;
    s.step += r.step;
    s.days += 1;
  }
  return out;
}

/** 成员按天步数（贡献窗口内）；供趋势与成员按天弹窗共用 */
export async function dailyStepRowsForMembers(
  campaign: CampaignDoc,
  segmentsByUser: Map<string, Segment[]>,
  userIds: string[],
  now = Date.now(),
): Promise<Array<{ userId: string; date: string; step: number }>> {
  const daySets = new Map<string, Set<string>>();
  for (const uid of userIds) {
    daySets.set(uid, new Set(membershipDays(campaign, segmentsByUser.get(uid) ?? [], now)));
  }
  const rows = await loadStepRows(userIds, campaign, now);
  return rows.filter((r) => daySets.get(r.userId)?.has(r.date));
}

/** 步数PK成员的连续天数（按有步数的天算） */
export async function stepStreakForUser(
  campaign: CampaignDoc,
  segs: Segment[],
  userId: string,
  now = Date.now(),
): Promise<number> {
  const days = membershipDays(campaign, segs, now);
  if (days.length === 0) return 0;
  const rows = await loadStepRows([userId], campaign, now);
  const stepDays = new Set(rows.filter((r) => r.step > 0).map((r) => r.date));
  return streakDays(days.filter((d) => stepDays.has(d)), now);
}

function statusTextOf(status: DayStepStatus): string {
  if (status === 'match') return '匹配';
  if (status === 'low') return '步数偏少';
  if (status === 'noTrack') return '仅步数';
  if (status === 'stepOnly') return '步数';
  return '未同步';
}

/**
 * 成员按天对比：活动内计入的轨迹距离 vs 当天微信步数。
 * - 只展示有轨迹或有步数的天；
 * - 步数只做展示，不影响排名；
 * - 活动未开启步数辅助时由调用方拒绝。
 */
export async function memberDayStepComparison(
  campaign: CampaignDoc,
  segs: Segment[],
  userId: string,
  query: { page: number; pageSize: number },
  now = Date.now(),
): Promise<MemberDayStepResult> {
  const days = membershipDays(campaign, segs, now).reverse();
  if (days.length === 0) {
    return {
      summary: { distance: 0, step: 0, days: 0, matchedDays: 0, lowDays: 0, noStepDays: 0 },
      items: [], total: 0, page: query.page, pageSize: query.pageSize,
    };
  }
  const fromDate = days[days.length - 1];
  const toDate = days[0];
  const [distanceRows, stepRows] = await Promise.all([
    campaign.kind === 'steps'
      ? Promise.resolve([])
      : dailyDistanceByType(campaign, new Map([[userId, segs]]), [userId]),
    loadStepRows([userId], campaign, now),
  ]);
  const distanceByDate = new Map<string, { distance: number; byType: Map<string, number> }>();
  for (const r of distanceRows) {
    const cur = distanceByDate.get(r.date) ?? { distance: 0, byType: new Map<string, number>() };
    cur.distance += r.distance;
    cur.byType.set(r.type, (cur.byType.get(r.type) ?? 0) + r.distance);
    distanceByDate.set(r.date, cur);
  }
  const stepByDate = new Map(stepRows.map((r) => [r.date, r.step]));
  const allRows: DayStepRow[] = [];
  for (const date of days) {
    if (date < fromDate || date > toDate) continue;
    const dist = distanceByDate.get(date);
    const distance = dist?.distance ?? 0;
    const step = stepByDate.has(date) ? stepByDate.get(date)! : null;
    if (distance <= 0 && step === null) continue;
    let status: DayStepStatus;
    if (campaign.kind === 'steps') {
      status = step === null ? 'noSteps' : 'stepOnly';
    } else if (distance > 0 && step === null) {
      status = 'noSteps';
    } else if (distance <= 0 && step !== null) {
      status = 'noTrack';
    } else {
      // 只拿「步数可比」的运动类型判真实性：骑行/游泳记录里的距离不能拿步数去卡，
      // 否则一次 20km 骑行 + 3000 步会被误报成「步数偏少」。
      const comparable = [...(dist?.byType ?? new Map<string, number>())]
        .filter(([type]) => !!STRIDE_M[type]);
      const comparableDistance = comparable.reduce((sum, [, d]) => sum + d, 0);
      if (comparableDistance > 0) {
        const maxStride = Math.max(...comparable.map(([type]) => STRIDE_M[type]));
        const maxM = (step ?? 0) * maxStride * TOLERANCE;
        status = comparableDistance > maxM ? 'low' : 'match';
      } else {
        // 当天只有不可比类型（骑行/游泳等）：不做好坏判断，避免误导
        status = 'match';
      }
    }
    allRows.push({
      date,
      dateText: `${date.slice(5).replace('-', '/')} ${weekdayText(date)}`,
      distance,
      step,
      status,
      statusText: statusTextOf(status),
    });
  }
  const summary = {
    distance: allRows.reduce((s, r) => s + r.distance, 0),
    step: allRows.reduce((s, r) => s + (r.step ?? 0), 0),
    days: allRows.length,
    matchedDays: allRows.filter((r) => r.status === 'match').length,
    lowDays: allRows.filter((r) => r.status === 'low').length,
    noStepDays: allRows.filter((r) => r.status === 'noSteps').length,
  };
  const from = (query.page - 1) * query.pageSize;
  return {
    summary,
    items: allRows.slice(from, from + query.pageSize),
    total: allRows.length,
    page: query.page,
    pageSize: query.pageSize,
  };
}
