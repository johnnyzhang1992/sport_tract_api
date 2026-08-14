import type { FastifyInstance } from 'fastify';
import { UserModel } from '../models/user.model.js';
import { WeightLogModel } from '../models/weight-log.model.js';
import { checkImage, checkText } from '../services/wechat-sec.js';
import { getSignedUrl } from '../services/oss.js';
import { UpdateMeSchema } from '../utils/validators.js';
import { success } from '../utils/response.js';
import { AppError } from '../utils/app-error.js';

/** 头像 URL 签名（bucket 私有，展示需签名 URL；未配置 OSS 时原样返回） */
function signAvatar(url: string): string {
  return url ? getSignedUrl(url) : '';
}

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
      avatarUrl: signAvatar(user.avatarUrl),
      gender: user.gender,
      weightKg: user.weightKg,
      heightCm: user.heightCm,
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

    // 体重变化趋势：更新前读取旧体重，若本次体重与旧值不同则插入体重记录
    if (typeof body.weightKg === 'number') {
      const prev = await UserModel.findById(request.user.userId).select('weightKg').lean();
      const prevWeight = prev?.weightKg ?? null;
      if (prevWeight === null || Math.abs(prevWeight - body.weightKg) >= 0.1) {
        await WeightLogModel.create({
          userId: request.user.userId,
          weightKg: body.weightKg,
        });
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
        avatarUrl: signAvatar(user.avatarUrl),
        gender: user.gender,
        weightKg: user.weightKg,
        heightCm: user.heightCm,
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

  // 体重变化趋势：最近 N 条（时间倒序）
  // 体重变化趋势：按维度（today/week/month/year）返回记录（时间倒序）
  fastify.get('/weight-logs', { onRequest: [fastify.authenticate] }, async (request) => {
    const q = request.query as { range?: string; limit?: string };
    const limit = Math.min(Number(q.limit) || 200, 1000);
    const filter: Record<string, unknown> = { userId: request.user.userId };
    if (q.range && q.range !== 'all') {
      const now = Date.now();
      const DAY = 86400000;
      const start =
        q.range === 'today'
          ? new Date(new Date(now).setHours(0, 0, 0, 0)).getTime()
          : q.range === 'week'
            ? now - 7 * DAY
            : q.range === 'month'
              ? now - 30 * DAY
              : now - 365 * DAY;
      filter.createdAt = { $gte: start };
    }
    const logs = await WeightLogModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return success({
      items: logs.map((l) => ({ weightKg: l.weightKg, createdAt: l.createdAt })),
    });
  });
}
