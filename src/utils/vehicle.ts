import { haversineDistance, type TrackPointLike } from './pace.js';
import { TYPE_CONFIGS, DEFAULT_TYPE_CONFIG } from './trajectory-clean.js';

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
 *
 * 单步可疑速度（补盲区）：老版本端上会把超物理上限的点整批丢掉，跳变以"贴近上限的步速"
 * 残存下来（如步行轨迹里 300m/30s=10m/s 的恢复步）；短途被运载（<60s）持续判据也够不着。
 * 这类步按 **单步速度 ≥ minHighSpeed**（与轨迹清洗器的单侧高速跳下限同源：
 * walking/hiking/mountaineering 7、running 10，都在人类单步冲刺之上）直接标 vehicle，
 * 不需要持续时长佐证。骑行豁免——50km/h 下坡对骑行是正常速度，与持续判据的豁免口径一致。
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

/**
 * 各类型「可持续均速上限」（m/s）：判据是「世界级选手可持续、业余不可能」——
 * 跑步 6.5（马拉松纪录均速级）、步行类 2.2（竞走级）、骑行 11.5（41km/h 职业环法均速级）。
 * 消费方（口径同源，改这里一处即可）：
 * 1) 巨步弦（dt>120s 的长断档）：弦速超过它是「被运载」而不是本运动——实测 2026-10-26：
 *    - dev 步行轨迹 212s 只移 3.9m（0.02m/s）与 126s 移 108m（0.86m/s）：室内信号差，
 *      旧规则只看时间就标 vehicle，白吞 338s 时长；
 *    - 线上骑行 358s 移 3805m（10.6m/s = 38km/h）：**真实骑行**速度，按 2.0 一刀切会误标 77min；
 *      骑行上限 11.5 m/s（41km/h）正好放行这种合法高速骑行、拦住 45km/h+ 的机动车。
 * 2) driftScore 的均速合理性项（utils/drift-score.ts 复用本表）。
 */
export const SUSTAINED_SPEED_CEIL_MPS: Record<string, number> = {
  // 步行/徒步/登山一律用跑步上限（23.4km/h）：产品上「步行」类目允许跑步速度
  // （2026-10-26 用户拍板）——按 7.9km/h 判罚会把快走/慢跑误伤成异常轨迹。
  // 真正不可能的速度（>23.4km/h 的步行）仍由 driftScore 的斜率罚分拦住。
  walking: 6.5,
  hiking: 6.5,
  mountaineering: 6.5,
  running: 6.5,
  swimming: 2.0,
  // cycling 不再设上限：骑行可能是自行车也可能是摩托车，不做速度追责（用户拍板）；
  // 未配置 = driftScore 跳过均速项
};
export const SUSTAINED_SPEED_CEIL_DEFAULT_MPS = 8;
/** 中短断档收紧下限（秒）：30 < dt ≤ 120 的步允许速度降到 gapSpeed——
 *  三级阶梯的中档：≤30s 走现行单步/持续判据，>120s 巨步弦无条件标，30-120s 之间
 *  信号刚恢复的首个 fix 不可信、但又够不着巨步弦门槛，地铁进出站就落在这一档 */
export const GAP_TIGHTEN_MIN_SEC = 30;


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
 * 标记来源取**并集**：端上实时标的坐车步（折算速度超类型上限，见小程序 tracker）原样保留，
 * 本函数只增不删——清掉重判会把孤立超速步漏回去（持续判据 ≥60s/≥5 步对单步永不命中）。
 * 本函数自己判的速度带是 6.5 m/s–类型上限之间的持续乘车段。
 * 时长/位移/段数口径统一按最终标记结算（检测段 + 预标记一起算）。
 */
