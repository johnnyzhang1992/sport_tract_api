import { Types } from 'mongoose';
import { NotificationModel } from '../models/notification.model.js';
import { NotificationReadModel } from '../models/notification-read.model.js';
import { AppError } from '../utils/app-error.js';
import { assertObjectIdLike, isObjectIdLike } from '../utils/object-id.js';

export interface NotificationSummaryItem {
  id: string;
  title: string;
}

/** 已发布通知，按发布时间倒序（首页/列表共用的唯一排序口径） */
async function publishedRows() {
  return NotificationModel.find({ published: true })
    .sort({ publishedAt: -1 })
    .select({ title: 1, content: 1, publishedAt: 1 })
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

/** 首页单行：登录用户取最新未读（没有则 null）；游客取最新已发布，未读数恒 0 */
export async function notificationSummary(userId?: string) {
  const rows = await publishedRows();
  const readIds = await readIdSet(userId, rows.map((r) => r._id));
  const unread = userId ? rows.filter((r) => !readIds.has(String(r._id))) : rows;
  const latest = unread[0];
  return {
    item: latest ? { id: String(latest._id), title: latest.title } : null,
    unreadCount: userId ? unread.length : 0,
  };
}

/** 历史列表：已发布全量，倒序；游客 read 一律 false、unreadCount=0 */
export async function listNotifications(userId?: string) {
  const rows = await publishedRows();
  const readIds = await readIdSet(userId, rows.map((r) => r._id));
  return {
    items: rows.map((r) => ({
      id: String(r._id),
      title: r.title,
      publishedAt: r.publishedAt ?? 0,
      read: userId ? readIds.has(String(r._id)) : false,
    })),
    unreadCount: userId ? rows.filter((r) => !readIds.has(String(r._id))).length : 0,
  };
}

/** 详情：仅已发布可读；读接口不写已读 */
export async function getNotificationDetail(id: string) {
  assertObjectIdLike(id, '通知不存在');
  const row = await NotificationModel.findOne({ _id: id, published: true }).lean();
  if (!row) throw new AppError(404, '通知不存在');
  return {
    id: String(row._id),
    title: row.title,
    content: row.content,
    publishedAt: row.publishedAt ?? 0,
  };
}

/** 标已读：幂等（并发唯一键冲突视为成功），返回最新未读数 */
export async function markNotificationRead(userId: string, id: string) {
  assertObjectIdLike(id, '通知不存在');
  const exists = await NotificationModel.exists({ _id: id, published: true });
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

  const rows = await publishedRows();
  const readIds = await readIdSet(userId, rows.map((r) => r._id));
  return { unreadCount: rows.filter((r) => !readIds.has(String(r._id))).length };
}

// ==================== 管理端 ====================

export interface AdminNotification {
  id: string;
  title: string;
  content: string;
  published: boolean;
  publishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type NotificationInput = {
  title?: unknown;
  content?: unknown;
  published?: unknown;
};

function toAdminNotification(r: Record<string, unknown> & { _id: unknown }): AdminNotification {
  return {
    id: String(r._id),
    title: String(r.title || ''),
    content: String(r.content || ''),
    published: Boolean(r.published),
    publishedAt: (r.publishedAt as number | null) ?? null,
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
  return out;
}

/** 管理端列表：含草稿，按创建时间倒序 */
export async function adminListNotifications(): Promise<AdminNotification[]> {
  const rows = await NotificationModel.find({}).sort({ createdAt: -1 }).lean();
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
