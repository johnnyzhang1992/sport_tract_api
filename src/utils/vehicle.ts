import { haversineDistance, type TrackPointLike } from './pace.js';

/**
 * 非运动段（搭车/推车/坐摆渡车）检测 —— 与静止剔除相反，这里必须用**速度**判据
 *
 * 静止判据用「走不出 10m 圈」的几何量，是因为原地抖动的瞬时速度和慢走同一量级；
 * 而"人能跑多快"是有硬上界的，速度阈值在这里是干净的判据——但只在上界**加上持续时长**之后才干净。
 *
 * 为什么需要它：录制端与后端的过滤都是**尖刺**逻辑（`trajectory-clean.ts` 要求相邻两步同时超
 * 18 m/s 且折返 >110° 才丢点），直线匀速移动几百米完全不像漂移，于是「跑步途中搭车」会整段落进指标。
 * 线上实测一条 5.95km「跑步」：第 4 个 1km 有 846m 是在 118s 内推进的（24–27 km/h），
 * 中间还夹着 48s 彻底停住（设备自报速度 0），刷出 fastestKm 220.6s（3'41"）并占了全国榜「最快 1km」第一
 * —— 算术没错，语义错了。取证脚本见 scripts/tmp-prod-bands.ts、scripts/tmp-prod-envelope.ts。
 *
 * 阈值怎么定的（三件事一起兜误伤，单看任何一条都不成立）：
 *   6.5 m/s = 23.4 km/h：低于男子 1km 世界纪录均速 7.63 m/s，所以"瞬间比它快"完全可能是真冲刺；
 *   ≥60s：能跑 23.4 km/h 的人，撑不满 60 秒——6.5 m/s 持续 60s 相当于 1500m 跑 3'45"（世界纪录级）；
 *   ≥5 步：第三方 GPX 常 10s+ 一采，60s 只由 3–4 次定位凑成时证据不够（与 standstill 的 ≥3 点同理）。
 * 段内允许穿插 ≤2 个慢步：车在路口会让行/等灯，按"严格连续"判会被切成 30 秒碎段而整体漏判
 * ——这是实测出来的代价：严格连续时那段车行只剩 34s（不够门槛），允许穿插 2 步后判出 1.3km。
 * 代价（刻意接受）：慢速搭车（<23.4 km/h 的电动车）与「搭车 <60s」漏判；极限选手真做 60 秒
 * 23.4 km/h 的间歇会被误剔——宁可少判普通人的真数据，也不给榜单留假 PR。
 *
 * 只对人力运动类型生效：骑行 6.5 m/s（23 km/h）是通勤速度，滑雪、划船同理，套这条会把自己判没。
 */
/** 车速下限（m/s）：6.5 m/s = 23.4 km/h，城市车流速度 */
export const VEHICLE_MIN_SPEED_MPS = 6.5;
/** 最短持续时长（秒）：低于此的高速更像冲坡/冲刺，人也能撑到几十秒 */
export const VEHICLE_MIN_SEC = 60;
/** 最少高速步数：时长门槛靠少数粗采样点凑出来时不判（删距离又删时长，得有足够证据） */
export const VEHICLE_MIN_STEPS = 5;
/** 段内允许穿插的慢步数：等灯/让行不切断车程，再多就是人真的又开始动了 */
export const VEHICLE_MAX_SLOW_STEPS = 2;
/** 相邻点间隔超过该秒数视为采样断档，不跨断档连段（丢点后的"瞬移"不是持续移动） */
export const VEHICLE_MAX_STEP_SEC = 120;
/** 会做车速判定的类型（人力运动）；其余类型一律不判 */
export const VEHICLE_TYPES = ['running', 'walking', 'hiking', 'mountaineering'];

export interface VehicleResult<T extends TrackPointLike> {
  points: (T & { vehicle?: boolean })[];
  /** 非运动段总时长（毫秒） */
  vehicleMs: number;
  /** 非运动段总位移（米） */
  vehicleM: number;
  spans: number;
}

/**
 * 标记非运动段（不改点序、不改坐标，只加 vehicle 标记）
 *
 * 语义：点上的 vehicle = true 表示**进入该点的那一步**（上一点 → 该点）属于非运动段，
 * 因此这一步的位移与时长都不该计入 distance / duration（与 still 只剔时长不同）。
 *
 * 入参点上若已带 vehicle（回填脚本换门槛重跑时会遇到），一律先清掉再按本次结果重标。
 */
