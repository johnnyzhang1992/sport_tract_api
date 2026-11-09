import { Types } from 'mongoose';
import { AppSettingModel } from '../models/app-setting.model.js';
import { ActivityModel } from '../models/activity.model.js';
import { UserModel } from '../models/user.model.js';
import { SubscribeGrantModel } from '../models/subscribe-grant.model.js';
import { SubscribeMessageLogModel } from '../models/subscribe-message-log.model.js';
import { NotificationModel } from '../models/notification.model.js';
import { createNotification } from './notification.js';
import { sendSubscribeMessage, type SubscribeSendResult } from './subscribe-message.js';
import { ACTIVITY_TYPE_META, type ActivityType } from '../config/constants.js';
import { AppError } from '../utils/app-error.js';
import { isObjectIdLike } from '../utils/object-id.js';
import { BJ_OFFSET_MS, bjDateStr, bjIsoWeekLabel, bjIsoWeekStart } from '../utils/bj-time.js';
import { fmtCnDateTime, truncateChars } from '../utils/wechat-template.js';

export const WEEKLY_SPORTS_TEMPLATE_KEY = 'weeklySports';
/** 账号下已添加的「运动数据同步提醒」模板（与小程序后台一致） */
export const WEEKLY_SPORTS_TEMPLATE_ID = 'WHINJ68h7-PCp63HfB22atBRHIxKKevNmOTYGWx9osI';
export const WEEKLY_SPORTS_SETTINGS_KEY = 'weeklySportsReminder';
const SETTINGS_CACHE_TTL_MS = 30_000;
const DAY_MS = 86_400_000;

export interface WeeklySportsSettings {
  enabled: boolean;
  templateId: string;
}

const DEFAULT_SETTINGS: WeeklySportsSettings = {
  enabled: false,
  templateId: WEEKLY_SPORTS_TEMPLATE_ID,
};

let settingsCache: { value: WeeklySportsSettings; expiresAt: number } | null = null;

function normalizeSettings(raw: unknown): WeeklySportsSettings {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    enabled: v.enabled === true,
    templateId: String(v.templateId ?? '').trim() || DEFAULT_SETTINGS.templateId,
  };
}

export async function getWeeklySportsSettings(now = Date.now()): Promise<WeeklySportsSettings> {
  if (settingsCache && now < settingsCache.expiresAt) return settingsCache.value;
  const row = await AppSettingModel.findById(WEEKLY_SPORTS_SETTINGS_KEY).select({ value: 1 }).lean();
  const value = row ? normalizeSettings(row.value) : { ...DEFAULT_SETTINGS };
  settingsCache = { value, expiresAt: now + SETTINGS_CACHE_TTL_MS };
  return value;
}

export async function setWeeklySportsSettings(input: unknown): Promise<WeeklySportsSettings> {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    throw new AppError(400, 'enabled 必须是布尔值');
  }
  const templateId = String(body.templateId ?? '').trim();
  if (!templateId) throw new AppError(400, '模板 ID 不能为空');
  if (templateId.length > 80) throw new AppError(400, '模板 ID 过长');
  const value: WeeklySportsSettings = { enabled: body.enabled === true, templateId };
  await AppSettingModel.findByIdAndUpdate(
    WEEKLY_SPORTS_SETTINGS_KEY,
    { value, updatedAt: new Date() },
    { upsert: true },
  );
  settingsCache = { value, expiresAt: Number.MAX_SAFE_INTEGER };
  return value;
}

export function resetWeeklySportsSettingsCacheForTest(): void {
  settingsCache = null;
}

/* ---------------------------- 授权额度 ---------------------------- */

export async function recordWeeklySportsGrant(userId: string, scene = ''): Promise<{ subscribed: boolean }> {
  if (!isObjectIdLike(userId)) throw new AppError(401, '请先登录');
  const settings = await getWeeklySportsSettings();
  await SubscribeGrantModel.create({
    userId: new Types.ObjectId(userId),
    templateKey: WEEKLY_SPORTS_TEMPLATE_KEY,
    templateId: settings.templateId,
    scene: truncateChars(scene, 20),
    status: 'granted',
    grantedAt: Date.now(),
  });
  return { subscribed: true };
}

export async function hasWeeklySportsGrant(userId: string): Promise<boolean> {
  if (!isObjectIdLike(userId)) return false;
  return Boolean(await SubscribeGrantModel.exists({
    userId: new Types.ObjectId(userId),
    templateKey: WEEKLY_SPORTS_TEMPLATE_KEY,
    status: 'granted',
  }));
}

/* ---------------------------- 周窗口与数据 ---------------------------- */

export interface WeeklySportsData {
  weekStart: number;
  weekEnd: number;
  runningMeters: number;
  activeDays: number;
  latest: { type: ActivityType; distance: number; duration: number; startTime: number } | null;
}

type ActivityRow = {
  type: string;
  distance?: number | null;
  duration?: number | null;
  startTime: number;
};

