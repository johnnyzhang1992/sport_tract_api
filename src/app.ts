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
import { shareRoutes } from './routes/share.routes.js';
import { geoRoutes } from './routes/geo.routes.js';
import { overviewRoutes } from './routes/overview.routes.js';

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

  // 容错：application/json 空 body（GET/DELETE 客户端可能带空 JSON body）→ 视为无 body
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === undefined || body === null || body === '') {
      done(null, null);
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

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
  await fastify.register(shareRoutes, { prefix: `${config.apiPrefix}/share` });
  await fastify.register(geoRoutes, { prefix: `${config.apiPrefix}/geo` });
  await fastify.register(overviewRoutes, { prefix: `${config.apiPrefix}/overview` });

  // 健康检查（含 MongoDB 状态）
  fastify.get('/health', async () => ({
    status: 'ok',
    mongodb: mongoose.connection.readyState === 1,
    timestamp: new Date().toISOString(),
  }));

  return fastify;
}
