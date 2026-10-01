import fp from 'fastify-plugin';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../utils/app-error.js';

/**
 * 冲突字段组合（keyPattern 排序后以 + 连接）→ 面向用户的 409 文案。
 * 认字段组合而不是索引名：Mongoose 在不同写入路径上不一定透出 index 名。
 * code 必须与应用层主动抛的那个一致，否则客户端要为"被索引拦住"和"被 service 拦住"写两套分支。
 */
const UNIQUE_CONFLICT_COPY: Record<string, { code: string; message: string }> = {
  'status+userId': { code: 'ACTIVITY_IN_PROGRESS', message: '已有进行中的运动，请先结束或放弃' },
};

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

      // 唯一索引冲突（E11000）：应用层"先查再插"总有并发窗口，兜底靠数据库唯一索引，
      // 但索引抛上来的原文带着集合名、索引名和冲突方的 ObjectId——落到下面的通用分支就是
      // 500 + 内部信息泄露。这里按索引名换成与应用层主动抛的完全同形同码的 409，客户端只认一套。
      const mongo = err as unknown as { code?: number; keyPattern?: Record<string, unknown> };
      if (mongo.code === 11000) {
        const fields = Object.keys(mongo.keyPattern ?? {}).sort();
        const copy = UNIQUE_CONFLICT_COPY[fields.join('+')] ?? {
          code: 'DUPLICATE_KEY',
          // 只报字段名，不回吐 keyValue：那里面可能是别人的 id
          message: `提交的内容与已有记录冲突（重复字段：${fields.join('、') || '未知'}）`,
        };
        return reply.code(409).send({ success: false, code: 409, message: copy.message, data: { code: copy.code } });
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
