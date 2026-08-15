import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import jsonwebtoken from 'jsonwebtoken';
import { AdminModel, hashPassword, verifyPassword } from '../models/admin.model.js';
import { UserModel } from '../models/user.model.js';
import { ActivityModel } from '../models/activity.model.js';
import { config } from '../config/index.js';
import { success } from '../utils/response.js';
import { AppError } from '../utils/app-error.js';

/**
 * 管理后台路由：/api/admin/*（与小程序用户接口隔离）
 * - 管理员登录（用户名 + 密码，bcrypt 校验，密码存数据库可修改）
 * - 其余接口需 admin token（独立 JWT secret，普通用户 token 无效）
 */

/** admin token 校验 */
async function adminAuth(request: FastifyRequest, reply: FastifyReply) {
  const auth = request.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) throw new AppError(401, '缺少管理员凭证');
  try {
    const payload = jsonwebtoken.verify(token, config.adminJwtSecret) as { role?: string; id?: string };
    if (payload.role !== 'admin') throw new AppError(401, '无管理员权限');
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(401, '管理员凭证无效或已过期');
  }
}

export async function adminRoutes(fastify: FastifyInstance) {
  // 管理员登录：用户名 + 密码 → admin token
  fastify.post('/login', async (request) => {
    const { username, password } = (request.body ?? {}) as { username?: string; password?: string };
    if (!username || !password) {
      throw new AppError(400, '请输入用户名和密码');
    }
    const admin = await AdminModel.findOne({ username }).lean();
    if (!admin || !(await verifyPassword(password, admin.passwordHash))) {
      throw new AppError(401, '用户名或密码错误');
    }
    const token = jsonwebtoken.sign(
      { role: 'admin', id: String(admin._id), username: admin.username },
      config.adminJwtSecret,
      { expiresIn: config.adminTokenTtl as jsonwebtoken.SignOptions['expiresIn'] },
    );
    return success({ token, username: admin.username });
  });

  // 修改当前管理员密码（需旧密码验证）
  fastify.put('/password', { onRequest: [adminAuth] }, async (request) => {
    const { oldPassword, newPassword } = (request.body ?? {}) as { oldPassword?: string; newPassword?: string };
    if (!oldPassword || !newPassword) {
      throw new AppError(400, '请输入旧密码和新密码');
    }
    if (newPassword.length < 6) {
      throw new AppError(400, '新密码至少 6 位');
    }
    // 从 token 拿管理员 id
    const auth = request.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const payload = jsonwebtoken.verify(token, config.adminJwtSecret) as { id?: string };
    const admin = await AdminModel.findById(payload.id);
    if (!admin) throw new AppError(404, '管理员不存在');
    if (!(await verifyPassword(oldPassword, admin.passwordHash))) {
      throw new AppError(401, '旧密码错误');
    }
    admin.passwordHash = await hashPassword(newPassword);
    await admin.save();
    return success(null, '密码修改成功');
  });

  // 概览统计
  fastify.get('/overview', { onRequest: [adminAuth] }, async () => {
    const [userCount, activityCount, finishedCount, distAgg] = await Promise.all([
      UserModel.countDocuments({}),
      ActivityModel.countDocuments({}),
      ActivityModel.countDocuments({ status: 'finished' }),
      ActivityModel.aggregate([
        { $match: { status: 'finished' } },
        { $group: { _id: null, total: { $sum: '$distance' } } },
      ]),
    ]);
    return success({
      userCount,
      activityCount,
      finishedCount,
      totalDistanceKm: Math.round(((distAgg[0]?.total as number) ?? 0) / 10) / 100,
    });
  });

  // 用户列表（含每人轨迹数；默认按最后登录时间倒序；支持昵称搜索）
  fastify.get('/users', { onRequest: [adminAuth] }, async (request) => {
    const { page = '1', pageSize = '20', keyword } = request.query as { page?: string; pageSize?: string; keyword?: string };
    const p = Math.max(1, Number(page) || 1);
    const ps = Math.min(100, Number(pageSize) || 20);
    const filter: Record<string, unknown> = {};
    if (keyword && String(keyword).trim()) {
      filter.nickname = { $regex: String(keyword).trim(), $options: 'i' };
    }
    const [total, users, counts] = await Promise.all([
      UserModel.countDocuments(filter),
      UserModel.find(filter)
        .sort({ lastLoginAt: -1, createdAt: -1 })
        .skip((p - 1) * ps)
        .limit(ps)
        .lean(),
      ActivityModel.aggregate([{ $group: { _id: '$userId', count: { $sum: 1 } } }]),
    ]);
    const countMap = new Map(counts.map((c) => [String(c._id), c.count]));
    return success({
      total,
      page: p,
      pageSize: ps,
      items: users.map((u) => ({
        id: String(u._id),
        nickname: u.nickname,
        openid: u.openid,
        weightKg: u.weightKg,
        heightCm: u.heightCm,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt ?? u.createdAt,
        activityCount: countMap.get(String(u._id)) ?? 0,
      })),
    });
  });

  // 轨迹列表（含用户昵称；支持 类型/状态/距离/时长/用户昵称 筛选）
  fastify.get('/activities', { onRequest: [adminAuth] }, async (request) => {
    const q = request.query as {
      page?: string; pageSize?: string; userId?: string;
      type?: string; status?: string; keyword?: string;
      minDistance?: string; maxDistance?: string; minDuration?: string; maxDuration?: string;
    };
    const p = Math.max(1, Number(q.page) || 1);
    const ps = Math.min(100, Number(q.pageSize) || 20);
    const filter: Record<string, unknown> = {};
    if (q.userId) filter.userId = q.userId;
    if (q.type) filter.type = q.type;
    if (q.status) filter.status = q.status;
    // 距离（公里 → 米）、时长（分钟 → 秒）
    const dist: Record<string, unknown> = {};
    if (q.minDistance) dist.$gte = Math.round(Number(q.minDistance) * 1000);
    if (q.maxDistance) dist.$lte = Math.round(Number(q.maxDistance) * 1000);
    if (Object.keys(dist).length) filter.distance = dist;
    const dur: Record<string, unknown> = {};
    if (q.minDuration) dur.$gte = Math.round(Number(q.minDuration) * 60);
    if (q.maxDuration) dur.$lte = Math.round(Number(q.maxDuration) * 60);
    if (Object.keys(dur).length) filter.duration = dur;
    // 用户昵称搜索 → 先查用户 id
    if (q.keyword && String(q.keyword).trim()) {
      const matched = await UserModel.find({ nickname: { $regex: String(q.keyword).trim(), $options: 'i' } })
        .select('_id').lean();
      const ids = matched.map((u) => String(u._id));
      filter.userId = { $in: ids };
    }
    const [total, items, users] = await Promise.all([
      ActivityModel.countDocuments(filter),
      ActivityModel.find(filter).sort({ startTime: -1 }).skip((p - 1) * ps).limit(ps).lean(),
      UserModel.find({}).select('_id nickname').lean(),
    ]);
    const nickMap = new Map(users.map((u) => [String(u._id), u.nickname || '微信用户']));
    return success({
      total,
      page: p,
      pageSize: ps,
      items: items.map((a) => ({
        id: String(a._id),
        userId: String(a.userId),
        userNickname: nickMap.get(String(a.userId)) ?? '微信用户',
        type: a.type,
        status: a.status,
        distance: a.distance ?? 0,
        duration: a.duration ?? 0,
        calories: a.calories ?? 0,
        elevationGain: a.elevationGain ?? 0,
        startTime: a.startTime,
      })),
    });
  });
}
