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
 * - 1km 分段：从起点起每累计 1000m 记一段，尾段不足 1km 剔除
 * - 纯运动时间：段内相邻点时间戳差累加；相邻点间隔 > 60s 视为暂停/空档，不计入
 * - 返回 null：轨迹不足 1km 或点缺少 timestamp
 */
/** 无配速概念的运动类型（与 calcStats 一致） */
const NO_PACE_TYPES = ['swimming', 'cycling'];
const GAP_MS = 60000;
export function calcFastestKm(points: TrackPointLike[], type?: string): number | null {
  if (type && NO_PACE_TYPES.includes(type)) return null; // 游泳/骑行不统计配速
  const sorted = [...points]
    .filter((p) => p.timestamp != null)
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  if (sorted.length < 2) return null;
  let fastest: number | null = null;
  let segDist = 0;
  let segSec = 0;
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const d = haversineDistance(prev, cur);
    let dt = ((cur.timestamp ?? 0) - (prev.timestamp ?? 0)) / 1000; // 秒
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    if (dt > GAP_MS / 1000) dt = 0; // 暂停/空档不计
    segDist += d;
    segSec += dt;
    if (segDist >= 1000) {
      // 段完成：按比例归一化到 1km
      const pace = segSec / (segDist / 1000);
      if (fastest === null || pace < fastest) fastest = pace;
      // 下一段从当前点重新开始（尾段不足 1km 自然剔除）
      segDist = 0;
      segSec = 0;
    }
    prev = cur;
  }
  return fastest === null ? null : Math.round(fastest * 10) / 10;
}
