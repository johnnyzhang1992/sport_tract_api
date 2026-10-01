import { Types } from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import { AppError } from '../utils/app-error.js';
import { assertObjectIdLike } from '../utils/object-id.js';
import { calcStats, calcFastestKm, haversineDistance } from '../utils/pace.js';
import { markStandstill } from '../utils/standstill.js';
import { markGapJumps } from '../utils/track-gap.js';
import { markVehicle, formatVehicleNotice } from '../utils/vehicle.js';
import { smoothTrackSmart } from '../utils/smooth.js';
import { cleanAltitudeSpikes } from '../utils/altitude-clean.js';
import { cleanTrajectory } from '../utils/trajectory-clean.js';
import { markFootprintDirty } from './footprint.js';
import { provincesOfPoints } from './region.js';
import { monthlyAggForMonths, type ActivityMonthlyRow } from './stats.js';
import { compactTrackPoints, normalizeTrackPoints } from '../utils/track-compact.js';
import { TYPE_CONFIGS, DEFAULT_TYPE_CONFIG } from '../utils/trajectory-clean.js';
import { deleteOssObjects, cleanUrl } from './oss.js';
import { resolveWeightKg } from './weight.js';
import type {
  AppendPointsInput,
  CreateActivityInput,
  CreateMarkerInput,
  FinishActivityInput,
  ListActivitiesQueryInput,
  UpdateMarkerInput,
} from '../utils/validators.js';
import { ACTIVITY_TYPES, MAX_TRACK_POINTS, MIN_EFFECTIVE_DISTANCE_M, MIN_EFFECTIVE_POINTS } from '../config/constants.js';

type ObjectIdLike = Types.ObjectId | string;

export interface TrackPointDto {
  seq: number;
  lat: number;
  lng: number;
  altitude: number | null;
  speed: number | null;
  accuracy: number | null;
  pauseGap?: boolean;
  /** 静止时段点（自动暂停口径，见 utils/standstill.ts） */
  still?: boolean;
  /** 非运动段点（疑似乘车，见 utils/vehicle.ts） */
  vehicle?: boolean;
  /** 采样断档连线的落点（渲染时在此断开，见 utils/track-gap.ts）；不影响任何指标 */
  gapJump?: boolean;
  timestamp: number;
}

export interface MarkerDto {
  id: string;
  lat: number;
  lng: number;
  timestamp: number;
  type: 'checkpoint' | 'rest' | 'photo' | 'note';
  note: string;
  photoUrl: string;
  photos: string[];
  /** 与 photos 同序的缩略图档（端上格子渲染用；photos 留给点开看大图） */
  photoThumbs?: string[];
  address: string;
}

export interface ActivityDto {
  id: string;
  type: string;
  status: string;
  /** 轨迹是否已纠偏：false = 存的是原始点（纠偏权在用户） */
  corrected: boolean;
  startTime: number;
  endTime: number | null;
  duration: number;
  totalDuration: number;
  distance: number;
  avgPace: number | null;
  fastestKm: number | null;
  calories: number;
  elevationGain: number;
  minAltitude: number | null;
  maxAltitude: number | null;
  startAddress: string;
  endAddress: string;
  provinces: string[]; // 轨迹经过的省
  startProvince: string;
  startCity: string;
  lastPointSeq: number;
  pausedMs: number;
  /** 自动暂停：本次判出的静止时段总时长（毫秒），运动时长 = 墙钟 − pausedMs − standstillMs − vehicleMs */
  standstillMs: number;
  /** 非运动段：疑似乘车的总时长（毫秒），位移见 vehicleM（见 utils/vehicle.ts） */
  vehicleMs: number;
  /** 非运动段：被剔掉的位移（米） */
  vehicleM: number;
  /** 非运动段：给用户看的整句说明（服务端拼好下发，见 utils/vehicle.ts#formatVehicleNotice）；无车速段为空串 */
  vehicleNotice: string;
  note: string;
  trackPoints: TrackPointDto[];
  markers: MarkerDto[];
  createdAt: string;
  updatedAt: string;
}

/**
 * 总时长（秒，含暂停的墙钟时长）= endTime − startTime
 * - duration 是运动时长（扣除暂停），两者差值即暂停总时长
 * - endTime 缺失（异常中断等）回退为 运动时长 + pausedMs，保证总时长 ≥ 运动时长
 */
function totalDurationOf(doc: Record<string, any>): number {
  const duration = doc.duration ?? 0;
  if (doc.endTime) {
    return Math.max(duration, Math.round((doc.endTime - doc.startTime) / 1000));
  }
  return duration + Math.round((doc.pausedMs ?? 0) / 1000);
}

