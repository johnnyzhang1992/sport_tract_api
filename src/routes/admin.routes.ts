import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import jsonwebtoken from 'jsonwebtoken';
import { Types, type PipelineStage } from 'mongoose';
import { AdminModel, hashPassword, verifyPassword } from '../models/admin.model.js';
import { UserModel } from '../models/user.model.js';
import { LoginLogModel } from '../models/login-log.model.js';
import { ActivityModel } from '../models/activity.model.js';
import { FootprintRecordModel } from '../models/footprint-record.model.js';
import { config } from '../config/index.js';
import { success } from '../utils/response.js';
import { AppError } from '../utils/app-error.js';
import { assertObjectIdLike, isObjectIdLike } from '../utils/object-id.js';
import { locateRegion } from '../services/region.js';
import { INVALID_REGION_VALUES, isValidRegionValue } from '../services/ip-locate.js';
import { overview as userStatsOverview, bestRecords } from '../services/stats.js';
import { footprint, markFootprintDirty } from '../services/footprint.js';
import {
  adminListFootprintRecords,
  adminGetFootprintById,
  deleteFootprintById,
} from '../services/footprint-record.js';
import { autoFinishStaleActivities, toActivityDto } from '../services/activity.js';
import { assertActivityForGpx, toGpx } from '../services/gpx.js';
import {
  adminListTopics,
  createTopic,
  updateTopic,
  deleteTopic,
  type TopicInput,
} from '../services/topic.js';
import { backfillUsers, backfillEmptyNicknames } from '../services/uid.js';
import { backfillVehicle } from '../services/vehicle-backfill.js';
import { leaderboard, leaderboardRegions } from '../services/leaderboard.js';
import { calcStats, calcFastestKm, type TrackPointLike } from '../utils/pace.js';
import { getSignedUrl, cleanUrl, getThumbUrl, uploadBuffer } from '../services/oss.js';

/**
 * 一条轨迹的图片数与首图（列表缩略图用）
 * photoUrl 与 photos[0] 是同一张图的两份记录，跨 markers 也可能重复挂同一文件 → 按裸链去重；
 * 老数据只有 photoUrl 没有 photos，按 1 张算。库里可能混着历史上写入的签名链，去重前先剥参数。
 */
function photoSummary(markers: Array<{ photoUrl?: string; photos?: string[] }> | undefined) {
  const seen = new Set<string>();
  let cover = '';
  for (const m of markers ?? []) {
    const urls = m.photos && m.photos.length ? m.photos : m.photoUrl ? [m.photoUrl] : [];
    for (const p of urls) {
      const bare = cleanUrl(p);
      if (!bare || seen.has(bare)) continue;
      seen.add(bare);
      if (!cover) cover = bare;
    }
  }
  return { photoCount: seen.size, coverPhoto: cover ? getThumbUrl(cover) : '' };
}

/**
 * 管理后台路由：/api/admin/*（与小程序用户接口隔离）
 * - 管理员登录（用户名 + 密码，bcrypt 校验，密码存数据库可修改）
 * - 其余接口需 admin token（独立 JWT secret，普通用户 token 无效）
 */

const DAY_MS = 86400000;

/** 东八区今日 0 点（epoch ms），与服务器时区无关 */
function bjToday0(): number {
  const bj = new Date(Date.now() + 8 * 3600000);
  return Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - 8 * 3600000;
}

/** 东八区日期串（YYYY-MM-DD） */
function bjDateStr(ms: number): string {
  return new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
}

/**
 * 生成趋势图时间桶：range=week（近 7 天按天）/ month（近 30 天按天）/ year（近 12 个月按月）
 * 返回时间桶标签 + 查询起始时间 + MongoDB 分组格式（均按东八区）
 */
