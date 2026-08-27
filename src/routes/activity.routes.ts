import type { FastifyInstance } from 'fastify';
import {
  appendPoints,
  addMarker,
  cancelActivity,
  createActivity,
  deleteActivity,
  finishActivity,
  getActivityDetailView,
  getActivityForGpx,
  listActivities,
  removeMarker,
  updateMarker,
  updateActivityMeta,
  reprocessActivity,
} from '../services/activity.js';
import { assertActivityForGpx, toGpx } from '../services/gpx.js';
import { ActivityModel } from '../models/activity.model.js';
import { deleteOssObjects, getSignedUrl } from '../services/oss.js';
import { importActivity } from '../services/import.js';
import { z } from 'zod';
import { success } from '../utils/response.js';
import { AppError } from '../utils/app-error.js';
import {
  AppendPointsSchema,
  CreateActivitySchema,
  CreateMarkerSchema,
  FinishActivitySchema,
  ListActivitiesQuery,
  UpdateMarkerSchema,
} from '../utils/validators.js';

/** 轨迹新增防刷：1 小时滑动窗口内最多创建 10 条，超出拒绝（冻结 1 小时） */
const CREATE_LIMIT = 10;
const CREATE_WINDOW_MS = 3600000;

async function assertCanCreate(userId: string) {
  const since = Date.now() - CREATE_WINDOW_MS;
  const recent = await ActivityModel.countDocuments({
    userId,
    createdAt: { $gte: new Date(since) },
  });
  if (recent >= CREATE_LIMIT) {
    throw new AppError(
      429,
      `创建过于频繁，1 小时内最多新增 ${CREATE_LIMIT} 条，请 1 小时后再试`,
    );
  }
}

/**
 * 运动记录路由（M2 核心同步协议）
 * 前缀：/api/activities，全部需登录（未登录无法新增/读取）
 */
export async function activityRoutes(fastify: FastifyInstance) {
  // 创建进行中活动
  fastify.post('/', { onRequest: [fastify.authenticate] }, async (request) => {
    await assertCanCreate(request.user.userId); // 防刷：1 小时 10 条上限
    const input = CreateActivitySchema.parse(request.body);
    const activity = await createActivity(request.user.userId, input);
    return success({ activityId: activity.id, activity }, '活动已创建');
  });

  // 增量上传轨迹点（幂等去重）
  fastify.post('/:id/points', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = AppendPointsSchema.parse(request.body);
    const result = await appendPoints(id, request.user.userId, input);
    return success(result, '轨迹点已同步');
  });

  // 新增打点
  fastify.post('/:id/markers', { onRequest: [fastify.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const input = CreateMarkerSchema.parse(request.body);
    const result = await addMarker(id, request.user.userId, input);
    return success(result, '打点成功');
  });

  // 编辑打点（运动结束后可补充/编辑）
  fastify.put('/:id/markers/:markerId', { onRequest: [fastify.authenticate] }, async (request) => {
    const { id, markerId } = request.params as { id: string; markerId: string };
    const input = UpdateMarkerSchema.parse(request.body);
    const result = await updateMarker(id, request.user.userId, markerId, input);
    return success(result, '打点已更新');
  });

  // 删除打点（同步清理照片 OSS 文件）
  fastify.delete('/:id/markers/:markerId', { onRequest: [fastify.authenticate] }, async (request) => {
    const { id, markerId } = request.params as { id: string; markerId: string };
    const { marker } = await removeMarker(id, request.user.userId, markerId);
    const urls = [marker.photoUrl, ...(marker.photos ?? [])].filter(Boolean);
    if (urls.length > 0) {
      try {
        await deleteOssObjects(urls);
      } catch {
        // 照片清理失败不阻塞删除
      }
    }
    return success(null, '打点已删除');
  });

  // 结束活动（final 包对账）
  fastify.put('/:id/finish', { onRequest: [fastify.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const input = FinishActivitySchema.parse(request.body);
    const result = await finishActivity(id, request.user.userId, input);
    return success(result, '运动已保存');
  });

  // 放弃活动
  fastify.put('/:id/cancel', { onRequest: [fastify.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    await cancelActivity(id, request.user.userId);
    return success(null, '已放弃该次运动');
  });

  // 活动列表（分页 + 类型/月份筛选）
  fastify.get('/', { onRequest: [fastify.authenticate] }, async (request) => {
    const query = ListActivitiesQuery.parse(request.query);
    const result = await listActivities(request.user.userId, query);
    return success(result);
  });

  // 活动详情（分享/只读查看：未登录/非本人仅 finished 可读，isOwner=false 只读；本人全功能）
  // 可选鉴权：游客也能打开分享链接查看；照片 URL 签名，bucket 私有可正常加载
  fastify.get('/:id', { onRequest: [fastify.authenticateOptional] }, async (request) => {
    const { id } = request.params as { id: string };
    const activity = await getActivityDetailView(id, request.user?.userId);
    // 私有 bucket：给打点照片签发访问签名 URL（库内仍存裸 URL）
    for (const m of activity.markers) {
      if (m.photos && m.photos.length > 0) {
        m.photos = m.photos.map((p) => getSignedUrl(p));
        // photoUrl 复用首图签名（同一 URL，避免前端按地址去重失效）
        m.photoUrl = m.photos[0];
      } else if (m.photoUrl) {
        m.photoUrl = getSignedUrl(m.photoUrl);
      }
    }
    return success(activity);
  });

  // 导出 GPX
  fastify.get('/:id/gpx', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const activity = await getActivityForGpx(id, request.user.userId);
    assertActivityForGpx(activity);
    reply.header('Content-Type', 'application/gpx+xml; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="activity-${id}.gpx"`);
    return toGpx(activity);
  });

  // 重新纠偏（事后清洗历史轨迹）
  fastify.post('/:id/reprocess', { onRequest: [fastify.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const activity = await reprocessActivity(id, request.user.userId);
    return success({ activity }, '已重新纠偏');
  });

  // 更新活动信息（类型/备注）
  fastify.put('/:id/meta', { onRequest: [fastify.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const input = z
      .object({ type: z.string().min(1).optional(), note: z.string().max(500).optional(), source: z.string().max(50).optional() })
      .parse(request.body);
    const result = await updateActivityMeta(id, request.user.userId, input);
    return success(result, '已更新');
  });

  // 删除活动
  fastify.delete('/:id', { onRequest: [fastify.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    await deleteActivity(id, request.user.userId);
    return success(null, '已删除');
  });

  // 导入轨迹文件（GPX/KML/TCX，multipart 上传）
  fastify.post('/import', { onRequest: [fastify.authenticate] }, async (request) => {
    await assertCanCreate(request.user.userId); // 防刷：导入也算新增
    const part = await request.file({ limits: { fileSize: 2 * 1024 * 1024 } });
    if (!part) {
      throw new AppError(400, '请上传轨迹文件');
    }
    const content = await part.toBuffer();
    const filename = part.filename || 'track.gpx';
    // multipart 字段（wx.uploadFile formData）
    const typeField = (part.fields?.type ?? part.fields?.['type']) as string | undefined;
    const typeOverride = typeof typeField === 'string' && typeField ? typeField : undefined;
    const sourceField = (part.fields?.source ?? part.fields?.['source']) as string | undefined;
    const source = typeof sourceField === 'string' && sourceField ? sourceField : undefined;
    const result = await importActivity(request.user.userId, filename, content.toString('utf8'), typeOverride, source);
    return success(result, '导入成功');
  });
}
