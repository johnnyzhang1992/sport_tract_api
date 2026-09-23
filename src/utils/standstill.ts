import { haversineDistance, type TrackPointLike } from './pace.js';

/**
 * 静止时段检测（自动暂停口径，finish 时算一次入库）
 *
 * 算法：停留点（stay point）检测——以某点为锚向后扩展，只要后续点仍在锚点半径内就继续，
 * 扩展时长 ≥ 门槛且点数 ≥ 3 才算一段「静止」，把这段点打上 still 标记、时长累计为 standstillMs。
 * 净运动时长 = 墙钟 − 手动暂停 − standstillMs（见 services/activity.ts）。
 *
 * 为什么用「半径」而不是「速度」判据：本项目的点是 2–3 秒一采，静止时 GPS 抖动的瞬时速度
 * 与慢走的瞬时速度是同一量级（都约 1–2 m/s），逐段速度阈值根本分不开；而「原地抖动走不出
 * 10m 圈、正常行进一定走得出」是几何事实。实测见 test/standstill.test.ts 与下方常量注释。
 *
 * 判据是**三维**的（水平 haversine + 高程差，见 spatialDistance）：爬坡/下坡时水平坐标可能
 * 长时间不出圈（之字上升、横向切坡），只看二维就会把人正在爬的时段判成休息。加上高程后，
 * 「水平不动但海拔在变」= 在爬，不再算静止；海拔缺失时自动退化为二维，老数据不受影响。
 * 注意 GPS 高程噪声本身就是 ±5m 量级，想在 60s 内增收 8m 需要 ~45° 坡，信噪比不宽裕——
 * 这条判据是防御性的，别指望它显著改变数值（实测 9.31km 徒步仅 1105s → 1102s）。
 *
 * 已知边界（刻意接受的代价）：门槛秒数 × 最慢真实速度 必须大于半径，否则一律误伤。
 * 当前 10m / 60s ⇒ 净速度低于 0.167 m/s 的极慢移动（很陡的之字爬升）会被判为静止。
 * 半径不能再放大——实测 20m 时连续跑步就开始被误判（见下方常量注释）。
 */
/**
 * 停留半径（米），三维距离（水平 + 高程）上限
 * 15m 时实测「站住不动在漂」与「0.2 m/s 缓挪」的同构点序列会被判静止，9.31km 徒步扣出 3281s
 * （63 段、占墙钟 29%、平均每 3 分钟一段，明显偏大）；收到 10m → 2109s / 36 段。
 * 上限不能到 20m：连续跑步会被圈进来。代价是抖动漂移 >10m 的手机可能漏判（宁可少扣）。
 */
export const STANDSTILL_RADIUS_M = 10;
/**
 * 最短持续时长（秒）
 * 口径依据（dev 库 9.31km 徒步实测）：30s → 3281s（63 段）；60s → 1528s（14 段）；
 * 120s → 835s（4 段）。取 60s：等红灯、拍照这类 1 分钟内的短停不扣，只认「明确停下休息」。
 * 下限不能低于「半径 ÷ 最慢真实速度」，否则匀速跑动会被必然误伤（10s 时连续跑步多扣 186–292s）。
 * 对照：华为「静止超过 10 秒自动暂停」、Keep 建议 15–30s —— 它们有加速度计，本项目只有坐标。
 */
export const STANDSTILL_MIN_SEC = 60;
/** 最少点数：只有 2 个点时（相隔几十秒落在同一圈内）说明是没采到点、不是静止，凭它删时间等于猜 */
export const STANDSTILL_MIN_POINTS = 3;
/** 相邻点间隔超过该秒数视为断档，不跨断档扩展 */
export const STANDSTILL_MAX_STEP_SEC = 120;

export interface StandstillResult<T extends TrackPointLike> {
  points: (T & { still?: boolean })[];
  standstillMs: number;
  spans: number;
}

const tsOf = (p: TrackPointLike): number | null =>
  typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? p.timestamp : null;

/**
 * 三维距离：水平 haversine + 高程差。任一端海拔缺失/为 null 时退化为水平距离
 * （老数据与无海拔的设备按原口径走，不会因缺字段全体失效）。
 */
function spatialDistance(a: TrackPointLike, b: TrackPointLike): number {
  const horizontal = haversineDistance(a, b);
  const za = a.altitude;
  const zb = b.altitude;
  if (typeof za !== 'number' || typeof zb !== 'number' || !Number.isFinite(za) || !Number.isFinite(zb)) {
    return horizontal;
  }
  const dz = zb - za;
  return Math.sqrt(horizontal * horizontal + dz * dz);
}

/**
 * 标记静止时段（不改点序、不改坐标，只加 still 标记）
 *
 * 入参点上若已带 still（回填脚本换个门槛重跑时就会遇到），一律先清掉再按本次结果重标，
 * 否则旧标记会原样留在库里、与新口径的 standstillMs 自相矛盾。
 * @returns points 打标后的点（原数组的浅拷贝）；standstillMs 静止总时长（毫秒）；spans 静止段数
 */
export function markStandstill<T extends TrackPointLike>(points: T[]): StandstillResult<T> {
  const out = (points ?? []).map((p) => {
    const copy = { ...p } as T & { still?: boolean };
    delete copy.still;
    return copy;
  });
  let standstillMs = 0;
  let spans = 0;
  const n = out.length;

  let i = 0;
  while (i < n) {
    const anchorTs = tsOf(out[i]);
    if (anchorTs == null) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n) {
      const prevTs = tsOf(out[j - 1]);
      const curTs = tsOf(out[j]);
      if (out[j].pauseGap) break; // 不跨手动暂停
      if (prevTs == null || curTs == null) break;
      const step = (curTs - prevTs) / 1000;
      if (step < 0 || step > STANDSTILL_MAX_STEP_SEC) break; // 不跨断档
      if (spatialDistance(out[i], out[j]) > STANDSTILL_RADIUS_M) break; // 走出圈（含高程）→ 这段到此为止
      j++;
    }
    const lastTs = tsOf(out[j - 1]);
    const sec = lastTs == null ? 0 : (lastTs - anchorTs) / 1000;
    if (sec >= STANDSTILL_MIN_SEC && j - i >= STANDSTILL_MIN_POINTS) {
      for (let k = i; k < j; k++) out[k].still = true;
      standstillMs += sec * 1000;
      spans++;
      i = j;
    } else {
      i++;
    }
  }

  return { points: out, standstillMs, spans };
}
