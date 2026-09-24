/**
 * 一次性回填：给已 finished 的历史活动补「非运动段（车速段）剔除」口径
 *
 * 两个入口共用本文件（逻辑只有一份，改判据不会只改一处）：
 *   - 管理端接口 POST /admin/activities/backfill-vehicle（线上跑：容器里没有 tsx，scripts/ 也不进镜像）
 *   - CLI `node --import tsx scripts/backfill-vehicle.ts`（本地/开发库跑，把报告打成文本）
 *
 * 背景：2026-09-24 起 finish 时会把「连续 ≥60s 保持 ≥6.5 m/s」的段判为搭车/推行，
 * 位移与时长一起从指标里剔掉（见 src/utils/vehicle.ts）。历史活动按旧口径入库，
 * 线上那条 5.95km「跑步」里 1.2km 是 25km/h 移动出来的、还刷出全国榜最快 1km 第一，
 * 这里按新口径重算一次。判据换门槛（6.5/7.0、60s/40s、容错穿插步数）后可直接重跑。
 *
 * 改这些字段：
 *   - trackPoints：补 vehicle 标记（同时重算 still，两段判据互斥但都要跑一遍才自洽）
 *   - vehicleMs / vehicleM / standstillMs / duration / avgPace：净时长与随之修正的平均配速
 *   - distance：剔掉车速段位移（只在「库里 distance 与重算几何总位移对得上」时才写）
 *   - fastestKm：车速步会断开 1km 窗口，必须重算，否则榜上仍是那条 3'41"
 *   - calories：时长被本次改写就要跟着重算（与 finish 同一个式子 MET × 档案体重 × 净时长）。
 *     2026-09-24 第一次线上执行时这一项漏了，36 条的消耗停在墙钟口径上偏高，
 *     所以另开 syncCalories 档补正（见下）。库里没有消耗记录（0/未落值）一律不新造。
 * 不动：elevationGain / minAltitude / maxAltitude（与时长无关）。
 *
 * 三道防误伤闸门（都只统计、不达标就跳过该字段并列出来）：
 *   1) 时长闸门用不变量 `duration + standstillMs + vehicleMs ≈ 墙钟`，而不是 `duration ≈ 墙钟`
 *      —— 后者跑过一次就不再成立，重跑会把该改的挡掉。
 *   2) fastestKm **只降不升**：回填不该顺手把人刷到更好的名次上；重算值比库里更快
 *      说明差异不是本次口径能解释的（库里那条另有来源，见 docs/04），只标记不写值。
 *   3) syncCalories **必须配 id**：库里没有任何字段记着「这条的 calories 是按墙钟还是按
 *      净时长结算的」，全量刷会把新录入的记录再折一次。只有按 id 点名（=已知被回填改过时长的行）才安全。
 */
import mongoose from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import { markVehicle } from '../utils/vehicle.js';
import { markStandstill } from '../utils/standstill.js';
import { calcFastestKm, calcStats, haversineDistance, formatPace, type TrackPointLike } from '../utils/pace.js';
import { assertObjectIdLike } from '../utils/object-id.js';
import { resolveWeightKg } from './weight.js';

/** 报告里每个清单只回前 N 条（接口要过 HTTP，全量可能几十 KB），总数另给 xxxCount 字段 */
const LIST_CAP = 50;

export interface BackfillVehicleOptions {
  /** false（默认）= 只算不写 */
  apply?: boolean;
  /** 只处理某一条 */
  id?: string;
  /** 限量，0/省略 = 不限 */
  limit?: number;
  /** 只补卡路里：时长已按新口径落库、但消耗还停在墙钟口径的行（须配 id 点名） */
  syncCalories?: boolean;
}

/** 一条记录回填前后的快照（只放会被这个口径动到的字段；after 是「闸门放行后真正会写进去的值」） */
export interface BackfillSnapshot {
  duration: number;
  distance: number;
  avgPace: number | null;
  fastestKm: number | null;
  calories: number | null;
  standstillMs: number;
  vehicleMs: number;
  stillPts: number;
  vehiclePts: number;
}

