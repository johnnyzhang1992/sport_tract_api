/**
 * 轨迹点存储紧凑化（方案：坐标存储瘦身，预计 -40~50%）
 *
 * 紧凑格式（v2，相对时间 + 稀疏布尔 + 7 位坐标）：
 * - lat/lng 保留 7 位小数（≈1.1cm 分辨率，远超 GPS 物理精度；抹平平滑产生的 15 位浮点伪影）
 * - timestamp 字段名不变，存相对 startTime 的毫秒数（int）：13 位 → 5~7 位；识别：> 1e12 为旧格式绝对 ms
 *   （字段名保留的原因：Mongo schema 要求 timestamp 必填，改名牵动 appendPoints/索引）
 * - speed 丢弃：finish 管线内无消费方（vehicle/standstill 检测用相邻点距离/时间差自算），
 *   若未来需要瞬时速度，从相邻点重算即可
 * - pauseGap/vehicle/still/gapJump 稀疏存储：仅 true 时写入字段，读端默认 false
 * - altitude 保留 1 位小数；accuracy 取整（米级整数已足够）；seq 保留（appendPoints 幂等键）
 *
 * 读兼容：normalizeTrackPoints 将新旧两种格式归一为绝对时间戳 + 全字段的旧形状，
 * 所有消费方（详情渲染/回放/reprocess/overview）无需感知存储格式。
 */

const ABS_TS_THRESHOLD = 1e12; // 绝对 ms 时间戳（>2001-09-09）；相对毫秒远小于该值

export interface CompactTrackPoint {
  seq: number;
  lat: number;
  lng: number;
  altitude?: number | null;
  /** 瞬时速度（m/s）：暂保留存储（展示/纠偏潜在用途），可选省略 */
  speed?: number | null;
  accuracy?: number | null;
  /** 相对 startTime 的毫秒数（紧凑格式；字段名保持 timestamp 以兼容 schema 与 appendPoints） */
  timestamp: number;
  /** 以下仅 true 时写入 */
  pauseGap?: true;
  still?: true;
  vehicle?: true;
  gapJump?: true;
}

const round7 = (v: number) => Math.round(v * 1e7) / 1e7;

/** 紧凑化：管线输出的点 → 存储格式（幂等：已紧凑的点原样保留） */
export function compactTrackPoints<T extends { seq?: number; lat: number; lng: number; altitude?: number | null; speed?: number | null; accuracy?: number | null; timestamp?: number; pauseGap?: boolean; still?: boolean; vehicle?: boolean; gapJump?: boolean }>(
  points: T[],
  startTimeMs: number,
): CompactTrackPoint[] {
  return points.map((p) => {
    const out: CompactTrackPoint = {
      seq: Number(p.seq ?? 0),
      lat: round7(p.lat),
      lng: round7(p.lng),
      timestamp: p.timestamp != null && p.timestamp > ABS_TS_THRESHOLD ? p.timestamp - startTimeMs : Math.round(p.timestamp ?? 0),
    };
    if (p.altitude != null) out.altitude = Math.round(p.altitude * 10) / 10;
    if (p.speed != null) out.speed = Math.round(p.speed * 10) / 10;
    if (p.accuracy != null) out.accuracy = Math.round(p.accuracy);
    if (p.pauseGap) out.pauseGap = true;
    if (p.still) out.still = true;
    if (p.vehicle) out.vehicle = true;
    if (p.gapJump) out.gapJump = true;
    return out;
  });
}

export interface NormalizedTrackPoint {
  seq: number;
  lat: number;
  lng: number;
  altitude: number | null;
  speed: number | null;
  accuracy: number | null;
  pauseGap: boolean;
  still: boolean;
  vehicle: boolean;
  gapJump: boolean;
  /** 绝对毫秒时间戳（紧凑格式 + startTime 还原；旧格式原样） */
  timestamp: number;
}

/** DTO 归一化：库内任意格式 → 绝对时间戳 + 全字段的旧形状（下游零感知） */
export function normalizeTrackPoints(points: Array<Record<string, unknown>> | undefined, startTimeMs: number): NormalizedTrackPoint[] {
  const rows = points ?? [];
  return rows.map((p) => {
    // 紧凑格式存相对 ms（< 1e12）→ 加 startTime 还原；旧格式存绝对 ms → 原样
    const ts = Number(p.timestamp ?? 0);
    return {
      seq: Number(p.seq ?? 0),
      lat: Number(p.lat),
      lng: Number(p.lng),
      altitude: p.altitude != null ? Number(p.altitude) : null,
      speed: p.speed != null ? Number(p.speed) : null,
      accuracy: p.accuracy != null ? Number(p.accuracy) : null,
      pauseGap: p.pauseGap === true,
      still: p.still === true,
      gapJump: p.gapJump === true,
      vehicle: p.vehicle === true,
      // 紧凑格式（相对 ms）→ 加 startTime 还原；旧格式（绝对 ms）原样
      timestamp: ts > ABS_TS_THRESHOLD ? ts : startTimeMs + ts,
    };
  });
}
