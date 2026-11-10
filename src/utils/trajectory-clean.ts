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
  /** GPS 水平精度（米，客户端上报）：差精度点（≥ ACC_BAD_M）触发加严离群判定；缺失走现行规则 */
  accuracy?: number | null;
  timestamp?: number;
  seq?: number;
  /** 非运动步标记（端上实时超速 / 服务端检测）：带标记的点清洗时保护，不剔除 */
  vehicle?: boolean;
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

/** 按运动类型的阈值配置（决策：不同运动速度特征差异大，统一阈值会误杀） */
export interface TypeConfig {
  /** 尖刺速度下限（m/s）：低于该值不判尖刺 */
  minSpikeSpeed: number;
  /** 绝对超速（m/s）：物理不可能上限 */
  maxAbsSpeed: number;
  /** 单侧高速下限（m/s）：相对局部速度判定的绝对基线 */
  minHighSpeed: number;
  /** 中短断档（30s < dt ≤ 120s）收紧阈值（m/s）：信号刚恢复的首个 fix 不可信，
   *  允许速度从类型上限收紧到该值——人无法以该速度持续 30s+（均为世界纪录级），
   *  而地铁/车载任意断档时长都远超它（地铁 30s ≥ 500m）。
   *  不配置 = 该类型豁免（骑行下坡/巡航 10-15m/s 合法速度与乘车重叠，与持续判据豁免同口径）。
   *  ⚠️ 与小程序 tracker.js#TYPE_TRACKER_CONFIG.gapSpeed 两端同值，改一处必须同步另一处。 */
  gapSpeed?: number;
}

export const TYPE_CONFIGS: Record<string, TypeConfig> = {
  // 步行/徒步/登山的 gapSpeed 与「可持续均速上限」统一到跑步级 6.5（23.4km/h）：
  // 「步行」类目允许跑步速度（2026-10-26 用户拍板），按 4.0（14.4km/h = 慢跑）判会把
  // 慢跑速度的断档误标成被运载。地铁 60s/400m = 6.7m/s 仍高于 6.5，照旧能抓到。
  walking: { minSpikeSpeed: 5, maxAbsSpeed: 12, minHighSpeed: 7, gapSpeed: 6.5 },
  hiking: { minSpikeSpeed: 5, maxAbsSpeed: 12, minHighSpeed: 7, gapSpeed: 6.5 },
  mountaineering: { minSpikeSpeed: 5, maxAbsSpeed: 12, minHighSpeed: 7, gapSpeed: 6.5 },
  running: { minSpikeSpeed: 8, maxAbsSpeed: 18, minHighSpeed: 10, gapSpeed: 6.5 }, // 跑步 ~3-5m/s，冲刺 8m/s；6.5 = 2'34"/km 省队级
  cycling: { minSpikeSpeed: 12, maxAbsSpeed: 30, minHighSpeed: 14 }, // 骑行 ~8m/s，冲刺 12m/s，下坡可 25m/s；gapSpeed 不配置 = 豁免
  swimming: { minSpikeSpeed: 3, maxAbsSpeed: 8, minHighSpeed: 5, gapSpeed: 3.0 }, // 游泳 ~1.5m/s；3m/s 公开水域世界级
};

export const DEFAULT_TYPE_CONFIG: TypeConfig = {
  minSpikeSpeed: 5,
  maxAbsSpeed: 25,
  minHighSpeed: 7,
};

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
  /** 是否启用「起始稳定」剔除（默认 true；对比/回归时可关掉） */
  startFix?: boolean;
}

/** —— 精度因子（accuracy）加严判定 ——
 * accuracy 是 GPS 上报的水平精度圈半径：值越大，该点真实位置的可疑偏移幅度越大。
 * 好精度（< ACC_BAD_M）走现行规则零影响；缺失（旧数据/导入）同样不受影响。 */
/** 差精度阈值（米）：≥ 该值的点触发加严离群判定 */
export const ACC_BAD_M = 50;
/** 差精度点离群距离系数：点偏离前后连线中点 > accuracy × 该系数 即判漂移 */
export const ACC_OUTLIER_FACTOR = 1.0;

/** 起始稳定阈值（accuracy 米）：开头连续丢点，直到出现第一个 accuracy < 该值的可信定位（2026-11-10）。
 *  背景：录制开始时 GPS 未收敛（冷启动漂移），前几秒坐标能甩出几百米且多带 accBad/vehicle
 *  标记——现行规则因 vehicle 保留语义不会剔它们，导致轨迹开头飞到河里/楼里。
 *  取 50 而不取 30 的理由（本地 1139 条已完成轨迹 dry-run）：
 *  - 30m：影响 24.1%（274 条）——大量轨迹首点 accuracy 恰为 30~35，属于「可用」却被剔，属过度修饰；
 *  - 50m：影响 0.4%（4 条），且与清洗器既有的 ACC_BAD_M = 50「差精度」定义同口径；
 *  - 两条真实问题轨迹（开头 62/161/136/95 与 242×3）在 50m 阈值下都能完整修好。 */
export const START_FIX_M = 50;
/** 起始剔除上限（个）：室内全程差精度时最多剔前 10 个连续点，剩余保留（室内运动合法） */
export const START_TRIM_MAX = 10;

/**
 * 轨迹纠偏：剔除尖刺点与孤立离群点（保持首尾）
 * @returns 清洗后的点数组（剔除点被移除，其余保持顺序）
 */