/** 上周一 00:00 至本周一 00:00（东八区） */
export function weeklyWindow(now: number): { weekStart: number; weekEnd: number } {
  const weekEnd = bjIsoWeekStart(now);
  return { weekStart: weekEnd - 7 * DAY_MS, weekEnd };
}

export async function collectWeeklySports(userId: string, now = Date.now()): Promise<WeeklySportsData> {
  const { weekStart, weekEnd } = weeklyWindow(now);
  const rows = await ActivityModel.find({
    userId: new Types.ObjectId(userId),
    status: 'finished',
    startTime: { $gte: weekStart, $lt: weekEnd },
  }).select({ type: 1, distance: 1, duration: 1, startTime: 1 }).lean();
  return summarizeWeeklySports(weekStart, weekEnd, rows as ActivityRow[]);
}

function summarizeWeeklySports(weekStart: number, weekEnd: number, rows: ActivityRow[]): WeeklySportsData {
  let runningMeters = 0;
  let latest: WeeklySportsData['latest'] = null;
  const days = new Set<string>();
  for (const r of rows) {
    days.add(bjDateStr(r.startTime));
    if (r.type === 'running') runningMeters += Number(r.distance ?? 0);
    if (!latest || r.startTime > latest.startTime) {
      latest = {
        type: r.type as ActivityType,
        distance: Number(r.distance ?? 0),
        duration: Number(r.duration ?? 0),
        startTime: r.startTime,
      };
    }
  }
  return { weekStart, weekEnd, runningMeters, activeDays: days.size, latest };
}

function latestSummary(latest: NonNullable<WeeklySportsData['latest']>): string {
  const label = ACTIVITY_TYPE_META[latest.type]?.label ?? '运动';
  if (latest.distance > 0) return `上周${label} ${(latest.distance / 1000).toFixed(2)} 公里`;
  if (latest.duration > 0) return `上周${label} ${Math.max(1, Math.round(latest.duration / 60))} 分钟`;
  return `上周${label}`;
}

/** 模板字段：character_string4 本周跑步里程 / thing2 累计运动天数 / thing1 最近运动数据 / time3 最近运动时间 */
export function buildWeeklySportsData(data: WeeklySportsData): Record<string, { value: string }> {
  if (!data.latest) throw new Error('上周没有运动记录，不能生成运动数据提醒');
  // character_string 类型只允许数字/字母/符号（47003：不能带中文与空格），单位缩写用 km
  return {
    character_string4: { value: `${(data.runningMeters / 1000).toFixed(2)}km` },
    thing2: { value: truncateChars(`上周 ${data.activeDays} 天`, 20) },
    thing1: { value: truncateChars(latestSummary(data.latest), 20) },
    time3: { value: fmtCnDateTime(data.latest.startTime) },
  };
}

export function weeklyDedupeKey(userId: string, weekKey: string): string {
  return `weeklySports:wechat:${userId}:${weekKey}`;
}

/** 站内通知幂等键（每周一条；与微信 dedupe 互相独立） */
function weeklyInappDedupeKey(userId: string, weekKey: string): string {
  return `weeklySports:inapp:${userId}:${weekKey}`;
}

/** 站内正文：与微信模板同口径（跑步里程只算 running），供消息中心兜底展示 */
function weeklyInappContent(data: WeeklySportsData): string {
  const latest = data.latest!;
  return `上周跑步 ${(data.runningMeters / 1000).toFixed(2)} 公里，运动 ${data.activeDays} 天；最近一次：${latestSummary(latest)}（${fmtCnDateTime(latest.startTime)}）`;
}

/** 周一 09:00（东八区）起才发；force 仅供后台手动跑 */
export function isWeeklySendTime(now: number): boolean {
  const d = new Date(now + BJ_OFFSET_MS);
  return d.getUTCDay() === 1 && d.getUTCHours() >= 9;
}

/* ---------------------------- 下发 ---------------------------- */

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

export interface WeeklySportsRunResult {
  sent: number;
  noData: number;
  /** 站内定向通知（保底通道，与微信结果解耦） */
  inapp: number;
  skipped: number;
  failed: number;
}

/**
 * 扫描有「每周运动数据」授权额度的用户：
 * - 只取上周已完成轨迹；上周没有运动的人不发；
 * - 每人每周一条（dedupeKey 由唯一索引裁决）；
 * - 发送成功才消耗额度；43101 作废；网络错误删占位，下一轮重试。
 */
