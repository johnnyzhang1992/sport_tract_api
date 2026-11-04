import type { FastifyInstance } from 'fastify';
import {
  notificationSummary,
  listNotifications,
  getNotificationDetail,
  markNotificationRead,
  markAllNotificationsRead,
} from '../services/notification.js';
import {
  grantMessageSubscription,
  listMessageSubscriptions,
} from '../services/subscriptions.js';
import { success } from '../utils/response.js';

/** 系统通知：公开接口游客可读；已读上报需登录 */
export async function notificationRoutes(fastify: FastifyInstance) {
  // 首页单行 + 个人中心角标：一次带回最新一条与未读数
  fastify.get('/summary', { onRequest: [fastify.authenticateOptional] }, async (request) => {
    return success(await notificationSummary(request.user?.userId));
  });

  // 历史消息列表（已发布全量，倒序）；2026-11-04 起支持分类 / 搜索 / 只看未读
  fastify.get('/', { onRequest: [fastify.authenticateOptional] }, async (request) => {
    const query = (request.query ?? {}) as { category?: string; q?: string; unread?: string };
    return success(await listNotifications(request.user?.userId, {
      category: query.category,
      q: query.q,
      unreadOnly: query.unread === '1' || query.unread === 'true',
    }));
  });

  // 消息订阅：只列真正会下发的模板；状态来自本地额度台账（微信没有查询接口）
  fastify.get('/subscriptions', { onRequest: [fastify.authenticate] }, async (request) =>
    success(await listMessageSubscriptions(request.user.userId)));

  fastify.post('/subscriptions/grant', { onRequest: [fastify.authenticate] }, async (request) => {
    const body = (request.body ?? {}) as { key?: unknown; scene?: unknown };
    return success(await grantMessageSubscription(request.user.userId, body.key, body.scene));
  });

  // 通知详情（广播人人可读；定向行只有收件人可读，别人 404）
  fastify.get('/:id', { onRequest: [fastify.authenticateOptional] }, async (request) => {
    const { id } = request.params as { id: string };
    return success(await getNotificationDetail(id, request.user?.userId));
  });

  // 打开详情后标已读（幂等）
  // 一键全读：消息中心「全部已读」按钮；幂等，返回最新未读数（恒 0）
  fastify.post('/read-all', { onRequest: [fastify.authenticate] }, async (request) =>
    success(await markAllNotificationsRead(request.user.userId)));

  fastify.post('/:id/read', { onRequest: [fastify.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    return success(await markNotificationRead(request.user.userId, id));
  });
}
