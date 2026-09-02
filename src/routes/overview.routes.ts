import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getOverview, OVERVIEW_RANGES } from '../services/overview.js';
import { success } from '../utils/response.js';
import { AppError } from '../utils/app-error.js';

// from/to（epoch ms）与 range 二选一：报告页查历史周/月/年用精确区间，轨迹合集页沿用滑动 range
const QuerySchema = z
  .object({
    range: z.enum(OVERVIEW_RANGES).default('week'),
    from: z.coerce.number().int().optional(),
    to: z.coerce.number().int().optional(),
  })
  .refine((q) => (q.from == null) === (q.to == null), { message: 'from/to 必须成对出现' })
  .refine((q) => q.from == null || q.to == null || q.from < q.to, { message: 'from 必须早于 to' });

/** 轨迹合集：GET /api/overview?range=week|month|year|all 或 ?from=&to=（epoch ms） */
export async function overviewRoutes(fastify: FastifyInstance) {
  fastify.get('/', { onRequest: [fastify.authenticate] }, async (request) => {
    const { range, from, to } = QuerySchema.parse(request.query);
    if (from != null && to != null) {
      if (from < 946684800000) throw new AppError(400, 'from 早于 2000-01-01'); // 946684800000 = 2000-01-01
      // 当前周期是不完整区间：周/月/年的 to 可能落在未来（本周下周一、本月次月一日、今年次年一日），放宽到一年内
      if (to > Date.now() + 366 * 86400000) throw new AppError(400, 'to 超出允许范围');
      const data = await getOverview(request.user.userId, range, { from, to });
      return success(data);
    }
    const data = await getOverview(request.user.userId, range);
    return success(data);
  });
}
