/**
 * 表现分（Performance Index）：ITRA 风格幂律评分的社区逆向模型，
 * 常量与等级线移植自 TrailCraft（github.com/fasssoulpan/trailcraft）core/perf/score.ts
 * 的 commit 5 refit（C=77.9 / K=0.850 / M=0.155，M/K=0.182 落在 Riegel 耐力
 * 模型的生理合理带 [0.10, 0.20] 内）。
 *
 *   PI = min(1000, round(77.9 × (kme/小时)^0.85 × (kme/270)^0.155))
 *   kme（公里效率）= 距离km + 爬升m/100（+ 下降m/150）
 *
 * 本实现为 v1 口径：不含下降项（落库未存下降累计），等价于 TrailCraft 的
 * spiRawScore；引入下降累计后可升级为 kmeV2。envFactor（环境补偿）取 1。
 *
 * 标定锚点（TrailCraft 用崇礼 168 / 2025 UTMB 周各 组别冠军回归拟合）：
 *   平地锚点 92km/186m 爬升 /12.75h → ~361（中等）
 *   2025 UTMB 男子 174km/10000m/19.32h → ~744（精英级，封顶 1000 不可达）
 *
 * 等级线：680 精英级 / 500 优秀 / 380 良好 / 200 中等 / 其余 入门。
 * 仅对"类跑步"运动类型有意义（步行/徒步/登山/跑步）；骑行/游泳的速度- effort
 * 换算完全是另一种生理学，不适用。
 */

export const PERF_C = 77.9;
export const PERF_K = 0.85;
export const PERF_M = 0.155;
/** 参考公里效率：UTMB 经典 ~270 km-effort（170km + 10000m 爬升/100） */
export const PERF_KME_REF = 270;

export const PERF_LEVELS: { threshold: number; label: string }[] = [
  { threshold: 680, label: '精英级' },
  { threshold: 500, label: '优秀' },
  { threshold: 380, label: '良好' },
  { threshold: 200, label: '中等' },
  { threshold: 0, label: '入门' },
];

/** 表现分适用的运动类型（类跑步的 effort 换算；骑行/游泳不适用） */
export const PERF_RUN_LIKE = new Set(['running', 'walking', 'hiking', 'mountaineering']);

/** 最低门槛：短于 1km / 快走几分钟的轨迹算出的分数没有意义 */
const PERF_MIN_DISTANCE_M = 1000;
const PERF_MIN_DURATION_SEC = 300;

export interface PerfScore {
  score: number;
  level: string;
}

/**
 * 由已落库指标计算表现分（不需要轨迹点）。
 * @returns 数据不足/不适用返回 null（骑行游泳、距离时长过短、无爬升时 kme 仍可计算，
 *          但爬升为 0 且距离过短的组合一律 null）
 */
export function calcPerfScore(type: string, distanceM: number, ascentM: number, durationSec: number): PerfScore | null {
  if (!PERF_RUN_LIKE.has(type)) return null;
  if (!(distanceM >= PERF_MIN_DISTANCE_M) || !(durationSec >= PERF_MIN_DURATION_SEC)) return null;
  const kme = distanceM / 1000 + ascentM / 100;
  const hours = durationSec / 3600;
  if (!(kme > 0) || !(hours > 0)) return null;
  const speed = kme / hours;
  const lengthFactor = (kme / PERF_KME_REF) ** PERF_M;
  const score = Math.round(Math.min(PERF_C * speed ** PERF_K * lengthFactor, 1000));
  const level = PERF_LEVELS.find((l) => score >= l.threshold)!.label;
  return { score, level };
}
