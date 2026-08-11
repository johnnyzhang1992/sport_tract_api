import type { FastifyInstance } from 'fastify';
import { issueUploadCredential } from '../services/oss.js';
import { StsSchema } from '../utils/validators.js';
import { success } from '../utils/response.js';

/** OSS 路由：POST /api/oss/credential 签发直传签名凭证（AK 签名，无需 roleArn） */
export async function ossRoutes(fastify: FastifyInstance) {
  fastify.post('/credential', { onRequest: [fastify.authenticate] }, async (request) => {
    const userId = request.user.userId;
    const { dir } = StsSchema.parse(request.body ?? {});

    const creds = await issueUploadCredential(userId, dir);
    return success(creds, '上传凭证签发成功');
  });
}
