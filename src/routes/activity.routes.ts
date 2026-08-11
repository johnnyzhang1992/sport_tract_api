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
} from '../services/activity.js';
import { assertActivityForGpx, toGpx } from '../services/gpx.js';
import { success } from '../utils/response.js';
import {
  AppendPointsSchema,
  CreateActivitySchema,
  CreateMarkerSchema,
  FinishActivitySchema,
  ListActivitiesQuery,
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

  // 活动详情（完整轨迹点 + 打点）
  fastify.get('/:id', { onRequest: [fastify.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const activity = await getActivityDetail(id, request.user.userId);
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
}
