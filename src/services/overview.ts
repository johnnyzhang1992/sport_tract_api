/**
 * 轨迹合集（决策 M6）：一周/一月/一年/全部 的聚合轨迹 + 热力
 * 查询 finished 活动 → 后端抽稀（DP + 预算）→ 网格热力 → 聚合统计
 */
import { ActivityModel } from '../models/activity.model.js';
import { simplifyTracks, gridHeat, type LatLng } from '../utils/simplify.js';
import { buildDateSummary, type DateSummary } from './report.js';

export const OVERVIEW_RANGES = ['week', 'month', 'year', 'all'] as const;
export type OverviewRange = (typeof OVERVIEW_RANGES)[number];

/** 范围 → 起始时间偏移（天） */
const RANGE_DAYS: Record<OverviewRange, number | null> = {
  week: 7,
  month: 30,
  year: 365,
  all: null,
};

export interface OverviewPoint extends LatLng {
  pauseGap?: boolean; // 暂停恢复后首个有效点（前端渲染时断开连线）
}

export interface OverviewTrack {
  id: string;
  type: string;
  startTime: string;
  distance: number;
  duration: number;
  avgPace: number | null;
  /** 轨迹内最快 1km 分段（秒/公里），不足 1km 为 null（年度报告「最佳配速」用） */
  fastestKm: number | null;
  elevationGain: number;
  calories: number;
  /** 起点的省（老数据可能为空串）：轨迹合集页的省份筛选靠它在前端聚合候选与条数 */
  startProvince: string;
  /** 抽稀后的轨迹点；lean 模式不下发 */
  points?: OverviewPoint[];
}

export interface OverviewResult {
  range: OverviewRange;
  count: number;
  totalDistanceKm: number;
  totalDurationSec: number;
  totalElevationGain: number;
  totalCalories: number;
  tracks: OverviewTrack[];
  heat: { lat: number; lng: number; weight: number }[];
  /** 报告页日期汇总（仅 opts.dateSummary=true 时下发，后端按东八区分桶） */
  dateSummary?: DateSummary;
}

/** 查询 + 抽稀 + 热力（轨迹多则每轨迹点少，总量受预算约束）
 * 传入 precise（epoch ms 区间）时按精确时间查询（报告页历史周/月/年），否则按 range 滑动窗口
 * opts.lean：精简模式（报告页/年度报告用）——不查 trackPoints、不算抽稀与热力，tracks 只回元数据
 * opts.dateSummary：额外返回报告页「日期汇总」桶（后端分桶，range 决定粒度）
 */
