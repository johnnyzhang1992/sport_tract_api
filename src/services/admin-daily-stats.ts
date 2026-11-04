import { Types } from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import { LoginLogModel } from '../models/login-log.model.js';
import { NotificationModel } from '../models/notification.model.js';
import { PointSigninModel } from '../models/point.model.js';
import { UserModel } from '../models/user.model.js';
import { SubscribeGrantModel } from '../models/subscribe-grant.model.js';
import { SubscribeMessageLogModel } from '../models/subscribe-message-log.model.js';
import { createNotification } from './notification.js';
import { sendSubscribeMessage, type SubscribeSendResult } from './subscribe-message.js';
import { bjYmd } from './member-reminder.js';
import { bjToday0, BJ_OFFSET_MS } from '../utils/bj-time.js';
import { fmtCnDate } from '../config/member-copy.js';
import { AppError } from '../utils/app-error.js';
import { isObjectIdLike } from '../utils/object-id.js';
import { truncateChars } from '../utils/wechat-template.js';

const DAY = 86_400_000;

export const DAILY_REPORT_TEMPLATE_KEY = 'dailyReport';
/** 账号下已添加的「今日数据统计通知」模板 */
export const DAILY_REPORT_TEMPLATE_ID = '5fnFwBCfMaVYfHeSuIDYlzl0D0VET5eHZPeKvudLUYo';

export interface DailyStats {
  date: number;
  uv: number;
  pv: number;
  tracksCreated: number;
  tracksFinished: number;
  signinUsers: number;
  newUsers: number;
}

/** 东八区 'M月D日'（通知标题用） */
export function bjMonthDay(ms: number): string {
  const d = new Date(ms + 8 * 3600_000);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

/** 汇总某个东八区自然日的站内数据（dayStart 为该日 0 点） */
export async function collectDailyStats(dayStart: number): Promise<DailyStats> {
  const dayEnd = dayStart + DAY;
  const from = new Date(dayStart);
  const to = new Date(dayEnd);
  const [uvRows, pv, tracksCreated, tracksFinished, signinIds, newUsers] = await Promise.all([
    LoginLogModel.aggregate<{ n: number }>([
      { $match: { createdAt: { $gte: from, $lt: to } } },
      { $group: { _id: '$userId' } },
      { $count: 'n' },
    ]),
    LoginLogModel.countDocuments({ createdAt: { $gte: from, $lt: to } }),
    ActivityModel.countDocuments({ createdAt: { $gte: from, $lt: to } }),
    ActivityModel.countDocuments({ status: 'finished', endTime: { $gte: dayStart, $lt: dayEnd } }),
    PointSigninModel.distinct('userId', { dateKey: bjYmd(dayStart) }),
    UserModel.countDocuments({ createdAt: { $gte: from, $lt: to } }),
  ]);
  return {
    date: dayStart,
    uv: uvRows[0]?.n ?? 0,
    pv,
    tracksCreated,
    tracksFinished,
    signinUsers: signinIds.length,
    newUsers,
  };
}

/** 通知正文：所有指标都塞进 content 字段，一行一项 */
export function buildDailyStatsContent(s: DailyStats): string {
  return [
    `访问人数：${s.uv} 人`,
    `访问次数：${s.pv} 次`,
    `轨迹创建：${s.tracksCreated} 条`,
    `轨迹完成：${s.tracksFinished} 条`,
    `签到人数：${s.signinUsers} 人`,
    `新增用户：${s.newUsers} 人`,
  ].join('\n');
}

/** 订阅消息字段很短：≥1 万用「万」，个位数不加空格，四项最多 20 字 */
export function compactDailyCount(n: number): string {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v < 10_000) return String(v);
  if (v < 100_000) return `${(v / 10_000).toFixed(1).replace(/\.0$/, '')}万`;
  return `${Math.round(v / 10_000)}万`;
}

