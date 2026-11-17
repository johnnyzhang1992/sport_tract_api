import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import jsonwebtoken from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config/index.js';
import { UserModel } from '../models/user.model.js';

export interface JwtPayload {
  userId: string;
  type: 'access' | 'refresh';
}


/**
 * JWT 鉴权插件（决策 D14）
 * - access token：7 天，业务接口鉴权
 * - refresh token：30 天，静默续期
 */
export default fp(
  async (fastify) => {
    await fastify.register(jwt, {
      secret: config.jwtSecret,
      sign: { expiresIn: config.accessTokenTtl },
    });

    // 签发 access token
    fastify.decorate('signAccessToken', (userId: string) =>
      fastify.jwt.sign({ userId, type: 'access' }),
    );

    // 签发 refresh token（独立 secret + jsonwebtoken，只能用 refresh 接口换新）
    fastify.decorate('signRefreshToken', (userId: string) =>
      jsonwebtoken.sign(
        { userId, type: 'refresh' } satisfies JwtPayload,
        config.jwtRefreshSecret,
        { expiresIn: config.refreshTokenTtl as jsonwebtoken.SignOptions['expiresIn'] },
      ),
    );

    const unauthorized = (reply: FastifyReply) =>
      reply.code(401).send({ success: false, code: 401, message: '未授权，请先登录', data: null });

    // 路由级鉴权装饰器：{ onRequest: [fastify.authenticate] }
    fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
      /*
       * 第一段只处理「token 本身有问题」（签名/过期/类型/非法 userId）→ 401。
       * 这段必须自己 catch：抛出去会被 Fastify 当 500，端上会看到「服务器错误」而不是重新登录。
       */
      try {
        await request.jwtVerify<JwtPayload>();
        if (request.user.type !== 'access') throw new Error('invalid token type');
        // 非 ObjectId 的 userId（伪造/脏 token）：在查库前就拦掉，避免 CastError 变成 500
        if (!ObjectId.isValid(String(request.user.userId))) throw new Error('bad user id');
      } catch {
        return unauthorized(reply);
      }

      /*
       * **用户仍存在？**（2026-11-17 加）
       * JWT 是无状态的：只验签名的话，注销/删除账号后旧 token 在有效期内（7 天）仍能用。
       * 这里补一次主键查询（走 _id 索引，成本极低），用户不存在即视为未登录——
       * 这是「注销立即生效」的唯一可靠手段，否则就得维护 token 黑名单。
       *
       * ⚠️ 这句**故意留在 try 之外**（2026-11-17 修复）：
       * Mongo 抖动时若被吞成 401，端上会「401 → 去刷 refresh → refresh 也挂 → 全局登出」，
       * 一次数据库抖动等于把全站用户踢下线。故障就让它以 5xx 暴露，客户端不会当成未登录。
       */
      const exists = await UserModel.exists({ _id: request.user.userId });
      if (!exists) return unauthorized(reply);
    });

    // 可选鉴权：有效 access token → 注入 user；无 token/无效/refresh → 放行（游客，业务内自行区分）
    // 用途：分享/只读接口（未登录用户可查看 finished 轨迹等）
    fastify.decorate('authenticateOptional', async (request: FastifyRequest) => {
      try {
        await request.jwtVerify<JwtPayload>();
        if (request.user.type !== 'access') {
          delete (request as { user?: unknown }).user;
          return;
        }
        // 非 ObjectId = 脏 token，按游客处理（别让 CastError 把公开页打成 500）
        const uid = String(request.user.userId);
        if (!ObjectId.isValid(uid)) {
          delete (request as { user?: unknown }).user;
          return;
        }
        // 已注销/删除的账号不该被当成登录用户（同 authenticate，2026-11-17）
        // 数据库故障时降级为游客而不是 401：公开页（分享/只读）不该因为点查失败就白屏，
        // 也不能回 401——那会让端上走「刷新失败 → 全局登出」。
        try {
          const exists = await UserModel.exists({ _id: uid });
          if (!exists) delete (request as { user?: unknown }).user;
        } catch (err) {
          request.log.warn(
            { err: (err as Error).message },
            '[jwt] 校验用户存在性失败，本次按游客处理',
          );
          delete (request as { user?: unknown }).user;
        }
      } catch {
        // 游客或无有效 token：不注入 user，直接放行
      }
    });
  },
  { name: 'jwt' },
);