export function toActivityDto(doc: Record<string, any>): ActivityDto {
  return {
    id: String(doc._id),
    type: doc.type,
    status: doc.status,
    startTime: doc.startTime,
    endTime: doc.endTime ?? null,
    duration: doc.duration ?? 0,
    totalDuration: totalDurationOf(doc),
    distance: doc.distance ?? 0,
    avgPace: doc.avgPace ?? null,
    fastestKm: doc.fastestKm ?? null,
    calories: doc.calories ?? 0,
    elevationGain: doc.elevationGain ?? 0,
    minAltitude: doc.minAltitude ?? null,
    maxAltitude: doc.maxAltitude ?? null,
    startAddress: doc.startAddress ?? '',
    endAddress: doc.endAddress ?? '',
    provinces: doc.provinces ?? [],
    startProvince: doc.startProvince ?? '',
    startCity: doc.startCity ?? '',
    lastPointSeq: doc.lastPointSeq ?? 0,
    pausedMs: doc.pausedMs ?? 0,
    standstillMs: doc.standstillMs ?? 0,
    vehicleMs: doc.vehicleMs ?? 0,
    vehicleM: doc.vehicleM ?? 0,
    vehicleNotice: formatVehicleNotice(doc.trackPoints, doc.vehicleMs, doc.vehicleM),
    note: doc.note ?? '',
    corrected: doc.corrected ?? true, // 2026-09-27 前的旧轨迹无字段：均经自动管线落库，视为已纠偏；新 finish 落库显式写 false
    trackPoints: normalizeTrackPoints(doc.trackPoints, doc.startTime),
    markers: doc.markers ?? [],
    createdAt: doc.createdAt?.toISOString?.() ?? '',
    updatedAt: doc.updatedAt?.toISOString?.() ?? '',
  };
}

/** 校验活动归属并返回（无则 404） */
async function findOwnedActivity(activityId: ObjectIdLike, userId: ObjectIdLike) {
  assertObjectIdLike(activityId, '活动不存在');
  const activity = await ActivityModel.findOne({ _id: activityId, userId }).lean();
  if (!activity) {
    throw new AppError(404, '活动不存在');
  }
  return activity;
}

/** 创建进行中活动（决策 D13：幂等，客户端可重试） */
export async function createActivity(userId: string, input: CreateActivityInput): Promise<ActivityDto> {
  const activity = await ActivityModel.create({
    userId,
    type: input.type,
    status: 'in_progress',
    startTime: input.startTime,
    deviceInfo: input.deviceInfo ?? null,
  });
  return toActivityDto(activity.toObject());
}

/**
 * 增量上传轨迹点（核心同步协议）
 * - 服务端按 seq > lastPointSeq 幂等去重（决策 D13）
 * - 单次 findOneAndUpdate 原子追加（$push $each + $max）
 * - finish 后禁止上传 → 409
 */
export async function appendPoints(
  activityId: ObjectIdLike,
  userId: string,
  input: AppendPointsInput,
): Promise<{ lastPointSeq: number; added: number }> {
  assertObjectIdLike(activityId, '活动不存在');
  const activity = await ActivityModel.findOne({ _id: activityId, userId }).select('status lastPointSeq trackPoints').lean();
  if (!activity) {
    throw new AppError(404, '活动不存在');
  }
  if (activity.status !== 'in_progress') {
    throw new AppError(409, '活动已结束，不能再上传轨迹点', { code: 'ACTIVITY_FINISHED' });
  }

  // 过滤重复点 + 排序
  const newPoints = input.points
    .filter((p) => p.seq > activity.lastPointSeq)
    .sort((a, b) => a.seq - b.seq);

  if (newPoints.length === 0) {
    return { lastPointSeq: activity.lastPointSeq, added: 0 };
  }

  // 上限保护（文档：2 万点保护，超出提示客户端抽稀）
  if (activity.trackPoints.length + newPoints.length > MAX_TRACK_POINTS) {
    throw new AppError(400, '轨迹点超出上限，请先抽稀', { code: 'TRACK_TOO_LARGE' });
  }

  const updated = await ActivityModel.findByIdAndUpdate(
    activityId,
    {
      $push: { trackPoints: { $each: newPoints } },
      $max: { lastPointSeq: newPoints[newPoints.length - 1].seq },
    },
    { returnDocument: 'after' },
  );

  return { lastPointSeq: updated!.lastPointSeq, added: newPoints.length };
}

/** 新增打点（运动中） */
export async function addMarker(
  activityId: ObjectIdLike,
  userId: string,
  input: CreateMarkerInput,
): Promise<{ marker: MarkerDto }> {
  assertObjectIdLike(activityId, '活动不存在');
  const activity = await ActivityModel.findOne({ _id: activityId, userId }).select('status').lean();
  if (!activity) {
    throw new AppError(404, '活动不存在');
  }
  if (activity.status !== 'in_progress') {
    throw new AppError(409, '活动已结束，不能再打点', { code: 'ACTIVITY_FINISHED' });
  }

  const marker = { ...input };
  // 幂等：同 id 覆盖（客户端重试）；photos 缺失时回退 photoUrl
  if (!marker.photos && marker.photoUrl) {
    marker.photos = [marker.photoUrl];
  }
  // 净化：编辑回传的签名 URL → 裸 URL 入库
  marker.photoUrl = cleanUrl(marker.photoUrl);
  marker.photos = (marker.photos ?? []).map(cleanUrl);
  await ActivityModel.updateOne(
    { _id: activityId },
    {
      $pull: { markers: { id: input.id } },
    },
  );
  await ActivityModel.updateOne(
    { _id: activityId },
    {
      $push: { markers: marker },
    },
  );

  return { marker: marker as MarkerDto };
}

