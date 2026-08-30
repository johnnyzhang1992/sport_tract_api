/**
 * 轨迹合集（决策 M6）：一周/一月/一年/全部 的聚合轨迹 + 热力
 * 查询 finished 活动 → 后端抽稀（DP + 预算）→ 网格热力 → 聚合统计
 */
import { ActivityModel } from '../models/activity.model.js';
import { simplifyTracks, gridHeat, type LatLng } from '../utils/simplify.js';

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
  elevationGain: number;
  calories: number;
  points: OverviewPoint[];
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
}

/** 查询 + 抽稀 + 热力（轨迹多则每轨迹点少，总量受预算约束） */
export async function getOverview(
  userId: string,
  range: OverviewRange,
): Promise<OverviewResult> {
  const days = RANGE_DAYS[range];
  const query: Record<string, unknown> = {
    userId,
    status: 'finished',
  };
  if (days != null) {
    query.startTime = { $gte: new Date(Date.now() - days * 86400000) };
  }

  // 只取必要字段，避免大文档传输（trackPoints 仅 lat/lng/pauseGap，抽稀不需要海拔/时间）
  const activities = await ActivityModel.find(query)
    .select({
      _id: 1,
      type: 1,
      startTime: 1,
      distance: 1,
      duration: 1,
      elevationGain: 1,
      calories: 1,
      'trackPoints.lat': 1,
      'trackPoints.lng': 1,
      'trackPoints.pauseGap': 1,
    })
    .sort({ startTime: -1 })
    .lean();

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
    { maxPoints: 3000, maxPerTrack: 100 },
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

  return {
    range,
    count: activities.length,
    totalDistanceKm: Math.round(activities.reduce((s, a) => s + (a.distance || 0), 0) / 10) / 100,
    totalDurationSec: activities.reduce((s, a) => s + (a.duration || 0), 0),
    totalElevationGain: Math.round(activities.reduce((s, a) => s + (a.elevationGain || 0), 0)),
    totalCalories: Math.round(activities.reduce((s, a) => s + (a.calories || 0), 0)),
    tracks: activities.map((a, i) => ({
      id: String(a._id),
      type: a.type,
      startTime: new Date(a.startTime).toISOString(), // startTime 存的是 Number 时间戳
      distance: a.distance || 0,
      duration: a.duration || 0,
      avgPace: a.avgPace ?? null,
      elevationGain: a.elevationGain || 0,
      calories: a.calories || 0,
      points: tracks[i] || [],
    })),
    heat,
  };
}