export async function runWeeklySportsReminders(
  now = Date.now(),
  opts: {
    force?: boolean;
    /**
     * **仅测试用**：把扫描范围收窄到给定用户（与 `__setXSenderForTest` 同一类测试缝）。
     * 存在的理由：共享 dev 库上真实用户也会持有有效授权行，测试断言「本夹具发了 1 条、
     * 其余 0 条」时会被真实用户的行污染成 noData/多发送——测试不该要求独占全局集合。
     * 生产调用方一律不传（undefined＝扫全量）。
     */
    onlyUserIds?: string[];
  } = {},
): Promise<WeeklySportsRunResult> {
  const result: WeeklySportsRunResult = { sent: 0, noData: 0, inapp: 0, skipped: 0, failed: 0 };
  const settings = await getWeeklySportsSettings(now);
  if (!settings.enabled) return result;
  if (!opts.force && !isWeeklySendTime(now)) return result;

  const { weekStart, weekEnd } = weeklyWindow(now);
  const weekKey = bjIsoWeekLabel(weekStart);
  const grantFilter: Record<string, unknown> = {
    templateKey: WEEKLY_SPORTS_TEMPLATE_KEY,
    status: 'granted',
  };
  if (opts.onlyUserIds?.length) {
    grantFilter.userId = { $in: opts.onlyUserIds.map((id) => new Types.ObjectId(id)) };
  }
  const grants = await SubscribeGrantModel.find(grantFilter)
    .sort({ grantedAt: 1 }).select({ _id: 1, userId: 1 }).lean();
  if (grants.length === 0) return result;

  // 每用户只消费最早的一条额度
  const firstGrant = new Map<string, { _id: Types.ObjectId }>();
  for (const g of grants) {
    const key = String(g.userId);
    if (!firstGrant.has(key)) firstGrant.set(key, { _id: g._id });
  }
  const userIds = [...firstGrant.keys()];
  const users = await UserModel.find({ _id: { $in: userIds.map((id) => new Types.ObjectId(id)) } })
    .select({ openid: 1 }).lean();
  const openidOf = new Map(users.map((u) => [String(u._id), u.openid]));

  const rows = await ActivityModel.find({
    userId: { $in: userIds.map((id) => new Types.ObjectId(id)) },
    status: 'finished',
    startTime: { $gte: weekStart, $lt: weekEnd },
  }).select({ userId: 1, type: 1, distance: 1, duration: 1, startTime: 1 }).lean();
  const byUser = new Map<string, ActivityRow[]>();
  for (const r of rows) {
    const key = String(r.userId);
    const list = byUser.get(key);
    if (list) list.push(r as ActivityRow);
    else byUser.set(key, [r as ActivityRow]);
  }

  for (const [userId, grant] of firstGrant) {
    const list = byUser.get(userId);
    if (!list || list.length === 0) {
      result.noData += 1;
      continue;
    }
    const summary = summarizeWeeklySports(weekStart, weekEnd, list);
    const data = buildWeeklySportsData(summary);

    // 站内保底：先于微信、与微信结果解耦（43101/网络失败/无 openid 都已送达）；
    // 每用户每周一条，createNotification 撞 dedupe 唯一索引时返回既有行
    const inappKey = weeklyInappDedupeKey(userId, weekKey);
    if (!(await NotificationModel.exists({ dedupeKey: inappKey }))) {
      await createNotification({
        title: '每周运动数据',
        content: weeklyInappContent(summary),
        category: 'system',
        published: true,
        userId: new Types.ObjectId(userId),
      }, inappKey);
      result.inapp += 1;
    }

    const openid = openidOf.get(userId);
    if (!openid) {
      result.skipped += 1;
      continue;
    }
    const dedupeKey = weeklyDedupeKey(userId, weekKey);
    try {
      await SubscribeMessageLogModel.create({
        dedupeKey, userId: new Types.ObjectId(userId), templateKey: WEEKLY_SPORTS_TEMPLATE_KEY,
        channel: 'wechat', status: 'sending', createdAt: now,
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        result.skipped += 1;
        continue;
      }
      throw err;
    }

    try {
      const r = await sender({
        openid,
        templateId: settings.templateId,
        page: '/pages/stats/stats',
        miniprogramState: miniprogramState(),
        data,
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
      if (r.errcode === 47003) console.error(`[weekly-sports] 模板字段不匹配：${r.errmsg}`);
      result.failed += 1;
    } catch (err) {
      // 网络/微信临时错误：删掉占位，下一轮重试（额度未消耗）
      await SubscribeMessageLogModel.deleteOne({ dedupeKey, status: 'sending' }).catch(() => {});
      console.error('[weekly-sports] 下发异常：', (err as Error).message);
      result.failed += 1;
    }
  }
  return result;
}

/** 每小时扫一次（单实例进程内定时）；测试/显式关闭时不启动 */
export function startWeeklySportsJob(intervalMs = 60 * 60 * 1000): NodeJS.Timeout | null {
  if (process.env.NODE_ENV === 'test' || process.env.WEEKLY_SPORTS_JOB === 'off') return null;
  const timer = setInterval(() => {
    runWeeklySportsReminders().catch((err) => console.error('[weekly-sports] 扫描失败：', err));
  }, intervalMs);
  timer.unref?.();
  const first = setTimeout(() => {
    runWeeklySportsReminders().catch((err) => console.error('[weekly-sports] 扫描失败：', err));
  }, 60_000);
  first.unref?.();
  return timer;
}
