/**
 * 轨迹抽稀与热力网格（决策 M6：轨迹合集地图）
 * - Douglas-Peucker 逐轨迹抽稀：保留形状（转弯点不丢），轨迹越多取点越少
 * - 全局点预算：总量控制在地图渲染性能安全范围内
 * - 网格热力：按 ~150m 网格统计经过强度，返回 {lat, lng, weight} 序列
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** 点到线段距离（球面近似，用于 DP 抽稀） */
function pointToSegmentDist(p: LatLng, a: LatLng, b: LatLng): number {
  // 平面近似（短距离轨迹误差可接受），再转米
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const cosLat = Math.cos(toRad(p.lat));
  const x = (p.lng - a.lng) * cosLat;
  const y = p.lat - a.lat;
  // 线段向量
  const bx = (b.lng - a.lng) * cosLat;
  const by = b.lat - a.lat;
  const len2 = bx * bx + by * by;
  let t = len2 > 0 ? (x * bx + y * by) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = x - bx * t;
  const dy = y - by * t;
  // 度 → 米（纬度 1° ≈ 111320m）
  return Math.sqrt(dx * dx + dy * dy) * 111320;
}

/** Douglas-Peucker 抽稀（度单位 epsilon，内部换算米） */
function douglasPeucker(pts: LatLng[], epsM: number): LatLng[] {
  if (pts.length < 3) return pts.slice();
  let maxDist = 0;
  let index = 0;
  const first = pts[0];
  const last = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointToSegmentDist(pts[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist > epsM && index > 0) {
    const left = douglasPeucker(pts.slice(0, index + 1), epsM);
    const right = douglasPeucker(pts.slice(index), epsM);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

/** 轨迹包围盒对角线（米） */
function bboxDiagonal(pts: LatLng[]): number {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const cosLat = Math.cos(toRad((minLat + maxLat) / 2));
  const dLat = (maxLat - minLat) * 111320;
  const dLng = (maxLng - minLng) * 111320 * cosLat;
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

export interface SimplifyOptions {
  /** 全局点预算（默认 3000，地图渲染性能上限） */
  maxPoints?: number;
  /** 单轨迹硬上限（默认 100） */
  maxPerTrack?: number;
}

/**
 * 多轨迹抽稀：DP 保形 + 全局预算 + 单轨迹上限
 * @returns 抽稀后的轨迹数组（每条至少 2 点）
 */
export function simplifyTracks(
  tracks: LatLng[][],
  opts: SimplifyOptions = {},
): LatLng[][] {
  const maxPoints = opts.maxPoints ?? 3000;
  const maxPerTrack = opts.maxPerTrack ?? 100;
  if (tracks.length === 0) return [];

  // 第一步：每轨迹 DP 抽稀（容差 = 包围盒对角线的 1.5%，保留形状）；单点轨迹直接保留
  let result = tracks.map((t) => {
    if (t.length < 2) return t.slice();
    const diag = bboxDiagonal(t);
    const epsM = Math.max(5, diag * 0.015);
    let pts = douglasPeucker(t, epsM);
    // 保形修复：环形/回环轨迹首尾接近，DP 可能退化成重合两点（画不出线）。
    // 首尾距离 < 跨度 10% 时用更小容差重抽，至少保留形状拐点
    if (pts.length < 4 && t.length > 8) {
      const headTail = Math.hypot(
        (pts[pts.length - 1].lat - pts[0].lat) * 111320,
        (pts[pts.length - 1].lng - pts[0].lng) * 111320 * 0.85,
      );
      if (headTail < diag * 0.1) {
        pts = douglasPeucker(t, Math.max(2, diag * 0.004));
      }
    }
    // 单轨迹硬上限：均匀采样降点
    if (pts.length > maxPerTrack) {
      const step = Math.ceil(pts.length / maxPerTrack);
      pts = pts.filter((_, i) => i % step === 0);
      if (pts.length < 2) pts = [pts[0], pts[pts.length - 1]];
    }
    return pts;
  });

  // 第二步：全局预算裁剪（按轨迹点数占比分配，长轨迹多点）；单点轨迹不参与
  let total = result.reduce((s, t) => s + t.length, 0);
  if (total > maxPoints) {
    const ratio = maxPoints / total;
    result = result.map((t) => {
      if (t.length < 2) return t;
      const target = Math.max(2, Math.floor(t.length * ratio));
      if (t.length <= target) return t;
      const step = t.length / target;
      const out: LatLng[] = [];
      for (let i = 0; i < target; i++) {
        out.push(t[Math.min(t.length - 1, Math.floor(i * step))]);
      }
      out[out.length - 1] = t[t.length - 1]; // 保终点
      return out;
    });
  }
  return result;
}

export interface HeatCell {
  lat: number;
  lng: number;
  weight: number; // 0~1 归一化
}

/**
 * 网格热力：把多轨迹点按 ~gridM 网格统计强度
 * 同一网格被越多轨迹覆盖 → 权重越高（高频路线热区）
 * @returns 网格中心 + 归一化权重（≤ maxCells 个，按权重降序取前 N）
 */
export function gridHeat(
  tracks: LatLng[][],
  gridM = 150,
  maxCells = 200,
): HeatCell[] {
  const cellLat = gridM / 111320;
  const counts = new Map<string, { lat: number; lng: number; n: number }>();
  for (const t of tracks) {
    for (const p of t) {
      const cosLat = Math.cos((p.lat * Math.PI) / 180) || 1;
      const cellLng = cellLat / cosLat;
      const key = `${Math.round(p.lat / cellLat)},${Math.round(p.lng / cellLng)}`;
      const cur = counts.get(key);
      if (cur) {
        cur.n += 1;
      } else {
        counts.set(key, {
          lat: Math.round((p.lat / cellLat) * cellLat * 1e6) / 1e6,
          lng: Math.round((p.lng / cellLng) * cellLng * 1e6) / 1e6,
          n: 1,
        });
      }
    }
  }
  const cells = Array.from(counts.values()).sort((a, b) => b.n - a.n);
  const top = cells.slice(0, maxCells);
  const max = top.length > 0 ? top[0].n : 0;
  return top.map((c) => ({
    lat: c.lat,
    lng: c.lng,
    weight: max > 0 ? Math.max(0.05, Math.min(1, c.n / max)) : 0,
  }));
}
