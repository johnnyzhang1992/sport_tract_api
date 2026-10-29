import { ACTIVITY_TYPE_META, DEFAULT_WEIGHT_KG, type ActivityType } from '../config/constants.js';

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
  /** finish 时标出的静止时段点（自动暂停口径，见 utils/standstill.ts） */
  still?: boolean;
  /** finish 时标出的非运动段点（疑似乘车，见 utils/vehicle.ts）：该点「入段」的位移与时长一起剔除 */
  vehicle?: boolean;
  timestamp?: number;
}

export interface CalcStatsOptions {
  type: ActivityType;
  /** 运动时长（秒，已扣除暂停） */
  durationSec: number;
  /** 体重（kg），卡路里估算用：落库卡路里的 5 条路径（finish/自动收尾/纠偏/改类型/导入）一律传 services/weight.ts 的档案体重，别依赖这里的兜底 */
  weightKg?: number;
}

/** 配速最小有效距离（米）：低于此值配速无意义（如刚起步/静止） */
const MIN_PACE_DISTANCE_M = 200;

/**
 * 无配速概念的运动类型（唯一事实源）：这些类型 avgPace 恒为 null，是设计而非缺数据。
 * 引用它的两处必须同源，否则「不算配速的类型」与「发分不要求配速的类型」会各自漂移：
 * - calcStats / calcFastestKm：本就不为它们计算配速
 * - services/points-board.ts：发分口径的配速判据对它们不生效（否则游泳/骑行全国榜永远空）
 */
export const NO_PACE_TYPES: readonly ActivityType[] = ['swimming', 'cycling'];

/** 该运动类型是否根本不计算配速（入参允许任意字符串：库里/导入的历史值不受枚举约束） */
export function hasNoPace(type: string): boolean {
  return (NO_PACE_TYPES as readonly string[]).includes(type);
}

// 爬升算法（与小程序 services/tracker.js 同款，决策 D16 v2）：
// 旧"单步>死区即累计"缓坡漏计严重（每步差值远小于阈值）而慢噪声单步大跳反被累计；
// 改为 EMA 平滑 + 滞回确认——噪声上下抵消，缓坡可持续累计达标
//
// ⚠️ 标定提示（勿随意改动）：不同平台公布的爬升数字相差 15%~30%，几乎全部来自
// 这组阈值的选择（Strava/Garmin/ITRA 各不相同）。若要与其它平台对数，先各导一条
// 同轨迹对照，微调 confirmM 直到读数接近，再同步小程序端 tracker.js 的同名常量——
// 两端必须一致，否则 App 内实时值与落库复核值会永久打架。
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
 * - 距离：相邻点 Haversine 累加，跳过非运动段（vehicle）的入段位移
 * - 爬升：海拔 EMA 平滑 + 滞回确认（下坡抵扣未确认部分），只累计确认的上升段
 * - 最低/最高海拔：原始海拔点的极值（GPS 参考）
 * - 卡路里：MET × 体重 × 时长（小时）
 */
export function calcStats(points: TrackPointLike[], opts: CalcStatsOptions): CalcStatsResult {
  const { type, durationSec, weightKg = DEFAULT_WEIGHT_KG } = opts;

  // 距离（车速段是"被运过去的"不是自己动的，与人是否移动无关，一律不计）
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].vehicle) continue;
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
  const avgPace = hasNoPace(type)
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

/** 距离里程碑 PB 标记：到达 5/10/15…公里（每 5km 一个）的累计用时（秒） */
export interface PbMark {
  km: number;
  sec: number;
}

/** 里程碑步长（米）：每 5km 一个记录 */
const PB_MARK_STEP_M = 5000;

/**
 * 距离里程碑耗时（5公里PB/10公里PB/…）：从起点累计距离每满 5km 记一次用时
 * - 用时与距离的累计规则与 calcFastestKm 完全同款：
 *   a) 静止时段（still）照计——停下来休息也算跑完这段的耗时
 *   b) 暂停恢复点（pauseGap）/ 相邻点 >60s 丢点 / 车速段（vehicle）：
 *      跨越的距离与时间都不计（暂停位移是 GPS 漂移、暂停时间不该算成绩）
 * - 里程碑时刻在跨越它的相邻两点间按距离比例线性插值
 * - 不足 5km 的轨迹返回 []（里程碑必须真实到达）
 */
