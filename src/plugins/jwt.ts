import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import jsonwebtoken from 'jsonwebtoken';
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

    // 路由级鉴权装饰器：{ onRequest: [fastify.authenticate] }
    fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify<JwtPayload>();
        if (request.user.type !== 'access') {
          throw new Error('invalid token type');
        }
        /*
         * 用户仍存在？（2026-11-17 加）
         * JWT 是无状态的：只验签名的话，**注销/删除账号后旧 token 在有效期内（7 天）仍能用**，
         * 表现就是「已注销的账号还能访问接口」。这里补一次主键查询（走 _id 索引，成本极低），
         * 用户不存在即视为未登录。也是「注销立即生效」的唯一可靠手段——
         * 否则就得维护 token 黑名单，代价远高于一次点查。
         */
        const exists = await UserModel.exists({ _id: request.user.userId });
        if (!exists) throw new Error('user gone');
      } catch {
        reply.code(401).send({
          success: false,
          code: 401,
          message: '未授权，请先登录',
          data: null,
        });
      }
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
        // 已注销/删除的账号不该被当成登录用户（同 authenticate，2026-11-17）
        const exists = await UserModel.exists({ _id: request.user.userId });
        if (!exists) delete (request as { user?: unknown }).user;
      } catch {
        // 游客或无有效 token：不注入 user，直接放行
      }
    });
  },
  { name: 'jwt' },
);
