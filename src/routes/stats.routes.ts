import type { FastifyInstance } from 'fastify';
import { overview, trend, bestRecords, yearMilestones, activityMonthly, distancePercentile } from '../services/stats.js';
import { ACTIVITY_TYPES } from '../config/constants.js';
import { AppError } from '../utils/app-error.js';
import { footprint } from '../services/footprint.js';
import {
  leaderboard,
  leaderboardMe,
  leaderboardRegions,
  leaderboardTypeCounts,
  homeLeaderboardSummary,
} from '../services/leaderboard.js';
import { scheduleLazySettle } from '../services/board-lazy-settle.js';
import { collectSection } from '../utils/section.js';
import { success } from '../utils/response.js';

/** 统计路由：/api/stats（决策 F18/F19） */
export async function statsRoutes(fastify: FastifyInstance) {
  /**
   * 首页三段合并：一次请求带回累计数据 / 点亮省市 / 运动日历。
   * 按段独立降级（collectSection）：某一段失败只让那段 ok:false，另两段照常下发 ——
   * 合并成一次请求不能把 3cb2d5e 修掉的「一个接口挂掉、整块卡片消失」请回来。
   * 三个老接口保持不动（统计页 / 我的 / 足迹分包仍在用）。
   */
  fastify.get('/home', { onRequest: [fastify.authenticate] }, async (request) => {
    const userId = request.user.userId;
    const [overviewSec, footprintSec, heatSec] = await Promise.all([
      collectSection(() => overview(userId)),
      collectSection(() => footprint(userId)),
      collectSection(() => trend(userId, 'daily365')),
    ]);
    return success({ overview: overviewSec, footprint: footprintSec, heat: heatSec });
  });
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

  // 平台分位：累计距离超越全站用户占比（统计页「超越全站 XX%」）
  fastify.get('/percentile', { onRequest: [fastify.authenticate] }, async (request) => {
    return success(await distancePercentile(request.user.userId));
  });

  // 趋势：week(7天) / month(30天) / week6(6个月按周) / year(年按月)；days=365 兼容日历热力图
  // activityType：可选，按运动类型筛选（不传=全部类型）
  fastify.get('/trend', { onRequest: [fastify.authenticate] }, async (request) => {
    const { days, type, activityType } = request.query as {
      days?: string;
      type?: string;
      activityType?: string;
    };
    if (activityType && !ACTIVITY_TYPES.includes(activityType as never)) {
      throw new AppError(400, '运动类型不合法');
    }
    let result;
    if (type === 'month' || type === 'week6' || type === 'year' || type === 'week') {
      result = await trend(request.user.userId, type, activityType);
    } else if (days === '365') {
      // 日历热力图：近 365 天按天
      result = await trend(request.user.userId, 'daily365', activityType);
    } else {
      result = await trend(request.user.userId, 'week', activityType);
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

  // 按月聚合：当前用户某运动类型每月的 次数/距离/时长/千卡 全量汇总（轨迹列表月度统计用）
  fastify.get('/activity-monthly', { onRequest: [fastify.authenticate] }, async (request) => {
    const query = request.query as { type?: string };
    return success(await activityMonthly(request.user.userId, query.type || ''));
  });

  // 运动榜：全平台点亮地图（60s 缓存）
  // ?me=1 时额外带回「我的榜名次」（周→月→年→总，服务端一次请求内回退）；
  // 不传时响应形状与原先完全一致，老调用方（运动榜页）零变化。
  // 可选鉴权（2026-10-26）：游客可看榜单，me 只在登录时附带
  fastify.get('/leaderboard-regions', { onRequest: [fastify.authenticateOptional] }, async (request) => {
    const regions = await leaderboardRegions();
    const { me } = request.query as { me?: string };
    if (me !== '1') return success(regions);
    if (!request.user) return success({ ...regions, me: null });
    return success({ ...regions, me: await homeLeaderboardSummary(request.user.userId) });
  });

  // 运动榜：按 运动类型 > 省份 排行（周期 week/month/year/all；TOP10 昵称完整展示 + 当前用户真实排名）
  // 可选鉴权（2026-10-26）：游客可看榜单（me 为 null，前端不渲染"我的排名"卡）
  fastify.get('/leaderboard', { onRequest: [fastify.authenticateOptional] }, async (request) => {
    const query = request.query as { type?: string; province?: string; period?: string };
    const userId = request.user ? request.user.userId : null;
    // 懒结算后台触发（Task 9 / spec §4.2）：游客绝不触发（替谁结算都不成立）；
    // 只递 userId+时刻，query 里的 period 不参与调度——结算单元由 settleDueForUser 自己派生。
    if (userId) scheduleLazySettle(userId);
    const result = await leaderboard(
      userId,
      query.type || 'running',
      query.province || '全国',
      (query.period || 'all') as 'week' | 'month' | 'year' | 'all',
    );
    return success(result);
  });

  // 运动榜：各运动类型上榜轨迹数（前端 chips 按「有数据的排前面」排序）
  // 可选鉴权（2026-10-26）：游客可看（与榜单本体同口径）
  fastify.get('/leaderboard-type-counts', { onRequest: [fastify.authenticateOptional] }, async (request) => {
    // chips 排序与当前周期一致：period 缺省 week（榜单默认也是周榜）
    const query = request.query as { period?: string };
    const period = (['week', 'month', 'year', 'all'] as const).includes((query.period ?? '') as never)
      ? (query.period as 'week' | 'month' | 'year' | 'all')
      : 'week';
    return success(await leaderboardTypeCounts(period));
  });

  // 运动榜：当前用户各类型榜名次一览（单次聚合；首页摘要按 周榜→月榜→年榜→总榜 回退取最优展示）
  fastify.get('/leaderboard/me', { onRequest: [fastify.authenticate] }, async (request) => {
    const query = request.query as { province?: string; period?: string };
    const result = await leaderboardMe(
      request.user.userId,
      query.province || '全国',
      (query.period || 'week') as 'week' | 'month' | 'year' | 'all',
    );
    return success(result);
  });
}
