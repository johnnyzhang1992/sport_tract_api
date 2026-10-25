import type { FastifyInstance } from 'fastify';
import { PointCardModel } from '../models/point.model.js';
import { getBalance, listPointRecords, settleExpired } from '../services/points-ledger.js';
import { getSigninState, signIn, useMakeupCard } from '../services/points-signin.js';
import { getTaskRows, claimTask } from '../services/points-tasks.js';
import { getItems, exchangeMakeupCard, listExchanges } from '../services/points-items.js';
import { success } from '../utils/response.js';

/**
 * 积分中心接口（全部需登录）。
 *
 * 汇总一次带回签到状态（含未使用补签卡数）、任务行、商品与余额，前端首页/积分页只发一个请求。
 * 业务错误（AppError）由全局 error-handler 统一转成 400/404，路由层只做参数解包。
 */
export async function pointsRoutes(fastify: FastifyInstance) {
  fastify.get('/summary', { onRequest: [fastify.authenticate] }, async (request) => {
    const userId = request.user.userId;
    // 先结算过期批次，保证余额/卡数与后续各接口看到的口径一致
    await settleExpired(userId);
    const now = Date.now();
    const [signin, tasks, items, balance, cards, card] = await Promise.all([
      getSigninState(userId, now),
      getTaskRows(userId),
      getItems(),
      getBalance(userId, now),
      PointCardModel.countDocuments({ userId, status: 'unused', expiresAt: { $gt: now } }),
      // makeupCardId 是旧契约（客户端传卡 id）的残留：改版后由服务端自己挑卡，前端不再需要它。
      // spec §5.1 要求删掉，随 Task 5 的 summary DTO 接线一起撤，这里只保留字段不再宣称「补签昨天」。
      PointCardModel.findOne({ userId, status: 'unused', expiresAt: { $gt: now } })
        .sort({ expiresAt: 1, _id: 1 })
        .select({ _id: 1 })
        .lean(),
    ]);
    return success({
      balance,
      signin: { ...signin, cards, makeupCardId: card ? String(card._id) : '' },
      tasks,
      // 下发整张商品表（不是 items[0]）：积分页按道具列表渲染商品卡，将来加道具不用再改接口
      items,
    });
  });

  // 今日签到（幂等：重复提交返回 alreadySigned，不再发分）
  fastify.post('/sign-in', { onRequest: [fastify.authenticate] }, async (request) =>
    success(await signIn(request.user.userId)));

  // 积分明细（分页；pageSize 上限由 service 统一收紧到 50）
  fastify.get('/records', { onRequest: [fastify.authenticate] }, async (request) => {
    const q = request.query as { page?: string; pageSize?: string };
    return success(await listPointRecords(
      request.user.userId,
      Math.max(1, Number(q.page) || 1),
      Math.min(50, Number(q.pageSize) || 20),
    ));
  });

  // 领取任务奖励（条件不满足 400、任务不存在 404 由 service 抛）
  fastify.post('/tasks/:taskKey/claim', { onRequest: [fastify.authenticate] }, async (request) => {
    const { taskKey } = request.params as { taskKey: string };
    return success(await claimTask(request.user.userId, taskKey));
  });

  // 商品列表（当前固定一张补签卡，价格/有效期来自配置）
  fastify.get('/items', { onRequest: [fastify.authenticate] }, async () =>
    success(getItems()));

  // 兑换补签卡：requestId 由客户端生成，同一 requestId 连点只扣一次分、只发一张卡
  fastify.post('/items/makeup_card/exchange', { onRequest: [fastify.authenticate] }, async (request) => {
    const { requestId } = (request.body ?? {}) as { requestId?: string };
    return success(await exchangeMakeupCard(request.user.userId, String(requestId || '')));
  });

  // 补签窗口内的某一天（spec §5.2）：只传 dateKey，哪张卡由服务端挑（旧 /cards/:id/use 已撤）
  fastify.post('/signin/makeup', { onRequest: [fastify.authenticate] }, async (request) => {
    const { dateKey } = (request.body ?? {}) as { dateKey?: string };
    return success(await useMakeupCard(request.user.userId, String(dateKey ?? '')));
  });

  // 兑换记录（按兑换时间倒序，状态实时推导）
  fastify.get('/exchanges', { onRequest: [fastify.authenticate] }, async (request) =>
    success(await listExchanges(request.user.userId)));
}
