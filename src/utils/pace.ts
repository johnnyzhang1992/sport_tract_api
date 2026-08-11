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
  timestamp?: number;
}

export interface CalcStatsOptions {
  type: ActivityType;
  /** 运动时长（秒，已扣除暂停） */
  durationSec: number;
  /** 体重（kg），卡路里估算用，默认 60 */
  weightKg?: number;
  /** 爬升死区阈值（米），海拔误差 ±10~30m，小于该值视为噪声不累计 */
  climbDeadZoneM?: number;
}

/** 配速最小有效距离（米）：低于此值配速无意义（如刚起步/静止） */
const MIN_PACE_DISTANCE_M = 200;

export interface CalcStatsResult {
  distance: number; // 米
  avgPace: number | null; // 秒/公里（非跑步类返回 null）
  calories: number; // kcal
  elevationGain: number; // 米
  maxAltitude: number | null; // 米
}

/**
 * 基于轨迹点序列计算运动指标
 * - 距离：相邻点 Haversine 累加
 * - 爬升：3 点滑动平均滤波 + 死区阈值，只累计上升段
 * - 卡路里：MET × 体重 × 时长（小时）
 */
export function calcStats(points: TrackPointLike[], opts: CalcStatsOptions): CalcStatsResult {
  const { type, durationSec, weightKg = 60, climbDeadZoneM = 2 } = opts;

  // 距离
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    distance += haversineDistance(points[i - 1], points[i]);
  }

  // 海拔序列：3 点滑动平均滤波
  const altitudes = points.map((p) => p.altitude).filter((a): a is number => a !== null && a !== undefined);
  let elevationGain = 0;
  let maxAltitude: number | null = null;
  if (altitudes.length >= 2) {
    const smoothed = altitudes.map((_, i) => {
      const lo = Math.max(0, i - 1);
      const hi = Math.min(altitudes.length - 1, i + 1);
      let sum = 0;
      let n = 0;
      for (let j = lo; j <= hi; j++) {
        if (altitudes[j] !== undefined) {
          sum += altitudes[j];
          n++;
        }
      }
      return n > 0 ? sum / n : 0;
    });
    for (let i = 1; i < smoothed.length; i++) {
      const diff = smoothed[i] - smoothed[i - 1];
      if (diff > climbDeadZoneM) {
        elevationGain += diff;
      }
    }
    maxAltitude = Math.max(...smoothed);
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
    maxAltitude: maxAltitude === null ? null : Math.round(maxAltitude),
  };
}

/** 配速格式化：秒/公里 → "5'30\"" */
export function formatPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}'${s.toString().padStart(2, '0')}"`;
}