export function cleanTrajectory<T extends CleanTrackPoint>(
  points: T[],
  opts: CleanOptions = {},
  type?: string,
): T[] {
  const typeCfg = (type && TYPE_CONFIGS[type]) || DEFAULT_TYPE_CONFIG;
  const {
    minSpikeSpeed = typeCfg.minSpikeSpeed,
    spikeRatio = 3.5,
    minTurnDeg = 100,
    minOutlierM = 25,
    outlierRatio = 5,
    startFix = true,
  } = opts;
  const maxAbsSpeed = typeCfg.maxAbsSpeed;
  const n = points.length;
  if (n < 4) return points;

  const drop = new Array<boolean>(n).fill(false);

  // 局部相邻位移中位数（首尾跳点判定基准；窗口全轨迹 ±5 点）
  const stepDists: number[] = [];
  for (let j = 1; j < n; j++) {
    stepDists.push(distM(points[j - 1], points[j]));
  }
  const sortedSteps = stepDists.slice().sort((x, y) => x - y);
  const medStep = sortedSteps.length > 0 ? sortedSteps[Math.floor(sortedSteps.length / 2)] : 0;

  // 首点跳（起点 GPS 未收敛，实测 29m）：首段距离远超局部步长 → 剔首点
  if (n >= 3 && stepDists.length >= 2 && stepDists[0] > Math.max(12, medStep * 4)) {
    drop[0] = true;
  }
  // 尾点跳：末段距离远超局部步长 → 剔尾点
  if (n >= 3 && stepDists.length >= 2 && stepDists[stepDists.length - 1] > Math.max(12, medStep * 4)) {
    drop[n - 1] = true;
  }

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

    // 2) 绝对超速（物理不可能，如 70m/s）：前后两段都超上限（按类型，如骑行 30m/s/跑步 18m/s）才是孤立漂移点；
    //    单段超速由规则 3 相对判定（避免级联误剔超速段的正常邻居）
    if (v1 > maxAbsSpeed && v2 > maxAbsSpeed) {
      drop[i] = true;
      continue;
    }

    // 3) 单侧高速跳：一侧远超局部速度（同向高速/跳出又跳回），另一侧也不算慢 → 剔除
    //    实测模式：17m/s 同向跳、26m 跳出 + 6.5m/s 跳回
    const highV = Math.max(typeCfg.minHighSpeed, med * 4);
    const lowV = Math.max(3, med * 1.5);
    if ((v1 > highV || v2 > highV) && Math.min(v1, v2) > lowV) {
      drop[i] = true;
      continue;
    }

    // 3.5) 差精度点加严（accuracy 因子）：自身上报精度 ≥ ACC_BAD_M 的点，位置可信度低，
    //      偏离前后连线中点超过 accuracy 本身即判漂移——不再要求"高速/大转角"双条件。
    //      盲区堵漏：连续同向偏移、速度正常的坏点（现行规则看不见）由此剔除。
    const acc = (b as { accuracy?: number | null }).accuracy;
    if (acc != null && acc >= ACC_BAD_M) {
      const mid = { lat: (a.lat + c.lat) / 2, lng: (a.lng + c.lng) / 2 };
      if (distM(b, mid) > acc * ACC_OUTLIER_FACTOR) {
        drop[i] = true;
        continue;
      }
    }

    // 4) 孤立离群：距前后连线远（绝对 + 相对局部尺度）且两侧位移均不小 → 剔除
    const distLine = pointToSegmentDistM(b, a, c);
    const outlierTh = Math.max(minOutlierM, med * outlierRatio);
    if (distLine > outlierTh && d1 > 15 && d2 > 15) {
      drop[i] = true;
    }
  }

  // 端上/上游已标记的非运动步（vehicle）是刻意保留的原始点：清洗剔除它会让相邻两步
  // 直连、被剔位移重新计入距离（标记语义失效）。清洗只动未标记的点。
  for (let i = 0; i < n; i++) {
    if (drop[i] && points[i].vehicle) drop[i] = false;
  }

  // 起始稳定（2026-11-10）：开头 GPS 未收敛的漂移段整段剔除，直到第一个可信定位
  // （accuracy < START_FIX_M）。缺失 accuracy 的点（旧数据/导入）视为可信、不剔除。
  // 注意这一步在 vehicle 保留**之后**执行：开头的漂移点即使带 vehicle 标记也剔
  // （冷启动阶段谈不上"乘车语义"，保留只会让轨迹起点飞到河里）。
  //
  // 室内/弱信号场景（全程 accuracy ≥ 30）的保护：
  // 1) 找不到任何可信定位 → 一个都不剔（室内运动是合法轨迹，整段保留）；
  // 2) 有可信定位时，最多只剔前 START_TRIM_MAX(=10) 个连续坏点，且至少保留 2 点。
  // 起始稳定开关关闭时直接返回（仅用于对比实验/回归）
  if (!startFix) return points.filter((_, i) => !drop[i]);

  // 1) 先找第一个可信定位（没有则视为「全程弱信号」，不做起始剔除）
  let firstGoodIdx = -1;
  for (let i = 0; i < n; i++) {
    const acc = points[i].accuracy;
    if (acc == null || acc < START_FIX_M) { firstGoodIdx = i; break; }
  }
  // 2) 剔除量 = min(开头坏点个数, 上限 10, 保留至少 2 点)
  //    室内/弱信号（firstGoodIdx === -1）→ trimCount = 0：整段都是真实轨迹，一个都不剔。
  const keepMin = 2; // 至少保留起终点两点，避免剔成单点/空轨迹
  const trimCount = firstGoodIdx > 0
    ? Math.min(firstGoodIdx, START_TRIM_MAX, Math.max(0, n - keepMin))
    : 0;
  for (let i = 0; i < trimCount; i++) drop[i] = true;

  return points.filter((_, i) => !drop[i]);
}
