import type { FastifyInstance } from 'fastify';
import { overview, trend, bestRecords, yearMilestones } from '../services/stats.js';
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

  // 趋势：week(7天) / month(30天) / week6(6个月按周) / year(年按月)；days=365 兼容日历热力图
  fastify.get('/trend', { onRequest: [fastify.authenticate] }, async (request) => {
    const { days, type } = request.query as { days?: string; type?: string };
    let result;
    if (type === 'month' || type === 'week6' || type === 'year' || type === 'week') {
      result = await trend(request.user.userId, type);
    } else if (days === '365') {
      // 日历热力图：近 365 天按天
      result = await trend(request.user.userId, 'daily365');
    } else {
      result = await trend(request.user.userId, 'week');
    }
    return success(result);
  });

  // 年度里程碑：今年首次点亮的省份/城市、首次尝试的运动类型（年度报告用）
  fastify.get('/year-milestones', { onRequest: [fastify.authenticate] }, async (request) => {
    const query = request.query as { year?: string };
    const year = Math.min(
      new Date().getFullYear(),
      Math.max(2015, Number(query.year) || new Date().getFullYear()),
    );
    return success(await yearMilestones(request.user.userId, year));
  });
}
