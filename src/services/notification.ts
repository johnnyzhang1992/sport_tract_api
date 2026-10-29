import { Types } from 'mongoose';
import { NotificationModel } from '../models/notification.model.js';
import { NotificationReadModel } from '../models/notification-read.model.js';
import { UserModel } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { assertObjectIdLike, isObjectIdLike } from '../utils/object-id.js';

export interface NotificationSummaryItem {
  id: string;
  title: string;
}

/**
 * 用户侧可见性过滤（Task 8，方案 A）：广播行（userId:null，含字段缺失的历史行）+ 发给我的定向行。
 * 游客/畸形 userId 一律收敛成「只看广播」——比 plan 片段更严：畸形串若落到无过滤分支会泄他人定向行。
 */
function recipientFilter(userId?: string): Record<string, unknown> {
  if (userId && isObjectIdLike(userId)) {
    // 单条 $or 查询：一行最多命中一个分支，天然不会把广播重复计入
    return { $or: [{ userId: null }, { userId: new Types.ObjectId(userId) }] };
  }
  return { userId: null };
}

/** 已发布通知（广播 + 定向给我的），按发布时间倒序（首页/列表共用的唯一排序口径） */
async function publishedRows(userId?: string) {
  return NotificationModel.find({ published: true, ...recipientFilter(userId) })
    .sort({ publishedAt: -1 })
    .select({ title: 1, content: 1, publishedAt: 1, userId: 1 })
    .lean();
}

/** 该用户在这些通知里已读的 id 集合；游客/畸形 userId 一律空集 */
async function readIdSet(userId: string | undefined, ids: Types.ObjectId[]): Promise<Set<string>> {
  if (!userId || !isObjectIdLike(userId) || ids.length === 0) return new Set();
  const rows = await NotificationReadModel.find({
    userId: new Types.ObjectId(userId),
    notificationId: { $in: ids },
  })
    .select({ notificationId: 1 })
    .lean();
  return new Set(rows.map((r) => String(r.notificationId)));
}

/**
 * 用户注册时刻（ms）；游客/畸形 userId 返 0（= 不过滤，全部按未读，与历史行为一致）
 */
async function registeredAtOf(userId: string | undefined): Promise<number> {
  if (!userId || !isObjectIdLike(userId)) return 0;
  const row = await UserModel.findById(userId).select({ createdAt: 1 }).lean();
  return row?.createdAt ? new Date(row.createdAt).getTime() : 0;
}

/**
 * 未读口径（2026-10-26 用户拍板，只作用于刚注册的用户）：
 * - 注册后发布的：正常未读（显式已读除外）——存量用户不受影响（他们的注册时刻早已过去）；
 * - 注册前发布的：默认已读，否则新用户一进来就是一堆历史未读；
 *   例外：其中最新一条保留未读（发现入口，引导点进消息中心一次）。
 * 游客（userId 缺）：不判已读，isUnread 恒 true（调用方对游客未读数恒 0）。
 */
async function unreadState<T extends { _id: Types.ObjectId; publishedAt?: number | null }>(
  userId: string | undefined,
  rows: T[],
): Promise<{ unreadRows: T[]; isUnread: (r: T) => boolean }> {
  const readIds = await readIdSet(userId, rows.map((r) => r._id));
  const regAt = await registeredAtOf(userId);
  // 注册前最新一条：保留未读的发现入口（无则不过例外）
  let preRegLatest: (typeof rows)[number] | undefined;
  for (const r of rows) {
    const pa = r.publishedAt ?? 0;
    if (pa < regAt && (!preRegLatest || pa > (preRegLatest.publishedAt ?? 0))) preRegLatest = r;
  }
  const preRegLatestId = preRegLatest ? String(preRegLatest._id) : '';
  const isUnread = (r: { _id: Types.ObjectId; publishedAt?: number | null }): boolean => {
    if (readIds.has(String(r._id))) return false;
    if ((r.publishedAt ?? 0) >= regAt) return true;
    return String(r._id) === preRegLatestId;
  };
  const unreadRows = rows.filter(isUnread);
  return { unreadRows, isUnread };
}

/** 首页单行：登录用户取最新未读（没有则 null）；游客取最新已发布，未读数恒 0 */
export async function notificationSummary(userId?: string) {
  const rows = await publishedRows(userId);
  const { unreadRows } = await unreadState(userId, rows);
  const latest = unreadRows[0];
  return {
    item: latest ? { id: String(latest._id), title: latest.title } : null,
    unreadCount: userId ? unreadRows.length : 0,
  };
}

/** 历史列表：可见范围（广播+定向给我的）全量，倒序；游客 read 一律 false、unreadCount=0 */
export async function listNotifications(userId?: string) {
  const rows = await publishedRows(userId);
  const { unreadRows, isUnread } = await unreadState(userId, rows);
  return {
    items: rows.map((r) => ({
      id: String(r._id),
      title: r.title,
      publishedAt: r.publishedAt ?? 0,
      read: userId ? !isUnread(r) : false,
    })),
    unreadCount: userId ? unreadRows.length : 0,
  };
}

/** 详情：仅已发布且对我可见（广播或收件人是我）可读；读接口不写已读。
 * 别人的定向行按 404 处理——与仓内「外来 id 藏进 404」口径一致，不外泄「存在但不可见」。 */
