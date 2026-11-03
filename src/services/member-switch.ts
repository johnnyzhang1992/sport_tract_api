/**
 * 会员付费总开关（spec §11.7），照 services/board-switch.ts 的同一套纪律：
 * - 状态落 app_settings，webAdmin 点一下即生效，不用重启容器；
 * - 无行回落 env 种子值 config.memberPaymentsEnabled（线上缺省 false）＝部署即关、后台再放量；
 * - 读侧 30s 内存缓存：会员页/广告判据都在热路径上，逐请求查库没必要。
 *   代价是多实例部署下别的实例最迟 30s 才感知翻转——对运营开关可接受，写侧已让本实例立即可见。
 */
import { AppSettingModel } from '../models/app-setting.model.js';
import { config } from '../config/index.js';

export const MEMBER_SWITCH_KEY = 'memberPaymentsEnabled';
const CACHE_TTL_MS = 30_000;

let cache: { value: boolean; expiresAt: number } | null = null;

export async function isMemberPaymentsEnabled(now = Date.now()): Promise<boolean> {
  if (cache && now < cache.expiresAt) return cache.value;
  const row = await AppSettingModel.findById(MEMBER_SWITCH_KEY).select({ value: 1 }).lean();
  const value = row ? row.value === true : config.memberPaymentsEnabled;
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

export async function setMemberPaymentsEnabled(on: boolean): Promise<void> {
  await AppSettingModel.findByIdAndUpdate(
    MEMBER_SWITCH_KEY,
    { value: on, updatedAt: new Date() },
    { upsert: true },
  );
  cache = { value: on, expiresAt: Number.MAX_SAFE_INTEGER };
}

/** 测试专用：清掉进程内缓存，让下一次读重新走库 */
export function resetMemberSwitchCacheForTest(): void {
  cache = null;
}
