/**
 * 榜单用户公开资料（点击排行榜头像/昵称的半屏用）。
 * 只下发白名单字段：公开 UID、昵称、头像、加入天数、会员标记 + 累计数据八项。
 * 不返回 openid、settings、身高体重等私密字段。
 */
import { UserModel } from '../models/user.model.js';
import { overview } from './stats.js';
import { footprint } from './footprint.js';
import { activeMemberUserIds } from './entitlements.js';
import { getAvatarUrl, getMediumUrl } from './oss.js';
import { AppError } from '../utils/app-error.js';

export interface PublicProfile {
  uid: number;
  nickname: string;
  avatarUrl: string;
  /** 头像大图（800px 档，点开头像预览用） */
  avatarLargeUrl: string;
  avatarPreset: string;
  joinDays: number;
  memberActive: boolean;
  total: {
    count: number;
    distance: number;
    duration: number;
    elevationGain: number;
    calories: number;
    typeCount: number;
  };
  footprint: {
    provinceCount: number;
    cityCount: number;
  };
}

export async function publicProfileByUid(uid: number): Promise<PublicProfile | null> {
  const user = await UserModel.findOne({ uid })
    .select({ uid: 1, nickname: 1, avatarUrl: 1, avatarPreset: 1, createdAt: 1 })
    .lean();
  if (!user) return null;
  const id = String(user._id);
  const [ov, fp, memberIds] = await Promise.all([
    overview(id),
    footprint(id),
    activeMemberUserIds([id]),
  ]);
  const createdAt = new Date(user.createdAt as never).getTime();
  return {
    uid: Number(user.uid) || 0,
    nickname: user.nickname || '运动用户',
    avatarUrl: user.avatarUrl ? getAvatarUrl(user.avatarUrl) : '',
    avatarLargeUrl: user.avatarUrl ? getMediumUrl(user.avatarUrl) : '',
    avatarPreset: user.avatarPreset || '',
    joinDays: createdAt > 0 ? Math.max(1, Math.ceil((Date.now() - createdAt) / 86400000)) : 0,
    memberActive: memberIds.has(id),
    total: {
      count: ov.total.count || 0,
      distance: ov.total.distance || 0,
      duration: ov.total.duration || 0,
      elevationGain: ov.total.elevationGain || 0,
      calories: ov.total.calories || 0,
      typeCount: (ov.total.byType || []).length,
    },
    footprint: {
      provinceCount: fp.provinceCount || 0,
      cityCount: fp.cityCount || 0,
    },
  };
}


// ==================== 公开资料限流（按来源 IP，30 次/分钟） ====================
// 公开接口、会被榜单点击触发；overview + footprint 都是聚合查询，必须限频防刷。
export const PROFILE_RATE_WINDOW_MS = 60_000;
export const PROFILE_RATE_LIMIT = 30;
const profileRate = new Map<string, number[]>();

/** 当前窗口内计数，超过上限抛 429（now 可注入便于测试） */
export function assertProfileQuota(ip: string, now: number = Date.now()): void {
  const key = ip || 'unknown';
  if (profileRate.size > 10_000) profileRate.clear(); // 粗暴防漏：窗口内命中才保留，上限有界
  const hits = (profileRate.get(key) ?? []).filter((t) => now - t < PROFILE_RATE_WINDOW_MS);
  if (hits.length >= PROFILE_RATE_LIMIT) {
    throw new AppError(429, '请求过于频繁，请稍后再试');
  }
  hits.push(now);
  profileRate.set(key, hits);
}

/** 测试专用：清空频控窗口 */
export function resetProfileRateForTest(): void {
  profileRate.clear();
}
