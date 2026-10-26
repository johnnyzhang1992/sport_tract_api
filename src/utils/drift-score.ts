import { GAP_TIGHTEN_MIN_SEC } from './vehicle.js';

/**
 * 轨迹漂移置信度分（0–100，设计 docs/19 §4.1）：衡量一条轨迹被 GPS 漂移污染的程度，
 * 用于 PB/榜单进榜资格门禁（≥ DRIFT_SCORE_PB_GATE 不进榜，见 config/constants.ts）。
 *
 * 三个分量（设计宪法 §2：只标记不删数据，门禁不藏轨迹）：
 * - accBadRatio：端上精度差抽稀保留点的步占比——室内漂移的主信号，权重最高；
 * - vehicleRatio：vehicle 步时长占墙钟比——finish 时只有端上标记（超速/巨步弦/中短断档），
 *   reprocess 后含服务端持续判据，同一函数两个阶段分数只会更准；
 * - gapRatio：步长 > 30s 的断档时长占比——地铁形态信号。
 *
 * 标定锚点（上线前用 dev 库取证校准，方向「宁严勿松」）：
 * 城市正常跑步 ~2-3 分；混合地铁跑（30% 车程）~16 分；商场快走（50% 弱信号）~30 分；
 * 全程室内摇手机 40+ 分。
 */
export function calcDriftScore<T extends { timestamp?: number | null; accBad?: boolean; vehicle?: boolean }>(
  points: T[],
): number {
  const pts = points ?? [];
  const n = pts.length;
  if (n < 2) return 0;
  let accBadSteps = 0;
  let vehicleMs = 0;
  let gapMs = 0;
  let spanMs = 0;
  for (let i = 1; i < n; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const ta = typeof a.timestamp === 'number' ? a.timestamp : NaN;
    const tb = typeof b.timestamp === 'number' ? b.timestamp : NaN;
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) continue;
    const dtMs = Math.max(0, tb - ta);
    spanMs += dtMs;
    if (b.accBad === true) accBadSteps += 1;
    if (b.vehicle === true) vehicleMs += dtMs;
    // 相对时间戳（紧凑格式，>2001 为绝对）：差值口径下两种格式等价，无需区分
    if (dtMs > GAP_TIGHTEN_MIN_SEC * 1000) gapMs += dtMs;
  }
  const steps = n - 1;
  if (spanMs <= 0 || steps <= 0) return 0;
  const score =
    100 *
    Math.min(
      1,
      0.6 * (accBadSteps / steps) + 0.2 * (vehicleMs / spanMs) + 0.2 * (gapMs / spanMs),
    );
  return Math.round(score);
}
