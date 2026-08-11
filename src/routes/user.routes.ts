import type { FastifyInstance } from 'fastify';
import { UserModel } from '../models/user.model.js';
import { checkImage, checkText } from '../services/wechat-sec.js';
import { UpdateMeSchema } from '../utils/validators.js';
import { success } from '../utils/response.js';
import { AppError } from '../utils/app-error.js';

/** 用户资料路由：GET/PUT /api/users/me（仅本人）+ 图片合规检测 */
export async function userRoutes(fastify: FastifyInstance) {
  fastify.get('/me', { onRequest: [fastify.authenticate] }, async (request) => {
    const user = await UserModel.findById(request.user.userId);
    if (!user) {
      throw new AppError(404, '用户不存在');
    }
    return success({
      id: String(user._id),
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      gender: user.gender,
      settings: user.settings,
      createdAt: user.createdAt,
    });
  });

  fastify.put('/me', { onRequest: [fastify.authenticate] }, async (request) => {
    const body = UpdateMeSchema.parse(request.body);

    // 昵称合规检测（微信 msgSecCheck v2，scene=2 用户资料；未配置/异常时降级放行）
    if (body.nickname) {
      const user = await UserModel.findById(request.user.userId);
      const sec = await checkText(body.nickname, user?.openid);
      if (sec.risky) {
        throw new AppError(400, '昵称包含不当内容，请更换后再试', { code: 'NICKNAME_RISKY' });
      }
    }

    const user = await UserModel.findByIdAndUpdate(
      request.user.userId,
      { $set: body },
      { returnDocument: 'after', runValidators: true },
    );
    if (!user) {
      throw new AppError(404, '用户不存在');
    }

    return success(
      {
        id: String(user._id),
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        gender: user.gender,
        settings: user.settings,
      },
      '更新成功',
    );
  });

  /**
   * 图片合规检测（imgSecCheck，≤1MB）
   * 供前端直传 OSS 前调用：检测通过再上传，违规直接拒绝
   * 未配置微信接口时降级放行（skipped=true），不阻塞本地联调
   */
  fastify.post('/check-image', { onRequest: [fastify.authenticate] }, async (request) => {
    const file = await request.file();
    if (!file) {
      throw new AppError(400, '未上传图片');
    }
    const buf = await file.toBuffer();
    if (buf.length > 1024 * 1024) {
      throw new AppError(400, '图片不能超过 1MB', { code: 'IMAGE_TOO_LARGE' });
    }

    const user = await UserModel.findById(request.user.userId);
    const result = await checkImage(buf, user?.openid, file.filename);
    return success(result, '检测完成');
  });
}
