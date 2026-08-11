import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config/index.js';
import { ActivityModel } from '../models/activity.model.js';
import { getUnlimitedQRCode } from '../services/wechat-qrcode.js';
import { uploadBuffer } from '../services/oss.js';
import { success } from '../utils/response.js';
import { AppError } from '../utils/app-error.js';

const MiniCodeSchema = z.object({
  activityId: z.string().regex(/^[a-f0-9]{24}$/, 'activityId 不合法'),
});

/** 分享路由：POST /api/share/mini-code 生成活动专属小程序码（决策 F22） */
export async function shareRoutes(fastify: FastifyInstance) {
  fastify.post('/mini-code', { onRequest: [fastify.authenticate] }, async (request) => {
    const { activityId } = MiniCodeSchema.parse(request.body);

    // 校验活动归属（仅本人可生成自己活动的码）
    const activity = await ActivityModel.findOne({ _id: activityId, userId: request.user.userId })
      .select('_id')
      .lean();
    if (!activity) {
      throw new AppError(404, '活动不存在');
    }

    const png = await getUnlimitedQRCode(activityId);

    // 存 OSS（目录按 userId 隔离），失败则降级返回 base64
    const key = `${config.oss.baseDir}/mini-codes/${request.user.userId}/${activityId}.png`;
    try {
      const url = await uploadBuffer(png, key);
      return success({ url, key });
    } catch (err) {
      fastify.log.warn('[share] 小程序码存 OSS 失败，降级 base64: ' + (err as Error).message);
      return success({ url: '', base64: `data:image/png;base64,${png.toString('base64')}` });
    }
  });
}
