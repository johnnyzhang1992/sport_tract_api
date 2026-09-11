import { ACTIVITY_TYPE_META, type ActivityType } from '../config/constants.js';

/**
 * 运动指标计算（服务端复核）
 * 客户端计算一份用于实时展示，finish 时服务端基于最终点集重算复核
 */

const EARTH_RADIUS_M = 6371000;

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Haversine 球面距离（米） */
export function haversineDistance(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s));
}

export interface TrackPointLike {
  lat: number;
  lng: number;
  altitude?: number | null;
  pauseGap?: boolean;
  timestamp?: number;
}

export interface CalcStatsOptions {
  type: ActivityType;
  /** 运动时长（秒，已扣除暂停） */
  durationSec: number;
  /** 体重（kg），卡路里估算用，默认 60 */
  weightKg?: number;
}

/** 配速最小有效距离（米）：低于此值配速无意义（如刚起步/静止） */
const MIN_PACE_DISTANCE_M = 200;

// 爬升算法（与小程序 services/tracker.js 同款，决策 D16 v2）：
// 旧"单步>死区即累计"缓坡漏计严重（每步差值远小于阈值）而慢噪声单步大跳反被累计；
// 改为 EMA 平滑 + 滞回确认——噪声上下抵消，缓坡可持续累计达标
/** 爬升用海拔 EMA 平滑系数（0~1，越小越平滑） */
const CLIMB_EMA_ALPHA = 0.3;
/** 爬升确认阈值（米）：待确认累计上升达到该值才计入 */
const CLIMB_CONFIRM_M = 3;
/** 爬升确认最少连续上升步数：单点大跳无法凭一步确认 */
const CLIMB_MIN_UP_STEPS = 2;

export interface CalcStatsResult {
  distance: number; // 米
  avgPace: number | null; // 秒/公里（非跑步类返回 null）
  calories: number; // kcal
  elevationGain: number; // 米
  minAltitude: number | null; // 米（轨迹原始海拔最低）
  maxAltitude: number | null; // 米（轨迹原始海拔最高）
}

/**
 * 基于轨迹点序列计算运动指标
 * - 距离：相邻点 Haversine 累加
 * - 爬升：海拔 EMA 平滑 + 滞回确认（下坡抵扣未确认部分），只累计确认的上升段
 * - 最低/最高海拔：原始海拔点的极值（GPS 参考）
 * - 卡路里：MET × 体重 × 时长（小时）
 */
export function calcStats(points: TrackPointLike[], opts: CalcStatsOptions): CalcStatsResult {
  const { type, durationSec, weightKg = 60 } = opts;

  // 距离
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    distance += haversineDistance(points[i - 1], points[i]);
  }

  // 海拔极值（原始点，GPS 参考）
  const altitudes = points.map((p) => p.altitude).filter((a): a is number => a !== null && a !== undefined);

  // 爬升：EMA 平滑 + 滞回确认；暂停恢复点（pauseGap）海拔可能漂移，重置状态不参与差值
  let elevationGain = 0;
  let climbEma: number | null = null;
  let pendingClimb = 0;
  let upSteps = 0;
  for (const p of points) {
    if (p.altitude === null || p.altitude === undefined) continue;
    if (p.pauseGap) {
      climbEma = p.altitude;
      pendingClimb = 0;
      upSteps = 0;
      continue;
    }
    if (climbEma === null) {
      climbEma = p.altitude;
      continue;
    }
    const prev: number = climbEma;
    climbEma = prev + CLIMB_EMA_ALPHA * (p.altitude - prev);
    const diff = climbEma - prev;
    if (diff > 0) {
      pendingClimb += diff;
      upSteps++;
      if (pendingClimb >= CLIMB_CONFIRM_M && upSteps >= CLIMB_MIN_UP_STEPS) {
        elevationGain += pendingClimb;
        pendingClimb = 0;
        upSteps = 0;
      }
    } else if (diff < 0) {
      pendingClimb = Math.max(0, pendingClimb + diff);
      if (pendingClimb === 0) upSteps = 0;
    }
  }

  // 配速（秒/公里）；游泳/骑行不展示；距离过短配速无意义
  const paceTypes: ActivityType[] = ['swimming', 'cycling'];
  const avgPace = paceTypes.includes(type)
    ? null
    : distance >= MIN_PACE_DISTANCE_M
      ? durationSec / (distance / 1000)
      : null;

  // 卡路里：MET × 体重 × 小时
  const met = ACTIVITY_TYPE_META[type]?.met ?? 3.5;
  const calories = Math.round(met * weightKg * (durationSec / 3600));

  return {
    distance: Math.round(distance),
    avgPace: avgPace === null ? null : Math.round(avgPace),
    calories,
    elevationGain: Math.round(elevationGain),
    minAltitude: altitudes.length > 0 ? Math.round(Math.min(...altitudes)) : null,
    maxAltitude: altitudes.length > 0 ? Math.round(Math.max(...altitudes)) : null,
  };
}

