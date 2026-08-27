import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../plugins/jwt.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** 路由级鉴权：{ onRequest: [fastify.authenticate] } */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** 可选鉴权：有效 token 注入 user，无/无效则放行（游客） */
    authenticateOptional: (request: FastifyRequest) => Promise<void>;
    /** 签发 access token */
    signAccessToken: (userId: string) => string;
    /** 签发 refresh token */
    signRefreshToken: (userId: string) => string;
  }
}

export {};
