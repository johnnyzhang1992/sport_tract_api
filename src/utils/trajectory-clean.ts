/**
 * 轨迹纠偏（决策：GPS 漂移点清洗）
 * 针对实测数据的两类偏移：
 * 1. 尖刺点：短时高速来回跳（如 21m/1.3s=15m/s 的抖动），双向高速 + 方向反转
 * 2. 孤立离群点：单点相对前后点连线偏移巨大（数十米级）
 * 阈值用"局部速度中位数 × 系数"自适应（真实骑行转弯不会误杀）
 */

export interface CleanTrackPoint {
  lat: number;
  lng: number;
  altitude?: number | null;
  timestamp?: number;
  seq?: number;
}

/** 两点球面距离（米） */
function distM(a: CleanTrackPoint, b: CleanTrackPoint): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** 方向转角（0~180°）：a→b 与 b→c 的夹角 */
function turnAngle(a: CleanTrackPoint, b: CleanTrackPoint, c: CleanTrackPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const bearing = (p: CleanTrackPoint, q: CleanTrackPoint) => {
    const y = Math.sin(toRad(q.lng - p.lng)) * Math.cos(toRad(q.lat));
    const x =
      Math.cos(toRad(p.lat)) * Math.sin(toRad(q.lat)) -
      Math.sin(toRad(p.lat)) * Math.cos(toRad(q.lat)) * Math.cos(toRad(q.lng - p.lng));
    return Math.atan2(y, x);
  };
  let turn = Math.abs(toDeg(bearing(a, b)) - toDeg(bearing(b, c))) % 360;
  if (turn > 180) turn = 360 - turn;
  return turn;
}

/** 点到线段距离（米，平面近似） */
function pointToSegmentDistM(p: CleanTrackPoint, a: CleanTrackPoint, b: CleanTrackPoint): number {
  const M = 111320;
  const toXY = (lat: number, lng: number) => ({
    x: lng * M * Math.cos((lat * Math.PI) / 180),
    y: lat * M,
  });
  const P = toXY(p.lat, p.lng);
  const A = toXY(a.lat, a.lng);
  const B = toXY(b.lat, b.lng);
  const len2 = (B.x - A.x) ** 2 + (B.y - A.y) ** 2;
  if (len2 === 0) return Math.hypot(P.x - A.x, P.y - A.y);
  let t = ((P.x - A.x) * (B.x - A.x) + (P.y - A.y) * (B.y - A.y)) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(P.x - (A.x + t * (B.x - A.x)), P.y - (A.y + t * (B.y - A.y)));
}

export interface CleanOptions {
  /** 尖刺速度下限（m/s）：低于该值不判尖刺（防误杀慢速运动） */
  minSpikeSpeed?: number;
  /** 尖刺速度倍数（相对局部中位速度） */
  spikeRatio?: number;
  /** 尖刺转角阈值（°） */
  minTurnDeg?: number;
  /** 孤立点距连线阈值（米，绝对下限） */
  minOutlierM?: number;
  /** 孤立点倍数（相对局部尺度） */
  outlierRatio?: number;
}

/**
 * 轨迹纠偏：剔除尖刺点与孤立离群点（保持首尾）
 * @returns 清洗后的点数组（剔除点被移除，其余保持顺序）
 */
export function cleanTrajectory<T extends CleanTrackPoint>(
  points: T[],
  opts: CleanOptions = {},
): T[] {
  const {
    minSpikeSpeed = 6,
    spikeRatio = 4,
    minTurnDeg = 110,
    minOutlierM = 30,
    outlierRatio = 6,
  } = opts;
  const n = points.length;
  if (n < 4) return points;

  const drop = new Array<boolean>(n).fill(false);

  for (let i = 1; i < n - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const t0 = a.timestamp ?? 0;
    const t1 = b.timestamp ?? 0;
    const t2 = c.timestamp ?? 0;
    const dt1 = (t1 - t0) / 1000;
    const dt2 = (t2 - t1) / 1000;
    if (dt1 <= 0 || dt2 <= 0) continue;

    const d1 = distM(a, b);
    const d2 = distM(b, c);
    const v1 = d1 / dt1;
    const v2 = d2 / dt2;

    // 局部速度中位数（窗口 ±2 点）
    const win: number[] = [];
    for (let j = Math.max(1, i - 2); j <= Math.min(n - 1, i + 2); j++) {
      const dt = ((points[j].timestamp ?? 0) - (points[j - 1].timestamp ?? 0)) / 1000;
      if (dt > 0) win.push(distM(points[j - 1], points[j]) / dt);
    }
    win.sort((x, y) => x - y);
    const med = win.length > 0 ? win[Math.floor(win.length / 2)] : 0;

    // 1) 尖刺：双向高速（绝对 + 相对局部）且方向反转 → 剔除
    const turn = turnAngle(a, b, c);
    const spikeV = Math.max(minSpikeSpeed, med * spikeRatio);
    if (v1 > spikeV && v2 > spikeV && turn > minTurnDeg) {
      drop[i] = true;
      continue;
    }

    // 2) 孤立离群：距前后连线远（绝对 + 相对局部尺度）且两侧位移均不小 → 剔除
    const distLine = pointToSegmentDistM(b, a, c);
    const outlierTh = Math.max(minOutlierM, med * outlierRatio);
    if (distLine > outlierTh && d1 > 15 && d2 > 15) {
      drop[i] = true;
    }
  }

  return points.filter((_, i) => !drop[i]);
}
