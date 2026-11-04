import type { FastifyInstance } from 'fastify';
import { success } from '../utils/response.js';
import { adminAuth, adminIdOf } from '../utils/admin-auth.js';
import {
  listPaidProductsForAdmin, createPaidProduct, updatePaidProduct,
  setPaidProductActive, setPaidProductSortOrder,
} from '../services/paid-products.js';
import { isMemberPaymentsEnabled, setMemberPaymentsEnabled } from '../services/member-switch.js';
import { getReminderSettings, setReminderSettings, runMemberExpiryReminders } from '../services/member-reminder.js';
import {
  getWeeklySportsSettings,
  setWeeklySportsSettings,
  runWeeklySportsReminders,
} from '../services/weekly-sports-reminder.js';
import {
  listXpayOrders, getXpayOrderDetail, refundPreview, startRefund, manualQuery,
  type XpayOrderListQuery,
} from '../services/xpay-admin.js';
import { isXpayPayConfigured, isXpayPushConfigured } from '../config/xpay.js';

/**
 * 支付域管理端（spec §6.3）。与 admin.routes.ts 分开是因为后者已 1799 行；鉴权沿用同一个 adminAuth
 * （已从 src/utils/admin-auth.ts 导出，不存在「两份验签」）。
 */
export async function adminXpayRoutes(fastify: FastifyInstance) {
  fastify.get('/products', { onRequest: [adminAuth] }, async () =>
    success(await listPaidProductsForAdmin()));

  fastify.post('/products', { onRequest: [adminAuth] }, async (request) =>
    success(await createPaidProduct((request.body ?? {}) as Record<string, unknown>), '已创建'));

  fastify.put('/products/:id', { onRequest: [adminAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    return success(await updatePaidProduct(id, (request.body ?? {}) as Record<string, unknown>), '已更新');
  });

  fastify.patch('/products/:id/active', { onRequest: [adminAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { active?: unknown };
    return success(await setPaidProductActive(id, body.active === true), '已更新');
  });

  // 排序与上下架同律：PUT 拒绝这两列，各自一条 PATCH（Task 13 的目录页要能改排序）
  fastify.patch('/products/:id/sort-order', { onRequest: [adminAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { sortOrder?: unknown };
    return success(await setPaidProductSortOrder(id, body.sortOrder), '已更新');
  });

  // ==================== 订单 ====================

  fastify.get('/orders', { onRequest: [adminAuth] }, async (request) => {
    const q = request.query as XpayOrderListQuery;
    return success(await listXpayOrders(q));
  });

  fastify.get('/orders/:id', { onRequest: [adminAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    return success(await getXpayOrderDetail(id));
  });

  // 三步退款：第一步单独成接口，让「刷新额度」这件事在 UI 上有明确的一次点击
  fastify.post('/orders/:id/refund-preview', { onRequest: [adminAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    return success(await refundPreview(id));
  });

  fastify.post('/orders/:id/refund', { onRequest: [adminAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { refundFee?: unknown; reason?: unknown; reasonCode?: unknown };
    return success(await startRefund(id, body, adminIdOf(request)), '退款已发起');
  });

  fastify.post('/orders/:id/query', { onRequest: [adminAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    return success(await manualQuery(id));
  });

  // 会员到期提醒（一次性订阅）设置：开关 / 模板 ID / 提前天数
  fastify.get('/reminder-settings', { onRequest: [adminAuth] }, async () =>
    success(await getReminderSettings()));

  fastify.put('/reminder-settings', { onRequest: [adminAuth] }, async (request) => {
    const next = await setReminderSettings(request.body);
    console.warn(`[member-reminder] 设置更新 → enabled=${next.enabled} days=${next.daysBefore}（admin=${adminIdOf(request)}）`);
    return success(next, '已保存');
  });

  // 手动跑一轮（幂等；联调/补发用）
  fastify.post('/reminder-settings/run', { onRequest: [adminAuth] }, async () =>
    success(await runMemberExpiryReminders(), '已执行'));

  // 每周运动数据提醒（一次性订阅）：开关 / 模板 ID；发送时间固定周一 09:00
  fastify.get('/weekly-sports-settings', { onRequest: [adminAuth] }, async () =>
    success(await getWeeklySportsSettings()));

  fastify.put('/weekly-sports-settings', { onRequest: [adminAuth] }, async (request) => {
    const next = await setWeeklySportsSettings(request.body);
    console.warn(`[weekly-sports] 设置更新 → enabled=${next.enabled}（admin=${adminIdOf(request)}）`);
    return success(next, '已保存');
  });

  // 手动跑一轮：绕过周一 09:00 的时间闸门，联调/补发用；同周幂等
  fastify.post('/weekly-sports-settings/run', { onRequest: [adminAuth] }, async () =>
    success(await runWeeklySportsReminders(Date.now(), { force: true }), '已执行'));

  // 会员开关 + 就绪度自检：运营要能看到「密钥配了没」，否则开关一开就全线报错还没法自证
  fastify.get('/member-switch', { onRequest: [adminAuth] }, async () =>
    success({
      enabled: await isMemberPaymentsEnabled(),
      payConfigured: isXpayPayConfigured(),
      pushConfigured: isXpayPushConfigured(),
    }));

  fastify.post('/member-switch', { onRequest: [adminAuth] }, async (request) => {
    const body = (request.body ?? {}) as { enabled?: unknown };
    const enabled = body.enabled === true;
    await setMemberPaymentsEnabled(enabled);
    // 开关是钱闸：谁（adminId）何时拨到哪边要留痕（与榜单开关同一条审计纪律）
    console.warn(`[xpay] 会员付费开关 → ${enabled ? 'ON' : 'OFF'}（admin=${adminIdOf(request)}）`);
    return success({
      enabled,
      payConfigured: isXpayPayConfigured(),
      pushConfigured: isXpayPushConfigured(),
      ...(enabled && !isXpayPayConfigured() ? { hint: '密钥未配置：开关已打开但下单会报「支付服务未就绪」' } : {}),
    });
  });
}