function buildUserTrendBuckets(range: string): {
  labels: string[];
  start: number;
  bucketFmt: string;
} {
  if (range === 'year') {
    const bj = new Date(Date.now() + 8 * 3600000);
    const y = bj.getUTCFullYear();
    const m = bj.getUTCMonth();
    const labels: string[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(y, m - i, 1));
      labels.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    return { labels, start: Date.UTC(y, m - 11, 1) - 8 * 3600000, bucketFmt: '%Y-%m' };
  }
  const days = range === 'month' ? 30 : 7;
  const today0 = bjToday0();
  const labels: string[] = [];
  for (let i = days - 1; i >= 0; i--) labels.push(bjDateStr(today0 - i * DAY_MS));
  return { labels, start: today0 - (days - 1) * DAY_MS, bucketFmt: '%Y-%m-%d' };
}

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
    const [userCount, activityCount, finishedCount, distAgg, footprintCount, footprintUsers, photoAgg] =
      await Promise.all([
        UserModel.countDocuments({}),
        ActivityModel.countDocuments({}),
        ActivityModel.countDocuments({ status: 'finished' }),
        ActivityModel.aggregate([
          { $match: { status: 'finished' } },
          { $group: { _id: null, total: { $sum: '$distance' } } },
        ]),
        FootprintRecordModel.countDocuments({}),
        FootprintRecordModel.distinct('userId'),
        FootprintRecordModel.aggregate([
          { $group: { _id: null, total: { $sum: { $size: { $ifNull: ['$photos', []] } } } } },
        ]),
      ]);
    return success({
      userCount,
      activityCount,
      finishedCount,
      totalDistanceKm: Math.round(((distAgg[0]?.total as number) ?? 0) / 10) / 100,
      footprintCount,
      footprintUserCount: footprintUsers.length,
      footprintPhotoCount: (photoAgg[0]?.total as number) ?? 0,
    });
  });

  // 时间维度数据量：新增用户/新增轨迹/新增足迹 + 登录 UV·PV（today/week/month）
  fastify.get('/stats', { onRequest: [adminAuth] }, async (request) => {
    const DAY = 86400000;
    const now = Date.now();
    const ranges = {
      today: new Date(new Date(now).setHours(0, 0, 0, 0)).getTime(),
      week: now - 7 * DAY,
      month: now - 30 * DAY,
    };
    const out: Record<string, { newUsers: number; newActivities: number; newFootprints: number; uv: number; pv: number }> = {};
    for (const [k, start] of Object.entries(ranges)) {
      const since = new Date(start);
      // 登录 UV/PV：PV = 登录次数，UV = 周期内登录过的去重用户数
      const [newUsers, newActivities, newFootprints, pv, uvRows] = await Promise.all([
        UserModel.countDocuments({ createdAt: { $gte: since } }),
        ActivityModel.countDocuments({ createdAt: { $gte: since } }),
        FootprintRecordModel.countDocuments({ createdAt: { $gte: since } }),
        LoginLogModel.countDocuments({ createdAt: { $gte: since } }),
        LoginLogModel.aggregate([
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: '$userId' } },
        ]),
      ]);
      out[k] = { newUsers, newActivities, newFootprints, uv: uvRows.length, pv };
    }
    return success(out);
  });

  // 数据趋势：新增用户/轨迹/足迹（折线图），维度 type=day|week|month|year
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
    const [uRows, aRows, fRows] = await Promise.all([
      UserModel.aggregate([
        { $match: { createdAt: { $gte: start } } },
        { $group: { _id: idExpr, count: { $sum: 1 } } },
      ]),
      ActivityModel.aggregate([
        { $match: { createdAt: { $gte: start } } },
        { $group: { _id: idExpr, count: { $sum: 1 } } },
      ]),
      FootprintRecordModel.aggregate([
        { $match: { createdAt: { $gte: start } } },
        { $group: { _id: idExpr, count: { $sum: 1 } } },
      ]),
    ]);
    const uMap = new Map(uRows.map((r) => [r._id, r.count]));
    const aMap = new Map(aRows.map((r) => [r._id, r.count]));
    const fMap = new Map(fRows.map((r) => [r._id, r.count]));
    const data: { date: string; newUsers: number; newActivities: number; newFootprints: number }[] = buckets.map(
      (key) => ({
        date: key,
        newUsers: uMap.get(key) ?? 0,
        newActivities: aMap.get(key) ?? 0,
        newFootprints: fMap.get(key) ?? 0,
      }),
    );
    return success({ type, data });
  });

  // 用户概况：用户总量 + 今日/近 7 天/近 30 天 注册数 + 登录 UV（去重）/ PV（登录次数），按东八区口径
  fastify.get('/user-stats', { onRequest: [adminAuth] }, async () => {
    const today0 = bjToday0();
    const weekStart = today0 - 6 * DAY_MS; // 近 7 天（含今日）
    const monthStart = today0 - 29 * DAY_MS; // 近 30 天（含今日）
    const sinceToday = new Date(today0);
    const sinceWeek = new Date(weekStart);
    const sinceMonth = new Date(monthStart);
    // UV 用 $group 去重，避免 distinct 全量拉取
    const uvCount = (since: Date) =>
      LoginLogModel.aggregate<{ n: number }>([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: '$userId' } },
        { $count: 'n' },
      ]).then((r) => r[0]?.n ?? 0);
    const [totalUsers, todayNewUsers, weekNewUsers, monthNewUsers, todayPv, todayUv, weekPv, weekUv, monthPv, monthUv] =
      await Promise.all([
        UserModel.countDocuments({}),
        UserModel.countDocuments({ createdAt: { $gte: sinceToday } }),
        UserModel.countDocuments({ createdAt: { $gte: sinceWeek } }),
        UserModel.countDocuments({ createdAt: { $gte: sinceMonth } }),
        LoginLogModel.countDocuments({ createdAt: { $gte: sinceToday } }),
        uvCount(sinceToday),
        LoginLogModel.countDocuments({ createdAt: { $gte: sinceWeek } }),
        uvCount(sinceWeek),
        LoginLogModel.countDocuments({ createdAt: { $gte: sinceMonth } }),
        uvCount(sinceMonth),
      ]);
    return success({
      totalUsers,
      today: { newUsers: todayNewUsers, uv: todayUv, pv: todayPv },
      week: { newUsers: weekNewUsers, uv: weekUv, pv: weekPv },
      month: { newUsers: monthNewUsers, uv: monthUv, pv: monthPv },
    });
  });

  // 用户趋势：注册用户量 + 登录 UV/PV（range=week|month|year，按东八区分桶补零）
  fastify.get('/user-trend', { onRequest: [adminAuth] }, async (request) => {
    const raw = String((request.query as { range?: string }).range || 'week');
    const range = ['week', 'month', 'year'].includes(raw) ? raw : 'week';
    const { labels, start, bucketFmt } = buildUserTrendBuckets(range);
    const bucketExpr = { $dateToString: { format: bucketFmt, date: '$createdAt', timezone: '+08:00' } };
    const [userRows, loginRows] = await Promise.all([
      UserModel.aggregate<{ _id: string; count: number }>([
        { $match: { createdAt: { $gte: new Date(start) } } },
        { $group: { _id: bucketExpr, count: { $sum: 1 } } },
      ]),
      LoginLogModel.aggregate<{ _id: string; pv: number; uv: number }>([
        { $match: { createdAt: { $gte: new Date(start) } } },
        { $group: { _id: bucketExpr, pv: { $sum: 1 }, users: { $addToSet: '$userId' } } },
        { $project: { pv: 1, uv: { $size: '$users' } } },
      ]),
    ]);
    const userMap = new Map(userRows.map((r) => [r._id, r.count]));
    const loginMap = new Map(loginRows.map((r) => [r._id, r]));
    return success({
      range,
      data: labels.map((date) => ({
        date,
        newUsers: userMap.get(date) ?? 0,
        uv: loginMap.get(date)?.uv ?? 0,
        pv: loginMap.get(date)?.pv ?? 0,
      })),
    });
  });

  // 用户分布：按登录 IP 归属地聚合省/市去重用户数（无法定位的归入“未知”，不作为省份上地图）
  fastify.get('/user-geo-stats', { onRequest: [adminAuth] }, async () => {
    const UNKNOWN = '未知';
    // 历史脏数据：ip2region/whois 可能落库 "0"、"内网IP"、空串或缺失，统一归到“未知”
    const provinceExpr = {
      $cond: [{ $in: [{ $ifNull: ['$province', ''] }, INVALID_REGION_VALUES] }, UNKNOWN, '$province'],
    };
    const cityExpr = {
      $cond: [{ $in: [{ $ifNull: ['$city', ''] }, INVALID_REGION_VALUES] }, UNKNOWN, '$city'],
    };
    const [provRows, cityRows, totalUsers] = await Promise.all([
      LoginLogModel.aggregate<{ name: string; users: number }>([
        { $group: { _id: provinceExpr, users: { $addToSet: '$userId' } } },
        { $project: { _id: 0, name: '$_id', users: { $size: '$users' } } },
        { $sort: { users: -1 } },
      ]),
      LoginLogModel.aggregate<{ name: string; province: string; users: number }>([
        {
          $group: {
            _id: { province: provinceExpr, city: cityExpr },
            users: { $addToSet: '$userId' },
          },
        },
        { $project: { _id: 0, name: '$_id.city', province: '$_id.province', users: { $size: '$users' } } },
        { $sort: { users: -1 } },
      ]),
      UserModel.countDocuments({}),
    ]);
    const totalLocated = provRows.reduce((s, p) => s + p.users, 0);
    return success({ totalUsers, totalLocated, provinces: provRows, cities: cityRows });
  });

  // 轨迹数据概况：today/week/month/year/all 各范围指标 + 状态细分 + 类型细分（一次 $facet 聚合）
  fastify.get('/activity-stats', { onRequest: [adminAuth] }, async () => {
    const DAY = 86400000;
    // 北京时间今日 0 点（产品为中国用户，概况口径统一按东八区）
    const today0 = new Date(new Date().toLocaleDateString('en-CA') + 'T00:00:00+08:00').getTime();
    const now = Date.now();
    const ranges: Record<string, number | null> = {
      today: today0,
      week: now - 7 * DAY,
      month: now - 30 * DAY,
      year: now - 365 * DAY,
      all: null,
    };
    const groupStage = {
      $group: {
        _id: null,
        count: { $sum: 1 },
        distance: { $sum: '$distance' },
        duration: { $sum: '$duration' },
        calories: { $sum: '$calories' },
        elevationGain: { $sum: '$elevationGain' },
      },
    };
    const facet: Record<string, PipelineStage.FacetPipelineStage[]> = {};
    for (const [key, since] of Object.entries(ranges)) {
      const timeMatch = since == null ? [] : [{ $match: { startTime: { $gte: since } } }];
      facet[key] = [...timeMatch, { $match: { status: 'finished' } }, groupStage];
      facet[`${key}_status`] = [...timeMatch, { $group: { _id: '$status', count: { $sum: 1 } } }];
      facet[`${key}_type`] = [
        ...timeMatch,
        { $match: { status: 'finished' } },
        {
          $group: {
            _id: '$type',
            count: { $sum: 1 },
            distance: { $sum: '$distance' },
            duration: { $sum: '$duration' },
          },
        },
        { $sort: { count: -1 } },
      ];
    }
    const [rows] = await ActivityModel.aggregate([{ $facet: facet }]);
    const pick = (arr: Array<Record<string, number>>) => {
      const r = arr?.[0];
      return {
        count: r?.count ?? 0,
        distance: r?.distance ?? 0,
        duration: r?.duration ?? 0,
        calories: r?.calories ?? 0,
        elevationGain: r?.elevationGain ?? 0,
      };
    };
    const STATUS_KEYS = ['finished', 'in_progress', 'cancelled'];
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(ranges)) {
      const statusRows = (rows?.[`${key}_status`] ?? []) as Array<Record<string, unknown>>;
      const statusMap = new Map(statusRows.map((r) => [String(r._id), Number(r.count)]));
      const finishedCount = statusMap.get('finished') ?? 0;
      const totalCount = statusRows.reduce((sum: number, r) => sum + Number(r.count), 0);
      out[key] = {
        ...pick(rows?.[key]),
        byStatus: STATUS_KEYS.map((st) => ({ status: st, count: statusMap.get(st) ?? 0 })),
        finishRate: totalCount > 0 ? Math.round((finishedCount / totalCount) * 1000) / 10 : 0,
        byType: (rows?.[`${key}_type`] ?? []).map((r: Record<string, unknown>) => ({
          type: String(r._id),
          count: Number(r.count),
          distance: Number(r.distance ?? 0),
          duration: Number(r.duration ?? 0),
        })),
      };
    }
    return success(out);
  });

  // 轨迹趋势：近 N 天按天轨迹数 + 距离（startTime 按东八区分桶，补零填充）
  fastify.get('/activity-trend', { onRequest: [adminAuth] }, async (request) => {
    const q = request.query as { days?: string };
    const days = Math.min(365, Math.max(7, Number(q.days) || 30));
    const start = Date.now() - days * 86400000;
    // 东八区日期桶：JS 用 +8h 后取 UTC 日期，与聚合 timezone 一致
    const buckets: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      buckets.push(new Date(Date.now() + 8 * 3600000 - i * 86400000).toISOString().slice(0, 10));
    }
    const rows = await ActivityModel.aggregate([
      { $match: { status: 'finished', startTime: { $gte: start } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: { $toDate: '$startTime' }, timezone: '+08:00' } },
          count: { $sum: 1 },
          distance: { $sum: '$distance' },
        },
      },
    ]);
    const rowMap = new Map(rows.map((r) => [r._id, r]));
    return success({
      days,
      data: buckets.map((date) => {
        const r = rowMap.get(date);
        return {
          date,
          count: r?.count ?? 0,
          distanceKm: Math.round(((r?.distance ?? 0) / 1000) * 100) / 100,
        };
      }),
    });
  });

  // 轨迹省份分布（含城市明细）：按落库 startProvince/startCity 聚合，支持时间范围
  fastify.get('/activity-geo-stats', { onRequest: [adminAuth] }, async (request) => {
    const q = request.query as { range?: string };
    const DAY = 86400000;
    const today0 = new Date(new Date().toLocaleDateString('en-CA') + 'T00:00:00+08:00').getTime();
    const rangeMap: Record<string, number | null> = {
      today: today0,
      week: Date.now() - 7 * DAY,
      month: Date.now() - 30 * DAY,
      year: Date.now() - 365 * DAY,
      all: null,
    };
    const since = rangeMap[q.range || 'all'] !== undefined ? rangeMap[q.range || 'all'] : null;
    const filter: Record<string, unknown> = { status: 'finished' };
    if (since != null) filter.startTime = { $gte: since };
    const rows = await ActivityModel.aggregate([
      { $match: filter },
      { $group: { _id: { prov: '$startProvince', city: '$startCity' }, count: { $sum: 1 } } },
    ]);
    // 组装省 → 市层级（空省份过滤：历史数据可能未落库省市）
    const provMap = new Map<string, Map<string, number>>();
    let total = 0;
    for (const r of rows) {
      const prov = r._id?.prov;
      const city = r._id?.city || '未知';
      if (!prov) continue;
      total += r.count;
      if (!provMap.has(prov)) provMap.set(prov, new Map());
      const cities = provMap.get(prov)!;
      cities.set(city, (cities.get(city) ?? 0) + r.count);
    }
    const provinces = [...provMap.entries()]
      .map(([province, cities]) => ({
        province,
        count: [...cities.values()].reduce((s, c) => s + c, 0),
        cities: [...cities.entries()].map(([city, count]) => ({ city, count })).sort((a, b) => b.count - a.count),
      }))
      .sort((a, b) => b.count - a.count);
    return success({ range: q.range || 'all', total, provinces });
  });

  // 轨迹省份/城市分布（按轨迹起点定位，离线 GeoJSON）
  fastify.get('/region-stats', { onRequest: [adminAuth] }, async () => {
    const acts = await ActivityModel.find({ status: 'finished' })
      .select('trackPoints')
      .lean();
    const provMap = new Map<string, number>();
    const cityMap = new Map<string, { province: string; count: number }>();
    for (const a of acts) {
      const pts = (a.trackPoints ?? []) as Array<{ lat?: number; lng?: number }>;
      const first = pts.find((p) => typeof p.lat === 'number' && typeof p.lng === 'number');
      if (!first) continue;
      const r = locateRegion(Number(first.lat), Number(first.lng));
      if (!r) continue;
      provMap.set(r.province, (provMap.get(r.province) ?? 0) + 1);
      const prev = cityMap.get(r.city);
      if (prev) prev.count += 1;
      else cityMap.set(r.city, { province: r.province, count: 1 });
    }
    const top = (m: Map<string, number>, n: number) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
    return success({
      provinces: top(provMap, 20),
      cities: [...cityMap.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 20)
        .map(([name, v]) => ({ name, province: v.province, count: v.count })),
    });
  });

  // 用户列表（含每人轨迹数；支持昵称搜索 + 创建时间/最后登录排序）
  fastify.get('/users', { onRequest: [adminAuth] }, async (request) => {
    const { page = '1', pageSize = '20', keyword, sortBy, order } = request.query as { page?: string; pageSize?: string; keyword?: string; sortBy?: string; order?: string };
    const p = Math.max(1, Number(page) || 1);
    const ps = Math.min(100, Number(pageSize) || 20);
    const filter: Record<string, unknown> = {};
    if (keyword && String(keyword).trim()) {
      const kw = { $regex: String(keyword).trim(), $options: 'i' };
      filter.$or = [{ nickname: kw }, { note: kw }]; // 昵称或管理员备注匹配
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
      // 按 status 双计数：finished 单列（列表展示 {已完成}/{总}），in_progress/abandoned 归入总数
      ActivityModel.aggregate([
        {
          $group: {
            _id: '$userId',
            count: { $sum: 1 },
            finishedCount: { $sum: { $cond: [{ $eq: ['$status', 'finished'] }, 1, 0] } },
          },
        },
      ]),
      LoginLogModel.aggregate([
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$userId', ip: { $first: '$ip' }, province: { $first: '$province' }, city: { $first: '$city' } } },
      ]),
    ]);
    const countMap = new Map(counts.map((c) => [String(c._id), { count: c.count, finished: c.finishedCount }]));
    const loginMap = new Map(lastLogins.map((l) => [String(l._id), l]));
    return success({
      total,
      page: p,
      pageSize: ps,
      items: users.map((u) => {
        const log = loginMap.get(String(u._id));
        const uc = countMap.get(String(u._id));
        return {
          id: String(u._id),
          nickname: u.nickname,
          gender: u.gender ?? 0, // 0 未知 1 男 2 女
          uid: u.uid != null ? String(u.uid) : '', // 用户唯一编号（openid 敏感不下发）
          weightKg: u.weightKg,
          heightCm: u.heightCm,
          createdAt: u.createdAt,
          lastLoginAt: u.lastLoginAt ?? u.createdAt,
          activityCount: uc?.count ?? 0, // 全部轨迹数
          finishedCount: uc?.finished ?? 0, // 已完成轨迹数
          note: u.note ?? '', // 管理员备注（仅管理端可见）
          lastLoginIp: log?.ip ?? '',
          // 定位失败的历史脏值（"0"/"内网IP"/空）统一显示“未知”
          lastLoginProvince: isValidRegionValue(log?.province) ? log!.province : '未知',
          lastLoginCity: isValidRegionValue(log?.city) ? log!.city : '未知',
        };
      }),
    });
  });

  // 老用户资料补全（部署后手动触发一次即可）：
  // 1) 缺 UID → 按创建时间补号（1000 起，不动已有昵称）
  // 2) 空昵称 → 补默认昵称 迹路者{uid}
  fastify.post('/users/backfill', { onRequest: [adminAuth] }, async () => {
    const { uidBackfilled } = await backfillUsers();
    const nicknameBackfilled = await backfillEmptyNicknames();
    const remaining = await UserModel.countDocuments({ uid: { $exists: false } });
    return success({ uidBackfilled, nicknameBackfilled, remaining });
  });

  // 设置用户备注（仅管理后台可见/编辑）
  fastify.put('/users/:id/note', { onRequest: [adminAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    assertObjectIdLike(id, '用户不存在');
    const { note } = (request.body ?? {}) as { note?: string };
    const raw = String(note ?? '').trim();
    if (raw.length > 200) throw new AppError(400, '备注最多 200 字');
    const user = await UserModel.findById(id).select('_id').lean();
    if (!user) throw new AppError(404, '用户不存在');
    await UserModel.updateOne({ _id: id }, { $set: { note: raw } });
    return success({ id, note: raw }, '备注已保存');
  });

  // 修改轨迹状态（管理端手动纠错：已完成↔已作废互转；不提供删除）
  // - in_progress 是进行中的同步会话，不允许干预（超过 24h 惰性清理自动收尾）
  // - 状态变化影响用户端列表/统计/足迹 → markFootprintDirty
  fastify.put('/activities/:id/status', { onRequest: [adminAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    assertObjectIdLike(id, '轨迹不存在');
    const { status } = (request.body ?? {}) as { status?: string };
    if (status !== 'finished' && status !== 'cancelled') {
      throw new AppError(400, 'status 仅支持 finished / cancelled');
    }
    const activity = await ActivityModel.findById(id).select('status userId').lean();
    if (!activity) throw new AppError(404, '轨迹不存在');
    if (activity.status === 'in_progress') {
      throw new AppError(400, '进行中的活动不能手动改状态（超过 24h 会自动收尾）');
    }
    if (activity.status === status) {
      return success({ id, status, changed: false }, '状态未变化');
    }
    await ActivityModel.updateOne({ _id: id }, { $set: { status } });
    await markFootprintDirty(String(activity.userId));
    return success(
      { id, status, changed: true },
      status === 'cancelled' ? '已作废该轨迹' : '已恢复为有效',
    );
  });

  // 用户登录历史（分页，按时间倒序；支持时间区间筛选）
  fastify.get('/users/:id/login-logs', { onRequest: [adminAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    assertObjectIdLike(id, '用户不存在');
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
    assertObjectIdLike(id, '用户不存在');
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

    // 惰性清理：in_progress 超过 24h 无更新（用户杀进程/异常退出）→ 自动收尾
    // 有轨迹点自动 finished 保留数据（endTime 以最后点上报时间为准）；空活动作废
    // 与用户端 listActivities 口径一致；admin 跨全部用户，不按 userId 过滤
    await autoFinishStaleActivities().catch(() => {});

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
      // 列表不下发轨迹点/打点大字段
      ActivityModel.find(filter)
        .select('-trackPoints -markers')
        .sort({ [sortField]: sortOrder })
        .skip((p - 1) * ps)
        .limit(ps)
        .lean(),
      UserModel.find({}).select('_id nickname gender').lean(),
    ]);
    // 图片列要数图：只回表捞这一页的 markers 照片字段（不放开头条的 -markers，避免整坨打点下发）
    const photoRows = items.length
      ? await ActivityModel.find({ _id: { $in: items.map((a) => a._id) } })
          .select('markers.photos markers.photoUrl')
          .lean()
      : [];
    const photoMap = new Map(photoRows.map((r) => [String(r._id), photoSummary(r.markers)]));
    const nickMap = new Map(users.map((u) => [String(u._id), u.nickname || '微信用户']));
    const genderMap = new Map(users.map((u) => [String(u._id), u.gender ?? 0]));
    return success({
      total,
      page: p,
      pageSize: ps,
      items: items.map((a) => ({
        id: String(a._id),
        userId: String(a.userId),
        userNickname: nickMap.get(String(a.userId)) ?? '微信用户',
        userGender: genderMap.get(String(a.userId)) ?? 0,
        type: a.type,
        status: a.status,
        distance: a.distance ?? 0,
        duration: a.duration ?? 0,
        calories: a.calories ?? 0,
        elevationGain: a.elevationGain ?? 0,
        startProvince: a.startProvince ?? '',
        startCity: a.startCity ?? '',
        startTime: a.startTime,
        ...photoMap.get(String(a._id)) ?? { photoCount: 0, coverPhoto: '' },
      })),
    });
  });

  // 足迹数据概况：today/week/month/year/all 五档一次给全（前端切档不再请求）
  // 时间一律按「记录创建时间 createdAt」——到访日期是用户手填的，可以填三年前，讲不清「这段时间进了多少数据」
  // 传 userId 则收口到单个用户（用户详情页的个人足迹概况用），不传是全站
  fastify.get('/footprint-stats', { onRequest: [adminAuth] }, async (request) => {
    const q = request.query as { userId?: string };
    const scope: Record<string, unknown> = {};
    if (q.userId?.trim()) {
      // aggregate 的 $match 不按 schema 转型，字符串 userId 必须先转 ObjectId（否则恒不命中、静默给 0）
      const raw = assertObjectIdLike(q.userId.trim(), '用户不存在');
      scope.userId = new Types.ObjectId(String(raw));
    }
    const DAY = 86400000;
    const now = Date.now();
    const ranges: Record<string, number | null> = {
      today: bjToday0(),
      week: now - 7 * DAY,
      month: now - 30 * DAY,
      year: now - 365 * DAY,
      all: null,
    };
    const groupStage: PipelineStage.FacetPipelineStage = {
      $group: {
        _id: null,
        total: { $sum: 1 },
        users: { $addToSet: '$userId' },
        provinces: { $addToSet: { $ifNull: ['$location.province', ''] } },
        // 城市按「省|市」组合去重：同名市跨省时不能合并（两个 测试市己 是两个地方）
        cities: {
          $addToSet: {
            $concat: [{ $ifNull: ['$location.province', ''] }, '|', { $ifNull: ['$location.city', ''] }],
          },
        },
        photos: { $sum: { $size: { $ifNull: ['$photos', []] } } },
        withPhoto: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$photos', []] } }, 0] }, 1, 0] } },
      },
    };
    const facet: Record<string, PipelineStage.FacetPipelineStage[]> = {};
    for (const [key, since] of Object.entries(ranges)) {
      const match: Record<string, unknown> = { ...scope };
      if (since != null) match.createdAt = { $gte: new Date(since) };
      facet[key] = [
        { $match: match } as PipelineStage.FacetPipelineStage,
        groupStage,
      ];
    }
    const [rows] = await FootprintRecordModel.aggregate([{ $facet: facet }]);
    const out: Record<
      string,
      {
        total: number;
        userCount: number;
        provinceCount: number;
        cityCount: number;
        photoCount: number;
        withPhotoCount: number;
      }
    > = {};
    for (const key of Object.keys(ranges)) {
      const r = (rows?.[key] as Array<Record<string, unknown>> | undefined)?.[0];
      const provinces = (r?.provinces as string[] | undefined) ?? [];
      const cities = (r?.cities as string[] | undefined) ?? [];
      const hasText = (s: string | undefined) => !!s && !!s.trim();
      out[key] = {
        total: Number(r?.total ?? 0),
        userCount: ((r?.users as unknown[] | undefined) ?? []).length,
        provinceCount: provinces.filter(hasText).length,
        cityCount: cities.filter((c) => {
          const [p, ci] = String(c).split('|');
          return hasText(p) || hasText(ci);
        }).length,
        photoCount: Number(r?.photos ?? 0),
        withPhotoCount: Number(r?.withPhoto ?? 0),
      };
    }
    return success(out);
  });

  // 足迹省份分布（含城市明细）：按落库 location.province/city 聚合，range 同概况五档
  // 空省市的记录在地图上没有位置 → 不入分布，只体现在概况总数里（与 activity-geo-stats 同处理）
  fastify.get('/footprint-geo-stats', { onRequest: [adminAuth] }, async (request) => {
    const q = request.query as { range?: string };
    const rangeMap: Record<string, number | null> = {
      today: bjToday0(),
      week: Date.now() - 7 * DAY_MS,
      month: Date.now() - 30 * DAY_MS,
      year: Date.now() - 365 * DAY_MS,
      all: null,
    };
    const since = rangeMap[q.range || 'all'] !== undefined ? rangeMap[q.range || 'all'] : null;
    const filter: Record<string, unknown> = {};
    if (since != null) filter.createdAt = { $gte: new Date(since) };
    const rows = await FootprintRecordModel.aggregate([
      { $match: filter },
      { $group: { _id: { prov: '$location.province', city: '$location.city' }, count: { $sum: 1 } } },
    ]);
    const provMap = new Map<string, Map<string, number>>();
    let total = 0;
    for (const r of rows) {
      const prov = String(r._id?.prov ?? '').trim();
      if (!prov) continue;
      const city = String(r._id?.city ?? '').trim() || '未知';
      total += r.count;
      if (!provMap.has(prov)) provMap.set(prov, new Map());
      const cities = provMap.get(prov)!;
      cities.set(city, (cities.get(city) ?? 0) + r.count);
    }
    const provinces = [...provMap.entries()]
      .map(([province, cities]) => ({
        province,
        count: [...cities.values()].reduce((s, c) => s + c, 0),
        cities: [...cities.entries()].map(([city, count]) => ({ city, count })).sort((a, b) => b.count - a.count),
      }))
      .sort((a, b) => b.count - a.count);
    return success({ range: q.range || 'all', total, provinces });
  });

  // 足迹趋势：近 N 天按天「新增足迹条数 + 新增照片数」（createdAt 按东八区分桶，缺数据的桶补 0）
  fastify.get('/footprint-trend', { onRequest: [adminAuth] }, async (request) => {
    const q = request.query as { days?: string };
    const days = Math.min(365, Math.max(7, Number(q.days) || 30));
    const start = Date.now() - days * 86400000;
    const buckets: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      buckets.push(new Date(Date.now() + 8 * 3600000 - i * 86400000).toISOString().slice(0, 10));
    }
    // aggregate 的 $match 不像 find 那样按 schema 自动转型，Date 字段必须显式 new Date
    const rows = await FootprintRecordModel.aggregate([
      { $match: { createdAt: { $gte: new Date(start) } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+08:00' } },
          count: { $sum: 1 },
          photos: { $sum: { $size: { $ifNull: ['$photos', []] } } },
        },
      },
    ]);
    const rowMap = new Map(rows.map((r) => [r._id, r]));
    return success({
      days,
      data: buckets.map((date) => ({
        date,
        count: rowMap.get(date)?.count ?? 0,
        photos: rowMap.get(date)?.photos ?? 0,
      })),
    });
  });

  // 足迹列表（全站；回填归属人昵称/UID，不下发照片数组）
  fastify.get('/footprint-records', { onRequest: [adminAuth] }, async (request) => {
    const q = request.query as {
      page?: string; pageSize?: string; userId?: string; keyword?: string; province?: string;
      minPhotos?: string; visitFrom?: string; visitTo?: string;
    };
    const minPhotos = Number(q.minPhotos);
    return success(
      await adminListFootprintRecords({
        page: Math.max(1, Number(q.page) || 1),
        pageSize: Math.min(100, Number(q.pageSize) || 20),
        userId: q.userId?.trim() || undefined,
        keyword: q.keyword?.trim() || undefined,
        province: q.province?.trim() || undefined,
        minPhotos: Number.isFinite(minPhotos) && minPhotos > 0 ? Math.floor(minPhotos) : undefined,
        visitFrom: q.visitFrom?.trim() || undefined,
        visitTo: q.visitTo?.trim() || undefined,
      }),
    );
  });

  // 足迹详情（含照片签名 URL 与归属人）
  fastify.get('/footprint-records/:id', { onRequest: [adminAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    return success(await adminGetFootprintById(id));
  });

  // 删除足迹（合规图误放行 / 违规内容处置；硬删并清理 OSS 照片）
  fastify.delete('/footprint-records/:id', { onRequest: [adminAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    await deleteFootprintById(id);
    return success(null);
  });

  // 用户详情（管理后台用户页聚合：资料 + 周/月/年/总概况 + 个人最佳 + 点亮城市）
  fastify.get('/users/:id', { onRequest: [adminAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    assertObjectIdLike(id, '用户不存在');
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
        avatarUrl: user.avatarUrl ? getSignedUrl(user.avatarUrl) : '',
        gender: user.gender ?? 0,
        openid: user.openid,
        weightKg: user.weightKg ?? null,
        heightCm: user.heightCm ?? null,
        note: user.note ?? '',
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
    assertObjectIdLike(id, '轨迹不存在');
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

  /**
   * 导出 GPX（管理端）：与用户端 /activities/:id/gpx 同一份 toGpx 口径（坐标反算 WGS-84、打点作航点）
   * 管理员按 id 直取不校验归属；用全量轨迹点，不像详情那样抽稀到 600 点 —— 导出是存档，不能缺点
   */
  fastify.get('/activities/:id/gpx', { onRequest: [adminAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    assertObjectIdLike(id, '轨迹不存在');
    const activity = await ActivityModel.findById(id).lean();
    if (!activity) throw new AppError(404, '轨迹不存在');
    assertActivityForGpx(activity);
    reply.header('Content-Type', 'application/gpx+xml; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="activity-${id}.gpx"`);
    return toGpx(activity);
  });

  // 运动榜（管理端）：与用户端 /stats/leaderboard 同口径；TOP N（默认 20）
  // 管理端不下发"我的排名"，行数据带 userId 供跳转用户详情
  fastify.get('/leaderboard', { onRequest: [adminAuth] }, async (request) => {
    const q = request.query as { type?: string; province?: string; period?: string; limit?: string };
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 20));
    const result = await leaderboard(
      null,
      q.type || 'walking',
      q.province || '全国',
      (q.period || 'all') as 'week' | 'month' | 'year' | 'all',
      { limit, includeUserId: true },
    );
    return success(result);
  });

  // 运动榜省份选项（管理端）：复用全平台点亮聚合（provinces 用于省份筛选下拉）
  fastify.get('/leaderboard-regions', { onRequest: [adminAuth] }, async () => {
    return success(await leaderboardRegions());
  });

  // 旧数据重算（部署后手动批量触发）：
  // 1) 用新版爬升算法（海拔 EMA 平滑 + 滞回确认）重算 elevationGain，并回填最低/最高海拔
  // 2) 用新版最快配速算法（暂停/断档不跨段，必须跑满 1km）重算 fastestKm
  // 分批处理：带 maxId=上次返回的 lastId 循环调用，直到 remaining=0；dryRun=true 只预览不写库
  fastify.post('/activities/recompute-elevation', { onRequest: [adminAuth] }, async (request) => {
    const body = (request.body ?? {}) as { limit?: number | string; maxId?: string; dryRun?: boolean | string };
    const lim = Math.min(1000, Math.max(1, Number(body.limit) || 200));
    const dryRun = body.dryRun === true || body.dryRun === 'true';
    const filter: Record<string, unknown> = { status: 'finished', 'trackPoints.0': { $exists: true } };
    if (body.maxId) {
      // 游标形态不合法要当场拒：静默忽略的话，空结果时下面的 lastId 会回落成同一个非法串，
      // 再进 `new Types.ObjectId(lastId)` 直接抛 500
      if (!isObjectIdLike(String(body.maxId))) {
        throw new AppError(400, `maxId 不合法（需 24 位 ObjectId，收到 "${String(body.maxId).slice(0, 32)}"）`);
      }
      filter._id = { $gt: new Types.ObjectId(String(body.maxId)) };
    }
    const acts = await ActivityModel.find(filter)
      .sort({ _id: 1 })
      .limit(lim)
      .select('type duration elevationGain minAltitude maxAltitude fastestKm trackPoints')
      .lean();

    let updated = 0;
    const changes: Array<Record<string, unknown>> = [];
    for (const a of acts) {
      const points = (a.trackPoints ?? []) as TrackPointLike[];
      const stats = calcStats(points, {
        type: a.type,
        durationSec: a.duration ?? 0,
      });
      const before = {
        elevationGain: a.elevationGain ?? 0,
        minAltitude: a.minAltitude ?? null,
        maxAltitude: a.maxAltitude ?? null,
        fastestKm: a.fastestKm ?? null,
      };
      const after = {
        elevationGain: stats.elevationGain,
        minAltitude: stats.minAltitude,
        maxAltitude: stats.maxAltitude,
        fastestKm: calcFastestKm(points, a.type),
      };
      if (
        before.elevationGain === after.elevationGain &&
        before.minAltitude === after.minAltitude &&
        before.maxAltitude === after.maxAltitude &&
        before.fastestKm === after.fastestKm
      ) {
        continue;
      }
      updated++;
      if (changes.length < 20) {
        changes.push({ id: String(a._id), type: a.type, before, after });
      }
      if (!dryRun) {
        await ActivityModel.updateOne({ _id: a._id }, { $set: after });
      }
    }

    const lastId = acts.length ? String(acts[acts.length - 1]._id) : String(body.maxId || '');
    const remaining = lastId
      ? await ActivityModel.countDocuments({ ...filter, _id: { $gt: new Types.ObjectId(lastId) } })
      : 0;
    return success({ dryRun, processed: acts.length, updated, lastId, remaining, changes });
  });

  // 车速段回填（历史数据按新口径重算，换判据门槛后可重跑）：
  // 与上面的 recompute-elevation 相反，这里默认**只算不写**、必须显式 apply:true 才落库——
  // 它会重写整条 trackPoints，误触的代价不是一次重算那么小
  // syncCalories 是「只补消耗、不动时长」的补救档：库里没有任何字段记着某条的 calories
  // 是按墙钟还是按净时长结算的，全量刷会把新录入的记录再折一次，所以只允许按 id 点名。
  fastify.post('/activities/backfill-vehicle', { onRequest: [adminAuth] }, async (request) => {
    const body = (request.body ?? {}) as {
      apply?: boolean | string;
      id?: string;
      limit?: number | string;
      syncCalories?: boolean | string;
    };
    const id = body.id ? String(body.id) : '';
    const syncCalories = body.syncCalories === true || body.syncCalories === 'true';
    if (syncCalories && !id) {
      throw new AppError(400, 'syncCalories=true 必须同时指定 id（一次一条）；不给 id 就是全库刷卡路里，会把已按净时长结算的新记录再折一次');
    }
    return success(
      await backfillVehicle({
        apply: body.apply === true || body.apply === 'true',
        id,
        limit: Math.max(0, Number(body.limit) || 0),
        syncCalories,
      }),
    );
  });

  // ==================== 专题管理（官方信息页，小程序首页入口） ====================

  // 专题列表（含未发布/未生效/已过期）
  fastify.get('/topics', { onRequest: [adminAuth] }, async () => {
    return success(await adminListTopics());
  });

  // 新建专题
  fastify.post('/topics', { onRequest: [adminAuth] }, async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    return success(await createTopic(body as TopicInput), '已创建');
  });

  // 更新专题
  fastify.put('/topics/:id', { onRequest: [adminAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    return success(await updateTopic(id, body as TopicInput), '已保存');
  });

  // 删除专题
  fastify.delete('/topics/:id', { onRequest: [adminAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    await deleteTopic(id);
    return success(null, '已删除');
  });

  // 专题图片上传（multipart，≤2MB，存 OSS topics/ 目录）
  fastify.post('/topics/upload', { onRequest: [adminAuth] }, async (request) => {
    const file = await request.file();
    if (!file) throw new AppError(400, '请选择图片文件');
    const buf = await file.toBuffer();
    if (buf.length > 2 * 1024 * 1024) throw new AppError(400, '图片不能超过 2MB', { code: 'IMAGE_TOO_LARGE' });
    const ext = (file.mimetype || 'image/png').split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const key = `${config.oss.baseDir}/topics/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const url = await uploadBuffer(buf, key, file.mimetype || 'image/png');
    // url 入库用（裸链），previewUrl 只给后台展示（私有桶裸链 403）；正文内联图同理取 previewUrl
    return success({ url, previewUrl: getSignedUrl(url) });
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
