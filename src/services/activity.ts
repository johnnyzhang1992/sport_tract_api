import { Types } from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import { AppError } from '../utils/app-error.js';
import { calcStats, calcFastestKm, haversineDistance } from '../utils/pace.js';
import { smoothTrackSmart } from '../utils/smooth.js';
import { cleanAltitudeSpikes } from '../utils/altitude-clean.js';
import { cleanTrajectory } from '../utils/trajectory-clean.js';
import { markFootprintDirty } from './footprint.js';
import { provincesOfPoints } from './region.js';
import { deleteOssObjects, cleanUrl } from './oss.js';
import type {
  AppendPointsInput,
  CreateActivityInput,
  CreateMarkerInput,
  FinishActivityInput,
  ListActivitiesQueryInput,
  UpdateMarkerInput,
} from '../utils/validators.js';
import { ACTIVITY_TYPES, MAX_TRACK_POINTS } from '../config/constants.js';

type ObjectIdLike = Types.ObjectId | string;

export interface TrackPointDto {
  seq: number;
  lat: number;
  lng: number;
  altitude: number | null;
  speed: number | null;
  accuracy: number | null;
  pauseGap?: boolean;
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
  address: string;
}

export interface ActivityDto {
  id: string;
  type: string;
  status: string;
  startTime: number;
  endTime: number | null;
  duration: number;
  distance: number;
  avgPace: number | null;
  fastestKm: number | null;
  calories: number;
  elevationGain: number;
  maxAltitude: number | null;
  startAddress: string;
  endAddress: string;
  provinces: string[]; // 轨迹经过的省
  startProvince: string;
  startCity: string;
  lastPointSeq: number;
  pausedMs: number;
  note: string;
  trackPoints: TrackPointDto[];
  markers: MarkerDto[];
  createdAt: string;
  updatedAt: string;
}

export function toActivityDto(doc: Record<string, any>): ActivityDto {
  return {
    id: String(doc._id),
    type: doc.type,
    status: doc.status,
    startTime: doc.startTime,
    endTime: doc.endTime ?? null,
    duration: doc.duration ?? 0,
    distance: doc.distance ?? 0,
    avgPace: doc.avgPace ?? null,
    fastestKm: doc.fastestKm ?? null,
    calories: doc.calories ?? 0,
    elevationGain: doc.elevationGain ?? 0,
    maxAltitude: doc.maxAltitude ?? null,
    startAddress: doc.startAddress ?? '',
    endAddress: doc.endAddress ?? '',
    provinces: doc.provinces ?? [],
    startProvince: doc.startProvince ?? '',
    startCity: doc.startCity ?? '',
    lastPointSeq: doc.lastPointSeq ?? 0,
    pausedMs: doc.pausedMs ?? 0,
    note: doc.note ?? '',
    trackPoints: doc.trackPoints ?? [],
    markers: doc.markers ?? [],
    createdAt: doc.createdAt?.toISOString?.() ?? '',
    updatedAt: doc.updatedAt?.toISOString?.() ?? '',
  };
}