/**
 * 结束活动（finish 对账，核心同步协议）
 * - 以客户端 final 包为准：全量替换 trackPoints + markers
 * - 服务端重算指标（距离/配速/卡路里/爬升）复核
 * - 轨迹无效（点数 < MIN_EFFECTIVE_POINTS 或重算距离 < MIN_EFFECTIVE_DISTANCE_M）→
 *   自动作废（cancelled）不保存，返回 reason=TOO_FEW_POINTS / DISTANCE_TOO_SHORT
 * - 幂等：已 finished 直接返回当前活动（防客户端重试）
 */

/** 该运动类型的物理速度上限（m/s）：取类型配置的绝对超速阈值 */
function typeMaxAbsSpeed(type: string): number {
  return (TYPE_CONFIGS[type] ?? DEFAULT_TYPE_CONFIG).maxAbsSpeed;
}

export type FinishInvalidReason = 'TOO_FEW_POINTS' | 'DISTANCE_TOO_SHORT' | 'IMPOSSIBLE_SPEED';

export interface FinishActivityResult {
  status: string;
  lastPointSeq: number;
  activity: ActivityDto;
  /** 轨迹无效作废原因（status=cancelled 时存在） */
  reason?: FinishInvalidReason;
  /** 纠偏前统计：管线预检出的可疑定位点数（前端引导纠偏用） */
  suspiciousPoints?: number;
  /** 纠偏后距离预估（米），未纠偏展示用 */
  projectedDistanceM?: number;
}

