import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import mongoose from 'mongoose';
import { config } from './config/index.js';
import mongodbPlugin from './plugins/mongodb.js';
import jwtPlugin from './plugins/jwt.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import { authRoutes } from './routes/auth.routes.js';
import { userRoutes } from './routes/user.routes.js';
import { ossRoutes } from './routes/oss.routes.js';
import { activityRoutes } from './routes/activity.routes.js';
import { statsRoutes } from './routes/stats.routes.js';

export interface BuildAppOptions {
  /** 日志开关（测试传 false；默认 dev 用 pino-pretty，prod 用 JSON） */
  logger?: boolean;
}

/** 组装 Fastify 应用（插件 + 路由），供 server.ts 与测试共用 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const fastify = Fastify({
    trustProxy: true,
    logger:
      opts.logger ??
      (config.isDev
        ? { transport: { target: 'pino-pretty' }, level: 'info' }
        : true),
  });

  // CORS：开发环境全放开；生产白名单
  const corsOrigin = config.isDev ? true : [process.env.CORS_ORIGIN ?? ''].filter(Boolean);
  await fastify.register(cors, { origin: corsOrigin, credentials: true });

  // multipart（图片合规检测上传）
  await fastify.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 } });

  // 基础插件
  await fastify.register(mongodbPlugin);
  await fastify.register(jwtPlugin);
  await fastify.register(errorHandlerPlugin);

  // 业务路由
  await fastify.register(authRoutes, { prefix: `${config.apiPrefix}/auth` });
  await fastify.register(userRoutes, { prefix: `${config.apiPrefix}/users` });
  await fastify.register(ossRoutes, { prefix: `${config.apiPrefix}/oss` });
  await fastify.register(activityRoutes, { prefix: `${config.apiPrefix}/activities` });
  await fastify.register(statsRoutes, { prefix: `${config.apiPrefix}/stats` });

  // 健康检查（含 MongoDB 状态）
  fastify.get('/health', async () => ({
    status: 'ok',
    mongodb: mongoose.connection.readyState === 1,
    timestamp: new Date().toISOString(),
  }));

  return fastify;
}
