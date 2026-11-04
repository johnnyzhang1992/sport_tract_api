import { Types } from 'mongoose';
import { AppSettingModel } from '../models/app-setting.model.js';
import { UserModel } from '../models/user.model.js';
import { XpayOrderModel } from '../models/xpay-order.model.js';
import { SubscribeGrantModel } from '../models/subscribe-grant.model.js';
import { SubscribeMessageLogModel } from '../models/subscribe-message-log.model.js';
import { NotificationModel } from '../models/notification.model.js';
import { createNotification } from './notification.js';
import { entitlementsOf, MEMBER_COUNTING_STATUS } from './entitlements.js';
import { sendSubscribeMessage, type SubscribeSendResult } from './subscribe-message.js';
import { AppError } from '../utils/app-error.js';
import { fmtCnDate } from '../config/member-copy.js';
import { BJ_OFFSET_MS } from '../utils/bj-time.js';
import { isObjectIdLike } from '../utils/object-id.js';
import { truncateChars } from '../utils/wechat-template.js';

export { truncateChars } from '../utils/wechat-template.js';

/** 当前账号下已添加的「会员到期提醒」模板（后台可换） */
export const MEMBER_EXPIRY_TEMPLATE_KEY = 'memberExpiry';
export const MEMBER_EXPIRY_TEMPLATE_ID = 'MCAY-wvmnELsyii1yEMysAPTN_oR0W_hdlsnb1yZ5Gg';
export const REMINDER_SETTINGS_KEY = 'memberExpiryReminder';
export const REMINDER_DAYS_BEFORE_DEFAULT = 3;
const SETTINGS_CACHE_TTL_MS = 30_000;

export interface ReminderSettings {
  enabled: boolean;
  templateId: string;
  daysBefore: number;
}

const DEFAULT_SETTINGS: ReminderSettings = {
  enabled: false,
  templateId: MEMBER_EXPIRY_TEMPLATE_ID,
  daysBefore: REMINDER_DAYS_BEFORE_DEFAULT,
};

let settingsCache: { value: ReminderSettings; expiresAt: number } | null = null;

function normalizeSettings(raw: unknown): ReminderSettings {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const enabled = v.enabled === true;
  const templateId = String(v.templateId ?? '').trim() || DEFAULT_SETTINGS.templateId;
  const days = Number(v.daysBefore);
  const daysBefore = Number.isInteger(days) && days >= 1 && days <= 30 ? days : DEFAULT_SETTINGS.daysBefore;
  return { enabled, templateId, daysBefore };
}

export async function getReminderSettings(now = Date.now()): Promise<ReminderSettings> {
  if (settingsCache && now < settingsCache.expiresAt) return settingsCache.value;
  const row = await AppSettingModel.findById(REMINDER_SETTINGS_KEY).select({ value: 1 }).lean();
  const value = row ? normalizeSettings(row.value) : { ...DEFAULT_SETTINGS };
  settingsCache = { value, expiresAt: now + SETTINGS_CACHE_TTL_MS };
  return value;
}

export async function setReminderSettings(input: unknown): Promise<ReminderSettings> {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new AppError(400, 'enabled 必须是布尔值');
  const templateId = String(body.templateId ?? '').trim();
  if (!templateId) throw new AppError(400, '模板 ID 不能为空');
  if (templateId.length > 80) throw new AppError(400, '模板 ID 过长');
  const days = Number(body.daysBefore);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new AppError(400, '提前天数需在 1-30 之间');
  const value: ReminderSettings = { enabled: body.enabled === true, templateId, daysBefore: days };
  await AppSettingModel.findByIdAndUpdate(
    REMINDER_SETTINGS_KEY,
    { value, updatedAt: new Date() },
    { upsert: true },
  );
  settingsCache = { value, expiresAt: Number.MAX_SAFE_INTEGER };
  return value;
}

export function resetReminderSettingsCacheForTest(): void {
  settingsCache = null;
}

/* ---------------------------- 纯函数 ---------------------------- */