/** 配速格式化：秒/公里 → "5'30\"" */
export function formatPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}'${s.toString().padStart(2, '0')}"`;
}

/** 轨迹内最快 1 公里分段（秒/公里）
 * - 只统计「无暂停」的连续区间：带 pauseGap 标记的恢复点、相邻点间隔 > 60s 的丢点断档，都把轨迹切成多段，窗口不跨段
 * - 滑动窗口：在每个连续区间内，以每个点为起点向前累计到 ≥ 1000m，取用时最短者（不再从起点固定切刀，避免漏掉跨切点的更快 1km）
 * - 段内按实际距离（≥1000m）归一化到 1km；不足 1km 返回 null
 * - 返回 null：无任一连续区间累积达到 1km，或点缺少 timestamp；游泳/骑行无配速概念
 */
/** 无配速概念的运动类型（与 calcStats 一致） */
const NO_PACE_TYPES = ['swimming', 'cycling'];
const GAP_MS = 60000;
/** 最快配速窗口长度（米）：必须跑满此距离才计一段 */
const PACE_SEGMENT_M = 1000;
export function calcFastestKm(points: TrackPointLike[], type?: string): number | null {
  if (type && NO_PACE_TYPES.includes(type)) return null; // 游泳/骑行不统计配速
  const sorted = [...points]
    .filter((p) => p.timestamp != null)
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  if (sorted.length < 2) return null;

  const gapSec = GAP_MS / 1000;
  let fastest: number | null = null;
  let start = 0;
  while (start < sorted.length - 1) {
    // 切出无暂停连续区间 [start, end)：区间内相邻点间隔有效（0~60s），且不含 pauseGap 恢复点
    let end = start + 1;
    while (end < sorted.length) {
      const dt = ((sorted[end].timestamp ?? 0) - (sorted[end - 1].timestamp ?? 0)) / 1000;
      if (sorted[end].pauseGap || !Number.isFinite(dt) || dt < 0 || dt > gapSec) break;
      end++;
    }
    // 区间内滑动窗口：对每个起点取“刚满 1km”的窗口（双指针 O(n)），用时最短者为最快
    let j = start + 1;
    let dist = 0;
    let sec = 0;
    for (let s = start; s < end - 1; s++) {
      if (j <= s) {
        j = s + 1;
        dist = 0;
        sec = 0;
      }
      while (j < end && dist < PACE_SEGMENT_M) {
        const dt = ((sorted[j].timestamp ?? 0) - (sorted[j - 1].timestamp ?? 0)) / 1000;
        dist += haversineDistance(sorted[j - 1], sorted[j]);
        sec += dt;
        j++;
      }
      if (dist >= PACE_SEGMENT_M) {
        const pace = sec / (dist / 1000);
        if (fastest === null || pace < fastest) fastest = pace;
      }
      // 窗口起点前移一位：从窗口里扣掉 s → s+1 这一步
      if (j > s + 1) {
        const dt = ((sorted[s + 1].timestamp ?? 0) - (sorted[s].timestamp ?? 0)) / 1000;
        dist -= haversineDistance(sorted[s], sorted[s + 1]);
        sec -= dt;
      }
    }
    start = end; // 断档点作为下一段起点（pauseGap 语义：该点之后是新的一段）
  }
  return fastest === null ? null : Math.round(fastest * 10) / 10;
}
