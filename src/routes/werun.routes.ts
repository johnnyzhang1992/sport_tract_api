import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UserModel } from '../models/user.model.js';
import { WerunDayModel } from '../models/werun-day.model.js';
import { code2Session } from '../services/wechat.js';
import { assertWatermarkTrustworthy, decryptWeRunData, sanitizeStepInfoList } from '../services/werun.js';
import { werunBoard, werunBoardProvinces } from '../services/werun-board.js';
import { WERUN_STATS_RANGES, werunStats, werunDayList, type WerunStatsRange } from '../services/werun-stats.js';
import { exportWerunCsv } from '../services/werun-export.js';
import { werunReport } from '../services/werun-report.js';
import { assertExportRate, contentDisposition, exportStamp, EXPORT_CSV_MAX_ROWS } from '../services/export.js';
import { WeRunSyncSchema } from '../utils/validators.js';
import { success } from '../utils/response.js';
import { AppError } from '../utils/app-error.js';

const StatsRange = z.coerce
  .number()
  .int()
  .refine((v) => WERUN_STATS_RANGES.some((r) => r === v), 'range 仅支持 7 / 30 / 180 / 365');

const StatsQuery = z.object({
  range: StatsRange,
  /** 1 = 额外下发前一个同长度窗口，供趋势变化卡对比 */
  compare: z.coerce.number().int().min(0).max(1).optional(),
});

/** 明细：固定窗口或 all（全部同步记录，不跟时间档走） */
const DaysRange = z.union([StatsRange, z.literal('all')]);

const DaysQuery = z.object({
  range: DaysRange,
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

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

  // 步数排行榜：day/week/month/year 四周期，全国/按省（用户最近登录省份），TOP50 + 我的真实排名。
  // 可选鉴权：游客可看榜单（me 为 null，前端不渲染「我的排名」卡）——与运动榜 2026-10-26 口径一致。
  fastify.get('/board', { onRequest: [fastify.authenticateOptional] }, async (request) => {
    const query = request.query as { period?: string; periodKey?: string; province?: string };
    const userId = request.user ? request.user.userId : null;
    return success(
      await werunBoard(userId, query.period || 'day', {
        province: query.province || '全国',
        periodKey: query.periodKey,
      }),
    );
  });

  // 省份选择器数据：有登录记录的省份（人数降序），前端拼「全国」在首位
  fastify.get('/board-provinces', { onRequest: [fastify.authenticateOptional] }, async () => {
    return success(await werunBoardProvinces());
  });

  // 个人步数统计：概况 + 趋势（7/30 按日、180 按周、365 按月；缺失日补 0）
  fastify.get('/stats', { onRequest: [fastify.authenticate] }, async (request) => {
    const { range, compare } = StatsQuery.parse(request.query);
    return success(await werunStats(request.user.userId, range as WerunStatsRange, Date.now(), compare === 1));
  });

  // 每日步数明细：只列有同步记录的天，按日期倒序分页；range=all 为全部记录
  fastify.get('/days', { onRequest: [fastify.authenticate] }, async (request) => {
    const { range, page, pageSize } = DaysQuery.parse(request.query);
    return success(await werunDayList(request.user.userId, range as WerunStatsRange | 'all', page, pageSize));
  });

  // 报告页步数聚合：from/to 与 /overview 同口径 [from, to)，不传 = 全部时间
  fastify.get('/report', { onRequest: [fastify.authenticate] }, async (request) => {
    const q = request.query as { from?: string; to?: string };
    return success(
      await werunReport(
        request.user.userId,
        q.from ? Number(q.from) : undefined,
        q.to ? Number(q.to) : undefined,
      ),
    );
  });

  // 步数 CSV：与运动记录导出同款范围参数（from/to 为 ms，换算成东八区自然日）
  fastify.get('/export/csv', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const q = request.query as { from?: string; to?: string };
    assertExportRate(`werun-export:${request.user.userId}`);
    const csv = await exportWerunCsv({
      userId: String(request.user.userId),
      from: q.from ? Number(q.from) : undefined,
      to: q.to ? Number(q.to) : undefined,
      cap: EXPORT_CSV_MAX_ROWS,
    });
    const stamp = exportStamp();
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', contentDisposition(`werun-steps-${stamp}.csv`, `微信步数_${stamp}.csv`));
    return reply.send(csv);
  });
}
