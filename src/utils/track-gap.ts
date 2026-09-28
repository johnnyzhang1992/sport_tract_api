import { haversineDistance, type TrackPointLike } from './pace.js';

/**
 * 采样断档连线标记（"这条线不可信"，只打标不删点、不改数）
 *
 * 要解决的问题：丢锁几秒后重定位，位置跳到侧向几十米外，地图上画出一条横穿内场/空地的直线，
 * 看着像用户抄了近道。速度类纠偏规则抓不到它们：漂移步的"进入步"快得离谱、"离开步"却是正常速度
 * （人本来就在前面继续走），而规则要求双向都超；更糟的是自适应门槛取「局部中位 × N」，
 * 连续漂移会把局部中位本身抬到 5–12 m/s，实测门槛被顶到 20–46 m/s，类型下限那一项永不生效。
 *
 * 删点也不行：删掉落点后前后两点直连，弦只是换个长度（75m/7s + 15m/3s → 60m/10s），
 * 横穿照样横穿——弦是"时间间隔"的属性，不是"某个坏点"的属性。
 *
 * 判据（三条同时成立才标，与运动类型无关，靠全轨迹中位数自适应）：
 *   1) 间隔 ≥ max(2×中位间隔, 5s)
 *   2) 位移 > max(25m, 中位步速 × 间隔 × 2.5)
 *   3) 横向偏移 > max(20m, 中位步速 × 间隔 × 1.5)   ← 横向 = 垂直于"断档前那段的方向"的分量
 * 2.5 倍余量的依据：实测漂移步是中位步速的 4.5–5.1 倍，而真冲刺/加速到不了 2.5 倍；
 * 用全轨迹中位（不是局部窗口）当基准，是因为中位数天然抗离群，且它就是这次运动自己的节奏。
 *
 * 第 3 条为什么必须有：线上样本 6ab8f4d7（本地副本 591 点）按前两条判出 5 步 66–112m / 6–10s，
 * 但实测它们与局部行进方向夹角只有 1–11°（横向偏移 1.3–12.6m）——那是**沿着跑道把弯切了**，
 * 线本来就贴着自己的轨迹，断开等于在正常的线上挖 5 个洞（用户反馈"看着还不如原来"）。
 * 用户看到的尖角来自切角，不来自横穿；切角不该断线。
 *
 * 标记语义与 pauseGap 一致：标在"该步的落点"上，渲染方遇到标记点就在此处断开连线
 * （即不画 上一点 → 标记点 那条线）。距离/配速/卡路里等指标一律不受影响。
 */
/** 断档的最短间隔（秒）：低于此值不判，避免把正常采样抖动当断档 */
export const GAP_MIN_SEC = 5;
/** 间隔相对全轨迹中位的倍数：超过即视为采样断档 */
export const GAP_SEC_MULT = 2;
/** 位移余量倍数：超过"该间隔按中位步速能走出的距离"的该倍数才判漂移 */
export const GAP_DIST_MULT = 2.5;
/** 位移绝对下限（米）：再长的间隔，只要没走出这个距离就只是慢走 */
export const GAP_MIN_M = 25;
/** 横向偏移余量倍数：位移里"垂直于断档前行进方向"的分量，超过中位步速×间隔的该倍数才算横穿 */
export const GAP_CROSS_MULT = 1.5;
/** 横向偏移绝对下限（米）：慢速运动里的小横移仍在 GPS 噪声范围内，不断线 */
export const GAP_CROSS_MIN_M = 20;
/**
 * 局部行进方向的回看窗口（秒）：用断档前这段的合位移定方向。
 * 取短（≈3 步）是为了拿到"离开 a 时的切线"：窗口太长时，弯道上的合位移弦本身就在向外偏，
 * 顺着切线把弯切了的漂移步会被误判成横穿（实测那条跑圈轨迹就是这么中了 2 处），
 * 而真正指向弯道外侧的横穿反而会被弦方向吃掉。单点方向又会被 GPS 抖动带偏，故取 6s 折中。
 */
export const GAP_HEADING_SEC = 6;

export interface GapPointLike extends TrackPointLike {
  timestamp?: number;
  gapJump?: boolean;
}

export interface GapResult<T extends GapPointLike> {
  points: (T & { gapJump?: true })[];
  /** 判出的断档处数 */
  gaps: number;
  /** 断档弦的合计位移（米）：将来若要按中位步速折算距离，这是待折算的量 */
  gapM: number;
}

const median = (arr: number[]) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/** 等距圆柱局部平面坐标（米）：只用于算方向夹角，不做距离口径 */
const toXY = (p: { lat: number; lng: number }) => ({
  x: p.lng * 111320 * Math.cos((p.lat * Math.PI) / 180),
  y: p.lat * 111320,
});

/**
 * 这一步位移里"垂直于行进方向"的分量（米）：横穿 ≈ 整段位移，沿跑道切角 ≈ 0。
 * 参照方向取断档前、后两条弦里**更贴合**的那条（min）：只看前方那条时，弯道上的合位移弦
 * 本身就在向外偏，"顺着切线把弯切了"会被误判成横穿（实测那条跑圈轨迹就是这样中了 2 处），
 * 而真横穿对前后两条弦都近乎垂直，min 也照样大 → 仍能判出。
 * 前后任意一侧取不到参照（贴着起点、或上一步本身就是断档）时返回 null → 不判：
 * 拿不准就保留连线，别在正常的线上挖洞。
 */
