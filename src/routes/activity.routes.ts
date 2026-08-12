import type { FastifyInstance } from 'fastify';
import {
  appendPoints,
  addMarker,
  cancelActivity,
  createActivity,
  deleteActivity,
  finishActivity,
  getActivityDetail,
  getActivityForGpx,
  listActivities,
  removeMarker,
  updateMarker,
} from '../services/activity.js';
import { assertActivityForGpx, toGpx } from '../services/gpx.js';
import { deleteOssObjects, getSignedUrl } from '../services/oss.js';
import { importActivity } from '../services/import.js';
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

/**
 * 运动记录路由（M2 核心同步协议）
 * 前缀：/api/activities，全部需登录
 */
export async function activityRoutes(fastify: FastifyInstance) {
  // 创建进行中活动
  fastify.post('/', { onRequest: [fastify.authenticate] }, async (request) => {
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

  // 活动详情（完整轨迹点 + 打点；照片 URL 签名，bucket 私有可正常加载）
  fastify.get('/:id', { onRequest: [fastify.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const activity = await getActivityDetail(id, request.user.userId);
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

  // 删除活动
  fastify.delete('/:id', { onRequest: [fastify.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    await deleteActivity(id, request.user.userId);
    return success(null, '已删除');
  });

  // 导入轨迹文件（GPX/KML/TCX，multipart 上传）
  fastify.post('/import', { onRequest: [fastify.authenticate] }, async (request) => {
    const part = await request.file({ limits: { fileSize: 2 * 1024 * 1024 } });
    if (!part) {
      throw new AppError(400, '请上传轨迹文件');
    }
    const content = await part.toBuffer();
    const filename = part.filename || 'track.gpx';
    const body = request.body as Record<string, unknown> | undefined;
    const typeOverride =
      typeof body?.type === 'string' && body.type ? (body.type as string) : undefined;
    const result = await importActivity(request.user.userId, filename, content.toString('utf8'), typeOverride);
    return success(result, '导入成功');
  });
}
