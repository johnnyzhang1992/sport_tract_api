import type { FastifyInstance } from 'fastify';
import { UserModel } from '../models/user.model.js';
import { UpdateMeSchema } from '../utils/validators.js';
import { success } from '../utils/response.js';
import { AppError } from '../utils/app-error.js';

/** 用户资料路由：GET/PUT /api/users/me（仅本人） */
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
}
