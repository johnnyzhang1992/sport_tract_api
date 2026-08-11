import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { reverseGeocode } from '../services/geo.js';
import { success } from '../utils/response.js';

const ReverseQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

/** 地理路由：GET /api/geo/reverse（逆地理编码，后端持 key，避免前端暴露） */
export async function geoRoutes(fastify: FastifyInstance) {
  fastify.get('/reverse', { onRequest: [fastify.authenticate] }, async (request) => {
    const { lat, lng } = ReverseQuery.parse(request.query);
    const address = await reverseGeocode(lat, lng);
    return success({ address });
  });
}