export function markVehicle<T extends TrackPointLike>(points: T[], type?: string): VehicleResult<T> {
  const out = (points ?? []).map((p) => ({ ...p }) as T & { vehicle?: boolean });

  if (type && VEHICLE_TYPES.includes(type)) {
    const minHighSpeed = (TYPE_CONFIGS[type] ?? DEFAULT_TYPE_CONFIG).minHighSpeed;
    let runFrom = -1; // 当前高速段起始点下标
    let endTo = -1; // 最后一个高速步的终点——收尾时以它为准，不把段尾的慢跑算进车程
    let endSec = 0;
    let runFastSteps = 0;
    let pendingSlow = 0; // 末尾拖着几个慢步还没定性（等灯 vs 人真的又开始动了）
    let runSec = 0;

    const close = () => {
      if (runFrom >= 0 && endSec >= VEHICLE_MIN_SEC && runFastSteps >= VEHICLE_MIN_STEPS) {
        for (let k = runFrom + 1; k <= endTo; k++) out[k].vehicle = true;
      }
      runFrom = -1;
      endTo = -1;
      endSec = 0;
      runFastSteps = 0;
      pendingSlow = 0;
      runSec = 0;
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
        // 单步可疑速度（≥minHighSpeed）：无需持续时长佐证，直接标（见文件头"单步可疑速度"）
        if (dist / dt >= minHighSpeed) out[i].vehicle = true;
        if (runFrom < 0) runFrom = i - 1;
        runSec += dt;
        runFastSteps++;
        pendingSlow = 0;
        endTo = i;
        endSec = runSec;
        continue;
      }
      if (!usable || runFrom < 0 || pendingSlow >= VEHICLE_MAX_SLOW_STEPS) {
        close();
        continue;
      }
      // 慢步先挂在段尾：车在路口让一下仍算同一趟，超过额度就是人又自己在动了
      runSec += dt;
      pendingSlow++;
    }
    close();
  }

  // 巨步弦（隧道/地下车库/移动到家等长时间无定位后的重现点）：单步间隔远超采样节奏（>120s），
  // 意味着这段完全没有任何采样，落点间直线是被运载/凭空连出来的 → 标 vehicle：
  // 灰线渲染、距离与时长都不计入（与端上 tracker 的 chord 标记同口径）。
  // 持续判据只管"开着记录坐车"，这里管"关着被运过去"；任何运动类型都评（坐车不分类型）。
  // 不跨 pauseGap：暂停时长已由 pausedMs 扣过，再剔就是双扣。
  //
  // 位移闸门 + 双向权威（2026-10-26）：dt>120 的步一律按弦速重定——只看时间会把「室内信号差、
  // 人几乎原地站着」的长空窗当乘车（实测 212s/3.9m 被吞整段时长）。慢于 CHORD_VEHICLE_MIN_MPS
  // 的步不仅不新标，还要**清除**已有标记（旧规则或旧版端上标的同一误判；只有这一档能安全清：
  // 端上 overSpeed 标的步弦速必 > maxAbsSpeed，gapTighten 只管 30<dt≤120，都不会被误清）。
  // 骑行整体豁免（产品决策 2026-10-26：骑行可能是自行车也可能是摩托车，不做速度追责）——
  // 距离/时长一律不扣，是否进榜交给 driftScore 门禁。
  const ceilMps = type === 'cycling' ? null : SUSTAINED_SPEED_CEIL_MPS[type ?? ''] ?? SUSTAINED_SPEED_CEIL_DEFAULT_MPS;
  for (let i = 1; ceilMps != null && i < out.length; i++) {
    if (out[i].pauseGap) continue;
    const a = out[i - 1];
    const b = out[i];
    if (typeof a.timestamp !== 'number' || typeof b.timestamp !== 'number') continue;
    const dt = (b.timestamp - a.timestamp) / 1000;
    if (dt <= VEHICLE_MAX_STEP_SEC) continue;
    // 弦速超过本类型的「可持续均速上限」才是被运载（同类型合法高速放行，见上表注释）
    if (haversineDistance(a, b) / dt > ceilMps) b.vehicle = true;
    else if (b.vehicle) delete (b as { vehicle?: boolean }).vehicle;
  }

  // 中短断档收紧（30 < dt ≤ 120，三级阶梯中档）：地铁进出站的典型形态——站厅到站台
  // 30-60s 丢信号后一步跳几百米，速度落在现行单步判据（minHighSpeed）与类型上限之间
  // 的空档里（如步行 60s 跳 400m = 6.7m/s，双标都够不着）。收紧到 gapSpeed：
  // 人无法以该速度持续 30s+（均为世界纪录级），地铁/车载任意断档时长都远超它。
  // 只对配置了 gapSpeed 的类型生效：不配置 = 豁免（骑行下坡/巡航合法速度与乘车重叠；
  // 未知类型走现行规则）；游泳虽不在 VEHICLE_TYPES（持续判据的人力类型集）里，
  // 但配置了 gapSpeed 就参与中档收紧。不跨 pauseGap：暂停恢复首点豁免（时长已由
  // pausedMs 扣过，再剔双扣）。
  // ⚠️ 与端上 tracker.js 的 gapTighten 判定同口径（GAP_TIGHTEN_MIN_SEC / gapSpeed 同源），改一处必须同步。
  const gapSpeed = (type ? (TYPE_CONFIGS[type] ?? DEFAULT_TYPE_CONFIG).gapSpeed : undefined) ?? undefined;
  if (gapSpeed != null) {
    for (let i = 1; i < out.length; i++) {
      if (out[i].vehicle || out[i].pauseGap) continue;
      const a = out[i - 1];
      const b = out[i];
      if (typeof a.timestamp !== 'number' || typeof b.timestamp !== 'number') continue;
      const dt = (b.timestamp - a.timestamp) / 1000;
      if (dt <= GAP_TIGHTEN_MIN_SEC || dt > VEHICLE_MAX_STEP_SEC) continue;
      if (haversineDistance(a, b) / dt > gapSpeed) b.vehicle = true;
    }
  }

  // 时长/位移/段数按最终标记统一结算（检测段 + 端上预标记 + 巨步弦的并集），逐「入段步」累加
  let vehicleMs = 0;
  let vehicleM = 0;
  let spans = 0;
  let inRun = false;
  for (let i = 1; i < out.length; i++) {
    if (!out[i].vehicle) {
      inRun = false;
      continue;
    }
    const a = out[i - 1];
    const b = out[i];
    const dtMs =
      typeof a.timestamp === 'number' && typeof b.timestamp === 'number' ? b.timestamp - a.timestamp : 0;
    vehicleMs += Math.max(0, dtMs);
    vehicleM += haversineDistance(a, b);
    if (!inRun) spans++;
    inRun = true;
  }
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

