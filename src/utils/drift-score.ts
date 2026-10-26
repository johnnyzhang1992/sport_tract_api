import {
  GAP_TIGHTEN_MIN_SEC,
  VEHICLE_MIN_SPEED_MPS,
  SUSTAINED_SPEED_CEIL_MPS,
  SUSTAINED_SPEED_CEIL_DEFAULT_MPS,
} from './vehicle.js';
import { TYPE_CONFIGS, DEFAULT_TYPE_CONFIG } from './trajectory-clean.js';

/**
 * 轨迹漂移置信度分（0–100，设计 docs/19 §4.1）：衡量一条轨迹被 GPS 漂移污染的程度，
 * 用于 PB/榜单进榜资格门禁（≥ DRIFT_SCORE_PB_GATE 不进榜，见 config/constants.ts）。
 *
 * 四个分量（设计宪法 §2：只标记不删数据，门禁不藏轨迹）：
 * - accBadRatio：端上精度差抽稀保留点的步占比——室内漂移的主信号，权重最高；
 * - vehicleRatio：vehicle 步时长占墙钟比——finish 时只有端上标记（超速/巨步弦/中短断档），
 *   reprocess 后含服务端持续判据，同一函数两个阶段分数只会更准；
 * - slowGapRatio：步长 > 30s 且弦速 ≤ 类型 gapSpeed 的占比——稀疏但弦速可信
 *   （真实徒步节奏/正常稀疏采样），轻罚 0.15；
 * - fastGapRatio：步长 > 30s 且弦速 > 类型 gapSpeed 的占比——**重罚 1.0**（2026-10-26 校准
 *   后新增，用户拍板）：点集稀疏本身就是质量问题——老版本客户端把超速点整批丢弃、
 *   纠偏清洗剔除漂移点，残留点之间的直线弦里藏着被丢弃的超速位移，弦速超人类持续
 *   上限就是证据。dev 库实测：旧公式下 25.8km/61min 的「步行」只拿 ~15 分混进榜，
 *   新公式直接 67 分进档。快弦阈值 = 类型 gapSpeed，未配置类型退化为车流速度 6.5。
 *
 * 标定锚点（dev 库 823 条实测，方向「宁严勿松」）：
 * 城市正常跑步 ~0-3 分；新版混合地铁跑（车段已标 vehicle）~6 分；稀疏慢弦（线上同步老轨迹）
 * ~15 分；老客户端地铁通勤/快弦藏车（30%+）35-67 分被拦；室内摇手机 ~38+ 分。
 */
export function calcDriftScore<
  T extends { timestamp?: number | null; lat?: unknown; lng?: unknown; accBad?: boolean; vehicle?: boolean },
>(points: T[], type?: string, metrics?: { distance?: number; durationSec?: number }): number {
  const pts = points ?? [];
  const n = pts.length;
  if (n < 2) return 0;
  // 快弦阈值 = 类型 gapSpeed（与中短断档收紧同源：人类无法持续 30s+ 的速度）；
  // 未配置类型（含骑行）退化为车流速度 6.5——骑行隧道真实弦 5m/s 不误伤，汽车 15m/s 照拦
  const fastGapMps =
    (type ? (TYPE_CONFIGS[type] ?? DEFAULT_TYPE_CONFIG).gapSpeed : undefined) ??
    VEHICLE_MIN_SPEED_MPS;
  let accBadSteps = 0;
  let vehicleMs = 0;
  let slowGapMs = 0;
  let fastGapMs = 0;
  let spanMs = 0;
  let chordSumM = 0; // 点集弦长合计：距离证据（距离 >> 弦长 = 挂机漂移刷距离/旧版丢弃）
  for (let i = 1; i < n; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const ta = typeof a.timestamp === 'number' ? a.timestamp : NaN;
    const tb = typeof b.timestamp === 'number' ? b.timestamp : NaN;
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) continue;
    const dtMs = Math.max(0, tb - ta);
    spanMs += dtMs;
    const chord = chordSpeedMps(a, b, dtMs);
    if (chord != null) chordSumM += chord * (dtMs / 1000);
    if (b.accBad === true) accBadSteps += 1;
    if (b.vehicle === true) {
      vehicleMs += dtMs; // vehicle 步的时长在 vehicleRatio 里计，不重复进 gap 分档
    } else if (dtMs > GAP_TIGHTEN_MIN_SEC * 1000) {
      // 未标记的长间隔步：按弦速分档（相对时间戳/绝对时间戳差值口径等价）
      const chordMps = chordSpeedMps(a, b, dtMs);
      if (chordMps != null && chordMps > fastGapMps) fastGapMs += dtMs;
      else slowGapMs += dtMs; // 坐标缺失无法算弦速：按慢弦处理（不加重罚）
    }
  }
  const steps = n - 1;
  if (spanMs <= 0 || steps <= 0) return 0;
  let penalty =
    0.6 * (accBadSteps / steps) +
    0.2 * (vehicleMs / spanMs) +
    0.15 * (slowGapMs / spanMs) +
    1.0 * (fastGapMs / spanMs);

  // 距离证据一致性（dev 库审计新增）：存储距离 >> 点集弦长 = 弦里丢位移
  // （still 收缩丢失漂移细节 / 旧版客户端丢弃超速点）→ 弦撑不起的距离不可信。
  // 阈值 0.8：正常轨迹弦长 ≈ 距离（±10% 对账守卫保证）；c10042 实测 11.6/20 = 0.58
  const dist = metrics?.distance;
  if (dist != null && dist > 1000 && chordSumM > 0) {
    const ratio = chordSumM / dist;
    if (ratio < 0.8) penalty += (0.8 - ratio) * 1.2;
  }

  // 均速合理性（dev 库审计新增）：存储距离/运动时长 超类型持续上限 → 物理不可能
  // （c10184 实测：30.6km/h 的「步行」21km；a81e2b：44.7km/h 的「骑行」）。
  // 上限取「世界级选手可持续全程的均速」：跑步 6.5（马拉松纪录级）、步行类 2.2（竞走级）、
  // 骑行 11.5（41km/h，职业环法均速级）——业余不可能，宁严勿松
  const dur = metrics?.durationSec;
  if (dist != null && dur != null && dur > 60) {
    const ceil = SUSTAINED_SPEED_CEIL_MPS[type ?? ''] ?? SUSTAINED_SPEED_CEIL_DEFAULT_MPS;
    const mps = dist / dur;
    if (mps > ceil) penalty += Math.min(1, ((mps - ceil) / ceil) * 2);
  }

  return Math.round(100 * Math.min(1, penalty));
}



/** 弦速（m/s）：粗略 haversine，坐标缺失返回 null */
function chordSpeedMps(
  a: { lat?: unknown; lng?: unknown; timestamp?: unknown },
  b: { lat?: unknown; lng?: unknown; timestamp?: unknown },
  dtMs: number,
): number | null {
  const aLat = typeof a.lat === 'number' ? a.lat : NaN;
  const aLng = typeof a.lng === 'number' ? a.lng : NaN;
  const bLat = typeof b.lat === 'number' ? b.lat : NaN;
  const bLng = typeof b.lng === 'number' ? b.lng : NaN;
  if (!Number.isFinite(aLat) || !Number.isFinite(aLng) || !Number.isFinite(bLat) || !Number.isFinite(bLng)) {
    return null;
  }
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  const dist = 2 * R * Math.asin(Math.sqrt(s));
  return dtMs > 0 ? dist / (dtMs / 1000) : null;
}
