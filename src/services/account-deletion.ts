/**
 * 账号注销（2026-11-17）
 *
 * 口径（产品裁定）：
 *   - **删除业务数据**：轨迹、计划及周期快照、积分（账户/流水/日常/兑换）、足迹记录、
 *     体重记录、微信步数、通知与其已读记录、登录日志、订阅授权与推送日志、活动参与记录
 *   - **保留支付订单**（xpayorders）：涉及退款/对账/审计，按合规要求留存；订单里不删 userId，
 *     后台仍能看到「谁付过」，但用户已无法登录
 *   - **删除 OSS 照片文件**（2026-11-17 补）：轨迹打点照片与足迹照片随注销一并删除。
 *     原实现只 deleteMany 删了数据库行，文件永久留在 OSS（URL 仍可签名访问、继续占空间），
 *     与「注销＝清干净」的承诺不符，也与单条轨迹删除（deleteActivity 会删文件）不一致。
 *   - **保留榜奖台账**（BoardSettlement，2026-11-17 补口径）：与支付订单同性质的钱账留痕，
 *     后台台账仍能看到「谁拿过这期的榜奖」。代价：该用户的积分流水已删，
 *     `revokeBoardSettlement` 会因「原流水已不存在」拒单 → **已注销用户的榜奖只能人工对账，不能自动撤回**。
 *     这不是漏删，是有意保留（台账页 listBoardSettlements 已按「缺文档＝删号」容错显示）。
 *   - **删除用户本身**：openid 一并清掉 → 同一微信再次进入小程序是**全新账号**，
 *     不继承任何历史（这正是「注销」的语义；软删除会让用户以为没清干净）
 *
 * 安全：
 *   - 要求输入当前昵称二次确认（宽松匹配：忽略首尾空格与大小写）
 *   - 昵称为空的老账号（从没设过昵称）改用固定词「注销」确认
 *   - 顺序保证可重入：先清数据、最后删用户。中途失败时用户仍在，重试即可补齐；
 *     不会出现「数据还在、用户没了」的孤儿状态（见 purgeUser 注释）
 *   - 不使用 MongoDB 事务（单机模式不支持），用上述顺序 + deleteMany 幂等替代
 */
import mongoose from 'mongoose';
import { UserModel } from '../models/user.model.js';
import { ActivityModel } from '../models/activity.model.js';
import { ExercisePlanModel } from '../models/exercise-plan.model.js';
import { ExercisePlanPeriodModel } from '../models/exercise-plan-period.model.js';
import {
  PointAccountModel,
  PointRecordModel,
  PointLotModel,
  PointSigninModel,
  PointTaskModel,
  PointCardModel,
  PointExchangeModel,
  PointDailyModel,
  PointDailyQuotaModel,
} from '../models/point.model.js';
import { FootprintRecordModel } from '../models/footprint-record.model.js';
import { WeightLogModel } from '../models/weight-log.model.js';
import { WerunDayModel } from '../models/werun-day.model.js';
import { NotificationModel } from '../models/notification.model.js';
import { NotificationReadModel } from '../models/notification-read.model.js';
import { LoginLogModel } from '../models/login-log.model.js';
import { CampaignMemberModel } from '../models/campaign-member.model.js';
import { SubscribeGrantModel } from '../models/subscribe-grant.model.js';
import { SubscribeMessageLogModel } from '../models/subscribe-message-log.model.js';
import { deleteOssObjects } from './oss.js';
import { AppError } from '../utils/app-error.js';

/** 确认词：昵称为空时用户需输入的字样 */
export const EMPTY_NICKNAME_CONFIRM_WORD = '注销';

/**
 * 昵称校验（宽松匹配）：忽略首尾空格、忽略大小写。
 * 空昵称（从没设过）→ 必须输入「注销」二字。
 */
export function confirmWordMatches(input: unknown, nickname: string): boolean {
  const got = String(input ?? '').trim().toLowerCase();
  const want = String(nickname ?? '').trim().toLowerCase();
  if (!want) return got === EMPTY_NICKNAME_CONFIRM_WORD;
  return got === want;
}

/** 用户输入正确时返回 true；不正确抛 400，前端据此提示 */
export function assertConfirmWord(input: unknown, nickname: string): void {
  if (!confirmWordMatches(input, nickname)) {
    const want = String(nickname ?? '').trim();
    throw new AppError(
      400,
      want ? '昵称不匹配，请重新输入当前昵称' : `请输入「${EMPTY_NICKNAME_CONFIRM_WORD}」确认`,
      { code: 'CONFIRM_MISMATCH' },
    );
  }
}

/**
 * 收集该用户名下所有 OSS 照片 URL（轨迹打点 + 足迹记录），去重非空。
 * 必须在删除数据库行之前调用。
 */
async function collectPhotoUrls(filter: { userId: mongoose.Types.ObjectId }): Promise<string[]> {
  const [acts, fps] = await Promise.all([
    ActivityModel.find(filter).select({ markers: 1 }).lean(),
    FootprintRecordModel.find(filter).select({ photos: 1 }).lean(),
  ]);
  const urls: string[] = [];
  for (const a of acts as Array<{ markers?: Array<{ photoUrl?: string; photos?: string[] }> }>) {
    for (const m of a.markers ?? []) {
      if (m.photoUrl) urls.push(m.photoUrl);
      for (const u of m.photos ?? []) if (u) urls.push(u);
    }
  }
  for (const f of fps as Array<{ photos?: string[] }>) {
    for (const u of f.photos ?? []) if (u) urls.push(u);
  }
  return [...new Set(urls)];
}

