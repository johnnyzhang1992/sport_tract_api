import type { FastifyInstance } from 'fastify';
import { listActiveTopics, getActiveTopicDetail } from '../services/topic.js';
import { success } from '../utils/response.js';

/** 专题（官方信息）：GET /api/topics/active 与 /api/topics/:id（可选鉴权，游客可见） */
export async function topicRoutes(fastify: FastifyInstance) {
  // 首页入口：生效中的专题列表
  fastify.get('/active', { onRequest: [fastify.authenticateOptional] }, async () => {
    return success(await listActiveTopics());
  });

  // 专题详情（markdown 正文，图片已签名）
  fastify.get('/:id', { onRequest: [fastify.authenticateOptional] }, async (request) => {
    const { id } = request.params as { id: string };
    return success(await getActiveTopicDetail(id));
  });
}