function crossOffsetM<T extends { lat: number; lng: number; timestamp?: number }>(
  rows: T[],
  i: number,
): number | null {
  const a = toXY(rows[i - 1]); // 断档前的最后一点
  const b = toXY(rows[i]);
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const t0 = rows[i - 1].timestamp ?? 0;
  const t1 = rows[i].timestamp ?? 0;
  // 向前回看窗口内最早的点：方向 = 参照点 → a
  let j = i - 1;
  while (j > 0 && t0 - (rows[j - 1].timestamp ?? 0) <= GAP_HEADING_SEC * 1000) j--;
  // 向后看窗口内最晚的点：方向 = b → 参照点
  let k = i;
  while (k < rows.length - 1 && (rows[k + 1].timestamp ?? 0) - t1 <= GAP_HEADING_SEC * 1000) k++;
  const perp = (R: { x: number; y: number }, fromA: boolean) => {
    const ux = fromA ? a.x - R.x : R.x - b.x;
    const uy = fromA ? a.y - R.y : R.y - b.y;
    const norm = Math.hypot(ux, uy);
    if (norm < 1) return null; // 参照段几乎零位移：方向不可信
    return Math.abs(vx * (uy / norm) - vy * (ux / norm));
  };
  // 两侧参照都要成立（缺参照 = 贴着起点、或上一步本身就是断档、或参照弦零位移）：
  // 拿不准就返回 null 不判，保留连线，别在正常的线上挖洞
  const pre = j < i - 1 ? perp(toXY(rows[j]), true) : null;
  const post = k > i ? perp(toXY(rows[k]), false) : null;
  return pre != null && post != null ? Math.min(pre, post) : null;
}

/** 一处采样断档：该步的实测位移 vs 按自己的节奏所能走出的距离 */
export interface GapStep {
  /** 落点在点数组里的下标 */
  index: number;
  /** 实测位移（米） */
  distM: number;
  /** 采样间隔（秒） */
  dtSec: number;
  /** 这段时间按全轨迹中位步速能走出的距离（米） */
  plausibleM: number;
  /** 虚高部分（米）= distM - plausibleM */
  overM: number;
}

export interface GapStepReport {
  steps: GapStep[];
  medDt: number;
  medSpeed: number;
  /** 断档步实测位移合计（米） */
  chordM: number;
  /** 断档步按中位步速应有的距离合计（米） */
  plausibleM: number;
  /** 虚高合计（米） */
  overM: number;
}

/**
 * 判「采样断档步」：只看前两条判据（间隔被拉长 + 位移超出该间隔能走出的距离）。
 * 这是**距离口径**用的：位置被报到前面，那段地面人当时没到过，里程却照记了。
 * 视觉断线要在这之上再加第三条横向闸门（见 markGapJumps）——沿跑道把弯切了的步
 * 线是贴着自己的轨迹的，不该断，但它的虚高照样要算。
 */
export function detectGapSteps<T extends GapPointLike>(points: T[]): GapStepReport {
  const rows = points ?? [];
  const n = rows.length;
  const empty: GapStepReport = { steps: [], medDt: 0, medSpeed: 0, chordM: 0, plausibleM: 0, overM: 0 };
  if (n < 3) return empty;

  const secs: number[] = [];
  const speeds: number[] = [];
  for (let i = 1; i < n; i++) {
    const dt = ((rows[i].timestamp ?? 0) - (rows[i - 1].timestamp ?? 0)) / 1000;
    if (dt > 0) {
      secs.push(dt);
      speeds.push(haversineDistance(rows[i - 1], rows[i]) / dt);
    }
  }
  const medDt = median(secs);
  const medSpeed = median(speeds);
  if (!secs.length || medSpeed <= 0) return empty;

  const minSec = Math.max(medDt * GAP_SEC_MULT, GAP_MIN_SEC);
  const steps: GapStep[] = [];
  for (let i = 1; i < n; i++) {
    const dtSec = ((rows[i].timestamp ?? 0) - (rows[i - 1].timestamp ?? 0)) / 1000;
    if (dtSec < minSec) continue;
    const distM = haversineDistance(rows[i - 1], rows[i]);
    if (distM <= Math.max(GAP_MIN_M, medSpeed * dtSec * GAP_DIST_MULT)) continue;
    const plausibleM = medSpeed * dtSec;
    steps.push({ index: i, distM, dtSec, plausibleM, overM: Math.max(0, distM - plausibleM) });
  }
  return {
    steps,
    medDt,
    medSpeed,
    chordM: steps.reduce((a, s) => a + s.distM, 0),
    plausibleM: steps.reduce((a, s) => a + s.plausibleM, 0),
    overM: steps.reduce((a, s) => a + s.overM, 0),
  };
}

/**
 * 标记断档连线（不改点序、不改坐标、不删点，只加/清 gapJump 标记）
 * 入参上已有的 gapJump 一律先清再按本次结果重标，所以可重复跑（回填、重跑纠偏不会累积）。
 */
export function markGapJumps<T extends GapPointLike>(points: T[]): GapResult<T> {
  const rows = (points ?? []).map((p) => {
    const copy = { ...p } as T & { gapJump?: true };
    delete copy.gapJump;
    return copy;
  });
  const det = detectGapSteps(rows);
  let gaps = 0;
  let gapM = 0;
  for (const s of det.steps) {
    // 第 3 道闸：只有"横着离开走廊"的位移才值得断线；沿跑道把弯切了的那条弦照画
    const cross = crossOffsetM(rows, s.index);
    if (cross == null || cross <= Math.max(GAP_CROSS_MIN_M, s.plausibleM * GAP_CROSS_MULT)) continue;
    rows[s.index].gapJump = true;
    gaps += 1;
    gapM += s.distM;
  }
  return { points: rows, gaps, gapM };
}
