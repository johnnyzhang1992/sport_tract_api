import { Types } from 'mongoose';
import { TopicModel } from '../models/topic.model.js';
import { AppError } from '../utils/app-error.js';
import { getSignedUrl } from './oss.js';

type ObjectIdLike = Types.ObjectId | string;

/** 管理端创建/更新入参（service 内统一校验） */
export type TopicInput = {
  title?: unknown;
  coverUrl?: unknown;
  content?: unknown;
  published?: unknown;
  effectiveAt?: unknown;
  expiresAt?: unknown;
};

const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

/** 正文/封面里的 OSS 图片换成签名 URL（bucket 私有；getSignedUrl 对外部 URL 原样返回） */
function signContentImages(content: string): string {
  return String(content || '').replace(
    /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g,
    (_m, alt: string, url: string) => `![${alt}](${getSignedUrl(url)})`,
  );
}

export interface ActiveTopic {
  id: string;
  title: string;
  coverUrl: string;
  effectiveAt: number;
  expiresAt: number | null;
}

/** 生效中的专题（首页入口）：已发布 + 生效时间内 + 未过期，按生效时间倒序 */
export async function listActiveTopics(): Promise<ActiveTopic[]> {
  const now = Date.now();
  const rows = await TopicModel.find({
    published: true,
    effectiveAt: { $lte: now },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  })
    .sort({ effectiveAt: -1 })
    .select({ title: 1, coverUrl: 1, effectiveAt: 1, expiresAt: 1 })
    .lean();

  return rows.map((r) => ({
    id: String(r._id),
    title: r.title,
    coverUrl: r.coverUrl ? getSignedUrl(r.coverUrl) : '',
    effectiveAt: r.effectiveAt,
    expiresAt: r.expiresAt ?? null,
  }));
}

/** 生效中专题详情（过期/下架/未发布对外 404），正文图片签名为可访问 URL */
export async function getActiveTopicDetail(id: string) {
  if (!OBJECT_ID_RE.test(String(id))) throw new AppError(404, '专题不存在');
  const now = Date.now();
  const r = await TopicModel.findOne({
    _id: id,
    published: true,
    effectiveAt: { $lte: now },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  }).lean();
  if (!r) throw new AppError(404, '专题不存在');

  return {
    id: String(r._id),
    title: r.title,
    coverUrl: r.coverUrl ? getSignedUrl(r.coverUrl) : '',
    content: signContentImages(r.content || ''),
    effectiveAt: r.effectiveAt,
    expiresAt: r.expiresAt ?? null,
  };
}

// ==================== 管理端 ====================

export interface AdminTopic {
  id: string;
  title: string;
  coverUrl: string;
  content: string;
  published: boolean;
  effectiveAt: number;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function toAdminTopic(r: Record<string, unknown> & { _id: unknown }): AdminTopic {
  return {
    id: String(r._id),
    title: String(r.title || ''),
    coverUrl: r.coverUrl ? getSignedUrl(String(r.coverUrl)) : '',
    content: String(r.content || ''),
    published: Boolean(r.published),
    effectiveAt: Number(r.effectiveAt || 0),
    expiresAt: (r.expiresAt as number | null) ?? null,
    createdAt: r.createdAt ? new Date(r.createdAt as string).getTime() : 0,
    updatedAt: r.updatedAt ? new Date(r.updatedAt as string).getTime() : 0,
  };
}

/** 管理端列表（含未发布/未生效/已过期），按创建时间倒序 */
export async function adminListTopics(): Promise<AdminTopic[]> {
  const rows = await TopicModel.find({}).sort({ createdAt: -1 }).lean();
  return rows.map((r) => toAdminTopic(r as never));
}

function validateInput(input: TopicInput, { partial }: { partial: boolean }) {
  const out: Record<string, unknown> = {};
  if (input.title !== undefined || !partial) {
    const title = String(input.title ?? '').trim();
    if (!title) throw new AppError(400, '标题不能为空');
    if (title.length > 60) throw new AppError(400, '标题不能超过 60 字');
    out.title = title;
  }
  if (input.content !== undefined || !partial) {
    out.content = String(input.content ?? '');
  }
  if (input.coverUrl !== undefined) out.coverUrl = String(input.coverUrl || '');
  if (input.published !== undefined) out.published = Boolean(input.published);
  if (input.effectiveAt !== undefined || !partial) {
    const effectiveAt = Number(input.effectiveAt ?? Date.now());
    if (!Number.isFinite(effectiveAt)) throw new AppError(400, '生效时间不合法');
    out.effectiveAt = effectiveAt;
  }
  if (input.expiresAt !== undefined) {
    const expiresAt = input.expiresAt == null ? null : Number(input.expiresAt);
    if (expiresAt !== null && !Number.isFinite(expiresAt)) throw new AppError(400, '过期时间不合法');
    out.expiresAt = expiresAt;
  }
  return out;
}

export async function createTopic(input: TopicInput): Promise<AdminTopic> {
  const data = validateInput(input, { partial: false });
  const doc = await TopicModel.create(data);
  return toAdminTopic(doc.toObject() as never);
}

export async function updateTopic(id: string, input: TopicInput): Promise<AdminTopic> {
  if (!OBJECT_ID_RE.test(String(id))) throw new AppError(404, '专题不存在');
  const data = validateInput(input, { partial: true });
  const doc = await TopicModel.findByIdAndUpdate(id, { $set: data }, { new: true }).lean();
  if (!doc) throw new AppError(404, '专题不存在');
  return toAdminTopic(doc as never);
}

export async function deleteTopic(id: string): Promise<void> {
  if (!OBJECT_ID_RE.test(String(id))) throw new AppError(404, '专题不存在');
  const doc = await TopicModel.findByIdAndDelete(id).lean();
  if (!doc) throw new AppError(404, '专题不存在');
}