export interface BackfillChangeRow {
  id: string;
  type: string;
  /** 这条的改动是谁带来的：线上核账要用它把「车速段」和「首次静止剔除」分开算。
   *  'calories' = 时长没动、只有消耗要补正（syncCalories 档专属） */
  reason: 'vehicle' | 'standstill' | 'both' | 'calories';
  before: BackfillSnapshot;
  after: BackfillSnapshot;
}

export interface BackfillVehicleReport {
  /** 连的是哪个库：干跑也要看清自己打到了哪 */
  db: string;
  apply: boolean;
  scanned: number;
  changed: number;
  /** 会被改写的记录逐条列出（含前后快照），最多 LIST_CAP 条，总数看 changesCount */
  changes: BackfillChangeRow[];
  changesCount: number;
  vehicleCount: number;
  standstillCount: number;
  bothCount: number;
  /** 卡路里被改写的条数（与其他来源重叠，不参与上面三类相加） */
  caloriesCount: number;
  /** 只动卡路里、时长一字未动的条数（reason === 'calories'，与三类一起加回 changed） */
  caloriesOnlyCount: number;
  hits: string[];
  fastSlower: string[];
  distSkipped: string[];
  fastSkipped: string[];
  timeGateSkipped: string[];
  hitCount: number;
  fastSlowerCount: number;
  distSkippedCount: number;
  fastSkippedCount: number;
  timeGateSkippedCount: number;
}

const mmss = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};
const pace = (sec: number | null | undefined) => (sec == null ? '—' : formatPace(sec));