export async function getNotificationDetail(id: string, userId?: string) {
  assertObjectIdLike(id, '通知不存在');
  const row = await NotificationModel.findOne({ _id: id, published: true, ...recipientFilter(userId) }).lean();
  if (!row) throw new AppError(404, '通知不存在');
  return {
    id: String(row._id),
    title: row.title,
    content: row.content,
    publishedAt: row.publishedAt ?? 0,
  };
}

/** 标已读：幂等（并发唯一键冲突视为成功），返回最新未读数；别人的定向行按 404（同详情口径） */
export async function markNotificationRead(userId: string, id: string) {
  assertObjectIdLike(id, '通知不存在');
  const exists = await NotificationModel.exists({ _id: id, published: true, ...recipientFilter(userId) });
  if (!exists) throw new AppError(404, '通知不存在');

  try {
    await NotificationReadModel.updateOne(
      { userId: new Types.ObjectId(userId), notificationId: new Types.ObjectId(id) },
      { $set: { readAt: Date.now() } },
      { upsert: true },
    );
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
  }

  const rows = await publishedRows(userId);
  const { unreadRows } = await unreadState(userId, rows);
  return { unreadCount: unreadRows.length };
}

// ==================== 管理端 ====================

export interface AdminNotification {
  id: string;
  title: string;
  content: string;
  published: boolean;
  publishedAt: number | null;
  /** 定向收件人；null＝广播。后台列表只回广播行，此字段恒 null（保留供单条 DTO 透明） */
  userId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type NotificationInput = {
  title?: unknown;
  content?: unknown;
  published?: unknown;
  /** 定向收件人（24 位 hex）；null/缺省＝广播 */
  userId?: unknown;
};

function toAdminNotification(r: Record<string, unknown> & { _id: unknown }): AdminNotification {
  return {
    id: String(r._id),
    title: String(r.title || ''),
    content: String(r.content || ''),
    published: Boolean(r.published),
    publishedAt: (r.publishedAt as number | null) ?? null,
    userId: r.userId ? String(r.userId) : null,
    createdAt: r.createdAt ? new Date(r.createdAt as string).getTime() : 0,
    updatedAt: r.updatedAt ? new Date(r.updatedAt as string).getTime() : 0,
  };
}

function validateInput(input: NotificationInput, { partial }: { partial: boolean }) {
  const out: Record<string, unknown> = {};
  if (input.title !== undefined || !partial) {
    const title = String(input.title ?? '').trim();
    if (!title) throw new AppError(400, '标题不能为空');
    if (title.length > 60) throw new AppError(400, '标题不能超过 60 字');
    out.title = title;
  }
  if (input.content !== undefined || !partial) {
    const content = String(input.content ?? '').replace(/\r\n?/g, '\n').trim();
    if (!content) throw new AppError(400, '正文不能为空');
    if (content.length > 5000) throw new AppError(400, '正文不能超过 5000 字');
    out.content = content;
  }
  if (input.published !== undefined) out.published = Boolean(input.published);
  if (input.userId !== undefined) {
    if (input.userId === null) {
      out.userId = null; // 显式 null＝广播
    } else {
      // 畸形收件人 id 必须 400：静默当广播发出去等于把定向流水公开全站
      const raw = String(input.userId).trim();
      if (!isObjectIdLike(raw)) throw new AppError(400, '收件人 userId 格式不合法（需 24 位 hex，或 null 表示广播）');
      out.userId = new Types.ObjectId(raw);
    }
  }
  return out;
}

/** 管理端列表：只回广播行（含草稿）；定向通知是系统自动发的流水，不进公告台账，按创建时间倒序 */
export async function adminListNotifications(): Promise<AdminNotification[]> {
  const rows = await NotificationModel.find({ userId: null }).sort({ createdAt: -1 }).lean();
  return rows.map((r) => toAdminNotification(r as never));
}

export async function createNotification(input: NotificationInput): Promise<AdminNotification> {
  const data = validateInput(input, { partial: false });
  const published = Boolean(data.published);
  const doc = await NotificationModel.create({
    ...data,
    published,
    publishedAt: published ? Date.now() : null,
  });
  return toAdminNotification(doc.toObject() as never);
}

export async function updateNotification(id: string, input: NotificationInput): Promise<AdminNotification> {
  assertObjectIdLike(id, '通知不存在');
  const data = validateInput(input, { partial: true });
  const before = await NotificationModel.findById(id).lean();
  if (!before) throw new AppError(404, '通知不存在');
  if (data.published === true && !before.published) data.publishedAt = Date.now();
  const doc = await NotificationModel.findByIdAndUpdate(id, { $set: data }, { new: true }).lean();
  if (!doc) throw new AppError(404, '通知不存在');
  return toAdminNotification(doc as never);
}

export async function deleteNotification(id: string): Promise<void> {
  assertObjectIdLike(id, '通知不存在');
  const doc = await NotificationModel.findByIdAndDelete(id).lean();
  if (!doc) throw new AppError(404, '通知不存在');
  await NotificationReadModel.deleteMany({ notificationId: new Types.ObjectId(id) });
}