/** 东八区 'YYYYMMDD'（幂等键/到期日归组） */
export function bjYmd(ms: number): string {
  const d = new Date(ms + BJ_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/** 东八区自然日差：until 所在日 − now 所在日（今天到期返回 0，明天 1） */
export function daysUntilBj(until: number, now: number): number {
  return Math.floor((until + BJ_OFFSET_MS) / 86400000) - Math.floor((now + BJ_OFFSET_MS) / 86400000);
}

/** 会员类型：会员月卡 → 月卡；认不出来就回「会员」 */
export function memberTypeOf(name: string): string {
  return truncateChars(String(name || '').replace(/^会员/, ''), 5) || '会员';
}

export function buildReminderData(input: {
  name: string;
  until: number;
  daysLeft: number;
}): Record<string, { value: string }> {
  const name = truncateChars(input.name || '迹路者会员', 20);
  return {
    thing1: { value: name },
    date2: { value: fmtCnDate(input.until) },
    thing3: { value: input.daysLeft > 0 ? '会员即将到期，续费可继续使用' : '会员已到期，续费可继续使用' },
    short_thing5: { value: memberTypeOf(name) },
    number6: { value: String(input.daysLeft) },
  };
}

function wechatDedupeKey(userId: string, until: number): string {
  return `memberExpiry:wechat:${userId}:${bjYmd(until)}`;
}

function inappDedupeKey(userId: string, until: number): string {
  return `memberExpiry:inapp:${userId}:${bjYmd(until)}`;
}

/* ---------------------------- 授权额度 ---------------------------- */

export async function recordReminderGrant(userId: string, scene = ''): Promise<{ subscribed: boolean }> {
  if (!isObjectIdLike(userId)) throw new AppError(401, '请先登录');
  const settings = await getReminderSettings();
  await SubscribeGrantModel.create({
    userId: new Types.ObjectId(userId),
    templateKey: MEMBER_EXPIRY_TEMPLATE_KEY,
    templateId: settings.templateId,
    scene: truncateChars(scene, 20),
    status: 'granted',
    grantedAt: Date.now(),
  });
  return { subscribed: true };
}

export async function hasReminderGrant(userId: string): Promise<boolean> {
  if (!isObjectIdLike(userId)) return false;
  return Boolean(await SubscribeGrantModel.exists({
    userId: new Types.ObjectId(userId),
    templateKey: MEMBER_EXPIRY_TEMPLATE_KEY,
    status: 'granted',
  }));
}

export async function reminderQuotaCount(userId: string): Promise<number> {
  if (!isObjectIdLike(userId)) return 0;
  return SubscribeGrantModel.countDocuments({
    userId: new Types.ObjectId(userId),
    templateKey: MEMBER_EXPIRY_TEMPLATE_KEY,
    status: 'granted',
  });
}

/* ---------------------------- 站内兜底 ---------------------------- */

async function ensureInappReminder(userId: string, name: string, until: number): Promise<boolean> {
  const key = inappDedupeKey(userId, until);
  const exists = await NotificationModel.exists({ dedupeKey: key });
  if (exists) return false;
  await createNotification({
    title: '会员即将到期',
    content: `你的${name}将于 ${fmtCnDate(until)} 到期，续费可继续使用。`,
    category: 'member',
    published: true,
    userId,
  }, key);
  return true;
}

/* ---------------------------- 扫描与下发 ---------------------------- */

type Sender = (input: {
  openid: string;
  templateId: string;
  page?: string;
  data: Record<string, { value: string }>;
  miniprogramState?: 'developer' | 'trial' | 'formal';
}) => Promise<SubscribeSendResult>;

let sender: Sender = sendSubscribeMessage;

export function __setSubscribeSenderForTest(fn: Sender | null): void {
  sender = fn ?? sendSubscribeMessage;
}

function miniprogramState(): 'developer' | 'trial' | 'formal' {
  const v = process.env.MINIPROGRAM_STATE;
  return v === 'developer' || v === 'trial' ? v : 'formal';
}

export interface ReminderRunResult {
  sent: number;
  inapp: number;
  skipped: number;
  failed: number;
}

/**
 * 扫描到期会员并下发提醒（幂等；同用户同到期日最多一条）。
 * 触发窗口：剩余天数 0 < daysLeft ≤ daysBefore（漏跑一天也能在窗口内补发）。
 */
export async function runMemberExpiryReminders(now = Date.now()): Promise<ReminderRunResult> {
  const result: ReminderRunResult = { sent: 0, inapp: 0, skipped: 0, failed: 0 };
  const settings = await getReminderSettings(now);
  if (!settings.enabled) return result;

  const userIds = await XpayOrderModel.distinct('userId', {
    status: { $in: MEMBER_COUNTING_STATUS },
    periodStart: { $gt: 0 },
    periodEnd: { $gt: now },
  });

  for (const rawId of userIds) {
    const userId = String(rawId);
    const e = await entitlementsOf(userId, now);
    if (!e.memberActive) { result.skipped += 1; continue; }
    const daysLeft = daysUntilBj(e.memberUntil, now);
    if (daysLeft < 0 || daysLeft > settings.daysBefore) { result.skipped += 1; continue; }

    const user = await UserModel.findById(userId).select({ openid: 1, nickname: 1 }).lean();
    if (!user?.openid) { result.skipped += 1; continue; }
    const order = await XpayOrderModel.findOne({
      userId: new Types.ObjectId(userId),
      status: { $in: MEMBER_COUNTING_STATUS },
      periodStart: { $gt: 0 },
      periodEnd: { $gte: e.memberUntil - 1 },
    }).sort({ periodEnd: -1 }).select({ name: 1 }).lean();
    const name = order?.name || '迹路者会员';

    const grant = await SubscribeGrantModel.findOne({
      userId: new Types.ObjectId(userId),
      templateKey: MEMBER_EXPIRY_TEMPLATE_KEY,
      status: 'granted',
    }).sort({ grantedAt: 1 }).lean();

    if (!grant) {
      if (await ensureInappReminder(userId, name, e.memberUntil)) result.inapp += 1;
      else result.skipped += 1;
      continue;
    }

    const dedupeKey = wechatDedupeKey(userId, e.memberUntil);
    try {
      await SubscribeMessageLogModel.create({
        dedupeKey, userId: new Types.ObjectId(userId), templateKey: MEMBER_EXPIRY_TEMPLATE_KEY,
        channel: 'wechat', status: 'sending', createdAt: now,
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) { result.skipped += 1; continue; }
      throw err;
    }

    try {
      const r = await sender({
        openid: user.openid,
        templateId: settings.templateId,
        page: '/pages/member/member',
        miniprogramState: miniprogramState(),
        data: buildReminderData({ name, until: e.memberUntil, daysLeft }),
      });
      if (r.errcode === 0) {
        await SubscribeGrantModel.updateOne({ _id: grant._id }, { $set: { status: 'consumed', consumedAt: now } });
        await SubscribeMessageLogModel.updateOne({ dedupeKey }, { $set: { status: 'sent', errcode: 0, errmsg: r.errmsg } });
        result.sent += 1;
        continue;
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
      if (r.errcode === 47003) console.error(`[member-reminder] 模板字段不匹配：${r.errmsg}`);
      if (await ensureInappReminder(userId, name, e.memberUntil)) result.inapp += 1;
      else result.failed += 1;
    } catch (err) {
      // 网络/微信临时错误：删掉占位，下一轮重试（额度未消耗）
      await SubscribeMessageLogModel.deleteOne({ dedupeKey, status: 'sending' }).catch(() => {});
      console.error('[member-reminder] 下发异常：', (err as Error).message);
      result.failed += 1;
    }
  }
  return result;
}

/** 每小时扫一次（单实例进程内定时）；测试/显式关闭时不启动 */
export function startMemberReminderJob(intervalMs = 60 * 60 * 1000): NodeJS.Timeout | null {
  if (process.env.NODE_ENV === 'test' || process.env.MEMBER_REMINDER_JOB === 'off') return null;
  const timer = setInterval(() => {
    runMemberExpiryReminders().catch((err) => console.error('[member-reminder] 扫描失败：', err));
  }, intervalMs);
  timer.unref?.();
  return timer;
}
