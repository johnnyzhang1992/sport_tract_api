/**
 * 管理端鉴权（2026-11-03 从 routes/admin.routes.ts 原样搬出）。
 * 搬动理由：支付域要新开一个路由文件（admin.routes.ts 已 1799 行），而 adminAuth 是私有的——
 * 复制一份就是第二个真相（哪天只改一处，另一处路由就裸奔）。
 * 行为逐字不变：验签 + role==='admin'，取身份走 adminIdOf。
 */
import jsonwebtoken from 'jsonwebtoken';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config/index.js';
import { AppError } from './app-error.js';

/** admin token 校验 */
export async function adminAuth(request: FastifyRequest, reply: FastifyReply) {
  const token = adminTokenOf(request);
  if (!token) throw new AppError(401, '缺少管理员凭证');
  try {
    const payload = jsonwebtoken.verify(token, config.adminJwtSecret) as { role?: string; id?: string };
    if (payload.role !== 'admin') throw new AppError(401, '无管理员权限');
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(401, '管理员凭证无效或已过期');
  }
}

/** 从 authorization 头剥出裸 token（adminAuth 与取管理员身份两处共用同一口径） */
export function adminTokenOf(request: FastifyRequest): string {
  const auth = request.headers.authorization ?? '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

/**
 * 当前管理员身份（发放留痕用的 grantedBy）。
 * adminAuth 只验签、不往 request 挂任何东西（也没有 request.admin / request.username），
 * 而 /login 签发的 payload 就是 { role, id, username }——所以在这枚已经过闸的 token 里取 id，
 * 与 PUT /password 取管理员同一口径。username 只作为缺 id 的历史 token 兜底。
 * 路由的 onRequest 已先跑过 adminAuth，这里再验一次不会把无效凭证放到写库之后。
 */
export function adminIdOf(request: FastifyRequest): string {
  const payload = jsonwebtoken.verify(adminTokenOf(request), config.adminJwtSecret) as {
    id?: string; username?: string;
  };
  return String(payload.id ?? payload.username ?? '');
}
