import { ActivityModel } from '../models/activity.model.js';
import { LoginLogModel } from '../models/login-log.model.js';
import { UserModel } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { bjToday0, bjDateStr, BJ_OFFSET_MS } from '../utils/bj-time.js';

const DAY = 86_400_000;

export type TrendRange = 'week' | 'month' | 'halfyear';
export type TrendGranularity = 'day' | 'week';

export interface TrendBucket {
  key: string;
  label: string;
  newUsers: number;
  uv: number;
  pv: number;
  tracksCreated: number;
  tracksFinished: number;
}

export function defaultGranularity(range: TrendRange): TrendGranularity {
  return range === 'halfyear' ? 'week' : 'day';
}

/** 周粒度桶数=1（最近一周）或 180×3 系列柱放不下（半年按天）→ 禁用 */
export function granularityAllowed(range: TrendRange, g: TrendGranularity): boolean {
  if (range === 'week') return g === 'day';
  if (range === 'halfyear') return g === 'week';
  return true;
}

function mondayOf(ms: number): number {
  const day = bjToday0(ms);
  const dow = new Date(day + BJ_OFFSET_MS).getUTCDay();
  return day - ((dow + 6) % 7) * DAY;
}

function bucketLabel(start: number): string {
  const d = new Date(start + BJ_OFFSET_MS);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** 窗口 [from, to) 与桶起点列表（东八区；周桶周一始，边缘桶可为残周） */
function windowOf(range: TrendRange, g: TrendGranularity, now: number): { from: number; to: number; starts: number[] } {
  const today0 = bjToday0(now);
  const to = today0 + DAY;
  let from: number;
  if (range === 'week') from = today0 - 6 * DAY;
  else if (range === 'month') from = today0 - 29 * DAY;
  else {
    const bj = new Date(today0 + BJ_OFFSET_MS);
    from = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth() - 5, 1) - BJ_OFFSET_MS;
  }
  const starts: number[] = [];
  if (g === 'day') {
    for (let t = from; t < to; t += DAY) starts.push(t);
  } else {
    for (let t = mondayOf(from); t < to; t += 7 * DAY) starts.push(t);
  }
  return { from, to, starts };
}

function truncExpr(g: TrendGranularity, field = 'createdAt') {
  // $toDate：endTime 是毫秒 number（activity.model），$dateTrunc 只收日期类型；Date 字段上是无操作
  const date = { $toDate: `$${field}` };
  return g === 'week'
    ? { $dateTrunc: { date, unit: 'week', timezone: '+08:00', startOfWeek: 'Monday' } }
    : { $dateTrunc: { date, unit: 'day', timezone: '+08:00' } };
}

const keyExpr = (g: TrendGranularity, field = 'createdAt') => ({
  $dateToString: { format: '%Y-%m-%d', date: truncExpr(g, field), timezone: '+08:00' },
});

/**
 * 运营者趋势：整窗一次性聚合/表（$dateTrunc 东八区桶），空桶补 0。
 * UV=桶内去重 userId（周桶重新去重，≠逐日相加）；PV=登录日志数；
 * newUsers=users.createdAt；tracksCreated=activities.createdAt（同 summary「新增轨迹」）；
 * tracksFinished=status finished 且 endTime（同 summary「轨迹完成」，按完成时间归桶）。
 */
export async function operatorTrend(
  range: string,
  granularity: string | undefined,
  now: number = Date.now(),
): Promise<{ range: TrendRange; granularity: TrendGranularity; buckets: TrendBucket[] }> {
  if (range !== 'week' && range !== 'month' && range !== 'halfyear') {
    throw new AppError(400, `range 仅支持 week/month/halfyear，收到 ${range}`);
  }
  const g = granularity ?? defaultGranularity(range);
  if (g !== 'day' && g !== 'week') {
    throw new AppError(400, `granularity 仅支持 day/week，收到 ${g}`);
  }
  if (!granularityAllowed(range, g)) {
    throw new AppError(
      400,
      range === 'week'
        ? `最近一周仅支持按天（周粒度只有 1 桶），收到 ${g}`
        : `最近半年仅支持按周（按天 180 桶柱状图放不下），收到 ${g}`,
    );
  }
  const { from, to, starts } = windowOf(range, g, now);
  const match = { createdAt: { $gte: new Date(from), $lt: new Date(to) } };

  const [loginRows, userRows, trackCreatedRows, trackFinishedRows] = await Promise.all([
    LoginLogModel.aggregate<{ _id: string; uv: number; pv: number }>([
      { $match: match },
      { $group: { _id: { k: keyExpr(g), u: '$userId' }, n: { $sum: 1 } } },
      { $group: { _id: '$_id.k', uv: { $sum: 1 }, pv: { $sum: '$n' } } },
    ]),
    UserModel.aggregate<{ _id: string; n: number }>([
      { $match: match },
      { $group: { _id: keyExpr(g), n: { $sum: 1 } } },
    ]),
    ActivityModel.aggregate<{ _id: string; n: number }>([
      { $match: match },
      { $group: { _id: keyExpr(g), n: { $sum: 1 } } },
    ]),
    ActivityModel.aggregate<{ _id: string; n: number }>([
      { $match: { status: 'finished', endTime: { $gte: from, $lt: to } } },
      { $group: { _id: keyExpr(g, 'endTime'), n: { $sum: 1 } } },
    ]),
  ]);

  const byKey = new Map<string, TrendBucket>();
  for (const s of starts) {
    byKey.set(bjDateStr(s), {
      key: bjDateStr(s), label: bucketLabel(s), newUsers: 0, uv: 0, pv: 0, tracksCreated: 0, tracksFinished: 0,
    });
  }
  for (const r of loginRows) {
    const b = byKey.get(r._id);
    if (b) {
      b.uv = r.uv;
      b.pv = r.pv;
    }
  }
  for (const r of userRows) {
    const b = byKey.get(r._id);
    if (b) b.newUsers = r.n;
  }
  for (const r of trackCreatedRows) {
    const b = byKey.get(r._id);
    if (b) b.tracksCreated = r.n;
  }
  for (const r of trackFinishedRows) {
    const b = byKey.get(r._id);
    if (b) b.tracksFinished = r.n;
  }
  return { range, granularity: g, buckets: [...byKey.values()] };
}