/** 非运动段的分类（2026-10-26 用户拍板：按「是否直线」分语文，不是全局改名）：
 * - 'vehicle'（疑似搭车）：被运载时轨迹基本是**直线**（净位移 / 路径长 接近 1）；
 * - 'drift'（疑似定位漂移）：室内弱信号、GPS 噪声基本**不是直线**（来回跳、折返）。
 * 辅助条件（防单步大跳误判为搭车）：净位移 ≥ 200m 且持续 ≥ 30s。
 * dev 库实测标定：
 *   真搭车（8m/s×180s 构造）直线度 1.00 / 净位移 1424m / 178s；
 *   来回跳漂移（±80m 交替）直线度 0.00 / 净位移 0m；
 *   室内漂移（Redmi Android 15 实测）6 段直线度 0.65/0.14/0/0/0/1.0，净位移均 < 175m。
 * 注：单个标记点（n=1）测不出直线度 → 按漂移处理（孤立尖点不是搭车）。 */
export const VEHICLE_SEGMENT_MIN_NET_M = 200;
export const VEHICLE_SEGMENT_MIN_SEC = 30;
/** 直线度下限：净位移 / 路径长 ≥ 该值才算「被运载」（0.85 是实测两类之间的空档） */
export const VEHICLE_SEGMENT_MIN_STRAIGHT = 0.85;

export type NonSportKind = 'vehicle' | 'drift';

export interface NonSportSegment {
  kind: NonSportKind;
  /** 段内各步弦长之和（米，与被剔除的 vehicleM 同口径） */
  pathM: number;
  /** 首末点直线净位移（米） */
  netM: number;
  /** 直线度 = netM / 标记点串起来的路径长（0~1，1 = 笔直） */
  straight: number;
  /** 段时长（秒） */
  sec: number;
  /** 段内步数 */
  steps: number;
}

const tsNum = (p: TrackPointLike): number | null =>
  typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? p.timestamp : null;

/** 相邻标记点间隔超过该秒数视为两个独立事件（不跨断档聚合，否则直线度会被长空窗污染） */
const NON_SPORT_CLUSTER_GAP_SEC = 30;
/** 两个标记点之间夹的未标记点数 ≥ 该值也算两个独立事件：
 *  采样密（2~6s/点）时，夹着 5 个以上正常点说明中间人在正常走，不该并进同一段
 *  （实测夹具：搭车段后步行 60s 再接漂移段，只按时间合并会把两类混成一段、直线度被拉低） */
const NON_SPORT_CLUSTER_MAX_GAP_POINTS = 5;

/**
 * 把 vehicle 标记点聚成「事件段」，并按直线度归类为搭车 / 漂移。
 * 纯几何分类：不改标记、不影响指标，只决定文案怎么说。
 * 聚合口径：标记点在时间上间隔 ≤120s 归同一段（漂移的标记点之间常夹着正常点，
 * 按「连续标记步」切会碎成单点段、测不出直线度）。
 */
