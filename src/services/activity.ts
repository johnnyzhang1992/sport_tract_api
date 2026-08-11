import { Types } from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import { AppError } from '../utils/app-error.js';
import { calcStats, haversineDistance } from '../utils/pace.js';
import { smoothTrackSmart } from '../utils/smooth.js';
import { deleteOssObjects, cleanUrl } from './oss.js';
import type {
  AppendPointsInput,
  CreateActivityInput,
  CreateMarkerInput,
  FinishActivityInput,
  ListActivitiesQueryInput,
  UpdateMarkerInput,
} from '../utils/validators.js';
import { MAX_TRACK_POINTS } from '../config/constants.js';

type ObjectIdLike = Types.ObjectId | string;

export interface TrackPointDto {
  seq: number;
  lat: number;
  lng: number;
  altitude: number | null;
  speed: number | null;
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
  calories: number;
  elevationGain: number;
  maxAltitude: number | null;
  startAddress: string;
  endAddress: string;
  lastPointSeq: number;
  pausedMs: number;
  trackPoints: TrackPointDto[];
  markers: MarkerDto[];
  createdAt: string;
  updatedAt: string;
}

function toActivityDto(doc: Record<string, any>): ActivityDto {
  return {
    id: String(doc._id),
    type: doc.type,
    status: doc.status,
    startTime: doc.startTime,
    endTime: doc.endTime ?? null,
    duration: doc.duration ?? 0,
    distance: doc.distance ?? 0,
    avgPace: doc.avgPace ?? null,
    calories: doc.calories ?? 0,
    elevationGain: doc.elevationGain ?? 0,
    maxAltitude: doc.maxAltitude ?? null,
    startAddress: doc.startAddress ?? '',
    endAddress: doc.endAddress ?? '',
    lastPointSeq: doc.lastPointSeq ?? 0,
    pausedMs: doc.pausedMs ?? 0,
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

  const endTime = input.endTime ?? Date.now();
  const durationSec = Math.max(0, (endTime - activity.startTime - input.pausedMs) / 1000);

  // 轨迹平滑（滑动平均 + 位移守卫）：抑制 GPS 抖动，端点保持，位移过大回退原值
  const smoothedPoints = smoothTrackSmart(trackPoints, 5, haversineDistance);
  const stats = calcStats(smoothedPoints, {
    type: activity.type,
    durationSec,
    weightKg: input.weightKg,
  });

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
        pausedMs: input.pausedMs,
        duration: Math.round(durationSec),
        distance: stats.distance,
        avgPace: stats.avgPace,
        calories: stats.calories,
        elevationGain: stats.elevationGain,
        maxAltitude: stats.maxAltitude,
        lastPointSeq: trackPoints.length > 0 ? trackPoints[trackPoints.length - 1].seq : 0,
      },
    },
    { returnDocument: 'after' },
  );

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
 * 活动列表（分页 + 筛选）
 * 性能：不返回完整轨迹点，用聚合计算 pointsCount / markerCount / 首尾点（缩略图用）
 */
export async function listActivities(
  userId: string,
  query: ListActivitiesQueryInput,
): Promise<{ items: Array<Record<string, any>>; total: number; page: number; pageSize: number }> {
  const { type, month, page, pageSize } = query;

  // aggregate 的 $match 不做 Mongoose 类型转换，userId 需手动转 ObjectId
  const filter: Record<string, any> = { userId: new Types.ObjectId(userId), status: 'finished' };
  if (type) filter.type = type;
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
          createdAt: 1,
          pointsCount: { $size: '$trackPoints' },
          markerCount: { $size: '$markers' },
          firstPoint: { $arrayElemAt: ['$trackPoints', 0] },
          lastPoint: { $arrayElemAt: ['$trackPoints', -1] },
        },
      },
    ]),
  ]);

  return { items, total, page, pageSize };
}

/** 活动详情（含完整轨迹点与打点） */
export async function getActivityDetail(activityId: ObjectIdLike, userId: string): Promise<ActivityDto> {
  const activity = await findOwnedActivity(activityId, userId);
  return toActivityDto(activity);
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