export async function getOverview(
  userId: string,
  range: OverviewRange,
  precise?: { from: number; to: number },
  opts: { lean?: boolean; dateSummary?: boolean } = {},
): Promise<OverviewResult> {
  const { lean = false, dateSummary = false } = opts;
  const days = RANGE_DAYS[range];
  const query: Record<string, unknown> = {
    userId,
    status: 'finished',
  };
  if (precise) {
    query.startTime = { $gte: precise.from, $lt: precise.to }; // startTime 存的是 Number 时间戳
  } else if (days != null) {
    query.startTime = { $gte: new Date(Date.now() - days * 86400000) };
  }

  // 只取必要字段，避免大文档传输（trackPoints 仅 lat/lng/pauseGap，抽稀不需要海拔/时间）
  // lean 模式连 trackPoints 都不查：报告类页面只用元数据，省掉大文档读取
  const select: Record<string, number> = {
    _id: 1,
    type: 1,
    startTime: 1,
    distance: 1,
    duration: 1,
    avgPace: 1,
    fastestKm: 1,
    elevationGain: 1,
    calories: 1,
    startProvince: 1,
  };
  if (!lean) {
    select['trackPoints.lat'] = 1;
    select['trackPoints.lng'] = 1;
    select['trackPoints.pauseGap'] = 1;
  }
  const activities = await ActivityModel.find(query)
    .select(select)
    .sort({ startTime: -1 })
    .lean();

  // 日期汇总（仅报告页需要）：与轨迹查询并行，少一次串行往返
  const dateSummaryData = dateSummary ? await buildDateSummary(userId, range, precise) : undefined;

  const totals = {
    count: activities.length,
    totalDistanceKm: Math.round(activities.reduce((s, a) => s + (a.distance || 0), 0) / 10) / 100,
    totalDurationSec: activities.reduce((s, a) => s + (a.duration || 0), 0),
    totalElevationGain: Math.round(activities.reduce((s, a) => s + (a.elevationGain || 0), 0)),
    totalCalories: Math.round(activities.reduce((s, a) => s + (a.calories || 0), 0)),
  };
  const metaTracks = activities.map((a) => ({
    id: String(a._id),
    type: a.type,
    startTime: new Date(a.startTime).toISOString(), // startTime 存的是 Number 时间戳
    distance: a.distance || 0,
    duration: a.duration || 0,
    avgPace: a.avgPace ?? null,
    fastestKm: a.fastestKm ?? null,
    elevationGain: a.elevationGain || 0,
    calories: a.calories || 0,
    startProvince: a.startProvince || '', // 老数据/导入数据没有省 → 空串（前端不列进候选）
  }));
  if (lean) {
    return { range, ...totals, tracks: metaTracks, heat: [], ...(dateSummaryData ? { dateSummary: dateSummaryData } : {}) };
  }

  // 按轨迹抽稀：轨迹越多，每轨迹点越少（全局预算 3000）
  const rawTracks: OverviewPoint[][] = activities.map(
    (a) =>
      ((a.trackPoints ?? []) as Array<{ lat?: number; lng?: number; pauseGap?: boolean }>)
        .filter((p) => p && typeof p.lat === 'number' && typeof p.lng === 'number')
        .map((p) => ({
          lat: p.lat as number,
          lng: p.lng as number,
          ...(p.pauseGap ? { pauseGap: true } : {}),
        })),
  );

  // 按 pauseGap 切段（暂停间隙不连线）：所有轨迹的段合成一个数组过同一套抽稀（保全局预算），
  // 抽稀后再拼回各轨迹，段首重新打 pauseGap 标记（前端按标记断开连线）
  const segments: { owner: number; pts: OverviewPoint[] }[] = [];
  activities.forEach((_, i) => {
    const raw = rawTracks[i];
    let start = 0;
    for (let j = 1; j < raw.length; j++) {
      if (raw[j].pauseGap && j > start) {
        segments.push({ owner: i, pts: raw.slice(start, j) });
        start = j;
      }
    }
    if (start < raw.length) segments.push({ owner: i, pts: raw.slice(start) });
  });
  const simplifiedSegs = simplifyTracks(
    segments.map((s) => s.pts),
    // 轨迹多时按预算均摊；上限放宽 + 保形降点，避免缩略图过于抽象
    { maxPoints: 5000, maxPerTrack: 150 },
  );
  const tracks: OverviewPoint[][] = activities.map(() => []);
  simplifiedSegs.forEach((segRaw, k) => {
    const seg = segRaw as OverviewPoint[];
    if (seg.length === 0) return;
    const out = tracks[segments[k].owner];
    if (out.length > 0) out.push({ ...seg[0], pauseGap: true });
    else out.push(seg[0]);
    for (let j = 1; j < seg.length; j++) out.push(seg[j]);
  });
  const heat = gridHeat(rawTracks, 150, 200);

  // 卡片缩略图点：与 /activities 列表 previewPoints 同口径（均匀采样 60 点 + 暂停断点全量补回），
  // 保证轨迹列表与轨迹合集两处缩略图形状一致；地图渲染仍用上面的保形抽稀点
  const previewPointsOf = (raw: OverviewPoint[]) => {
    const n = raw.length;
    if (n === 0) return [];
    const step = n / 60;
    const byIdx = new Map<number, OverviewPoint>();
    for (let i = 0; i < 60; i++) {
      const idx = Math.min(n - 1, Math.floor(i * step));
      const p = raw[idx];
      byIdx.set(idx, { lat: p.lat, lng: p.lng, ...(p.pauseGap ? { pauseGap: true } : {}) });
    }
    // 断点全量补回（数量少）：采样会丢 pauseGap 标，同 idx 时断点优先
    raw.forEach((p, idx) => {
      if (p.pauseGap) byIdx.set(idx, { lat: p.lat, lng: p.lng, pauseGap: true });
    });
    return [...byIdx.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  };

  return {
    range,
    ...totals,
    tracks: activities.map((a, i) => ({
      ...metaTracks[i],
      points: tracks[i] || [],
      previewPoints: previewPointsOf(rawTracks[i] || []),
    })),
    heat,
    ...(dateSummaryData ? { dateSummary: dateSummaryData } : {}),
  };
}