export async function finishActivity(
  activityId: ObjectIdLike,
  userId: string,
  input: FinishActivityInput,
): Promise<FinishActivityResult> {
  assertObjectIdLike(activityId, '活动不存在');
  const activity = await ActivityModel.findOne({ _id: activityId, userId }).lean();
  if (!activity) {
    throw new AppError(404, '活动不存在');
  }

  // 幂等返回（重复 finish）
  if (activity.status === 'finished') {
    return { status: activity.status, lastPointSeq: activity.lastPointSeq, activity: toActivityDto(activity) };
  }
  // 重复 finish 一条已因轨迹无效作废的活动：同样返回作废结果（防客户端重试报 409）
  if (activity.status === 'cancelled') {
    const pts = (activity.trackPoints ?? []) as TrackPointDto[];
    const looksInvalid =
      (activity.distance ?? 0) < MIN_EFFECTIVE_DISTANCE_M || pts.length < MIN_EFFECTIVE_POINTS;
    if (!looksInvalid) {
      throw new AppError(409, '活动已取消，无法结束', { code: 'ACTIVITY_CANCELLED' });
    }
    return {
      status: activity.status,
      lastPointSeq: activity.lastPointSeq,
      activity: toActivityDto(activity),
      reason: pts.length < MIN_EFFECTIVE_POINTS ? 'TOO_FEW_POINTS' : 'DISTANCE_TOO_SHORT',
    };
  }
  if (activity.status !== 'in_progress') {
    throw new AppError(409, '活动已取消，无法结束', { code: 'ACTIVITY_CANCELLED' });
  }

  // 最终点集：按 seq 排序（客户端保证完整，服务端兜底去重）
  const seen = new Set<number>();
  const trackPoints = input.trackPoints
    .filter((p) => {
      if (seen.has(p.seq)) return false;
      seen.add(p.seq);
      return true;
    })
    .sort((a, b) => a.seq - b.seq);

  // 结束时间：以最后一个轨迹点的上报时间为准（异常中断后补 finish 时，避免把中断后的空档计入时长）
  const validTs = trackPoints
    .map((p) => (typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? p.timestamp : 0))
    .filter((t) => t > 0);
  const endTime = validTs.length > 0 ? Math.max(...validTs) : (input.endTime ?? Date.now());

  // 运动时长 = 墙钟 − 手动暂停（下限 0）。原始口径：静止/车速段的修正在纠偏时才发生
  const durationSec = Math.max(0, (endTime - activity.startTime - input.pausedMs) / 1000);

  // 存储距离口径 = 客户端 tracker 实时累加值（用户运动时看到的数字）；
  // 客户端未传（旧版本）时退化为服务端按原始点直算（Haversine 累加）
  let storedDistance = input.clientDistance;
  if (storedDistance == null) {
    let d = 0;
    for (let i = 1; i < trackPoints.length; i++) d += haversineDistance(trackPoints[i - 1], trackPoints[i]);
    storedDistance = Math.round(d);
  }

  // 无效运动守卫（极简版，不跑管线）：
  // - 点数过少：单点无位移/两点成假直线
  // - 距离过短：原地不动结束（原始口径下也必然不足）
  // - 记录跨度内平均速度超骑行上限（如全程车内 GPS 漂移注水）：拦住这类垃圾轨迹。
  //   速度分母用「首尾点时间差」（实际记录跨度）而非墙钟——用户坐车到达起点再开始记录，
  //   墙钟含车程，会把正常运动误判成超速
  const tooFewPoints = trackPoints.length < MIN_EFFECTIVE_POINTS;
  const tooShort = storedDistance < MIN_EFFECTIVE_DISTANCE_M;
  // 平均速度用「步长速度的中位数」（抗抖动点干扰：单点大跳不抬高中位数；全程车内时中位数照样超限）
  const stepSpeeds: number[] = [];
  for (let i = 1; i < trackPoints.length; i++) {
    const dt = (trackPoints[i].timestamp - trackPoints[i - 1].timestamp) / 1000;
    if (dt > 0) stepSpeeds.push(haversineDistance(trackPoints[i - 1], trackPoints[i]) / dt);
  }
  stepSpeeds.sort((a, b) => a - b);
  const medStepSpeed = stepSpeeds.length > 0 ? stepSpeeds[Math.floor(stepSpeeds.length / 2)] : 0;
  if (tooFewPoints || tooShort || medStepSpeed > typeMaxAbsSpeed(activity.type)) {
    const reason = tooFewPoints
      ? 'TOO_FEW_POINTS'
      : tooShort
        ? 'DISTANCE_TOO_SHORT'
        : 'IMPOSSIBLE_SPEED';
    const cancelled = await ActivityModel.findByIdAndUpdate(
      activityId,
      {
        $set: {
          status: 'cancelled',
          endTime,
          trackPoints: compactTrackPoints(trackPoints, activity.startTime),
          markers: input.markers ?? activity.markers ?? [],
          pausedMs: input.pausedMs,
          duration: Math.round(durationSec),
          distance: storedDistance,
          corrected: false, // cancelled 轨迹保存原始点，若允许纠偏应从未纠偏状态开始
        },
      },
      { returnDocument: 'after' },
    );
    return {
      status: cancelled!.status,
      lastPointSeq: cancelled!.lastPointSeq,
      activity: toActivityDto(cancelled!.toObject()),
      reason,
    };
  }

  // 落库点先紧凑化（存储口径）
  const storedPoints = compactTrackPoints(trackPoints, activity.startTime);

  // 原始口径的爬升/海拔极值/卡路里：复用 calcStats（其爬升算法含 EMA+滞回，不宜复制），
  // 距离字段不采用（存储距离 = tracker 口径）
  const weightKg = await resolveWeightKg(activity.userId);
  const rawStats = calcStats(storedPoints, {
    type: activity.type,
    durationSec,
    weightKg,
  });

  // ===== 纠偏前统计：管线跑一遍但不落库，仅产出「可疑点数」供前端引导（存储距离/时长保持原始口径） =====
  const altitudeCleaned = cleanAltitudeSpikes(storedPoints as never);
  const trajectoryCleaned = cleanTrajectory(altitudeCleaned as never, {}, activity.type);
  const smoothedPoints = smoothTrackSmart(trajectoryCleaned as never, 5, haversineDistance);
  const suspiciousPoints = storedPoints.length - smoothedPoints.length;
  const projected = calcStats(smoothedPoints as never, {
    type: activity.type,
    durationSec,
    weightKg,
  });

  // 轨迹内最快 1km 分段（个人最佳"最快配速"口径）：基于原始存储点（未纠偏口径）
  const fastestKm = calcFastestKm(storedPoints, activity.type);
  // 落库省市（按省查询轨迹 + 点亮地图省下钻）
  const regions = provincesOfPoints(storedPoints);

  const updated = await ActivityModel.findByIdAndUpdate(
    activityId,
    {
      $set: {
        status: 'finished',
        endTime,
        trackPoints: storedPoints,
        markers: input.markers ?? activity.markers ?? [],
        startAddress: input.startAddress,
        endAddress: input.endAddress,
        provinces: regions.provinces,
        startProvince: regions.startProvince,
        startCity: regions.startCity,
        pausedMs: input.pausedMs,
        duration: Math.round(durationSec),
        distance: storedDistance,
        avgPace: durationSec > 0 && storedDistance > 0 ? durationSec / (storedDistance / 1000) : null,
        fastestKm,
        calories: rawStats.calories,
        elevationGain: rawStats.elevationGain,
        minAltitude: rawStats.minAltitude,
        maxAltitude: rawStats.maxAltitude,
        lastPointSeq: trackPoints.length > 0 ? trackPoints[trackPoints.length - 1].seq : 0,
        corrected: false, // 落库原始点，纠偏权在用户
        suspiciousPoints, // 供前端引导：「检测到 X 个可疑定位点」
      },
    },
    { returnDocument: 'after' },
  );

  await markFootprintDirty(String(activity.userId)); // 足迹失效，下次读取重算

  // 可疑点投影距离（纠偏后距离的预估，前端确认弹窗展示）
  void projected;

  return {
    status: 'finished',
    lastPointSeq: updated!.lastPointSeq,
    activity: toActivityDto(updated!.toObject()),
    suspiciousPoints,
    projectedDistanceM: projected.distance,
  };
}

/** 放弃活动 */
export async function cancelActivity(activityId: ObjectIdLike, userId: string): Promise<void> {
  assertObjectIdLike(activityId, '活动不存在');
  const activity = await ActivityModel.findOne({ _id: activityId, userId }).select('status').lean();
  if (!activity) {
    throw new AppError(404, '活动不存在');
  }
  if (activity.status === 'finished') {
    throw new AppError(409, '活动已结束，不能取消', { code: 'ACTIVITY_FINISHED' });
  }
  await ActivityModel.updateOne({ _id: activityId }, { $set: { status: 'cancelled', endTime: Date.now() } });
}

