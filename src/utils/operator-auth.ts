/**
 * 运营者鉴权（2026-11-04）：role=admin 的微信用户＝站内运营者。
 *
 * 与 adminAuth（webAdmin 的 AdminModel 账号体系）并存、互不替代：
 * - 身份是微信用户（小程序同一把用户 JWT），通过 fastify.authenticate 后进入本守卫；
 * - 实时查库校验 role==='admin'——webAdmin 里降权/撤权立即生效，不依赖 token 余期；
 * - 所有 operator 路由必须在 onRequest 链中先跑 fastify.authenticate 再跑本守卫。
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { UserModel } from '../models/user.model.js';
import { AppError } from './app-error.js';

export async function requireOperator(request: FastifyRequest, _reply: FastifyReply) {
  const userId = operatorIdOf(request);
  if (!userId) throw new AppError(401, '请先登录');
  const u = await UserModel.findById(userId).select({ role: 1 }).lean();
  if (!u || u.role !== 'admin') throw new AppError(403, '仅运营者可用');
}

/** 守卫放行后取运营者 userId（审计与定向查询用） */
export function operatorIdOf(request: FastifyRequest): string {
  return String((request.user as { userId?: string } | undefined)?.userId ?? '');
}
