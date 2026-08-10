import type { FastifyInstance } from 'fastify';
import { issueStsCredentials } from '../services/oss.js';
import { StsSchema } from '../utils/validators.js';
import { success } from '../utils/response.js';

/** OSS 路由：POST /api/oss/sts 签发直传临时凭证（决策 D12） */
export async function ossRoutes(fastify: FastifyInstance) {
  fastify.post('/sts', { onRequest: [fastify.authenticate] }, async (request) => {
    const userId = request.user.userId;
    const { dir } = StsSchema.parse(request.body ?? {});

    const creds = await issueStsCredentials(userId, dir);
    return success(creds, 'STS 凭证签发成功');
  });
}
