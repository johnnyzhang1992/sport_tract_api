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
 * 不动：elevationGain / minAltitude / maxAltitude（与时长无关）、
 *       calories（= MET × 体重 × 时长，历史体重没落库，用默认体重回算会把口径带偏）。
 *
 * 两道防误伤闸门（都只统计、不达标就跳过该字段并列出来）：
 *   1) 时长闸门用不变量 `duration + standstillMs + vehicleMs ≈ 墙钟`，而不是 `duration ≈ 墙钟`
 *      —— 后者跑过一次就不再成立，重跑会把该改的挡掉。
 *   2) fastestKm **只降不升**：回填不该顺手把人刷到更好的名次上；重算值比库里更快
 *      说明差异不是本次口径能解释的（库里那条另有来源，见 docs/04），只标记不写值。
 */
import mongoose from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import { markVehicle } from '../utils/vehicle.js';
import { markStandstill } from '../utils/standstill.js';
import { calcFastestKm, calcStats, haversineDistance, formatPace, type TrackPointLike } from '../utils/pace.js';
import { assertObjectIdLike } from '../utils/object-id.js';

/** 报告里每个清单只回前 N 条（接口要过 HTTP，全量可能几十 KB），总数另给 xxxCount 字段 */
const LIST_CAP = 50;

export interface BackfillVehicleOptions {
  /** false（默认）= 只算不写 */
  apply?: boolean;
  /** 只处理某一条 */
  id?: string;
  /** 限量，0/省略 = 不限 */
  limit?: number;
}

export interface BackfillVehicleReport {
  /** 连的是哪个库：干跑也要看清自己打到了哪 */
  db: string;
  apply: boolean;
  scanned: number;
  changed: number;
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
  const limit = Number(opts.limit ?? 0);
  // 不在这里建连接：接口侧 app 启动时已连好，CLI 侧自己 connect(config.mongodbUri)。
  // 服务里再 connect 一次会把 URI 口径分裂成两份（一份走 config、一份走环境变量默认值）。

  const filter: Record<string, unknown> = { status: 'finished', 'trackPoints.20': { $exists: true } };
  if (opts.id) filter._id = assertObjectIdLike(opts.id, '轨迹不存在');
  let q = ActivityModel.find(filter)
    .select('type startTime endTime pausedMs duration standstillMs vehicleMs vehicleM avgPace fastestKm distance trackPoints')
    .sort({ startTime: -1 });
  if (limit > 0) q = q.limit(limit);
  const acts = (await q.lean()) as any[];

  let changed = 0;
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

    if (newVehicleMs > 0) {
      hits.push(
        `${a._id} ${a.type} ${(stats.distance / 1000).toFixed(2)}km 车速段 ${veh.spans} 段 ${Math.round(newVehicleMs / 1000)}s/${Math.round(veh.vehicleM)}m ` +
          `时长 ${mmss(a.duration ?? 0)}→${mmss(netSec)} 最快1km ${pace(a.fastestKm)}→${newFast == null ? '—' : pace(newFast)}`,
      );
    }
    if (Object.keys(set).length === 0) continue;
    changed++;

    if (apply) await ActivityModel.updateOne({ _id: a._id }, { $set: set });
  }

  const clip = (arr: string[]) => arr.slice(0, LIST_CAP);
  return {
    db: `${mongoose.connection.name} / ${mongoose.connection.host}:${mongoose.connection.port}`,
    apply,
    scanned: acts.length,
    changed,
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
