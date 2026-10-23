import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config/index.js';
import { getUnlimitedQRCode } from '../services/wechat-qrcode.js';
import { uploadBuffer, getSignedUrl } from '../services/oss.js';
import { success } from '../utils/response.js';
import { AppError } from '../utils/app-error.js';
import { CreateCampaignSchema, ListCampaignQuery, UpdateCampaignSchema } from '../utils/validators.js';
import {
  createCampaign,
  updateCampaign,
  listCampaigns,
  getCampaignDetail,
  joinCampaign,
  leaveCampaign,
  campaignLeaderboard,
  campaignTrend,
  memberDetail,
  listPending,
  approveMember,
  rejectMember,
  kickMember,
  dissolveCampaign,
} from '../services/campaign.js';

/**
 * 审批 / 拒绝 / 踢人的目标用户：body 字段走 zod（非法 → 400，符合既有 body 校验口径）。
 * 注意与 **path** 参数的区别：`:id` / `:uid` 不在这里校验，交给 service 的 assertObjectIdLike
 * 抛 404（repo-wide「非法 id → 404」行为，见 utils/object-id.ts）。
 */
const TargetSchema = z.object({ userId: z.string().regex(/^[a-f\d]{24}$/i, '成员不存在') });

/** 分页参数：成员明细与排行榜共用一份，两处的默认值/上限必须同口径（20 / 100） */
const PageQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

/** 排行榜额外支持排序指标与运动类型筛选 */
const LeaderboardQuery = PageQuery.extend({
  metric: z.enum(['distance', 'count', 'duration']).optional(),
  type: z.string().min(1).max(32).optional(),
});

const TrendQuery = z.object({
  type: z.string().min(1).max(32).optional(),
  /** 分档：缺省按人（前三名 + 我），type＝全队按运动类型分线 */
  by: z.enum(['person', 'type']).default('person'),
});

/**
 * 一起运动活动（campaign）用户端路由。
 * 注意：与既有 activity（一条运动记录）完全无关，前缀 ${config.apiPrefix}/campaigns。
 */
export async function campaignRoutes(fastify: FastifyInstance) {
  const auth = { onRequest: [fastify.authenticate] };

  fastify.post('/', auth, async (request) => {
    const input = CreateCampaignSchema.parse(request.body);
    return success(await createCampaign(request.user.userId, input), '活动已创建');
  });

  fastify.get('/', auth, async (request) => {
    const query = ListCampaignQuery.parse(request.query);
    return success(await listCampaigns(request.user.userId, query));
  });

  // 静态路径 `/mini-code` 必须先于 `/:id` 存在；Fastify 按优先级路由，这里显式保证不与 /:id 混淆
  fastify.post('/mini-code', auth, async (request) => {
    const { campaignId, envVersion } = z
      .object({
        campaignId: z.string().regex(/^[a-f\d]{24}$/i, '活动不存在'),
        envVersion: z.enum(['develop', 'trial', 'release']).optional(),
      })
      .parse(request.body);

    // 仅活动成员（含发起人）可生成邀请码（Spec §5）
    const detail = await getCampaignDetail(campaignId, request.user.userId);
    if (detail.myState !== 'joined') throw new AppError(403, '只有活动成员可以邀请');

    const png = await getUnlimitedQRCode(campaignId, 'pages/campaign-detail/campaign-detail', envVersion);
    // 目录按 userId 隔离（bucket 私有，前端加载需签名）
    const key = `${config.oss.baseDir}/mini-codes/${request.user.userId}/campaign-${campaignId}.png`;
    try {
      const url = await uploadBuffer(png, key);
      return success({ url: getSignedUrl(url), key });
    } catch (err) {
      fastify.log.warn('[campaign] 小程序码存 OSS 失败，降级 base64: ' + (err as Error).message);
      return success({ url: '', base64: `data:image/png;base64,${png.toString('base64')}` });
    }
  });

  fastify.get('/:id', auth, async (request) => {
    const { id } = request.params as { id: string };
    return success(await getCampaignDetail(id, request.user.userId));
  });

  // 发起人编辑活动：body 走 UpdateCampaignSchema（.strict()，多传 startDate 一律 400，
  // 不能静默吃掉——静默吃掉会让用户以为改成功了）
  fastify.put('/:id', auth, async (request) => {
    const { id } = request.params as { id: string };
    const input = UpdateCampaignSchema.parse(request.body);
    return success(await updateCampaign(id, request.user.userId, input), '活动已更新');
  });

  fastify.post('/:id/join', auth, async (request) => {
    const { id } = request.params as { id: string };
    return success(await joinCampaign(id, request.user.userId), '已加入');
  });

  fastify.post('/:id/leave', auth, async (request) => {
    const { id } = request.params as { id: string };
    return success(await leaveCampaign(id, request.user.userId), '已退出');
  });

  fastify.get('/:id/leaderboard', auth, async (request) => {
    const { id } = request.params as { id: string };
    const query = LeaderboardQuery.parse(request.query);
    return success(await campaignLeaderboard(id, request.user.userId, query));
  });

  fastify.get('/:id/trend', auth, async (request) => {
    const { id } = request.params as { id: string };
    const query = TrendQuery.parse(request.query);
    return success(await campaignTrend(id, request.user.userId, query));
  });

  fastify.get('/:id/members/:uid', auth, async (request) => {
    const { id, uid } = request.params as { id: string; uid: string };
    const query = PageQuery.parse(request.query);
    return success(await memberDetail(id, request.user.userId, uid, query));
  });

  fastify.get('/:id/pending', auth, async (request) => {
    const { id } = request.params as { id: string };
    return success({ rows: await listPending(id, request.user.userId) });
  });

  fastify.post('/:id/approve', auth, async (request) => {
    const { id } = request.params as { id: string };
    const { userId } = TargetSchema.parse(request.body);
    await approveMember(id, request.user.userId, userId);
    return success(null, '已同意');
  });

  fastify.post('/:id/reject', auth, async (request) => {
    const { id } = request.params as { id: string };
    const { userId } = TargetSchema.parse(request.body);
    await rejectMember(id, request.user.userId, userId);
    return success(null, '已拒绝');
  });

  fastify.post('/:id/kick', auth, async (request) => {
    const { id } = request.params as { id: string };
    const { userId } = TargetSchema.parse(request.body);
    await kickMember(id, request.user.userId, userId);
    return success(null, '已移出');
  });

  fastify.delete('/:id', auth, async (request) => {
    const { id } = request.params as { id: string };
    await dissolveCampaign(id, request.user.userId);
    return success(null, '活动已解散');
  });
}
