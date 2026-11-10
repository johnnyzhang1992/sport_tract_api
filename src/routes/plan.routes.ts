/** 运动计划：查询/保存本人计划 + 当期完成度（登录态） */
import type { FastifyInstance } from 'fastify';
import { getPlanWithProgress, upsertPlan } from '../services/exercise-plan.js';
import { success } from '../utils/response.js';

export async function planRoutes(fastify: FastifyInstance) {
  fastify.get('/current', { onRequest: [fastify.authenticate] }, async (request) =>
    success(await getPlanWithProgress(request.user.userId)),
  );

  fastify.put('/', { onRequest: [fastify.authenticate] }, async (request) => {
    const saved = await upsertPlan(request.user.userId, request.body);
    return success(saved, '已保存');
  });
}
