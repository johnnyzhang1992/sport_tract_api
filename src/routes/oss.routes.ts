import type { FastifyInstance } from 'fastify';
import { issueUploadCredential } from '../services/oss.js';
import { getPhotoQuota } from '../services/photo-quota.js';
import { AppError } from '../utils/app-error.js';
import { StsSchema } from '../utils/validators.js';
import { photoQuotaFullMessage } from '../config/member-copy.js';
import { success } from '../utils/response.js';

/** OSS 路由：POST /api/oss/credential 签发直传签名凭证（AK 签名，无需 roleArn） */
export async function ossRoutes(fastify: FastifyInstance) {
  fastify.post('/credential', { onRequest: [fastify.authenticate] }, async (request) => {
    const userId = request.user.userId;
    const { dir } = StsSchema.parse(request.body ?? {});

    // 额度已满就别再签发：直传成功与否服务端看不到，先挡住白传的流量。
    // 真正的闸门在落库处（photo-quota.settlePhotoQuota），这里只是提前一步的提示。
    const quota = await getPhotoQuota(userId);
    if (quota.remaining === 0) {
      // 文案唯一真值在 config/member-copy（2026-11-03 批准稿 MC-15/15b）：这里不许再写第二份句子
      throw new AppError(400, photoQuotaFullMessage(quota.used, quota.limit, quota.isMember));
    }

    const creds = await issueUploadCredential(userId, dir);
    return success({ ...creds, photoQuotaRemaining: quota.remaining }, '上传凭证签发成功');
  });
}