export function classifyNonSportSegments(points: TrackPointLike[] | undefined): NonSportSegment[] {
  const pts = points ?? [];
  const out: NonSportSegment[] = [];
  // entry = 进入该段的那个点（首个标记步的前一点）：单步段的净位移要从它量起，
  // 否则「首末都是同一个标记点」会算出 netM=0，被误归为漂移
  type Acc = { entry: TrackPointLike; last: TrackPointLike; pathM: number; chordM: number; sec: number; steps: number };
  let cur: Acc | null = null;

  const flush = () => {
    if (!cur) return;
    const netM = haversineDistance(cur.entry, cur.last);
    const straight = cur.steps >= 2 && cur.chordM > 0 ? netM / cur.chordM : 0;
    // 单步段（steps=1，典型是巨步弦）测不出直线度：按「位移够大 + 撑得起时间」兜底判搭车
    // （实测 47d88a 徒步轨迹一个 300s 单步跨 3km，明显被运载，不能因为没直线度就说是漂移）
    const straightOk = cur.steps >= 2 ? straight >= VEHICLE_SEGMENT_MIN_STRAIGHT : true;
    const kind: NonSportKind =
      straightOk && netM >= VEHICLE_SEGMENT_MIN_NET_M && cur.sec >= VEHICLE_SEGMENT_MIN_SEC ? 'vehicle' : 'drift';
    out.push({ kind, pathM: cur.pathM, netM, straight, sec: cur.sec, steps: cur.steps });
    cur = null;
  };

  let lastMarkedIdx = -1;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (!b?.vehicle) continue;
    const ta = tsNum(a);
    const tb = tsNum(b);
    const dt = ta != null && tb != null ? Math.max(0, (tb - ta) / 1000) : 0;
    const stepM = haversineDistance(a, b);
    // 与上一个标记点隔太久、或中间夹了太多正常点（或还没有段）→ 收尾重开
    if (cur) {
      const lastTs = tsNum(cur.last);
      const gap = lastTs != null && tb != null ? (tb - lastTs) / 1000 : Infinity;
      // i - lastIdx - 1 = 两个标记点之间的未标记点数
      const gapPoints = i - lastMarkedIdx - 1;
      if (!(gap <= NON_SPORT_CLUSTER_GAP_SEC) || gapPoints >= NON_SPORT_CLUSTER_MAX_GAP_POINTS) flush();
    }
    if (!cur) cur = { entry: a, last: b, pathM: 0, chordM: stepM, sec: 0, steps: 0 };
    else cur.chordM += haversineDistance(cur.last, b);
    cur.last = b;
    cur.pathM += stepM;
    cur.sec += dt;
    cur.steps += 1;
    lastMarkedIdx = i;
  }
  flush();
  return out;
}

export function formatVehicleNotice(
  points: TrackPointLike[] | undefined,
  vehicleMs?: number,
  vehicleM?: number,
): string {
  // 脏数据保护：有标记但没量（时长 0），不编一句话出来
  if (countVehicleSpans(points) <= 0 || Math.round((vehicleMs ?? 0) / 1000) <= 0) return '';

  const segs = classifyNonSportSegments(points);
  if (segs.length === 0) return '';

  // 总量以**存储的 vehicleM** 为准（那是真被剔除的距离，与指标同口径）；
  // 几何分类只决定这句话怎么拆开说。两者不一致时按比例分摊，不改变总距离。
  const computedTotal = segs.reduce((sum, s) => sum + s.pathM, 0);
  const totalM = (vehicleM ?? 0) > 0 ? (vehicleM as number) : computedTotal;
  const carPathM = segs.filter((s) => s.kind === 'vehicle').reduce((sum, s) => sum + s.pathM, 0);
  const driftPathM = segs.filter((s) => s.kind === 'drift').reduce((sum, s) => sum + s.pathM, 0);
  const share = (part: number) => (computedTotal > 0 ? (totalM * part) / computedTotal : 0);
  const carM = share(carPathM);
  const driftM = share(driftPathM);

  const km = (m: number) => (m / 1000).toFixed(2);
  // 四舍五入到厘米后仍可能有一侧变 0（极短段）：只有真为 0 才省略该类
  const carText = km(carM);
  const driftText = km(driftM);
  if (Number(carText) > 0 && Number(driftText) > 0) {
    return `约 ${carText} 公里疑似搭车、${driftText} 公里疑似定位漂移，未计入`;
  }
  if (Number(carText) > 0) return `约 ${carText} 公里疑似搭车，未计入`;
  return `约 ${driftText} 公里疑似定位漂移，未计入`;
}
