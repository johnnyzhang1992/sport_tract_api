import { Types } from 'mongoose';
import { AppError } from '../utils/app-error.js';
import { isObjectIdLike } from '../utils/object-id.js';
import { UserModel } from '../models/user.model.js';
import {
  getReminderSettings,
  hasReminderGrant,
  recordReminderGrant,
  MEMBER_EXPIRY_TEMPLATE_KEY,
} from './member-reminder.js';
import {
  getWeeklySportsSettings,
  hasWeeklySportsGrant,
  recordWeeklySportsGrant,
  WEEKLY_SPORTS_TEMPLATE_KEY,
} from './weekly-sports-reminder.js';
import {
  DAILY_REPORT_TEMPLATE_ID,
  DAILY_REPORT_TEMPLATE_KEY,
  hasDailyReportGrant,
  recordDailyReportGrant,
} from './admin-daily-stats.js';

export interface MessageSubscriptionItem {
  key: string;
  label: string;
  description: string;
  /** 消息类型：一次性订阅 / 长期订阅（工具类目仅能申请一次性；长期仅政务/医疗等公共服务类目开放） */
  subscribeType: string;
  templateId: string;
  /** 会员到期提醒用；其它模板不返回 */
  daysBefore?: number;
  /** 只能来自本地额度台账：微信不提供查询用户一次性订阅剩余额度的接口 */
  subscribed: boolean;
}

/**
 * 只列真正会下发的模板：
 * - 会员到期提醒：后台开关打开才出现；
 * - 每周运动数据：后台开关打开才出现。
 * 关闭时不展示不可用项，避免用户点了却永远收不到。
 */
export async function listMessageSubscriptions(userId: string): Promise<{ items: MessageSubscriptionItem[] }> {
  if (!isObjectIdLike(userId)) throw new AppError(401, '请先登录');
  const [memberSettings, weeklySettings] = await Promise.all([
    getReminderSettings(),
    getWeeklySportsSettings(),
  ]);
  const items: MessageSubscriptionItem[] = [];
  if (memberSettings.enabled) {
    items.push({
      key: MEMBER_EXPIRY_TEMPLATE_KEY,
      label: '会员到期提醒',
      description: `会员到期前 ${memberSettings.daysBefore} 天提醒你续费`,
      subscribeType: '一次性订阅',
      templateId: memberSettings.templateId,
      daysBefore: memberSettings.daysBefore,
      subscribed: await hasReminderGrant(userId),
    });
  }
  if (weeklySettings.enabled) {
    items.push({
      key: WEEKLY_SPORTS_TEMPLATE_KEY,
      label: '每周运动数据',
      description: '每周一 09:00 汇总上周运动数据',
      subscribeType: '一次性订阅',
      templateId: weeklySettings.templateId,
      subscribed: await hasWeeklySportsGrant(userId),
    });
  }
  // 每日数据报告只给管理员；普通用户不展示也不可订阅
  const user = await UserModel.findById(new Types.ObjectId(userId)).select({ role: 1 }).lean();
  if (user?.role === 'admin') {
    items.push({
      key: DAILY_REPORT_TEMPLATE_KEY,
      label: '每日数据报告',
      description: '每天 09:00 推送昨日数据',
      subscribeType: '一次性订阅',
      templateId: DAILY_REPORT_TEMPLATE_ID,
      subscribed: await hasDailyReportGrant(userId),
    });
  }
  return { items };
}

export async function grantMessageSubscription(
  userId: string,
  key: unknown,
  scene: unknown,
): Promise<{ subscribed: boolean }> {
  const templateKey = String(key ?? '');
  if (templateKey === MEMBER_EXPIRY_TEMPLATE_KEY) {
    const settings = await getReminderSettings();
    if (!settings.enabled) throw new AppError(403, '会员到期提醒暂未开放');
    return recordReminderGrant(userId, String(scene ?? ''));
  }
  if (templateKey === WEEKLY_SPORTS_TEMPLATE_KEY) {
    const settings = await getWeeklySportsSettings();
    if (!settings.enabled) throw new AppError(403, '每周运动数据提醒暂未开放');
    return recordWeeklySportsGrant(userId, String(scene ?? ''));
  }
  if (templateKey === DAILY_REPORT_TEMPLATE_KEY) {
    const user = await UserModel.findById(new Types.ObjectId(userId)).select({ role: 1 }).lean();
    if (user?.role !== 'admin') throw new AppError(403, '仅管理员可订阅');
    return recordDailyReportGrant(userId, String(scene ?? ''));
  }
  throw new AppError(400, '订阅类型不存在');
}
