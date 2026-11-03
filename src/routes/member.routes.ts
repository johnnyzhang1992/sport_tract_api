import type { FastifyInstance } from 'fastify';
import { success } from '../utils/response.js';
import { createMemberOrder, readOrderForUser, memberProductsPayload } from '../services/xpay-orders.js';
import { entitlementsOf } from '../services/entitlements.js';
import { scheduleLazySync } from '../services/xpay-deliver.js';

/**
 * 会员（虚拟支付）用户侧接口（spec §6.1）。四个都要登录：
 * 商品目录本身不算隐私，但「价格 + 我的到期时间」混在一个响应里，拆成两个入口不值得。
 */
export async function memberRoutes(fastify: FastifyInstance) {
  fastify.get('/products', { onRequest: [fastify.authenticate] }, async (request) => {
    // 懒查单兜底（spec §7.3）：挂在这里而不是定时任务；不等它、也不因它失败
    scheduleLazySync(request.user.userId);
    return success(await memberProductsPayload(request.user.userId));
  });

  fastify.get('/entitlements', { onRequest: [fastify.authenticate] }, async (request) =>
    success(await entitlementsOf(request.user.userId)));

  fastify.post('/order', { onRequest: [fastify.authenticate] }, async (request) => {
    const body = (request.body ?? {}) as { productKey?: unknown; code?: unknown; channel?: unknown };
    return success(await createMemberOrder({
      userId: request.user.userId,
      productKey: body.productKey,
      code: body.code,
      channel: body.channel,
    }), '订单已创建');
  });

  // 前端轮询自家服务器的状态，不看微信回调（spec §6.1：success 回调会丢，不能当发货依据）
  fastify.get('/order/:outTradeNo', { onRequest: [fastify.authenticate] }, async (request) => {
    const { outTradeNo } = request.params as { outTradeNo: string };
    return success(await readOrderForUser(request.user.userId, outTradeNo));
  });
}