/** 模板 thing1「消息内容」：轨迹{完成}/{全部}签到{签到}新增{新增}，绝不超 20 字 */
export function buildDailyStatsSubscribeContent(s: DailyStats): string {
  const done = compactDailyCount(s.tracksFinished);
  const total = compactDailyCount(s.tracksCreated);
  const signin = compactDailyCount(s.signinUsers);
  const fresh = compactDailyCount(s.newUsers);
  const full = `轨迹${done}/${total}签到${signin}新增${fresh}`;
  // 数字全是 4 位时完整标签会到 23 字：退成更短的标签，四项数据一个不丢
  const compact = `轨${done}/${total}签${signin}新${fresh}`;
  return truncateChars(full.length <= 20 ? full : compact, 20);
}

export function buildDailyStatsSubscribeData(s: DailyStats, dayStart: number): Record<string, { value: string }> {
  return {
    time21: { value: fmtCnDate(dayStart) },
    thing29: { value: '迹路者' },
    number22: { value: String(s.uv) },
    number4: { value: String(s.pv) },
    thing1: { value: buildDailyStatsSubscribeContent(s) },
  };
}

export function dailyStatsDedupeKey(dayStart: number, userId: string): string {
  return `adminDailyStats:${bjYmd(dayStart)}:${userId}`;
}

function dailyStatsWechatDedupeKey(dayStart: number, userId: string): string {
  return `adminDailyStats:wechat:${bjYmd(dayStart)}:${userId}`;
}

/** 只在 09:00–12:00 发微信；后台手动跑一轮用 force 绕过 */
export function isDailyReportSendTime(now: number): boolean {
  const h = new Date(now + BJ_OFFSET_MS).getUTCHours();
  return h >= 9 && h <= 12;
}

/* ---------------------- 每日报告订阅额度 ---------------------- */

export async function recordDailyReportGrant(userId: string, scene = ''): Promise<{ subscribed: boolean }> {
  if (!isObjectIdLike(userId)) throw new AppError(401, '请先登录');
  await SubscribeGrantModel.create({
    userId: new Types.ObjectId(userId),
    templateKey: DAILY_REPORT_TEMPLATE_KEY,
    templateId: DAILY_REPORT_TEMPLATE_ID,
    scene: truncateChars(scene, 20),
    status: 'granted',
    grantedAt: Date.now(),
  });
  return { subscribed: true };
}

export async function hasDailyReportGrant(userId: string): Promise<boolean> {
  if (!isObjectIdLike(userId)) return false;
  return Boolean(await SubscribeGrantModel.exists({
    userId: new Types.ObjectId(userId),
    templateKey: DAILY_REPORT_TEMPLATE_KEY,
    status: 'granted',
  }));
}

/* ---------------------- 微信订阅消息下发 ---------------------- */

type Sender = (input: {
  openid: string;
  templateId: string;
  page?: string;
  data: Record<string, { value: string }>;
  miniprogramState?: 'developer' | 'trial' | 'formal';
}) => Promise<SubscribeSendResult>;

let sender: Sender = sendSubscribeMessage;

export function __setAdminDailyStatsSenderForTest(fn: Sender | null): void {
  sender = fn ?? sendSubscribeMessage;
}

function miniprogramState(): 'developer' | 'trial' | 'formal' {
  const v = process.env.MINIPROGRAM_STATE;
  return v === 'developer' || v === 'trial' ? v : 'formal';
}

