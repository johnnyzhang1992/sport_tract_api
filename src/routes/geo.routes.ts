import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { reverseGeocode } from '../services/geo.js';
import { getChinaMap, getProvinceMap } from '../services/region.js';
import { success } from '../utils/response.js';

const ReverseQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

const ProvinceQuery = z.object({
  adcode: z.coerce.number(),
});

/** 地理路由：GET /api/geo/reverse（逆地理编码，后端持 key，避免前端暴露） */
export async function geoRoutes(fastify: FastifyInstance) {
  fastify.get('/reverse', { onRequest: [fastify.authenticate] }, async (request) => {
    const { lat, lng } = ReverseQuery.parse(request.query);
    const address = await reverseGeocode(lat, lng);
    return success({ address });
  });

  // 中国省界地图数据（点亮地图用；体积大放后端，前端按需拉取缓存；公开接口无需认证）
  fastify.get('/china-map', async () => {
    return success(getChinaMap());
  });

  // 指定省份地图数据（按 adcode 过滤；公开接口无需认证）
  fastify.get('/province-map', async (request) => {
    const query = request.query as Record<string, unknown>;
    const { adcode } = ProvinceQuery.parse(query);
    return success(getProvinceMap(adcode));
  });
}
