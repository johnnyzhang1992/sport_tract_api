import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import jsonwebtoken from 'jsonwebtoken';
import { Types } from 'mongoose';
import { AdminModel, hashPassword, verifyPassword } from '../models/admin.model.js';
import { UserModel } from '../models/user.model.js';
import { LoginLogModel } from '../models/login-log.model.js';
import { ActivityModel } from '../models/activity.model.js';
import { config } from '../config/index.js';
import { success } from '../utils/response.js';
import { AppError } from '../utils/app-error.js';
import { locateRegion } from '../services/region.js';
import { overview as userStatsOverview, bestRecords } from '../services/stats.js';
import { footprint } from '../services/footprint.js';
import { toActivityDto } from '../services/activity.js';
import { getSignedUrl } from '../services/oss.js';

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

  // 时间维度数据量：新增用户/新增轨迹（today/week/month）
  fastify.get('/stats', { onRequest: [adminAuth] }, async (request) => {
    const DAY = 86400000;
    const now = Date.now();
    const ranges = {
      today: new Date(new Date(now).setHours(0, 0, 0, 0)).getTime(),
      week: now - 7 * DAY,
      month: now - 30 * DAY,
    };
    const out: Record<string, { newUsers: number; newActivities: number; uv: number; pv: number }> = {};
    for (const [k, start] of Object.entries(ranges)) {
      const since = new Date(start);
      // 登录 UV/PV：PV = 登录次数，UV = 周期内登录过的去重用户数
      const [newUsers, newActivities, pv, uvRows] = await Promise.all([
        UserModel.countDocuments({ createdAt: { $gte: since } }),
        ActivityModel.countDocuments({ createdAt: { $gte: since } }),
        LoginLogModel.countDocuments({ createdAt: { $gte: since } }),
        LoginLogModel.aggregate([
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: '$userId' } },
        ]),
      ]);
      out[k] = { newUsers, newActivities, uv: uvRows.length, pv };
    }
    return success(out);
  });

  // 数据趋势：新增用户/轨迹（折线图），维度 type=day|week|month|year
  // day：近 30 天按天；week：近 25 周按周；month：近 12 个月按月；year：近 6 年按半年（12 个点）
  fastify.get('/trend', { onRequest: [adminAuth] }, async (request) => {
    const type = String((request.query as { type?: string }).type || 'day');
    const DAY = 86400000;
    // 各维度配置：桶 key 生成函数 + 标签 + 起止
    let fmt = '%Y-%m-%d';
    let labelOf: (d: Date) => string;
    let buckets: string[] = [];
    const now = new Date();

    if (type === 'week') {
      // 近 25 周（ISO 年-周）
      fmt = '%G-W%V';
      labelOf = (d) => {
        const t = new Date(d.getTime());
        t.setHours(12, 0, 0, 0); // 避免周末边界时区问题
        const day = (t.getDay() + 6) % 7; // 周一 = 0
        t.setDate(t.getDate() - day + 3); // 周四（ISO 周锚点）
        const isoYear = t.getFullYear();
        const week = Math.ceil(((t.getTime() - new Date(isoYear, 0, 4).getTime()) / DAY + 1) / 7);
        return `${isoYear}-W${String(week).padStart(2, '0')}`;
      };
      for (let i = 24; i >= 0; i--) {
        buckets.push(labelOf(new Date(Date.now() - i * 7 * DAY)));
      }
    } else if (type === 'month') {
      fmt = '%Y-%m';
      labelOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        buckets.push(labelOf(d));
      }
    } else if (type === 'year') {
      // 近 6 年按半年（H1/H2）
      fmt = '%Y-%m';
      labelOf = (d) => {
        const half = d.getMonth() < 6 ? 'H1' : 'H2';
        return `${d.getFullYear()}-${half}`;
      };
      // 最近 12 个半年（含当前半年）
      const y = now.getFullYear();
      const halfIdx = now.getMonth() < 6 ? 0 : 1; // 当前半年的下半年索引
      for (let i = 11; i >= 0; i--) {
        const n = halfIdx - i; // 相对当前半年的偏移（0=当前，-1=上一半年…）
        const ty = y + Math.floor(n / 2);
        const th = ((n % 2) + 2) % 2 === 0 ? 'H1' : 'H2';
        buckets.push(`${ty}-${th}`);
      }
    } else {
      // day：近 30 天
      labelOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      for (let i = 29; i >= 0; i--) buckets.push(labelOf(new Date(Date.now() - i * DAY)));
    }

    // 聚合：把日期时间戳按桶归并（用 ${fmt} 分组，day 直接用天）
    const start = new Date(Date.now() - 6 * 365 * DAY); // 最多取近 6 年数据足够
    // year 维度：按月分组后桶是 年-H1/H2 不匹配，直接用 年+半年 拼接分组
    const idExpr =
      type === 'year'
        ? {
            $concat: [
              { $dateToString: { format: '%Y', date: '$createdAt' } },
              '-',
              { $cond: [{ $lt: [{ $month: '$createdAt' }, 7] }, 'H1', 'H2'] },
            ],
          }
        : { $dateToString: { format: fmt, date: '$createdAt' } };
    const [uRows, aRows] = await Promise.all([
      UserModel.aggregate([
        { $match: { createdAt: { $gte: start } } },
        { $group: { _id: idExpr, count: { $sum: 1 } } },
      ]),
      ActivityModel.aggregate([
        { $match: { createdAt: { $gte: start } } },
        { $group: { _id: idExpr, count: { $sum: 1 } } },
      ]),
    ]);
    const uMap = new Map(uRows.map((r) => [r._id, r.count]));
    const aMap = new Map(aRows.map((r) => [r._id, r.count]));
    const data: { date: string; newUsers: number; newActivities: number }[] = buckets.map((key) => ({
      date: key,
      newUsers: uMap.get(key) ?? 0,
      newActivities: aMap.get(key) ?? 0,
    }));
    return success({ type, data });
  });

  // 轨迹省份/城市分布（按轨迹起点定位，离线 GeoJSON）
  fastify.get('/region-stats', { onRequest: [adminAuth] }, async () => {
    const acts = await ActivityModel.find({ status: 'finished' })
      .select('trackPoints')
      .lean();
    const provMap = new Map<string, number>();
    const cityMap = new Map<string, number>();
    for (const a of acts) {
      const pts = (a.trackPoints ?? []) as Array<{ lat?: number; lng?: number }>;
      const first = pts.find((p) => typeof p.lat === 'number' && typeof p.lng === 'number');
      if (!first) continue;
      const r = locateRegion(Number(first.lat), Number(first.lng));
      if (!r) continue;
      provMap.set(r.province, (provMap.get(r.province) ?? 0) + 1);
      cityMap.set(r.city, (cityMap.get(r.city) ?? 0) + 1);
    }
    const top = (m: Map<string, number>, n: number) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
    return success({
      provinces: top(provMap, 20),
      cities: top(cityMap, 20),
    });
  });

  // 用户列表（含每人轨迹数；支持昵称搜索 + 创建时间/最后登录排序）
  fastify.get('/users', { onRequest: [adminAuth] }, async (request) => {
    const { page = '1', pageSize = '20', keyword, sortBy, order } = request.query as { page?: string; pageSize?: string; keyword?: string; sortBy?: string; order?: string };
    const p = Math.max(1, Number(page) || 1);
    const ps = Math.min(100, Number(pageSize) || 20);
    const filter: Record<string, unknown> = {};
    if (keyword && String(keyword).trim()) {
      filter.nickname = { $regex: String(keyword).trim(), $options: 'i' };
    }
    const allowedSortFields = ['createdAt', 'lastLoginAt'];
    const sortField = allowedSortFields.includes(sortBy || '') ? sortBy! : 'lastLoginAt';
    const sortOrder = order === 'asc' ? 1 : -1;
    const [total, users, counts, lastLogins] = await Promise.all([
      UserModel.countDocuments(filter),
      UserModel.find(filter)
        .sort({ [sortField]: sortOrder })
        .skip((p - 1) * ps)
        .limit(ps)
        .lean(),
      ActivityModel.aggregate([{ $group: { _id: '$userId', count: { $sum: 1 } } }]),
      LoginLogModel.aggregate([
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$userId', ip: { $first: '$ip' }, province: { $first: '$province' }, city: { $first: '$city' } } },
      ]),
    ]);
    const countMap = new Map(counts.map((c) => [String(c._id), c.count]));
    const loginMap = new Map(lastLogins.map((l) => [String(l._id), l]));
    return success({
      total,
      page: p,
      pageSize: ps,
      items: users.map((u) => {
        const log = loginMap.get(String(u._id));
        return {
          id: String(u._id),
          nickname: u.nickname,
          openid: u.openid,
          weightKg: u.weightKg,
          heightCm: u.heightCm,
          createdAt: u.createdAt,
          lastLoginAt: u.lastLoginAt ?? u.createdAt,
          activityCount: countMap.get(String(u._id)) ?? 0,
          lastLoginIp: log?.ip ?? '',
          lastLoginProvince: log?.province ?? '',
          lastLoginCity: log?.city ?? '',
        };
      }),
    });
  });

  // 用户登录历史（分页，按时间倒序；支持时间区间筛选）
  fastify.get('/users/:id/login-logs', { onRequest: [adminAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    const { page = '1', pageSize = '20', startDate, endDate } = request.query as {
      page?: string;
      pageSize?: string;
      startDate?: string;
      endDate?: string;
    };
    const p = Math.max(1, Number(page) || 1);
    const ps = Math.min(100, Number(pageSize) || 20);
    const filter: Record<string, unknown> = { userId: id };
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) (filter.createdAt as any).$gte = new Date(startDate);
      if (endDate) (filter.createdAt as any).$lte = new Date(endDate);
    }
    const total = await LoginLogModel.countDocuments(filter);
    const logs = await LoginLogModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((p - 1) * ps)
      .limit(ps)
      .lean();
    return success({
      total,
      page: p,
      pageSize: ps,
      items: logs.map((l) => ({
        id: String(l._id),
        ip: l.ip ?? '',
        province: l.province ?? '',
        city: l.city ?? '',
        platform: l.platform ?? '',
        system: l.system ?? '',
        brand: l.brand ?? '',
        model: l.model ?? '',
        sdkVersion: l.sdkVersion ?? '',
        appVersion: l.appVersion ?? '',
        createdAt: l.createdAt,
      })),
    });
  });

  // 用户登录统计（最近 N 天登录次数）
  fastify.get('/users/:id/login-stats', { onRequest: [adminAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    const now = Date.now();
    const stats = await Promise.all([
      LoginLogModel.countDocuments({ userId: id, createdAt: { $gte: new Date(now - 7 * 86400000) } }),
      LoginLogModel.countDocuments({ userId: id, createdAt: { $gte: new Date(now - 30 * 86400000) } }),
      LoginLogModel.countDocuments({ userId: id, createdAt: { $gte: new Date(now - 180 * 86400000) } }),
      LoginLogModel.countDocuments({ userId: id }),
    ]);
    return success({
      last7Days: stats[0],
      last30Days: stats[1],
      last180Days: stats[2],
      total: stats[3],
    });
  });

  // 轨迹列表（含用户昵称；支持 类型/状态/距离/时长/用户昵称 筛选 + 距离/时长排序）
  fastify.get('/activities', { onRequest: [adminAuth] }, async (request) => {
    const q = request.query as {
      page?: string; pageSize?: string; userId?: string;
      type?: string; status?: string; keyword?: string;
      minDistance?: string; maxDistance?: string; minDuration?: string; maxDuration?: string;
      sortBy?: string; order?: string;
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
    const allowedSortFields = ['distance', 'duration', 'startTime'];
    const sortField = allowedSortFields.includes(q.sortBy || '') ? q.sortBy! : 'startTime';
    const sortOrder = q.order === 'asc' ? 1 : -1;
    const [total, items, users] = await Promise.all([
      ActivityModel.countDocuments(filter),
      ActivityModel.find(filter).sort({ [sortField]: sortOrder }).skip((p - 1) * ps).limit(ps).lean(),
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

  // 用户详情（管理后台用户页聚合：资料 + 周/月/年/总概况 + 个人最佳 + 点亮城市）
  fastify.get('/users/:id', { onRequest: [adminAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) throw new AppError(404, '用户不存在');
    const user = await UserModel.findById(id).lean();
    if (!user) throw new AppError(404, '用户不存在');
    const [stats, best, fp, activityCount] = await Promise.all([
      userStatsOverview(id),
      bestRecords(id),
      footprint(id),
      ActivityModel.countDocuments({ userId: new Types.ObjectId(id) }),
    ]);
    return success({
      user: {
        id,
        nickname: user.nickname ?? '',
        avatarUrl: user.avatarUrl ?? '',
        gender: user.gender ?? 0,
        openid: user.openid,
        weightKg: user.weightKg ?? null,
        heightCm: user.heightCm ?? null,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt ?? user.createdAt,
      },
      activityCount,
      overview: stats,
      best,
      footprint: fp,
    });
  });

  // 轨迹详情（管理后台弹窗：完整字段 + 打点照片签名 + 抽稀轨迹点供图）
  fastify.get('/activities/:id', { onRequest: [adminAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) throw new AppError(404, '轨迹不存在');
    const activity = await ActivityModel.findById(id).lean();
    if (!activity) throw new AppError(404, '轨迹不存在');
    const owner = await UserModel.findById(activity.userId).select('nickname').lean();
    const dto = toActivityDto(activity);
    // 私有 bucket：给打点照片签发访问签名（与用户端详情口径一致）
    for (const m of dto.markers) {
      if (m.photos && m.photos.length > 0) {
        m.photos = m.photos.map((p) => getSignedUrl(p));
        m.photoUrl = m.photos[0];
      } else if (m.photoUrl) {
        m.photoUrl = getSignedUrl(m.photoUrl);
      }
    }
    return success({
      ...dto,
      userId: String(activity.userId),
      userNickname: owner?.nickname || '微信用户',
      pointsCount: dto.trackPoints.length,
      // 抽稀到 ≤600 点：弹窗海拔/速度图用，避免 2 万点全量下发
      trackPoints: samplePoints(dto.trackPoints, 600),
    });
  });
}

/** 均匀采样（保留首尾点） */
function samplePoints<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const out: T[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    out.push(points[Math.round(i * step)]);
  }
  return out;
}