export function calcPbMarks(points: TrackPointLike[]): PbMark[] {
  const sorted = [...points]
    .filter((p) => p.timestamp != null)
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  if (sorted.length < 2) return [];
  const marks: PbMark[] = [];
  let markIndex = 1; // 第几个里程碑（× PB_MARK_STEP_M = 目标距离）
  let cumDist = 0;
  let cumSec = 0;
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const dt = ((cur.timestamp ?? 0) - (prev.timestamp ?? 0)) / 1000; // 秒
    // 与 calcFastestKm 同款：跨暂停/丢点/车速段的距离与时间都不算
    if (cur.pauseGap || cur.vehicle || !Number.isFinite(dt) || dt < 0 || dt > GAP_MS / 1000) {
      prev = cur;
      continue;
    }
    const stepDist = haversineDistance(prev, cur);
    // 单步跨多个里程碑时逐个补齐（按距离比例插值到里程碑时刻）
    // epsilon：恰好跑满 5km 时 haversine 累计的浮点误差可能停在 4999.999999x，不能因此漏记
    while (stepDist > 0 && cumDist + stepDist >= markIndex * PB_MARK_STEP_M - 1e-6) {
      const remain = markIndex * PB_MARK_STEP_M - cumDist;
      marks.push({ km: markIndex * 5, sec: Math.round(cumSec + (dt * remain) / stepDist) });
      markIndex++;
    }
    cumDist += stepDist;
    cumSec += dt;
    prev = cur;
  }
  return marks;
}

/** 轨迹内最快 1 公里分段（秒/公里）
 * - 1km 分段：从起点起每累计 1000m 记一段（不足 1km 的尾段剔除），段内按实际距离归一化到 1km
 * - 用时按**经过时间**算（与 Keep/华为的分段口径一致）：段内静止时段（still）照计，
 *   中途停下休息就是让这一公里变慢——剔掉静止时间反而会奖励"km 中间停车"
 * - 暂停/断档不跨段：
 *   a) 带 pauseGap 标记的恢复点：跨暂停的距离与时间都不计入，新段从该点重新开始
 *   b) 相邻点间隔 > 60s（丢点/暂停未标记）：同样断段（旧实现只把时间置 0、距离仍累加，会刷出假 PR）
 *   c) 非运动段（vehicle，疑似乘车）：断段而非"跳过这几步"——乘车会把人运到别处，
 *      跨它拼出来的 1km 既不同段也不同路，实测就是这条规则把 3'41" 的假 PR 挡在门外
 * - 返回 null：轨迹不足 1km 或点缺少 timestamp；即「最快配速」必须是真实跑满 1km 的分段
 */
const GAP_MS = 60000;
/** 最快配速分段长度（米）：必须跑满此距离才计一段 */
const PACE_SEGMENT_M = 1000;
export function calcFastestKm(points: TrackPointLike[], type?: string): number | null {
  if (type && hasNoPace(type)) return null; // 游泳/骑行不统计配速
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
    const dt = ((cur.timestamp ?? 0) - (prev.timestamp ?? 0)) / 1000; // 秒
    // 暂停恢复点 / 丢点断档 / 车速段：跨过去的距离与时间都不算，段从当前点重新开始
    if (cur.pauseGap || cur.vehicle || !Number.isFinite(dt) || dt < 0 || dt > GAP_MS / 1000) {
      prev = cur;
      segDist = 0;
      segSec = 0;
      continue;
    }
    segDist += haversineDistance(prev, cur);
    // 静止时段（still）照计时间：分段配速是"跑完这 1km 花了多久"，中途站着休息就该算进这一公里。
    // （曾把静止时间剔掉，结果线上那条在 km 中间停 48s 的轨迹从 3'41" 变成 2'32"——停下反而更快，方向反了）
    segSec += dt;
    if (segDist >= PACE_SEGMENT_M) {
      // 段完成（≥ 1km）：按实际距离归一化到 1km；尾段不足 1km 自然剔除
      const pace = segSec / (segDist / 1000);
      if (fastest === null || pace < fastest) fastest = pace;
      segDist = 0;
      segSec = 0;
    }
    prev = cur;
  }
  return fastest === null ? null : Math.round(fastest * 10) / 10;
}
