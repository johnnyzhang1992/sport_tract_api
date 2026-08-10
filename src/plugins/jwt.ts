import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import jsonwebtoken from 'jsonwebtoken';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config/index.js';

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
      } catch {
        reply.code(401).send({
          success: false,
          code: 401,
          message: '未授权，请先登录',
          data: null,
        });
      }
    });
  },
  { name: 'jwt' },
);
