import type { FastifyInstance } from 'fastify';
import jsonwebtoken from 'jsonwebtoken';
import { UserModel } from '../models/user.model.js';
import { code2Session } from '../services/wechat.js';
import { getSignedUrl } from '../services/oss.js';
import { LoginSchema, RefreshSchema } from '../utils/validators.js';
import { success } from '../utils/response.js';
import { AppError } from '../utils/app-error.js';
import { config } from '../config/index.js';
import type { JwtPayload } from '../plugins/jwt.js';

/**
 * 认证路由（决策 D2/D14）
 * POST /api/auth/login   微信静默登录：code → openid → 查/建用户 → JWT
 * POST /api/auth/refresh 静默续期：refresh token → 新 access token
 */
export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/login', async (request) => {
    const { code } = LoginSchema.parse(request.body);

    const session = await code2Session(code);

    // 查/建用户（openid 唯一索引幂等）
    let user = await UserModel.findOne({ openid: session.openid });
    if (!user) {
      user = await UserModel.create({ openid: session.openid });
      fastify.log.info(`新用户注册: ${user._id}`);
    }

    const userId = String(user._id);
    const accessToken = fastify.signAccessToken(userId);
    const refreshToken = fastify.signRefreshToken(userId);

    // openid/sessionKey 为敏感字段，不出接口；头像签名（bucket 私有）
    return success(
      {
        accessToken,
        refreshToken,
        user: {
          id: userId,
          nickname: user.nickname,
          avatarUrl: user.avatarUrl ? getSignedUrl(user.avatarUrl) : '',
          gender: user.gender,
          weightKg: user.weightKg,
          heightCm: user.heightCm,
          settings: user.settings,
        },
      },
      '登录成功',
    );
  });

  fastify.post('/refresh', async (request) => {
    const { refreshToken } = RefreshSchema.parse(request.body);

    let payload: JwtPayload;
    try {
      payload = jsonwebtoken.verify(refreshToken, config.jwtRefreshSecret) as JwtPayload;
    } catch {
      throw new AppError(401, 'refresh token 无效或已过期', { code: 'INVALID_REFRESH_TOKEN' });
    }

    if (payload.type !== 'refresh') {
      throw new AppError(401, 'refresh token 类型不合法');
    }

    // 用户被删除/注销后拒绝续期
    const user = await UserModel.findById(payload.userId);
    if (!user) {
      throw new AppError(401, '用户不存在，请重新登录');
    }

    return success(
      {
        accessToken: fastify.signAccessToken(payload.userId),
        refreshToken: fastify.signRefreshToken(payload.userId),
      },
      '刷新成功',
    );
  });
}
