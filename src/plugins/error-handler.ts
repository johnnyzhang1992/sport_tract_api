import fp from 'fastify-plugin';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../utils/app-error.js';

/**
 * 全局错误处理：统一 { success, code, message, data } 响应
 * - AppError：业务错误（保留 statusCode + extra）
 * - ZodError：参数校验错误（400，返回第一条 issue）
 * - 其他：500，生产环境不泄露内部信息
 */
export default fp(
  async (fastify: FastifyInstance) => {
    fastify.setErrorHandler((err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({
          success: false,
          code: err.statusCode,
          message: err.message,
          data: err.extra ?? null,
        });
      }

      if (err instanceof ZodError) {
        return reply.code(400).send({
          success: false,
          code: 400,
          message: err.issues[0]?.message ?? '参数校验失败',
          data: null,
        });
      }

      // 校验类错误（Fastify schema / body 解析等）
      if (err.validation || err.statusCode === 400) {
        return reply.code(400).send({
          success: false,
          code: 400,
          message: err.message ?? '请求参数不合法',
          data: null,
        });
      }

      const isDev = process.env.NODE_ENV !== 'production';
      fastify.log.error({ err }, '未处理异常');
      return reply.code(err.statusCode ?? 500).send({
        success: false,
        code: err.statusCode ?? 500,
        message: isDev ? err.message : '服务器内部错误',
        data: null,
      });
    });

    // 未匹配路由 → 404 统一格式
    fastify.setNotFoundHandler((request, reply) => {
      reply.code(404).send({
        success: false,
        code: 404,
        message: `接口不存在: ${request.method} ${request.url}`,
        data: null,
      });
    });
  },
  { name: 'error-handler' },
);
