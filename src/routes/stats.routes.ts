import type { FastifyInstance } from 'fastify';
import { overview, trend, bestRecords } from '../services/stats.js';
import { footprint } from '../services/footprint.js';
import { success } from '../utils/response.js';

/** 统计路由：/api/stats（决策 F18/F19） */
export async function statsRoutes(fastify: FastifyInstance) {
  // 概览：今日/本周/本月/累计
  fastify.get('/overview', { onRequest: [fastify.authenticate] }, async (request) => {
    const result = await overview(request.user.userId);
    return success(result);
  });

  // 足迹点亮：省/市统计
  fastify.get('/footprint', { onRequest: [fastify.authenticate] }, async (request) => {
    const result = await footprint(request.user.userId);
    return success(result);
  });

  // 个人最佳纪录（PR）
  fastify.get('/best', { onRequest: [fastify.authenticate] }, async (request) => {
    const result = await bestRecords(request.user.userId);
    return success(result);
  });

  // 趋势：近 7/30 天距离与时长
  fastify.get('/trend', { onRequest: [fastify.authenticate] }, async (request) => {
    const { days } = request.query as { days?: string };
    const d = days === '365' ? 365 : days === '30' ? 30 : 7;
    const result = await trend(request.user.userId, d);
    return success(result);
  });
}
