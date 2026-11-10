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
  /** 目标用户开了隐私模式 → 仅此字段为 true，其余字段全部零值（前端 toast 后不弹半屏） */
  privacyMode: boolean;
  uid: number;
  nickname: string;
  avatarUrl: string;
  /** 头像大图（800px 档，点开头像预览用） */
  avatarLargeUrl: string;
  avatarPreset: string;
  joinDays: number;
  memberActive: boolean;
  /** 是否允许在资料卡展示累计数据（用户设置，默认 true） */
  showSportData: boolean;
  total: {
    count: number;
    distance: number;
    duration: number;
    elevationGain: number;
    calories: number;
    typeCount: number;
  } | null;
  footprint: {
    provinceCount: number;
    cityCount: number;
  } | null;
}

export async function publicProfileByUid(
  uid: number,
  /** 查看者（可选）：等于目标用户本人时不匿名（Q2 自己看自己保持真实） */
  viewerId?: string | null,
): Promise<PublicProfile | null> {
  const user = await UserModel.findOne({ uid })
    .select({ uid: 1, nickname: 1, avatarUrl: 1, avatarPreset: 1, createdAt: 1, settings: 1 })
    .lean();
  if (!user) return null;
  // 隐私模式（2026-11-09）：目标用户开了隐私 → 身份与数据一概不下发，双保险（榜单行已置 uid=0）。
  // 例外：查看者就是目标本人（Q2 自己看自己保持真实）。
  const isSelf = !!viewerId && String(user._id) === String(viewerId);
  if (user.settings?.privacyMode === true && !isSelf) {
    return {
      privacyMode: true, uid: 0, nickname: '', avatarUrl: '', avatarLargeUrl: '', avatarPreset: '',
      joinDays: 0, memberActive: false, showSportData: false, total: null, footprint: null,
    };
  }
  const id = String(user._id);
  const showSportData = user.settings?.showSportData !== false;
  // 关闭展示时不跑 overview/footprint（两个聚合都不便宜），只保留身份与会员徽标
  const [ov, fp, memberIds] = showSportData
    ? await Promise.all([overview(id), footprint(id), activeMemberUserIds([id])])
    : [null, null, await activeMemberUserIds([id])];
  const createdAt = new Date(user.createdAt as never).getTime();
  return {
    privacyMode: false,
    uid: Number(user.uid) || 0,
    nickname: user.nickname || '运动用户',
    avatarUrl: user.avatarUrl ? getAvatarUrl(user.avatarUrl) : '',
    avatarLargeUrl: user.avatarUrl ? getMediumUrl(user.avatarUrl) : '',
    avatarPreset: user.avatarPreset || '',
    joinDays: createdAt > 0 ? Math.max(1, Math.ceil((Date.now() - createdAt) / 86400000)) : 0,
    memberActive: memberIds.has(id),
    showSportData,
    total: showSportData && ov
      ? {
        count: ov.total.count || 0,
        distance: ov.total.distance || 0,
        duration: ov.total.duration || 0,
        elevationGain: ov.total.elevationGain || 0,
        calories: ov.total.calories || 0,
        typeCount: (ov.total.byType || []).length,
      }
      : null,
    footprint: showSportData && fp
      ? { provinceCount: fp.provinceCount || 0, cityCount: fp.cityCount || 0 }
      : null,
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