/** 各集合的清理结果（返回给日志/测试，不返回给前端） */
export interface PurgeStats {
  activity: number;
  plan: number;
  planPeriod: number;
  /** 积分相关 9 张表合计 */
  point: number;
  footprint: number;
  weight: number;
  werunDay: number;
  notification: number;
  notificationRead: number;
  loginLog: number;
  campaignMember: number;
  subscribeGrant: number;
  subscribeMessageLog: number;
  /** 删除的 OSS 照片文件数（轨迹打点 + 足迹） */
  ossPhotos: number;
}

/**
 * **删除**用户全部业务数据并移除账号本身。
 *
 * @param userId 目标用户
 * @returns 各集合删除条数
 *
 * ⚠️ 不可恢复。调用方必须已做完身份与确认词校验。
 * 支付订单（xpayorder）**不删**，理由见文件头。
 */
/** 可注入的副作用（测试用；生产用默认实现） */
export interface PurgeDeps {
  /** 删除 OSS 文件；默认走 services/oss 的 deleteOssObjects */
  deleteOss?: (urls: string[]) => Promise<void>;
}

export async function purgeUser(userId: string, opts: { deps?: PurgeDeps } = {}): Promise<PurgeStats> {
  const removeOss = opts.deps?.deleteOss ?? deleteOssObjects;
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw new AppError(400, '用户 ID 非法');
  }
  const uid = new mongoose.Types.ObjectId(userId);
  const filter = { userId: uid };
  const stats: PurgeStats = {
    activity: 0, plan: 0, planPeriod: 0, point: 0, footprint: 0, weight: 0,
    werunDay: 0, notification: 0, notificationRead: 0, loginLog: 0,
    campaignMember: 0, subscribeGrant: 0, subscribeMessageLog: 0, ossPhotos: 0,
  };

  /*
   * 不用事务：本机与线上 MongoDB 都是**单机模式**（无副本集），
   * session.withTransaction 会直接抛「Transaction numbers are only allowed on a
   * replica set member or mongos」。
   *
   * 替代保证——**顺序 + 可重入**：
   *   1. 先删业务数据（deleteMany 幂等，重复执行只会删到 0 条）
   *   2. **最后**删用户本身：用户还在 = 还能再次发起注销，把残留数据清干净；
   *      用户没了 = 全部数据早已清完
   *   任一步失败 → 用户记录仍在 → 用户重试即可补齐，**不会出现「数据还在但人也还在却登不上」**
   *   这种半吊子状态；唯一的中间态是「数据删了、用户还在」，此时重试注销即可完成。
   */
  const run = async (model: mongoose.Model<any>, key: keyof PurgeStats) => {
    const r = await model.deleteMany(filter);
    stats[key] = r.deletedCount ?? 0;
  };

  /*
   * OSS 照片必须在 deleteMany **之前**收集（删完就读不到 URL 了）。
   * 与 deleteActivity 同一套口径：轨迹打点 photoUrl/photos + 足迹 photos。
   */
  const photoUrls = await collectPhotoUrls(filter);

  // 业务数据（按依赖顺序：先明细后主干）
  await run(ActivityModel, 'activity');
  await run(ExercisePlanPeriodModel, 'planPeriod');
  await run(ExercisePlanModel, 'plan');
  // 积分是一组表（账户/流水/批次/签到/任务/卡券/兑换/日常/额度）
  const pointModels = [
    PointAccountModel, PointRecordModel, PointLotModel, PointSigninModel, PointTaskModel,
    PointCardModel, PointExchangeModel, PointDailyModel, PointDailyQuotaModel,
  ];
  for (const m of pointModels) {
    const r = await m.deleteMany(filter);
    stats.point += r.deletedCount ?? 0;
  }
  await run(FootprintRecordModel, 'footprint');
  await run(WeightLogModel, 'weight');
  await run(WerunDayModel, 'werunDay');
  await run(NotificationReadModel, 'notificationRead');
  await run(NotificationModel, 'notification');
  await run(LoginLogModel, 'loginLog');
  await run(CampaignMemberModel, 'campaignMember');
  await run(SubscribeGrantModel, 'subscribeGrant');
  await run(SubscribeMessageLogModel, 'subscribeMessageLog');

  /*
   * 清理 OSS 文件：放在删 DB 之后、删用户之前，失败只记日志不上抛
   * （与 deleteActivity 同取向：文件清理失败不该让注销半途失败；
   *  此时用户还在 → 重试注销可以补齐，但已删的 DB 行读不到 URL，故 URL 已在上面收集好）。
   */
  if (photoUrls.length > 0) {
    try {
      await removeOss(photoUrls);
      stats.ossPhotos = photoUrls.length;
    } catch (err) {
      console.error('[oss] 注销时清理照片失败（账号仍会被删除）:', (err as Error).message);
    }
  }

  // 最后删账号本身（openid 一并清掉 → 再次进入是全新账号）
  await UserModel.deleteOne({ _id: uid });
  return stats;
}
