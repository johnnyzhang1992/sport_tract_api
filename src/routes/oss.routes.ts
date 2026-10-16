import type { FastifyInstance } from 'fastify';
import { issueUploadCredential } from '../services/oss.js';
import { getPhotoQuota } from '../services/photo-quota.js';
import { AppError } from '../utils/app-error.js';
import { StsSchema } from '../utils/validators.js';
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
      throw new AppError(400, `图片额度已满（已用 ${quota.used}/${quota.limit} 张），请先删除部分照片`);
    }

    const creds = await issueUploadCredential(userId, dir);
    return success({ ...creds, photoQuotaRemaining: quota.remaining }, '上传凭证签发成功');
  });
}
