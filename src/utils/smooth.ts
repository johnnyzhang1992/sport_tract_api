/**
 * 轨迹平滑（滑动平均 + 离群点检测，替代外部轨迹纠偏）
 * - 离群点（GPS 抖动，到前后点连线距离 > 阈值）：直接采用窗口均值（修正）
 * - 正常点：平滑后若位移过大（急弯）回退原值，避免拐点被拉平
 * - 首尾端点保持不动
 * - 调用后需重算距离等指标（平滑会略微缩短距离）
 */

export interface SmoothPoint {
  lat: number;
  lng: number;
}

const DEFAULT_WINDOW = 5;
/** 离群点判定：点到前后点连线垂直距离（米）超过即视为抖动 */
const MAX_OUTLIER_M = 30;
/** 正常点平滑位移守卫（米）：平滑后位移超过则回退原值（保护急弯） */
const MAX_SHIFT_M = 20;

/** 度 → 米（等距圆柱近似，用于局部距离计算） */
const M_PER_DEG = 111320;

/** 点到线段（a-b）的近似垂直距离（米） */
function pointToSegmentDistM(p: SmoothPoint, a: SmoothPoint, b: SmoothPoint): number {
  const toXY = (lat: number, lng: number) => ({
    x: lng * M_PER_DEG * Math.cos((lat * Math.PI) / 180),
    y: lat * M_PER_DEG,
  });
  const P = toXY(p.lat, p.lng);
  const A = toXY(a.lat, a.lng);
  const B = toXY(b.lat, b.lng);
  const abx = B.x - A.x;
  const aby = B.y - A.y;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return Math.hypot(P.x - A.x, P.y - A.y);
  let t = ((P.x - A.x) * abx + (P.y - A.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(P.x - (A.x + t * abx), P.y - (A.y + t * aby));
}

export function smoothTrackSmart<T extends SmoothPoint>(
  points: T[],
  windowSize = DEFAULT_WINDOW,
  haversine: (a: SmoothPoint, b: SmoothPoint) => number,
): T[] {
  const n = points.length;
  // 至少 3 个点才可能检测离群/平滑（half 窗口自动裁剪）
  if (n <= 2) return points;
  const half = Math.max(1, Math.floor(windowSize / 2));

  // 1. 离群点检测：到前后点连线距离过大 → GPS 抖动
  const outlier = new Array<boolean>(n).fill(false);
  for (let i = 1; i < n - 1; i++) {
    if (pointToSegmentDistM(points[i], points[i - 1], points[i + 1]) > MAX_OUTLIER_M) {
      outlier[i] = true;
    }
  }

  // 2. 滑动平均，端点保持
  return points.map((p, i) => {
    if (i < half || i >= n - half) return p;
    let latSum = 0;
    let lngSum = 0;
    let count = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j >= n) continue;
      latSum += points[j].lat;
      lngSum += points[j].lng;
      count++;
    }
    const avg = { ...p, lat: latSum / count, lng: lngSum / count };

    // 3. 离群点直接采用均值（修正抖动）；正常点位移过大回退（保护急弯）
    if (outlier[i]) return avg;
    return haversine(p, avg) > MAX_SHIFT_M ? p : avg;
  });
}
