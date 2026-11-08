/**
 * 运营者接口（role=admin 的微信用户，2026-11-04）。
 *
 * 定位：**只读数据概览**——今日/昨日六项指标（聚合数字，不含任何用户级明细）。
 * 退款不在此通道：Android 用户在小程序自助退 / 管理端 webAdmin 操作，iOS 用户走 App Store。
 * 权限隔离：所有路由先 fastify.authenticate（用户 JWT）再 requireOperator
 * （实时查库 role=admin，webAdmin 降权立即生效）；接口只回聚合数，无用户 PII。
 */
import type { FastifyInstance } from 'fastify';
import { success } from '../utils/response.js';
import { requireOperator, operatorIdOf } from '../utils/operator-auth.js';
import { UserModel } from '../models/user.model.js';
import { bjToday0 } from '../utils/bj-time.js';
import { collectDailyStats, bjMonthDay } from '../services/admin-daily-stats.js';
import { operatorTrend } from '../services/operator-trend.js';

const DAY = 86_400_000;

export async function operatorRoutes(fastify: FastifyInstance) {
  const guard = { onRequest: [fastify.authenticate, requireOperator] };

  // 身份自描述：小程序端用它决定「运营中心」入口是否可见
  fastify.get('/me', guard, async (request) => {
    const u = await UserModel.findById(operatorIdOf(request))
      .select({ uid: 1, nickname: 1, role: 1 })
      .lean();
    return success({
      uid: u?.uid ?? null,
      nickname: u?.nickname ?? '',
      role: 'admin',
      capabilities: ['stats', 'orders', 'refund'],
    });
  });

  // 数据概览：今日（实时）+ 昨日（完整自然日）
  fastify.get('/stats/summary', guard, async () => {
    const today0 = bjToday0(Date.now());
    const [today, yesterday] = await Promise.all([
      collectDailyStats(today0),
      collectDailyStats(today0 - DAY),
    ]);
    return success({
      today,
      yesterday: { ...yesterday, dateLabel: bjMonthDay(yesterday.date) },
      generatedAt: Date.now(),
    });
  });

  // 趋势：注册/登录 UV/PV/轨迹，范围×粒度组合约束在 service 校验（400 带实际值）
  fastify.get('/stats/trend', guard, async (request) => {
    const q = request.query as { range?: string; granularity?: string };
    return success(await operatorTrend(q.range ?? 'week', q.granularity));
  });

}
