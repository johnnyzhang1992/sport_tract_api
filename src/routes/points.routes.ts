import type { FastifyInstance } from 'fastify';
import { getBalance, listPointRecords, settleExpired } from '../services/points-ledger.js';
import { getSigninState, signIn, useMakeupCard } from '../services/points-signin.js';
import { getTaskRows, claimTask } from '../services/points-tasks.js';
import { listActiveItems, exchangeItem, listExchanges } from '../services/points-items.js';
import { confirmReceipt, listMyOrders } from '../services/points-orders.js';
import { activateCard, adFreeUntilOf, countUnusedCards } from '../services/points-cards.js';
import { getSigninCalendar } from '../services/points-calendar.js';
import { expiringOf, streakPercentileOf } from '../services/points-summary.js';
import { scheduleLazySettle } from '../services/board-lazy-settle.js';
import { success } from '../utils/response.js';

/**
 * 积分中心接口（全部需登录）。
 *
 * 汇总一次带回签到状态（含七格 cells 与未使用补签卡数）、任务行、商品与余额，前端首页/积分页只发一个请求。
 * 业务错误（AppError）由全局 error-handler 统一转成 400/404，路由层只做参数解包。
 */
export async function pointsRoutes(fastify: FastifyInstance) {
  fastify.get('/summary', { onRequest: [fastify.authenticate] }, async (request) => {
    const userId = request.user.userId;
    // 懒结算后台触发（Task 9 / spec §4.2）：放在读汇总之前，但**不等它、也不因它失败**——
    // 下面所有数据都不依赖结算结果，这趟没到账下趟进页自然看到（每用户限频＋吞错在调度器里）。
    scheduleLazySettle(userId);
    // 先结算过期批次，保证余额/卡数与后续各接口看到的口径一致
    await settleExpired(userId);
    const now = Date.now();
    const [signin, tasks, items, balance, adFreeUntil, cardsByItem, expiring, streakPercentile] = await Promise.all([
      getSigninState(userId, now),
      getTaskRows(userId),
      listActiveItems(),
      getBalance(userId, now),
      // 免广告到期时刻与持卡数都是现推不落字段（spec §5.4），与卡行永远同一口径
      adFreeUntilOf(userId),
      countUnusedCards(userId, now),
      expiringOf(userId, now),
      streakPercentileOf(userId, now),
    ]);
    return success({
      balance,
      // signin 原样下发（spec §5.1）：cards/cells 都在 getSigninState 里算好；
      // 旧契约字段 makeupCardId（客户端传卡 id）与 canMakeUp/makeupDate 已撤——
      // 可补与否唯一来源是 cells 里 state === 'makeup'，用哪张卡由服务端自己挑（spec §5.2）。
      signin,
      tasks,
      // 下发整张商品表（不是 items[0]）：积分页按道具列表渲染商品卡，将来加道具不用再改接口
      items,
      // 端上按 adFreeUntil > now 跳过自主代码位广告；cards 给卡包页/「我的补签卡 N 张」用（spec §7.3）
      adFreeUntil,
      cards: cardsByItem,
      // 积分页两张新卡（2026-10-28）：过期提醒只在 ≤EXPIRE_NOTICE_DAYS 时非 null，
      // 阈值判定在服务端，端上只按有值/无值渲染整行；百分位按全部注册用户算，本人 0 天时是 0
      expiring,
      streakPercentile,
    });
  });

  // 今日签到（幂等：重复提交返回 alreadySigned，不再发分）
  fastify.post('/sign-in', { onRequest: [fastify.authenticate] }, async (request) =>
    success(await signIn(request.user.userId)));

  // 积分明细（分页；pageSize 上限由 service 统一收紧到 50）
  fastify.get('/records', { onRequest: [fastify.authenticate] }, async (request) => {
    const q = request.query as { page?: string; pageSize?: string; type?: string };
    return success(await listPointRecords(
      request.user.userId,
      Math.max(1, Number(q.page) || 1),
      Math.min(50, Number(q.pageSize) || 20),
      Date.now(),
      q.type ? String(q.type) : undefined,
    ));
  });

  // 领取任务奖励（条件不满足 400、任务不存在 404 由 service 抛）
  fastify.post('/tasks/:taskKey/claim', { onRequest: [fastify.authenticate] }, async (request) => {
    const { taskKey } = request.params as { taskKey: string };
    return success(await claimTask(request.user.userId, taskKey));
  });

  // 商品列表（读道具目录，只下发在架项；老客户端读 items[0] 仍是补签卡）
  fastify.get('/items', { onRequest: [fastify.authenticate] }, async () =>
    success(await listActiveItems()));

  // 兑换：requestId 由客户端生成，同一 requestId 连点只扣一次分、只发一张卡/一张订单、只扣一次库存
  // 路径泛化为 /items/:itemKey/exchange：/items/makeup_card/exchange 是它的实例，老客户端不用改
  // 实物道具必须带 address（服务层校验；虚拟道具忽略它）
  fastify.post('/items/:itemKey/exchange', { onRequest: [fastify.authenticate] }, async (request) => {
    const { itemKey } = request.params as { itemKey: string };
    const { requestId, address } = (request.body ?? {}) as { requestId?: string; address?: unknown };
    return success(await exchangeItem(
      request.user.userId, itemKey, String(requestId || ''), Date.now(), address,
    ));
  });

  // 我的实物订单（只含本人，按下单时间倒序）
  fastify.get('/orders', { onRequest: [fastify.authenticate] }, async (request) =>
    success(await listMyOrders(request.user.userId)));

  // 确认收货：只能 shipped → completed（状态不对 400、非本人/不存在 404）
  fastify.post('/orders/:id/confirm', { onRequest: [fastify.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    return success(await confirmReceipt(request.user.userId, id));
  });

  // 补签窗口内的某一天（spec §5.2）：只传 dateKey，哪张卡由服务端挑（旧 /cards/:id/use 已撤）
  fastify.post('/signin/makeup', { onRequest: [fastify.authenticate] }, async (request) => {
    const { dateKey } = (request.body ?? {}) as { dateKey?: string };
    return success(await useMakeupCard(request.user.userId, String(dateKey ?? '')));
  });

  // 签到月历（积分页半屏日历）：month 缺省为当月；「可补」判据与七格同源，端上不再自己推
  fastify.get('/signin/calendar', { onRequest: [fastify.authenticate] }, async (request) => {
    const { month } = request.query as { month?: string };
    return success(await getSigninCalendar(request.user.userId, String(month ?? '')));
  });

  // 激活免广告卡（补签卡不走这条路，见 POST /signin/makeup）
  fastify.post('/cards/:cardId/activate', { onRequest: [fastify.authenticate] }, async (request) => {
    const { cardId } = request.params as { cardId: string };
    return success(await activateCard(request.user.userId, cardId));
  });

  // 兑换记录（按兑换时间倒序，状态实时推导）
  fastify.get('/exchanges', { onRequest: [fastify.authenticate] }, async (request) =>
    success(await listExchanges(request.user.userId)));
}
