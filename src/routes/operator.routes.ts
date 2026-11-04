/**
 * 运营者接口（role=admin 的微信用户＝站内运营者，2026-11-04）。
 *
 * 定位：移动端轻量运营工具——数据概览、待处理订单、移动端退款审批。
 * 与 webAdmin（AdminModel 账号）的关系：同一套底层服务（xpay-admin 的列表/预览/退款），
 * 不同身份通道；webAdmin 是全量后台，这里只挑适合手机操作的能力。
 * 所有路由：先 fastify.authenticate（用户 JWT）再 requireOperator（实时查库 role=admin）。
 */
import type { FastifyInstance } from 'fastify';
import { success } from '../utils/response.js';
import { requireOperator, operatorIdOf } from '../utils/operator-auth.js';
import { UserModel } from '../models/user.model.js';
import { collectDailyStats } from '../services/admin-daily-stats.js';
import { listXpayOrders, refundPreview, startRefund } from '../services/xpay-admin.js';
import { bjToday0 } from '../utils/bj-time.js';

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
    return success({ today, yesterday, generatedAt: Date.now() });
  });

  // 订单列表：默认看「已生效 + 退款中」（需要运营者关注的两态），可按状态覆盖
  fastify.get('/orders', guard, async (request) => {
    const q = (request.query ?? {}) as { status?: string; page?: string };
    return success(
      await listXpayOrders({
        status: q.status ?? 'delivered,refunding',
        channel: '',
        keyword: '',
        page: Number(q.page ?? 1) || 1,
        pageSize: 20,
      }),
    );
  });

  fastify.post('/orders/:id/refund-preview', guard, async (request) => {
    const { id } = request.params as { id: string };
    return success(await refundPreview(id));
  });

  // 移动端退款审批：与 webAdmin 同一套 startRefund（校验/幂等/审计全复用），
  // reqFrom='1'（人工客服发起）；iOS 单被 startRefund 拦下并给 App Store 指引
  fastify.post('/orders/:id/refund', guard, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { refundFee?: unknown; reason?: unknown; reasonCode?: unknown };
    return success(
      await startRefund(id, body, `operator:${operatorIdOf(request)}`),
      '退款已发起',
    );
  });
}