export async function backfillVehicle(opts: BackfillVehicleOptions = {}): Promise<BackfillVehicleReport> {
  const apply = opts.apply === true;
  const syncCalories = opts.syncCalories === true;
  const limit = Number(opts.limit ?? 0);
  // 不在这里建连接：接口侧 app 启动时已连好，CLI 侧自己 connect(config.mongodbUri)。
  // 服务里再 connect 一次会把 URI 口径分裂成两份（一份走 config、一份走环境变量默认值）。

  const filter: Record<string, unknown> = { status: 'finished', 'trackPoints.20': { $exists: true } };
  if (opts.id) filter._id = assertObjectIdLike(opts.id, '轨迹不存在');
  let q = ActivityModel.find(filter)
    .select('userId type startTime endTime pausedMs duration standstillMs vehicleMs vehicleM avgPace fastestKm distance calories trackPoints')
    .sort({ startTime: -1 });
  if (limit > 0) q = q.limit(limit);
  const acts = (await q.lean()) as any[];

  let changed = 0;
  const changes: BackfillChangeRow[] = [];
  const timeGateSkipped: string[] = [];
  const distSkipped: string[] = [];
  const fastSkipped: string[] = [];
  const fastSlower: string[] = [];
  const hits: string[] = [];

  for (const a of acts) {
    const pts = ((a.trackPoints ?? []) as TrackPointLike[]).filter(
      (p) => typeof p.timestamp === 'number' && Number.isFinite(p.timestamp),
    );
    if (pts.length < 3) continue;

    const endTime = a.endTime ?? pts[pts.length - 1].timestamp!;
    const wallSec = Math.max(0, (endTime - a.startTime - (a.pausedMs ?? 0)) / 1000);
    const accounted =
      (a.duration ?? 0) + Math.round((a.standstillMs ?? 0) / 1000) + Math.round((a.vehicleMs ?? 0) / 1000);
    if (Math.abs(accounted - wallSec) > 5) {
      timeGateSkipped.push(
        `${a._id} ${a.type} 库内=${Math.round(a.duration ?? 0)}+${Math.round((a.standstillMs ?? 0) / 1000)}+${Math.round((a.vehicleMs ?? 0) / 1000)}s 墙钟=${Math.round(wallSec)}s`,
      );
      continue;
    }

    const veh = markVehicle(pts, a.type);
    const { points: marked, standstillMs } = markStandstill(veh.points);
    const netSec = Math.max(0, wallSec - standstillMs / 1000 - veh.vehicleMs / 1000);
    const rawDist = pts.slice(1).reduce((s, p, i) => s + haversineDistance(pts[i], p), 0);

    const prevVehicleMs = Math.round(a.vehicleMs ?? 0);
    const prevVehicleM = Math.round(a.vehicleM ?? 0);
    const prevStandstillMs = Math.round(a.standstillMs ?? 0);
    const newVehicleMs = Math.round(veh.vehicleMs);
    const newStandstillMs = Math.round(standstillMs);
    const newVehiclePts = marked.filter((p) => p.vehicle === true).length;
    const prevVehiclePts = ((a.trackPoints ?? []) as TrackPointLike[]).filter((p) => p.vehicle === true).length;
    const newStillPts = marked.filter((p) => p.still === true).length;
    const prevStillPts = ((a.trackPoints ?? []) as TrackPointLike[]).filter((p) => p.still === true).length;
    const newDuration = Math.round(netSec);

    const set: Record<string, unknown> = {};
    // 换门槛重跑时旧标记必须能被冲掉，所以比的是「标记数 + 汇总值」而不是「有没有标记」
    if (
      newVehicleMs !== prevVehicleMs ||
      newStandstillMs !== prevStandstillMs ||
      newVehiclePts !== prevVehiclePts ||
      newStillPts !== prevStillPts ||
      newDuration !== Math.round(a.duration ?? 0)
    ) {
      set.trackPoints = marked;
      set.vehicleMs = newVehicleMs;
      set.vehicleM = Math.round(veh.vehicleM);
      set.standstillMs = newStandstillMs;
      set.duration = newDuration;
    }

    // 距离与平均配速直接走 finish 同一条 calcStats（它自己会跳过 vehicle 步、按类型决定要不要配速），
    // 别在回填里重排一遍四舍五入 —— 那样复跑会抖出 ±1s 的假差异，把"待更新"清单撑满
    const stats = calcStats(marked, { type: a.type, durationSec: netSec });

    // 距离：只有「库里 distance 本就等于这条轨迹的几何总位移」时才认为差异来自车速段剔除。
    // 已回填过的行库里已扣掉上一轮的 vehicleM，所以比对基准要加上它（否则重跑会把该改的挡掉）。
    const distOk = Math.abs((a.distance ?? 0) - (rawDist - prevVehicleM)) <= Math.max(3, rawDist * 0.005);
    if (veh.vehicleM > 0 && distOk) {
      if (Math.round(a.distance ?? 0) !== stats.distance) set.distance = stats.distance;
    } else if (veh.vehicleM > 0) {
      distSkipped.push(
        `${a._id} ${a.type} 库内=${Math.round(a.distance ?? 0)}m 重算几何=${Math.round(rawDist)}m 上轮已剔=${prevVehicleM}m`,
      );
    }
    // 平均配速：时长变了就得跟着变（库里本就没有配速的行不新造）
    if (a.avgPace != null && stats.avgPace != null && a.avgPace !== stats.avgPace) set.avgPace = stats.avgPace;
    if (a.avgPace != null && stats.avgPace == null) set.avgPace = null;

    // 最快 1km：**只降不升**，且库里没值就不新造（回填不该把人刷到更好的名次上，
    // 也不该让历史行凭空多出一条榜上成绩）。变慢有两种来源，分开统计便于核账：
    //   车速段断开 1km 窗口 / 静止时段改为照计时间（原来剔除，会奖励"km 中间停车"）。
    const newFast = calcFastestKm(marked, a.type);
    if (newFast != null && a.fastestKm != null) {
      if (newFast > a.fastestKm + 2) {
        set.fastestKm = Math.round(newFast * 10) / 10;
        fastSlower.push(
          `${a._id} ${a.type} ${pace(a.fastestKm)}→${pace(newFast)} ${newVehicleMs > 0 ? '车速段断开' : '静止照计'}`,
        );
      } else if (newFast < a.fastestKm - 2) {
        fastSkipped.push(`${a._id} ${a.type} 库内=${pace(a.fastestKm)} 重算=${pace(newFast)}（更快，不写）`);
      }
    }

    // 卡路里与净时长同源（MET × 档案体重 × 时长，和 finish 用的是同一个 calcStats）：
    // 时长被本次改写就必须跟着重算，否则等于按墙钟发消耗。syncCalories 档专门用来补正
    // 「上一轮 build 只改了时长、没改卡路里」的行（线上那 36 条就停在那个状态）。
    // 库里没有消耗记录（0 / 未落值）不新造——线上 100 条里 47 条是 0。
    if (a.calories != null && a.calories > 0 && (set.duration != null || syncCalories)) {
      const weightKg = await resolveWeightKg(a.userId);
      const newCalories = calcStats(marked, { type: a.type, durationSec: newDuration, weightKg }).calories;
      if (newCalories !== a.calories) set.calories = newCalories;
    }

    if (newVehicleMs > 0) {
      hits.push(
        `${a._id} ${a.type} ${(stats.distance / 1000).toFixed(2)}km 车速段 ${veh.spans} 段 ${Math.round(newVehicleMs / 1000)}s/${Math.round(veh.vehicleM)}m ` +
          `时长 ${mmss(a.duration ?? 0)}→${mmss(netSec)} 最快1km ${pace(a.fastestKm)}→${newFast == null ? '—' : pace(newFast)}`,
      );
    }
    if (Object.keys(set).length === 0) continue;
    changed++;

    const before: BackfillSnapshot = {
      duration: Math.round(a.duration ?? 0),
      distance: Math.round(a.distance ?? 0),
      avgPace: a.avgPace ?? null,
      fastestKm: a.fastestKm ?? null,
      calories: a.calories ?? null,
      standstillMs: prevStandstillMs,
      vehicleMs: prevVehicleMs,
      stillPts: prevStillPts,
      vehiclePts: prevVehiclePts,
    };
    // after 取「闸门真正放行的值」：距离/最快 1km 被闸门挡掉时，快照里就不该出现它们的假差异
    const after: BackfillSnapshot = {
      duration: (set.duration as number) ?? before.duration,
      distance: (set.distance as number) ?? before.distance,
      avgPace: 'avgPace' in set ? ((set.avgPace as number | null) ?? null) : before.avgPace,
      fastestKm: (set.fastestKm as number | null) ?? before.fastestKm,
      calories: 'calories' in set ? (set.calories as number) : before.calories,
      standstillMs: (set.standstillMs as number) ?? before.standstillMs,
      vehicleMs: (set.vehicleMs as number) ?? before.vehicleMs,
      stillPts: 'trackPoints' in set ? newStillPts : before.stillPts,
      vehiclePts: 'trackPoints' in set ? newVehiclePts : before.vehiclePts,
    };
    const vehMoved = after.vehicleMs !== before.vehicleMs;
    const stillMoved = after.standstillMs !== before.standstillMs || after.stillPts !== before.stillPts;
    // 时长与标记一起动 = 本次回填带来的口径变化；只动卡路里 = syncCalories 补正上一轮的漏项，
    // 单列一类，免得把「消耗修了 300 kcal」混进「剔了车速段」里去数来源
    const calMoved = after.calories !== before.calories;
    changes.push({
      id: String(a._id),
      type: a.type,
      reason:
        !('trackPoints' in set) && calMoved
          ? 'calories'
          : vehMoved && stillMoved
            ? 'both'
            : vehMoved
              ? 'vehicle'
              : 'standstill',
      before,
      after,
    });

    if (apply) await ActivityModel.updateOne({ _id: a._id }, { $set: set });
  }

  const clip = <T,>(arr: T[]) => arr.slice(0, LIST_CAP);
  return {
    db: `${mongoose.connection.name} / ${mongoose.connection.host}:${mongoose.connection.port}`,
    apply,
    scanned: acts.length,
    changed,
    changes: clip(changes),
    changesCount: changes.length,
    vehicleCount: changes.filter((c) => c.reason === 'vehicle').length,
    standstillCount: changes.filter((c) => c.reason === 'standstill').length,
    bothCount: changes.filter((c) => c.reason === 'both').length,
    caloriesCount: changes.filter((c) => c.before.calories !== c.after.calories).length,
    caloriesOnlyCount: changes.filter((c) => c.reason === 'calories').length,
    hits: clip(hits),
    fastSlower: clip(fastSlower),
    distSkipped: clip(distSkipped),
    fastSkipped: clip(fastSkipped),
    timeGateSkipped: clip(timeGateSkipped),
    hitCount: hits.length,
    fastSlowerCount: fastSlower.length,
    distSkippedCount: distSkipped.length,
    fastSkippedCount: fastSkipped.length,
    timeGateSkippedCount: timeGateSkipped.length,
  };
}
