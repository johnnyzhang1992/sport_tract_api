/**
 * 实跑/规划轨迹判别（TrailCraft core/perf/trackKind.ts 同思路的三态设计）：
 * recorded（实跑）/ planned（规划路线）/ uncertain（证据不足）。
 *
 * 三态而非布尔：证据不足时绝不猜——给规划路线算配速/表现分会误导用户，
 * 而「不确定」的代价只是提示一句。信号全部原样返回，让 UI 能展示判断依据。
 *
 * 关键信号：
 * - hasTime：规划工具导出的路线通常完全没有时间戳；
 * - 采样间隔过于规整（变异系数极低）：真实设备记录的间隔必然抖动，
 *   完全均匀的间隔是合成时间轴的红旗信号。
 */
import type { TrackPointLike } from './pace.js';

export type TrackKind = 'recorded' | 'planned' | 'uncertain';

export interface TrackKindSignals {
  /** 原始文件是否带时间戳（补全 1s 间隔之前判断） */
  hasTime: boolean;
  pointCount: number;
  distanceM: number;
  elapsedS?: number;
  avgSpeedMPS?: number;
  /** 平均速度是否落在人类运动合理区间（0.3 ~ 7 m/s，覆盖慢走~精英长跑） */
  speedPlausible?: boolean;
  intervalSampleCount: number;
  /** 相邻采样间隔变异系数（标准差/均值） */
  intervalCV?: number;
  /** 间隔是否"过于规整"（CV < 0.05 且样本足够）——合成时间轴红旗 */
  intervalUniform?: boolean;
}

export interface TrackKindResult {
  kind: TrackKind;
  /** 中文说明，可直接展示 */
  reason: string;
  signals: TrackKindSignals;
}

/** 人类运动合理速度上限（m/s）：> 7 m/s（25.2km/h）持续出现已不是跑步/徒步 */
const MAX_HUMAN_SPEED_MPS = 7;
const MIN_HUMAN_SPEED_MPS = 0.3;
/** 变异系数低于该值视为"过于规整"（需要至少 20 个间隔样本才判） */
const UNIFORM_CV = 0.05;
const UNIFORM_MIN_SAMPLES = 20;

/**
 * @param rawPoints 原始解析点（时间补全之前）：timestamp 缺失应为 0
 * @param distanceM 轨迹总距离（米，可由调用方算好传入；缺省现算）
 * @param opts.hasTime 原始时间戳存在性（调用方解析时更清楚——补全 1s 间隔后点集自身不可分辨）
 */
export function classifyTrackKind(
  rawPoints: TrackPointLike[],
  distanceM?: number,
  opts?: { hasTime?: boolean },
): TrackKindResult {
  const n = rawPoints.length;
  const hasTime = opts?.hasTime != null ? opts.hasTime : rawPoints.some((p) => typeof p.timestamp === 'number' && p.timestamp > 0);

  // 距离（缺省现算，与 pace.ts 同款 haversine 口径由调用方保证）
  let dist = distanceM ?? 0;
  if (distanceM == null) {
    for (let i = 1; i < n; i++) {
      const a = rawPoints[i - 1];
      const b = rawPoints[i];
      const dLat = ((b.lat - a.lat) * Math.PI) / 180;
      const dLng = ((b.lng - a.lng) * Math.PI) / 180;
      const s =
        Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
      dist += 2 * 6371000 * Math.asin(Math.sqrt(s));
    }
  }

  const signals: TrackKindSignals = { hasTime, pointCount: n, distanceM: Math.round(dist), intervalSampleCount: 0 };

  // 信号 1：完全没有时间戳 → 规划路线（最强信号，直接定论）
  if (!hasTime) {
    return { kind: 'planned', reason: '文件不含时间信息，判定为规划路线', signals };
  }

  const first = rawPoints[0];
  const last = rawPoints[n - 1];
  const elapsedS = (Number(last.timestamp) - Number(first.timestamp)) / 1000;
  const avgSpeedMPS = elapsedS > 0 ? dist / elapsedS : undefined;
  const speedPlausible = avgSpeedMPS != null ? avgSpeedMPS >= MIN_HUMAN_SPEED_MPS && avgSpeedMPS <= MAX_HUMAN_SPEED_MPS : undefined;
  signals.elapsedS = elapsedS;
  signals.avgSpeedMPS = avgSpeedMPS != null ? Math.round(avgSpeedMPS * 100) / 100 : undefined;
  signals.speedPlausible = speedPlausible;

  // 信号 2：采样间隔规整度（只统计相邻真实时间戳的间隔）
  const intervals: number[] = [];
  for (let i = 1; i < n; i++) {
    const dt = (Number(rawPoints[i].timestamp) - Number(rawPoints[i - 1].timestamp)) / 1000;
    if (Number.isFinite(dt) && dt > 0) intervals.push(dt);
  }
  signals.intervalSampleCount = intervals.length;
  if (intervals.length >= UNIFORM_MIN_SAMPLES) {
    const mean = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    const variance = intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
    signals.intervalCV = Math.round(cv * 1000) / 1000;
    signals.intervalUniform = cv < UNIFORM_CV;
  }

  // 判定（从严到松）：速度离谱 / 时间轴合成 → uncertain；否则 recorded
  if (speedPlausible === false) {
    return { kind: 'uncertain', reason: `平均速度 ${signals.avgSpeedMPS} m/s 超出人类运动合理区间，无法确认是实跑记录`, signals };
  }
  if (signals.intervalUniform) {
    return { kind: 'uncertain', reason: '采样间隔过于均匀，疑似合成时间轴，无法确认是实跑记录', signals };
  }
  return { kind: 'recorded', reason: '含真实时间戳且速度/采样特征正常', signals };
}
