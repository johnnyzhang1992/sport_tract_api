/**
 * 海拔尖刺清洗（GPS 海拔误差 ±10~30m，短时间跳变且方向反转视为无效）
 * 例：38 → 25 → 38，中间 25 若在短时间内大幅跳变，判定为尖刺 → 海拔置 null
 * 仅剔除海拔值，经纬度轨迹点保留
 */

export interface AltPoint {
  altitude?: number | null;
  timestamp?: number;
}

/** 尖刺判定：海拔变化量阈值（米） */
export const SPIKE_MIN_DELTA_M = 5;
/** 尖刺判定：海拔变化速率阈值（米/秒，正常爬坡 < 0.5 m/s） */
export const SPIKE_RATE_MPS = 0.8;

/**
 * 清洗海拔尖刺：对每个点，若其与前后点的海拔差均超阈值、变化率超阈值、
 * 且方向相反（前降后升或前升后降，即尖峰/谷），则该点海拔置 null
 */
export function cleanAltitudeSpikes<T extends AltPoint>(points: T[]): T[] {
  const n = points.length;
  if (n < 3) return points;

  const result = points.map((p) => ({ ...p }));

  for (let i = 1; i < n - 1; i++) {
    const prev = result[i - 1];
    const cur = result[i];
    const next = result[i + 1];
    if (cur.altitude == null || prev.altitude == null || next.altitude == null) continue;

    const d1 = cur.altitude - prev.altitude;
    const d2 = next.altitude - cur.altitude;
    const dt1 = ((cur.timestamp ?? 0) - (prev.timestamp ?? 0)) / 1000;
    const dt2 = ((next.timestamp ?? 0) - (cur.timestamp ?? 0)) / 1000;
    if (dt1 <= 0 || dt2 <= 0) continue;

    const rate1 = Math.abs(d1) / dt1;
    const rate2 = Math.abs(d2) / dt2;

    const isSpike =
      Math.abs(d1) >= SPIKE_MIN_DELTA_M &&
      Math.abs(d2) >= SPIKE_MIN_DELTA_M &&
      rate1 > SPIKE_RATE_MPS &&
      rate2 > SPIKE_RATE_MPS &&
      d1 * d2 < 0; // 方向反转（尖峰或尖谷）

    if (isSpike) {
      cur.altitude = null;
    }
  }

  return result;
}
