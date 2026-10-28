import type { FastifyInstance } from 'fastify';
import { listActiveAdSlots } from '../services/ads.js';
import { success } from '../utils/response.js';

/**
 * 广告位（公开）：小程序按 key 取 unit-id。
 * 不需要登录——游客也要能看到广告；只下发在架项，且只有 { key, unitId }。
 */
export async function adsRoutes(fastify: FastifyInstance) {
  fastify.get('/', async () => success({ items: await listActiveAdSlots() }));
}
