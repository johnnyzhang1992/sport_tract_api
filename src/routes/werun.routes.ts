import type { FastifyInstance } from 'fastify';
import { UserModel } from '../models/user.model.js';
import { WerunDayModel } from '../models/werun-day.model.js';
import { code2Session } from '../services/wechat.js';
import { assertWatermarkTrustworthy, decryptWeRunData, sanitizeStepInfoList } from '../services/werun.js';
import { WeRunSyncSchema } from '../utils/validators.js';
import { success } from '../utils/response.js';
import { AppError } from '../utils/app-error.js';

/**
 * 微信运动步数（决策：session_key 用完即弃，同 xpay 下单时序）
 * POST /api/werun/sync  body { code, encryptedData, iv }
 *
 * 时序：客户端 wx.login（可能轮换 session_key）→ wx.getWeRunData（用刚轮换出的 key 加密）
 *       → 本接口 code2Session 现换 session_key 解密——三步之间无其他登录，key 必然一致。
 * 不落库 session_key（与现有取舍一致：openid/sessionKey 敏感，不出接口也不留存储）。
 */
export async function werunRoutes(fastify: FastifyInstance) {
  fastify.post('/sync', { onRequest: [fastify.authenticate] }, async (request) => {
    const { code, encryptedData, iv } = WeRunSyncSchema.parse(request.body);
    const user = await UserModel.findById(request.user.userId);
    if (!user) throw new AppError(401, '用户不存在');

    // code 换 session_key，同时是「code 属于这个用户」的身份证明（同 xpay ORDER_IDENTITY_MISMATCH 口径）
    const session = await code2Session(code);
    if (session.openid !== user.openid) throw new AppError(400, '登录凭证与当前用户不匹配');

    const payload = decryptWeRunData(encryptedData, iv, session.sessionKey);
    assertWatermarkTrustworthy(payload.watermark);
    const days = sanitizeStepInfoList(payload.stepInfoList);

    // 逐日 upsert（(userId,date) 唯一）：重同步覆盖旧值，幂等
    await Promise.all(
      days.map((d) =>
        WerunDayModel.updateOne(
          { userId: user._id, date: d.date },
          { $set: { step: d.step, syncedAt: Date.now() } },
          { upsert: true },
        ),
      ),
    );

    return success({ syncedDays: days.length, days });
  });
}
