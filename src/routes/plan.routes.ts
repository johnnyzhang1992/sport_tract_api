/** 运动计划：查询/保存本人计划 + 当期完成度（登录态） */
import type { FastifyInstance } from 'fastify';
import {
  getPlanWithProgress, upsertPlan, listPlanHistory, finalizePreviousPeriod,
  listPlanCalendar, getPlanDayDetail,
} from '../services/exercise-plan.js';
import { success } from '../utils/response.js';

export async function planRoutes(fastify: FastifyInstance) {
  fastify.get('/current', { onRequest: [fastify.authenticate] }, async (request) => {
    const userId = request.user.userId;
    // 顺带补上一周期快照（fire-and-forget）：活跃用户即使错过定时任务，历史也不缺档
    finalizePreviousPeriod(userId).catch(() => {});
    return success(await getPlanWithProgress(userId));
  });

  // 历史计划完成情况（后续「计划查询界面」用）：按窗口倒序 + 游标翻页
  fastify.get('/history', { onRequest: [fastify.authenticate] }, async (request) => {
    const q = request.query as { period?: string; limit?: string; cursor?: string };
    return success(await listPlanHistory(request.user.userId, {
      period: q.period,
      limit: q.limit ? Number(q.limit) : undefined,
      cursor: q.cursor ? Number(q.cursor) : undefined,
    }));
  });

  // 月历：每天完成度三环 + 本月周计划记录（?month=YYYY-MM，缺省取当前月）
  fastify.get('/calendar', { onRequest: [fastify.authenticate] }, async (request) => {
    const q = request.query as { month?: string };
    const now = Date.now();
    const month = q.month && /^\d{4}-\d{2}$/.test(q.month)
      ? q.month
      : new Date(now + 8 * 3600_000).toISOString().slice(0, 7);
    return success(await listPlanCalendar(request.user.userId, month));
  });

  // 单日详情：三环 + 当天轨迹摘要（?date=YYYY-MM-DD）
  fastify.get('/day', { onRequest: [fastify.authenticate] }, async (request) => {
    const q = request.query as { date?: string };
    const now = Date.now();
    const date = q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date)
      ? q.date
      : new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
    return success(await getPlanDayDetail(request.user.userId, date));
  });

  fastify.put('/', { onRequest: [fastify.authenticate] }, async (request) => {
    const saved = await upsertPlan(request.user.userId, request.body);
    return success(saved, '已保存');
  });
}
