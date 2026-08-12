import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getOverview, OVERVIEW_RANGES } from '../services/overview.js';
import { success } from '../utils/response.js';

const QuerySchema = z.object({
  range: z.enum(OVERVIEW_RANGES).default('week'),
});

/** 轨迹合集：GET /api/overview?range=week|month|year|all */
export async function overviewRoutes(fastify: FastifyInstance) {
  fastify.get('/', { onRequest: [fastify.authenticate] }, async (request) => {
    const { range } = QuerySchema.parse(request.query);
    const data = await getOverview(request.user.userId, range);
    return success(data);
  });
}
