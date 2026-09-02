import type { FastifyInstance } from 'fastify';
import jsonwebtoken from 'jsonwebtoken';
import { UserModel } from '../models/user.model.js';
import { LoginLogModel } from '../models/login-log.model.js';
import { code2Session } from '../services/wechat.js';
import { getSignedUrl } from '../services/oss.js';
import { locateByIp } from '../services/ip-locate.js';
import { LoginSchema, RefreshSchema } from '../utils/validators.js';
import { success } from '../utils/response.js';
import { AppError } from '../utils/app-error.js';
import { nextUserUid, backfillUsers } from '../services/uid.js';
import { config } from '../config/index.js';
import type { JwtPayload } from '../plugins/jwt.js';

/** 从请求提取客户端 IP（优先 x-forwarded-for，其次 x-real-ip，最后 request.ip） */
function getClientIp(request: any): string | undefined {
  const forwarded = request.headers['x-forwarded-for'];
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : String(forwarded).split(',')[0].trim();
    if (first) return first;
  }
  const realIp = request.headers['x-real-ip'];
  if (realIp) return String(realIp);
  return request.ip;
}

/**
 * 认证路由（决策 D2/D14）
 * POST /api/auth/login   微信静默登录：code → openid → 查/建用户 → JWT
 * POST /api/auth/refresh 静默续期：refresh token → 新 access token
 */
export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/login', async (request) => {
    const { code, uid, platform, system, brand, model, sdkVersion, appVersion } = request.body as Record<string, unknown>;
    const parsed = LoginSchema.parse({ code, uid });

    const session = await code2Session(parsed.code);

    // 查/建用户（openid 唯一索引幂等）
    // UID：新用户创建时分配（1000 起，全局唯一）；老用户缺失时按创建时间批量补号（不动昵称）
    // 默认昵称：空昵称时用 UID（或显式 uid 参数）生成 迹路者{编号}；已有昵称绝不覆盖
    let user = await UserModel.findOne({ openid: session.openid });
    if (!user) {
      user = await UserModel.create({ openid: session.openid, uid: await nextUserUid(), nickname: '' });
      fastify.log.info(`新用户注册: ${user._id} uid=${user.uid}`);
    }
    if (!user.uid) {
      // 老用户缺 UID：按创建时间批量补（含当前用户），空昵称同步补默认昵称；已有昵称不覆盖
      await backfillUsers();
      user = await UserModel.findOne({ openid: session.openid });
      if (!user) throw new AppError(500, '用户状态异常');
    }
    if (!user.nickname) {
      // 空昵称：uid 参数显式优先，否则用自动 UID
      user.nickname = parsed.uid ? `迹路者${parsed.uid}` : `迹路者${user.uid}`;
      await UserModel.updateOne({ _id: user._id }, { $set: { nickname: user.nickname } });
    }

    const userId = String(user._id);
    // 更新最后登录时间（管理后台排序/展示用，不阻塞）
    UserModel.updateOne({ _id: user._id }, { $set: { lastLoginAt: Date.now() } }).catch(() => {});

    // 登录日志：IP + 设备信息（不阻塞）
    const ip = getClientIp(request);
    const loc = ip ? await locateByIp(ip).catch(() => null) : null;
    LoginLogModel.create({
      userId: user._id,
      ip,
      province: loc?.province,
      city: loc?.city,
      platform: typeof platform === 'string' ? platform : undefined,
      system: typeof system === 'string' ? system : undefined,
      brand: typeof brand === 'string' ? brand : undefined,
      model: typeof model === 'string' ? model : undefined,
      sdkVersion: typeof sdkVersion === 'string' ? sdkVersion : undefined,
      appVersion: typeof appVersion === 'string' ? appVersion : undefined,
    }).catch(() => {});

    const accessToken = fastify.signAccessToken(userId);
    const refreshToken = fastify.signRefreshToken(userId);

    // openid/sessionKey 为敏感字段，不出接口；头像签名（bucket 私有）
    return success(
      {
        accessToken,
        refreshToken,
        user: {
          id: userId,
          uid: user.uid ?? null, // 用户唯一编号
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
