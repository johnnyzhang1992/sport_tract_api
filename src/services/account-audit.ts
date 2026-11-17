/**
 * 账号注销审计（2026-11-17）
 *
 * 两个职责：
 *   1. **留痕**：注销前把「谁、什么时候、删了什么、多少条」记一条，账号删了它也还在
 *   2. **防刷**：按 openid 哈希统计「这是第几次注销」，反复「注册→领奖→注销」会在
 *      seq 上累积，后台「注销记录」页可直接筛出来
 *
 * 隐私口径见 models/account-deletion.model.ts 文件头（只存 openid 哈希、不存内容数据、180 天 TTL）。
 */
import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { AccountDeletionModel } from '../models/account-deletion.model.js';
import type { PurgeStats } from './account-deletion.js';
import { config } from '../config/index.js';

/**
 * openid → 不可逆哈希。
 * 盐复用 JWT_SECRET（不引入新 env：少一个配置项就少一处漏配）。
 * ⚠️ 轮换 JWT_SECRET 会让历史哈希对不上，届时「同一微信第几次注销」的连续性会断——
 * 只影响防刷判定，不影响留痕本身（uid / userId / 时间 / 条数都还在）。
 */
export function hashOpenid(openid: string): string {
  return crypto.createHmac('sha256', config.jwtSecret).update(String(openid ?? '')).digest('hex');
}

export interface AccountDeletionInput {
  userId: string;
  uid?: number;
  openid: string;
  nickname?: string;
  /** 注册时刻（毫秒）：用来算 ageDays */
  createdAt?: number;
  /** purgeUser 的返回值 */
  stats: PurgeStats;
  now?: number;
  ip?: string;
  platform?: string;
  system?: string;
  appVersion?: string;
}

export interface AccountDeletionRow {
  id: string;
  userId: string;
  uid: number;
  openidHash: string;
  seq: number;
  nickname: string;
  deletedAt: number;
  ageDays: number;
  stats: Record<string, number>;
  platform: string;
  system: string;
  appVersion: string;
}

/**
 * 写入一条注销记录，返回该 openid 的注销次数（seq）。
 *
 * 并发口径：两个请求同时注销同一个 openid 时 seq 可能撞成同一个值（读-改-写非原子）。
 * 不用自增计数器换原子性——真要精确，靠 openidHash 分组统计照样能看出「超过 1 次」，
 * 而多一张计数器表就多一处不一致的来源。这里宁可近似也不引入新的状态。
 */
export async function recordAccountDeletion(input: AccountDeletionInput): Promise<{ seq: number }> {
  const openidHash = hashOpenid(input.openid);
  const now = input.now ?? Date.now();
  const seq = (await AccountDeletionModel.countDocuments({ openidHash })) + 1;
  const createdAt = Number(input.createdAt ?? 0);
  const ageDays = createdAt > 0 ? Math.max(0, Math.floor((now - createdAt) / 86_400_000)) : 0;

  await AccountDeletionModel.create({
    userId: new Types.ObjectId(String(input.userId)),
    uid: Number(input.uid ?? 0),
    openidHash,
    seq,
    nickname: String(input.nickname ?? ''),
    deletedAt: now,
    ageDays,
    stats: input.stats as unknown as Record<string, number>,
    ip: String(input.ip ?? ''),
    platform: String(input.platform ?? ''),
    system: String(input.system ?? ''),
    appVersion: String(input.appVersion ?? ''),
  });
  return { seq };
}

export interface AccountDeletionListQuery {
  page?: number;
  pageSize?: number;
  /** 站内编号精确匹配 */
  uid?: number;
  /** 「仅看重复注销」：同一 openid 注销 ≥2 次的记录 */
  repeatOnly?: boolean;
  /** 昵称模糊匹配（不区分大小写） */
  nickname?: string;
}

export interface AccountDeletionListResult {
  items: AccountDeletionRow[];
  total: number;
  summary: {
    /** 全部注销记录数（= 注销次数，同一人多条就多计） */
    totalAll: number;
    /** 去重后的账号数（按 openidHash） */
    uniqueAccounts: number;
    /** 注销 ≥2 次的账号数（防刷关注点） */
    repeatAccounts: number;
    /** 最近 7 天注销次数 */
    last7Days: number;
  };
}

function toRow(r: Record<string, any>): AccountDeletionRow {
  return {
    id: String(r._id),
    userId: String(r.userId),
    uid: Number(r.uid ?? 0),
    openidHash: String(r.openidHash ?? ''),
    seq: Number(r.seq ?? 1),
    nickname: String(r.nickname ?? ''),
    deletedAt: Number(r.deletedAt ?? 0),
    ageDays: Number(r.ageDays ?? 0),
    stats: (r.stats ?? {}) as Record<string, number>,
    platform: String(r.platform ?? ''),
    system: String(r.system ?? ''),
    appVersion: String(r.appVersion ?? ''),
  };
}

/** 管理端列表：按时间倒序 + 汇总（汇总不受分页影响，但受筛选影响） */
export async function listAccountDeletions(
  query: AccountDeletionListQuery = {},
): Promise<AccountDeletionListResult> {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));

  const filter: Record<string, unknown> = {};
  if (Number.isInteger(query.uid) && Number(query.uid) > 0) filter.uid = Number(query.uid);
  if (query.nickname) filter.nickname = { $regex: String(query.nickname).trim(), $options: 'i' };

  // 「仅看重复注销」= 该 openidHash 在库里出现 ≥2 次（按当前筛选条件算）
  if (query.repeatOnly) {
    const dup = await AccountDeletionModel.aggregate<{ _id: string }>([
      { $match: filter },
      { $group: { _id: '$openidHash', n: { $sum: 1 } } },
      { $match: { n: { $gte: 2 } } },
    ]);
    const hashes = dup.map((d) => d._id);
    if (hashes.length === 0) {
      return { items: [], total: 0, summary: await summaryOf(filter) };
    }
    filter.openidHash = { $in: hashes };
  }

  const [rows, total, summary] = await Promise.all([
    AccountDeletionModel.find(filter).sort({ deletedAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    AccountDeletionModel.countDocuments(filter),
    summaryOf(filter),
  ]);

  return { items: rows.map(toRow), total, summary };
}

/** 汇总：总次数 / 去重账号数 / 重复注销账号数 / 最近 7 天次数 */
async function summaryOf(filter: Record<string, unknown>): Promise<AccountDeletionListResult['summary']> {
  const sevenDaysAgo = Date.now() - 7 * 86_400_000;
  const [totalAll, groups, last7Days] = await Promise.all([
    AccountDeletionModel.countDocuments(filter),
    AccountDeletionModel.aggregate<{ _id: string; n: number }>([
      { $match: filter },
      { $group: { _id: '$openidHash', n: { $sum: 1 } } },
    ]),
    AccountDeletionModel.countDocuments({ ...filter, deletedAt: { $gte: sevenDaysAgo } }),
  ]);
  return {
    totalAll,
    uniqueAccounts: groups.length,
    repeatAccounts: groups.filter((g) => g.n >= 2).length,
    last7Days,
  };
}
