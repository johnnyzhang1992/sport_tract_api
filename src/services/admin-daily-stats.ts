import { Types } from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import { LoginLogModel } from '../models/login-log.model.js';
import { NotificationModel } from '../models/notification.model.js';
import { PointSigninModel } from '../models/point.model.js';
import { UserModel } from '../models/user.model.js';
import { createNotification } from './notification.js';
import { bjYmd } from './member-reminder.js';
import { bjToday0 } from '../utils/bj-time.js';

const DAY = 86_400_000;

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

export function dailyStatsDedupeKey(dayStart: number, userId: string): string {
  return `adminDailyStats:${bjYmd(dayStart)}:${userId}`;
}

export interface DailyStatsRunResult {
  date: number;
  admins: number;
  sent: number;
  skipped: number;
  stats: DailyStats | null;
}

/** 给所有管理员投递「昨日数据统计」站内通知（普通用户收不到，按 userId 定向） */
export async function runAdminDailyStats(now = Date.now()): Promise<DailyStatsRunResult> {
  const dayStart = bjToday0(now) - DAY;
  const admins = await UserModel.find({ role: 'admin' }).select({ _id: 1 }).lean();
  if (!admins.length) {
    return { date: dayStart, admins: 0, sent: 0, skipped: 0, stats: null };
  }
  const stats = await collectDailyStats(dayStart);
  const title = `昨日数据统计（${bjMonthDay(dayStart)}）`;
  const content = buildDailyStatsContent(stats);
  let sent = 0;
  let skipped = 0;
  for (const admin of admins) {
    const key = dailyStatsDedupeKey(dayStart, String(admin._id));
    if (await NotificationModel.exists({ dedupeKey: key })) { skipped += 1; continue; }
    await createNotification({
      title,
      content,
      category: 'system',
      published: true,
      userId: new Types.ObjectId(String(admin._id)),
    }, key);
    sent += 1;
  }
  return { date: dayStart, admins: admins.length, sent, skipped, stats };
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