export function markVehicle<T extends TrackPointLike>(points: T[], type?: string): VehicleResult<T> {
  const out = (points ?? []).map((p) => {
    const copy = { ...p } as T & { vehicle?: boolean };
    delete copy.vehicle;
    return copy;
  });
  let vehicleMs = 0;
  let vehicleM = 0;
  let spans = 0;

  if (!type || !VEHICLE_TYPES.includes(type)) return { points: out, vehicleMs, vehicleM, spans };

  let runFrom = -1; // 当前高速段起始点下标
  let runTo = -1; // tentative 终点（含末尾挂着的慢步）
  let runSec = 0;
  let runDist = 0;
  let runFastSteps = 0;
  let pendingSlow = 0; // 末尾拖着几个慢步还没定性（等灯 vs 人真的又开始动了）
  let endTo = -1; // 最后一个高速步的终点——收尾时以它为准，不把段尾的慢跑算进车程
  let endSec = 0;
  let endDist = 0;

  const close = () => {
    if (runFrom >= 0 && endSec >= VEHICLE_MIN_SEC && runFastSteps >= VEHICLE_MIN_STEPS) {
      for (let k = runFrom + 1; k <= endTo; k++) out[k].vehicle = true;
      vehicleMs += Math.round(endSec * 1000);
      vehicleM += endDist;
      spans++;
    }
    runFrom = -1;
    runTo = -1;
    runSec = 0;
    runDist = 0;
    runFastSteps = 0;
    pendingSlow = 0;
    endTo = -1;
    endSec = 0;
    endDist = 0;
  };

  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1];
    const b = out[i];
    const hasTs = typeof a.timestamp === 'number' && typeof b.timestamp === 'number';
    const dt = hasTs ? (b.timestamp! - a.timestamp!) / 1000 : NaN;
    const dist = haversineDistance(a, b);
    // 断档与暂停恢复点都是硬边界：不跨过去连段，也不当"等灯"糊掉
    const usable = hasTs && Number.isFinite(dt) && dt > 0 && dt <= VEHICLE_MAX_STEP_SEC && !b.pauseGap;
    const fast = usable && dist / dt >= VEHICLE_MIN_SPEED_MPS;

    if (fast) {
      if (runFrom < 0) runFrom = i - 1;
      runTo = i;
      runSec += dt;
      runDist += dist;
      runFastSteps++;
      pendingSlow = 0;
      endTo = i;
      endSec = runSec;
      endDist = runDist;
      continue;
    }
    if (!usable || runFrom < 0 || pendingSlow >= VEHICLE_MAX_SLOW_STEPS) {
      close();
      continue;
    }
    // 慢步先挂在段尾：车在路口让一下仍算同一趟，超过额度就是人又自己在动了
    runTo = i;
    runSec += dt;
    runDist += dist;
    pendingSlow++;
  }
  close();

  return { points: out, vehicleMs: Math.round(vehicleMs), vehicleM: Math.round(vehicleM), spans };
}

/** 连续的 vehicle 步算一段（句子不报段数，但它是「到底有没有车速段」的判据） */
function countVehicleSpans(points: TrackPointLike[] | undefined): number {
  let spans = 0;
  let inRun = false;
  for (const p of points ?? []) {
    if (p?.vehicle) {
      if (!inRun) spans++;
      inRun = true;
    } else {
      inRun = false;
    }
  }
  return spans;
}

/**
 * 「约 X 公里疑似搭车，未计入」——整句由服务端拼好随活动下发（DTO 的 vehicleNotice），
 * 两端只渲染不自己拼：各拼一遍必然走偏（webAdmin 原先只画灰线没这句，小程序那句是本地算的）。
 * 只报距离：时长已经体现在「运动时长」比墙钟短这件事上，一句里摆两个数反而要解释谁是谁。
 * 段数不进句子（用户不关心分了几段），但仍参与判定：没有车速段就返回空串，客户端据此不渲染。
 * 单位固定公制：设置项里的「英制」目前没有任何渲染消费它，全站距离都按 km 显示。
 */
export function formatVehicleNotice(
  points: TrackPointLike[] | undefined,
  vehicleMs: number | undefined,
  vehicleM: number | undefined,
): string {
  if (countVehicleSpans(points) <= 0 || Math.round((vehicleMs ?? 0) / 1000) <= 0) {
    return '';
  }
  return `约 ${((vehicleM ?? 0) / 1000).toFixed(2)} 公里疑似搭车，未计入`;
}