async function sendDailyReportWechat(
  userId: string,
  openid: string,
  stats: DailyStats,
  dayStart: number,
  now: number,
  result: DailyStatsRunResult,
): Promise<void> {
  const grant = await SubscribeGrantModel.findOne({
    userId: new Types.ObjectId(userId),
    templateKey: DAILY_REPORT_TEMPLATE_KEY,
    status: 'granted',
  }).sort({ grantedAt: 1 }).lean();
  if (!grant) return;

  const dedupeKey = dailyStatsWechatDedupeKey(dayStart, userId);
  try {
    await SubscribeMessageLogModel.create({
      dedupeKey, userId: new Types.ObjectId(userId), templateKey: DAILY_REPORT_TEMPLATE_KEY,
      channel: 'wechat', status: 'sending', createdAt: now,
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      result.wechatSkipped += 1;
      return;
    }
    throw err;
  }

  try {
    const r = await sender({
      openid,
      templateId: DAILY_REPORT_TEMPLATE_ID,
      page: '/pages/notification-list/notification-list',
      miniprogramState: miniprogramState(),
      data: buildDailyStatsSubscribeData(stats, dayStart),
    });
    if (r.errcode === 0) {
      await SubscribeGrantModel.updateOne(
        { _id: grant._id, status: 'granted' },
        { $set: { status: 'consumed', consumedAt: now } },
      );
      await SubscribeMessageLogModel.updateOne(
        { dedupeKey },
        { $set: { status: 'sent', errcode: 0, errmsg: r.errmsg } },
      );
      result.wechatSent += 1;
      return;
    }
    if (r.errcode === 43101) {
      await SubscribeGrantModel.updateOne(
        { _id: grant._id },
        { $set: { status: 'invalid', consumedAt: now, invalidReason: '43101' } },
      );
    }
    await SubscribeMessageLogModel.updateOne(
      { dedupeKey },
      { $set: { status: 'failed', errcode: r.errcode, errmsg: r.errmsg } },
    );
    if (r.errcode === 47003) console.error(`[admin-daily-stats] 模板字段不匹配：${r.errmsg}`);
    result.wechatFailed += 1;
  } catch (err) {
    await SubscribeMessageLogModel.deleteOne({ dedupeKey, status: 'sending' }).catch(() => {});
    console.error('[admin-daily-stats] 订阅消息下发异常：', (err as Error).message);
    result.wechatFailed += 1;
  }
}

export interface DailyStatsRunResult {
  date: number;
  admins: number;
  /** 站内通知 */
  sent: number;
  skipped: number;
  /** 微信订阅消息 */
  wechatSent: number;
  wechatSkipped: number;
  wechatFailed: number;
  stats: DailyStats | null;
}

/**
 * 给所有管理员投递「昨日数据统计」：
 * - 站内通知照旧（无额度/发送失败也能看）；
 * - 有「每日数据报告」授权额度的管理员，同时发一条微信订阅消息。
 * 普通用户收不到，按 userId 定向。
 */
export async function runAdminDailyStats(
  now = Date.now(),
  opts: { force?: boolean } = {},
): Promise<DailyStatsRunResult> {
  const dayStart = bjToday0(now) - DAY;
  const admins = await UserModel.find({ role: 'admin' }).select({ _id: 1, openid: 1 }).lean();
  if (!admins.length) {
    return {
      date: dayStart, admins: 0, sent: 0, skipped: 0,
      wechatSent: 0, wechatSkipped: 0, wechatFailed: 0, stats: null,
    };
  }
  const stats = await collectDailyStats(dayStart);
  const title = `昨日数据统计（${bjMonthDay(dayStart)}）`;
  const content = buildDailyStatsContent(stats);
  const result: DailyStatsRunResult = {
    date: dayStart, admins: admins.length, sent: 0, skipped: 0,
    wechatSent: 0, wechatSkipped: 0, wechatFailed: 0, stats,
  };
  const wechatAllowed = opts.force === true || isDailyReportSendTime(now);
  for (const admin of admins) {
    const userId = String(admin._id);
    const key = dailyStatsDedupeKey(dayStart, userId);
    if (await NotificationModel.exists({ dedupeKey: key })) {
      result.skipped += 1;
    } else {
      await createNotification({
        title,
        content,
        category: 'system',
        published: true,
        userId: new Types.ObjectId(userId),
      }, key);
      result.sent += 1;
    }
    if (!wechatAllowed) continue;
    if (!admin.openid) {
      result.wechatSkipped += 1;
      continue;
    }
    await sendDailyReportWechat(userId, admin.openid, stats, dayStart, now, result);
  }
  return result;
}

/** 每天 09:00 后的小时扫描投递一次（按日幂等）；测试/显式关闭时不启动 */
export function startAdminDailyStatsJob(): NodeJS.Timeout | null {
  if (process.env.NODE_ENV === 'test' || process.env.ADMIN_DAILY_STATS_JOB === 'off') return null;
  const tick = () => {
    const bjHour = new Date(Date.now() + 8 * 3600_000).getUTCHours();
    if (bjHour < 9) return;
    runAdminDailyStats().catch((err) => console.error('[admin-daily-stats] 投递失败：', err));
  };
  const timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref?.();
  const first = setTimeout(tick, 60_000);
  first.unref?.();
  return timer;
}
