import type { FastifyInstance } from 'fastify';
import { success } from '../utils/response.js';
import { AppError } from '../utils/app-error.js';
import {
  CreateFootprintRecordSchema,
  ListFootprintQuery,
  UpdateFootprintRecordSchema,
} from '../utils/validators.js';
import {
  assertCanCreateFootprint,
  createFootprint,
  deleteFootprint,
  footprintCalendar,
  footprintStats,
  getFootprint,
  listFootprintGeo,
  listFootprints,
  updateFootprint,
} from '../services/footprint-record.js';

/**
 * 足迹记录（用户私有的"去过的地方"）
 * 前缀：/api/footprint-records，全部需登录 + 归属过滤
 */
export async function footprintRecordRoutes(fastify: FastifyInstance) {
  fastify.post('/', { onRequest: [fastify.authenticate] }, async (request) => {
    await assertCanCreateFootprint(request.user.userId);
    const input = CreateFootprintRecordSchema.parse(request.body);
    const record = await createFootprint(request.user.userId, input);
    return success({ record }, '足迹已创建');
  });

  fastify.get('/', { onRequest: [fastify.authenticate] }, async (request) => {
    const query = ListFootprintQuery.parse(request.query);
    return success(await listFootprints(request.user.userId, query));
  });

  // 地图专用：全量轻量点（私有数据量级可控，不分页）
  fastify.get('/geo', { onRequest: [fastify.authenticate] }, async (request) => {
    return success(await listFootprintGeo(request.user.userId));
  });

  // 统计页：按省/市聚合（from/to 为 YYYY-MM-DD，含 from 不含 to；省略即全部）
  fastify.get('/stats', { onRequest: [fastify.authenticate] }, async (request) => {
    const q = request.query as { from?: string; to?: string };
    const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
    if (q.from && !DATE_RX.test(q.from)) throw new AppError(400, 'from 需为 YYYY-MM-DD');
    if (q.to && !DATE_RX.test(q.to)) throw new AppError(400, 'to 需为 YYYY-MM-DD');
    if (q.from && q.to && q.from >= q.to) throw new AppError(400, '日期区间不合法（from 需早于 to）');
    return success(await footprintStats(request.user.userId, { from: q.from, to: q.to }));
  });

  // 日历形态：按天打点 + 总览汇总（全量不分页，前端切月在本地过滤 days）
  fastify.get('/calendar', { onRequest: [fastify.authenticate] }, async (request) => {
    return success(await footprintCalendar(request.user.userId));
  });

  fastify.get('/:id', { onRequest: [fastify.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    return success(await getFootprint(id, request.user.userId));
  });

  fastify.put('/:id', { onRequest: [fastify.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const input = UpdateFootprintRecordSchema.parse(request.body);
    const record = await updateFootprint(id, request.user.userId, input);
    return success({ record }, '足迹已更新');
  });

  fastify.delete('/:id', { onRequest: [fastify.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    await deleteFootprint(id, request.user.userId);
    return success(null, '足迹已删除');
  });
}