/**
 * 超时活动自动收尾（惰性清理）：in_progress 超过 24h 无更新（用户杀进程/异常退出）
 * - 有轨迹点 → 重算指标：距离达标 → finished 保留数据（endTime 以最后轨迹点上报时间为准，与 finish 同管线）；
 *   距离过短（漂移点全被清洗）→ cancelled 作废，不产生无意义轨迹
 * - 无轨迹点 → cancelled 作废（无数据可保留，不污染用户列表）
 * - userId 不传则清理全部用户（admin 列表用）；返回处理条数
 */
export async function autoFinishStaleActivities(userId?: string): Promise<number> {
  const stale = await ActivityModel.find({
    ...(userId ? { userId: new Types.ObjectId(userId) } : {}),
    status: 'in_progress',
    updatedAt: { $lt: new Date(Date.now() - 24 * 3600 * 1000) },
  })
    .select('userId type startTime pausedMs trackPoints')
    .lean();

  for (const activity of stale) {
    const pts = (activity.trackPoints ?? []) as TrackPointDto[];
    if (pts.length === 0) {
      await ActivityModel.updateOne({ _id: activity._id }, { $set: { status: 'cancelled', endTime: Date.now() } });
      continue;
    }

    // 最终点集：按 seq 去重排序（与 finish 兜底一致）
    const seen = new Set<number>();
    const trackPoints = pts
      .filter((p) => {
        if (seen.has(p.seq)) return false;
        seen.add(p.seq);
        return true;
      })
      .sort((a, b) => a.seq - b.seq);

    // 结束时间：以最后一个轨迹点的上报时间为准（异常中断后自动收尾，不把中断后的空档计入时长）
    const validTs = trackPoints
      .map((p) => (typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? p.timestamp : 0))
      .filter((t) => t > 0);
    const endTime = validTs.length > 0 ? Math.max(...validTs) : Date.now();

    // 与 finish 相同管线：海拔清洗 → 轨迹纠偏 → 平滑 → 车速段检测 → 静止检测 → 重算指标
    const altitudeCleaned = cleanAltitudeSpikes(trackPoints);
    const trajectoryCleaned = cleanTrajectory(altitudeCleaned, {}, activity.type);
    const smoothedPoints = smoothTrackSmart(trajectoryCleaned, 5, haversineDistance);
    const veh = markVehicle(smoothedPoints, activity.type);
    const { points: stillMarked, standstillMs } = markStandstill(veh.points);
    // 采样断档连线（见 utils/track-gap.ts）：只打标，不删点、不改任何指标——渲染方遇到该标记就断开连线
    const { points: markedPoints } = markGapJumps(stillMarked);
    const durationSec = Math.max(
      0,
      (endTime - activity.startTime - (activity.pausedMs ?? 0) - standstillMs - veh.vehicleMs) / 1000,
    );
    const storedPoints = compactTrackPoints(markedPoints, activity.startTime);
    const stats = calcStats(storedPoints, {
      type: activity.type,
      durationSec,
      weightKg: await resolveWeightKg(activity.userId),
    });

    // 无效运动守卫：点数过少或重算距离过短（漂移点全被清洗）→ 自动作废，与 finish 同口径
    if (trackPoints.length < MIN_EFFECTIVE_POINTS || stats.distance < MIN_EFFECTIVE_DISTANCE_M) {
      await ActivityModel.updateOne(
        { _id: activity._id },
        { $set: { status: 'cancelled', endTime } },
      );
      continue;
    }

    const fastestKm = calcFastestKm(storedPoints, activity.type);
    const regions = provincesOfPoints(markedPoints);

    await ActivityModel.updateOne(
      { _id: activity._id },
      {
        $set: {
          status: 'finished',
          endTime,
          trackPoints: storedPoints,
          corrected: true, // 无人值守收尾：自动管线清好（用户不在场，无纠偏选择权）
          provinces: regions.provinces,
          startProvince: regions.startProvince,
          startCity: regions.startCity,
          duration: Math.round(durationSec),
          standstillMs: Math.round(standstillMs),
          vehicleMs: Math.round(veh.vehicleMs),
          vehicleM: Math.round(veh.vehicleM),
          distance: stats.distance,
          avgPace: stats.avgPace,
          fastestKm,
          calories: stats.calories,
          elevationGain: stats.elevationGain,
          minAltitude: stats.minAltitude,
          maxAltitude: stats.maxAltitude,
          lastPointSeq: trajectoryCleaned.length > 0 ? trajectoryCleaned[trajectoryCleaned.length - 1].seq : 0,
        },
      },
    );
    await markFootprintDirty(String(activity.userId));
  }

  return stale.length;
}