/** 校验活动归属并返回（无则 404） */
async function findOwnedActivity(activityId: ObjectIdLike, userId: ObjectIdLike) {
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
 * - 幂等：已 finished 直接返回当前活动（防客户端重试）
 */
export async function finishActivity(
  activityId: ObjectIdLike,
  userId: string,
  input: FinishActivityInput,
): Promise<{ status: string; lastPointSeq: number; activity: ActivityDto }> {
  const activity = await ActivityModel.findOne({ _id: activityId, userId }).lean();
  if (!activity) {
    throw new AppError(404, '活动不存在');
  }

  // 幂等返回（重复 finish）
  if (activity.status === 'finished') {
    return { status: activity.status, lastPointSeq: activity.lastPointSeq, activity: toActivityDto(activity) };
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

  // 允许空轨迹点（用户随时结束）：指标按 0 处理

  // 结束时间：以最后一个轨迹点的上报时间为准（异常中断后补 finish 时，避免把中断后的空档计入时长）
  const validTs = trackPoints
    .map((p) => (typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? p.timestamp : 0))
    .filter((t) => t > 0);
  const endTime = validTs.length > 0 ? Math.max(...validTs) : (input.endTime ?? Date.now());
  const durationSec = Math.max(0, (endTime - activity.startTime - input.pausedMs) / 1000);

  // 海拔尖刺清洗（GPS 误差：短时间大幅跳变且方向反转 → 海拔置 null）
  const altitudeCleaned = cleanAltitudeSpikes(trackPoints);

  // 轨迹纠偏（决策：GPS 漂移点剔除）—— 尖刺点（短时高速来回跳）与孤立离群点
  const trajectoryCleaned = cleanTrajectory(altitudeCleaned, {}, activity.type);

  // 轨迹平滑（滑动平均 + 位移守卫）：抑制 GPS 抖动，端点保持，位移过大回退原值
  const smoothedPoints = smoothTrackSmart(trajectoryCleaned, 5, haversineDistance);
  const stats = calcStats(smoothedPoints, {
    type: activity.type,
    durationSec,
    weightKg: input.weightKg,
  });
  // 轨迹内最快 1km 分段（个人最佳"最快配速"口径：分段最快，非全程平均）
  const fastestKm = calcFastestKm(smoothedPoints, activity.type);
  // 落库省市（按省查询轨迹 + 点亮地图省下钻）
  const regions = provincesOfPoints(smoothedPoints);

  const updated = await ActivityModel.findByIdAndUpdate(
    activityId,
    {
      $set: {
        status: 'finished',
        endTime,
        trackPoints: smoothedPoints,
        markers: input.markers ?? activity.markers ?? [],
        startAddress: input.startAddress,
        endAddress: input.endAddress,
        provinces: regions.provinces,
        startProvince: regions.startProvince,
        startCity: regions.startCity,
        pausedMs: input.pausedMs,
        duration: Math.round(durationSec),
        distance: stats.distance,
        avgPace: stats.avgPace,
        fastestKm,
        calories: stats.calories,
        elevationGain: stats.elevationGain,
        maxAltitude: stats.maxAltitude,
        lastPointSeq: trajectoryCleaned.length > 0 ? trajectoryCleaned[trajectoryCleaned.length - 1].seq : 0,
      },
    },
    { returnDocument: 'after' },
  );

  await markFootprintDirty(String(activity.userId)); // 足迹失效，下次读取重算

  return {
    status: 'finished',
    lastPointSeq: updated!.lastPointSeq,
    activity: toActivityDto(updated!.toObject()),
  };
}

/** 放弃活动 */
export async function cancelActivity(activityId: ObjectIdLike, userId: string): Promise<void> {
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
 * - 有轨迹点 → 自动 finished 保留数据：endTime 以最后轨迹点上报时间为准，重算指标（与 finish 同管线）
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
    const durationSec = Math.max(0, (endTime - activity.startTime - (activity.pausedMs ?? 0)) / 1000);

    // 与 finish 相同管线：海拔清洗 → 轨迹纠偏 → 平滑 → 重算指标
    const altitudeCleaned = cleanAltitudeSpikes(trackPoints);
    const trajectoryCleaned = cleanTrajectory(altitudeCleaned, {}, activity.type);
    const smoothedPoints = smoothTrackSmart(trajectoryCleaned, 5, haversineDistance);
    const stats = calcStats(smoothedPoints, { type: activity.type, durationSec });
    const fastestKm = calcFastestKm(smoothedPoints, activity.type);
    const regions = provincesOfPoints(smoothedPoints);

    await ActivityModel.updateOne(
      { _id: activity._id },
      {
        $set: {
          status: 'finished',
          endTime,
          trackPoints: smoothedPoints,
          provinces: regions.provinces,
          startProvince: regions.startProvince,
          startCity: regions.startCity,
          duration: Math.round(durationSec),
          distance: stats.distance,
          avgPace: stats.avgPace,
          fastestKm,
          calories: stats.calories,
          elevationGain: stats.elevationGain,
          maxAltitude: stats.maxAltitude,
          lastPointSeq: trajectoryCleaned.length > 0 ? trajectoryCleaned[trajectoryCleaned.length - 1].seq : 0,
        },
      },
    );
    await markFootprintDirty(String(activity.userId));
  }

  return stale.length;
}

/** 预览点合并：均匀采样点 + 暂停断点按 seq 归并排序，断点优先（同 seq 覆盖）并保留 pauseGap 标 */
function mergePreviewPoints(
  sampled: Array<Record<string, any>>,
  gaps: Array<Record<string, any>>,
): Array<{ lat: number; lng: number; pauseGap?: boolean }> {
  const bySeq = new Map<number, { lat: number; lng: number; pauseGap?: boolean }>();
  for (const p of sampled ?? []) {
    if (p && typeof p.seq === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
      bySeq.set(p.seq, { lat: p.lat, lng: p.lng });
    }
  }
  for (const g of gaps ?? []) {
    if (g && typeof g.seq === 'number' && Number.isFinite(g.lat) && Number.isFinite(g.lng)) {
      bySeq.set(g.seq, { lat: g.lat, lng: g.lng, pauseGap: true });
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
): Promise<{ items: Array<Record<string, any>>; total: number; page: number; pageSize: number }> {
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
          // 暂停断点全量带出（数量少）：均匀采样会丢掉 pauseGap 标，与采样点按 seq 合并后段首重打标
          gapPoints: {
            $map: {
              input: { $filter: { input: '$trackPoints', as: 'tp', cond: { $eq: ['$$tp.pauseGap', true] } } },
              as: 'g',
              in: { seq: '$$g.seq', lat: '$$g.lat', lng: '$$g.lng', pauseGap: true },
            },
          },
        },
      },
    ]),
  ]);

  // 预览点后处理：
  // - 空轨迹置空（聚合 $ifNull 兜底会对空数组产生 60 个 (0,0) 填充点）
  // - 合并暂停断点，保证缩略图暂停间隙断开（与 overview 切段保标口径一致）
  for (const item of items as Array<Record<string, any>>) {
    if (!item.pointsCount) {
      item.previewPoints = [];
    } else {
      item.previewPoints = mergePreviewPoints(item.previewPoints ?? [], item.gapPoints ?? []);
    }
    delete item.gapPoints;
  }

  return { items, total, page, pageSize };
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
): Promise<ActivityDto> {
  const activity = await findOwnedActivity(activityId, userId);
  const raw = (activity.trackPoints ?? []) as TrackPointDto[];
  if (raw.length === 0) {
    throw new AppError(400, '轨迹点为空');
  }
  const altitudeCleaned = cleanAltitudeSpikes(raw);
  const trajectoryCleaned = cleanTrajectory(altitudeCleaned, {}, activity.type);
  const smoothed = smoothTrackSmart(trajectoryCleaned, 5, haversineDistance);
  const stats = calcStats(smoothed, {
    type: activity.type,
    durationSec: activity.duration ?? 0,
  });
  const fastestKm = calcFastestKm(smoothed, activity.type);
  // 纠偏后轨迹点变化 → 重算省市并更新
  const regions = provincesOfPoints(smoothed);
  const updated = await ActivityModel.findByIdAndUpdate(
    activityId,
    {
      $set: {
        trackPoints: smoothed,
        provinces: regions.provinces,
        startProvince: regions.startProvince,
        startCity: regions.startCity,
        distance: stats.distance,
        avgPace: stats.avgPace,
        fastestKm,
        calories: stats.calories,
        elevationGain: stats.elevationGain,
        maxAltitude: stats.maxAltitude,
        lastPointSeq: trajectoryCleaned.length > 0 ? trajectoryCleaned[trajectoryCleaned.length - 1].seq : 0,
      },
    },
    { returnDocument: 'after' },
  );
  return toActivityDto(updated!.toObject());
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
