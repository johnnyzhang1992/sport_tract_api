/**
 * 照片管理（2026-11-05）：
 * - GET  /photos        我的照片总览（按轨迹/足迹分组）+ 额度读数（used/limit/over）
 * - POST /photos/delete 批量删除（按 owner 文档分组，删完回最新额度）
 *
 * 为什么是 POST 而不是 DELETE：要按「文档 + 一批 URL」成组提交，DELETE 带 body 兼容性差。
 * 删除是幂等的：重复删同一批 URL 第二次不会报错（keep 集合不变 → 不更新、不结算）。
 */
import type { FastifyInstance } from 'fastify';
import { success } from '../utils/response.js';
import { deleteMyPhotos, listMyPhotos, myPhotoQuota, type PhotoRef } from '../services/photo-manager.js';

export async function photoRoutes(fastify: FastifyInstance) {
  fastify.get('/', { onRequest: [fastify.authenticate] }, async (request) => {
    return success(await listMyPhotos(request.user.userId));
  });

  // 只读额度（设置页/会员页已有 /member/entitlements 的读数，这个留给将来的单独刷新）
  fastify.get('/quota', { onRequest: [fastify.authenticate] }, async (request) => {
    return success(await myPhotoQuota(request.user.userId));
  });

  fastify.post('/delete', { onRequest: [fastify.authenticate] }, async (request) => {
    const body = (request.body ?? {}) as { refs?: unknown };
    const refs = Array.isArray(body.refs) ? (body.refs as PhotoRef[]) : [];
    return success(await deleteMyPhotos(request.user.userId, refs), '已删除');
  });
}