/** 预览点合并：均匀采样点 + 断点（暂停 / 断档连线）按 seq 归并排序，断点优先（同 seq 覆盖）并保留标记 */
function mergePreviewPoints(
  sampled: Array<Record<string, any>>,
  gaps: Array<Record<string, any>>,
): Array<{ lat: number; lng: number; pauseGap?: true; gapJump?: true }> {
  const bySeq = new Map<number, { lat: number; lng: number; pauseGap?: true; gapJump?: true }>();
  for (const p of sampled ?? []) {
    if (p && typeof p.seq === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
      bySeq.set(p.seq, { lat: p.lat, lng: p.lng });
    }
  }
  for (const g of gaps ?? []) {
    if (g && typeof g.seq === 'number' && Number.isFinite(g.lat) && Number.isFinite(g.lng)) {
      const flags: { lat: number; lng: number; pauseGap?: true; gapJump?: true } = {
        lat: g.lat,
        lng: g.lng,
      };
      if (g.pauseGap === true) flags.pauseGap = true;
      if (g.gapJump === true) flags.gapJump = true;
      bySeq.set(g.seq, flags);
    }
  }
  return [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

/**
 * 活动列表（分页 + 筛选）
 * 性能：不返回完整轨迹点，用聚合计算 pointsCount / markerCount / 首尾点（缩略图用）
 */
export async function listActivities(
  userId: string,
  query: ListActivitiesQueryInput,
): Promise<{
  items: Array<Record<string, any>>;
  total: number;
  page: number;
  pageSize: number;
  /** 选中类型时附带：页内出现月份的全量聚合（轨迹列表月度统计） */
  monthlyStats: ActivityMonthlyRow[];
}> {
  const { type, month, province, page, pageSize } = query;

  // 惰性清理：in_progress 超过 24h 无更新（用户杀进程/异常退出）→ 自动收尾
  // 有轨迹点自动 finished 保留数据（endTime 以最后点上报时间为准）；空活动作废
  // 列表接口是用户活跃入口，天然覆盖所有使用者
  await autoFinishStaleActivities(userId).catch(() => {});

  // aggregate 的 $match 不做 Mongoose 类型转换，userId 需手动转 ObjectId
  const filter: Record<string, any> = { userId: new Types.ObjectId(userId), status: 'finished' };
  if (type) filter.type = type;
  if (province) filter.provinces = province; // 多键索引 { userId, provinces } 命中
  if (month) {
    const [y, m] = month.split('-').map(Number);
    const start = new Date(y, m - 1, 1).getTime();
    const end = new Date(y, m, 1).getTime();
    filter.startTime = { $gte: start, $lt: end };
  }

  const [total, items] = await Promise.all([
    ActivityModel.countDocuments(filter),
    ActivityModel.aggregate([
      { $match: filter },
      { $sort: { startTime: -1 } },
      { $skip: (page - 1) * pageSize },
      { $limit: pageSize },
      {
        $project: {
          type: 1,
          status: 1,
          startTime: 1,
          endTime: 1,
          duration: 1,
          distance: 1,
          avgPace: 1,
          calories: 1,
          elevationGain: 1,
          minAltitude: 1,
          maxAltitude: 1,
          startAddress: 1,
          endAddress: 1,
          provinces: 1,
          startProvince: 1,
          startCity: 1,
          createdAt: 1,
          pointsCount: { $size: '$trackPoints' },
          markerCount: { $size: '$markers' },
          firstPoint: { $arrayElemAt: ['$trackPoints', 0] },
          lastPoint: { $arrayElemAt: ['$trackPoints', -1] },
          // 轨迹缩略图：均匀采样 60 点（列表卡片预览用，避免全量点下发）
          previewPoints: {
            $map: {
              input: { $range: [0, 60] },
              as: 'i',
              in: {
                $let: {
                  vars: {
                    idx: {
                      $min: [
                        { $subtract: [{ $size: '$trackPoints' }, 1] },
                        { $floor: { $multiply: ['$$i', { $divide: [{ $size: '$trackPoints' }, 60] }] } },
                      ],
                    },
                  },
                  in: {
                    $let: {
                      vars: {
                        p: { $ifNull: [{ $arrayElemAt: ['$trackPoints', '$$idx'] }, { lat: 0, lng: 0 }] },
                      },
                      in: { seq: '$$p.seq', lat: '$$p.lat', lng: '$$p.lng' },
                    },
                  },
                },
              },
            },
          },
          // 断点全量带出（数量少）：均匀采样会丢失标记点，与采样点按 seq 合并后段首重打标
          // pauseGap=暂停间隙、gapJump=采样断档连线（斜穿弦），两者都要求渲染处断开
          gapPoints: {
            $map: {
              input: {
                $filter: {
                  input: '$trackPoints',
                  as: 'tp',
                  cond: {
                    $or: [{ $eq: ['$$tp.pauseGap', true] }, { $eq: ['$$tp.gapJump', true] }],
                  },
                },
              },
              as: 'g',
              in: {
                seq: '$$g.seq',
                lat: '$$g.lat',
                lng: '$$g.lng',
                pauseGap: { $ifNull: ['$$g.pauseGap', false] },
                gapJump: { $ifNull: ['$$g.gapJump', false] },
              },
            },
          },
        },
      },
    ]),
  ]);

  // 预览点后处理：
  // - 空轨迹置空（聚合 $ifNull 兜底会对空数组产生 60 个 (0,0) 填充点）
  // - 合并断点（暂停间隙 / 断档连线），保证缩略图在不可信连线处断开（与 overview 切段保标口径一致）
  for (const item of items as Array<Record<string, any>>) {
    if (!item.pointsCount) {
      item.previewPoints = [];
    } else {
      item.previewPoints = mergePreviewPoints(item.previewPoints ?? [], item.gapPoints ?? []);
    }
    delete item.gapPoints;
  }

  // 附带月度全量聚合：选中类型时，页内出现哪些月份就返回哪些月的整月汇总（省去前端额外拉全量）
  // 月份切分用固定 +08:00（Asia/Shanghai 无夏令时），与月度聚合管道同口径
  let monthlyStats: ActivityMonthlyRow[] = [];
  if (type && items.length > 0) {
    const wanted = new Set<string>();
    for (const item of items as Array<Record<string, any>>) {
      const d = new Date(item.startTime + 8 * 3600 * 1000);
      wanted.add(`${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`);
    }
    monthlyStats = await monthlyAggForMonths(userId, type, province, wanted);
  }

  return { items, total, page, pageSize, monthlyStats };
}

/** 活动详情（含完整轨迹点与打点） */
export type ActivityDetailView = ActivityDto & { isOwner: boolean };

/**
 * 轨迹详情（分享/只读查看）
 * - 本人：完整可见（isOwner=true）
 * - 非本人：仅可查看 finished 轨迹（isOwner=false，前端隐藏编辑入口）；进行中/未完成轨迹对外 404
 */
export async function getActivityDetailView(
  activityId: ObjectIdLike,
  userId?: string | null,
): Promise<ActivityDetailView> {
  assertObjectIdLike(activityId, '活动不存在');
  const activity = await ActivityModel.findOne({ _id: activityId }).lean();
  if (!activity) {
    throw new AppError(404, '活动不存在');
  }
  const isOwner = !!userId && String(activity.userId) === String(userId);
  if (!isOwner && activity.status !== 'finished') {
    throw new AppError(404, '活动不存在');
  }
  return { ...toActivityDto(activity), isOwner };
}

/** 重新纠偏：对已完成活动重跑 海拔清洗→轨迹纠偏→平滑→重算指标（决策：事后清洗历史脏数据） */
export async function reprocessActivity(
  activityId: ObjectIdLike,
  userId: string,
): Promise<ActivityDto & { suspiciousPoints: number }> {
  const activity = await findOwnedActivity(activityId, userId);
  const raw = (activity.trackPoints ?? []) as TrackPointDto[];
  if (raw.length === 0) {
    throw new AppError(400, '轨迹点为空');
  }
  const altitudeCleaned = cleanAltitudeSpikes(raw);
  const trajectoryCleaned = cleanTrajectory(altitudeCleaned, {}, activity.type);
  const smoothed = smoothTrackSmart(trajectoryCleaned, 5, haversineDistance);
  // 非运动段/静止段随纠偏重打标（用户主动纠偏 = 接受这类修正）
  const veh = markVehicle(smoothed, activity.type);
  const { points: stillMarked, standstillMs } = markStandstill(veh.points);
  const { points: gapMarked } = markGapJumps(stillMarked);
  const storedPoints = compactTrackPoints(gapMarked, activity.startTime);
  // 纠偏后时长口径：墙钟 − 手动暂停 − 判出的静止 − 判出的车速段
  const endMs = activity.endTime ?? (raw.length ? raw[raw.length - 1].timestamp ?? activity.startTime : activity.startTime);
  const durationSec = Math.max(
    0,
    (endMs - activity.startTime - (activity.pausedMs ?? 0) - standstillMs - veh.vehicleMs) / 1000,
  );
  const stats = calcStats(storedPoints, {
    type: activity.type,
    durationSec,
    weightKg: await resolveWeightKg(activity.userId),
  });
  const fastestKm = calcFastestKm(storedPoints, activity.type);
  // 纠偏后轨迹点变化 → 重算省市并更新
  const regions = provincesOfPoints(smoothed);
  const updated = await ActivityModel.findByIdAndUpdate(
    activityId,
    {
      $set: {
        trackPoints: storedPoints,
        provinces: regions.provinces,
        startProvince: regions.startProvince,
        startCity: regions.startCity,
        duration: Math.round(durationSec),
        standstillMs: Math.round(standstillMs),
        vehicleMs: Math.round(veh.vehicleMs),
        vehicleM: Math.round(veh.vehicleM),
        corrected: true,
        distance: stats.distance,
        avgPace: stats.avgPace,
        fastestKm,
        calories: stats.calories,
        elevationGain: stats.elevationGain,
        minAltitude: stats.minAltitude,
        maxAltitude: stats.maxAltitude,
        lastPointSeq: trajectoryCleaned.length > 0 ? trajectoryCleaned[trajectoryCleaned.length - 1].seq : 0,
      },
    },
    { returnDocument: 'after' },
  );
  const before = { length: raw.length };
  return {
    ...toActivityDto(updated!.toObject()),
    suspiciousPoints: before.length - storedPoints.length,
  };
}

/** 更新活动信息（类型/备注；类型变化时重算配速/卡路里） */
export async function updateActivityMeta(
  activityId: ObjectIdLike,
  userId: string,
  input: { type?: string; note?: string; source?: string },
): Promise<{ id: string; type: string; note: string; source: string; avgPace: number | null; calories: number }> {
  const activity = await findOwnedActivity(activityId, userId);
  const patch: Record<string, unknown> = {};

  if (input.type != null && input.type !== activity.type) {
    if (!ACTIVITY_TYPES.includes(input.type as (typeof ACTIVITY_TYPES)[number])) {
      throw new AppError(400, '无效运动类型');
    }
    const stats = calcStats(activity.trackPoints ?? [], {
      type: input.type as never,
      durationSec: activity.duration ?? 0,
      weightKg: await resolveWeightKg(activity.userId),
    });
    patch.type = input.type;
    patch.avgPace = stats.avgPace;
    patch.fastestKm = calcFastestKm(activity.trackPoints ?? [], activity.type);
    patch.calories = stats.calories;
  }
  if (input.note != null) {
    patch.note = String(input.note).slice(0, 500);
  }
  if (input.source != null) {
    patch.deviceInfo = { ...(activity.deviceInfo ?? {}), source: String(input.source).slice(0, 50) };
  }
  if (Object.keys(patch).length > 0) {
    await ActivityModel.updateOne({ _id: activityId, userId }, patch);
  }
  return {
    id: String(activity._id),
    type: input.type ?? activity.type,
    note: input.note != null ? String(input.note).slice(0, 500) : activity.note ?? '',
    source:
      input.source != null
        ? String(input.source).slice(0, 50)
        : ((activity.deviceInfo as { source?: string } | null)?.source ?? ''),
    avgPace: (patch.avgPace as number | null) ?? activity.avgPace ?? null,
    calories: (patch.calories as number | undefined) ?? activity.calories ?? 0,
  };
}

/** 删除活动（硬删；同步清理打点照片的 OSS 文件，失败不影响主流程） */
export async function deleteActivity(activityId: ObjectIdLike, userId: string): Promise<void> {
  const activity = await findOwnedActivity(activityId, userId);

  const result = await ActivityModel.deleteOne({ _id: activityId, userId });
  if (result.deletedCount === 0) {
    throw new AppError(404, '活动不存在');
  }

  // 清理 OSS 照片（决策：删除接口同步清理文件；未配置 OSS 或失败时静默跳过）
  const photoUrls = ((activity.markers ?? []) as Array<{
    photoUrl?: string;
    photos?: string[];
  }>)
    .flatMap((m) => [m.photoUrl, ...(m.photos ?? [])])
    .filter((u): u is string => Boolean(u));
  if (photoUrls.length > 0) {
    try {
      await deleteOssObjects(photoUrls);
    } catch (err) {
      // 记录但不上抛：OSS 清理失败不应阻塞删除主流程
      console.error('[oss] 清理活动照片失败:', (err as Error).message);
    }
  }

  await markFootprintDirty(String(activity.userId)); // 足迹失效
}

/**
 * 编辑打点（决策 F13：运动结束后可补充、编辑或删除打点）
 * 仅更新传入字段，坐标（lat/lng）不可经此接口修改
 */
export async function updateMarker(
  activityId: ObjectIdLike,
  userId: string,
  markerId: string,
  input: UpdateMarkerInput,
): Promise<{ marker: MarkerDto }> {
  const activity = await findOwnedActivity(activityId, userId);
  const marker = ((activity.markers ?? []) as Array<MarkerDto>).find((m) => m.id === markerId);
  if (!marker) {
    throw new AppError(404, '打点不存在');
  }

  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    set[`markers.$.${k}`] = v;
  }
  // photos 全量替换时：净化签名 URL 入库 + 同步 photoUrl 为首图
  if (input.photos) {
    const cleaned = input.photos.map(cleanUrl);
    set['markers.$.photos'] = cleaned;
    set['markers.$.photoUrl'] = cleaned[0] || '';
  }
  if (Object.keys(set).length === 0) {
    throw new AppError(400, '没有可更新的字段');
  }

  await ActivityModel.updateOne(
    { _id: activityId, 'markers.id': markerId },
    { $set: set },
  );

  const updated = await findOwnedActivity(activityId, userId);
  const updatedMarker = ((updated.markers ?? []) as Array<MarkerDto>).find((m) => m.id === markerId);
  return { marker: updatedMarker as MarkerDto };
}

/**
 * 删除打点
 * 返回被删打点（含 photoUrl，路由层可据此清理 OSS 照片）
 */
export async function removeMarker(
  activityId: ObjectIdLike,
  userId: string,
  markerId: string,
): Promise<{ marker: MarkerDto }> {
  const activity = await findOwnedActivity(activityId, userId);
  const marker = ((activity.markers ?? []) as Array<MarkerDto>).find((m) => m.id === markerId);
  if (!marker) {
    throw new AppError(404, '打点不存在');
  }

  await ActivityModel.updateOne({ _id: activityId }, { $pull: { markers: { id: markerId } } });
  return { marker: marker as MarkerDto };
}

/** GPX 导出数据源 */
export async function getActivityForGpx(activityId: ObjectIdLike, userId: string) {
  return findOwnedActivity(activityId, userId);
}
