/**
 * 榜单发放开关（2026-10-29 用户拍板方案 B：后台开关，不搞环境变量仪式）。
 *
 * - 状态落 app_settings 集合（key=boardRewardsEnabled），webAdmin 点一下即生效，不用重启；
 * - 无行时回落到 env 种子值（config.boardRewardsEnabled，线上缺省 false）——部署即关、后台再开，
 *   保留「先上线后放量」的节奏，但把放量动作从「改 env + 重建容器」缩成「后台点一下」；
 * - 读侧 30s 内存缓存：懒结算挂在积分页/榜单页请求上，逐请求查库没必要；代价是**多实例部署下
 *   别的实例最迟 30s 才感知翻转**——对一个运营开关完全可接受，写侧已把本实例缓存立即可见。
 * - 结算起点（BOARD_SETTLE_FROM）不数据库化：它标定「从哪天开始发」，语义上就是部署期决策，
 *   且缺省 2026-11-01 已经把误发历史的风险兜死，维持 env 即可。
 */
import { AppSettingModel } from '../models/app-setting.model.js';
import { BOARD_REWARDS } from '../config/points.js';

const KEY = 'boardRewardsEnabled';
const CACHE_TTL_MS = 30_000;

let cache: { value: boolean; expiresAt: number } | null = null;

/** 开着吗：无设置行回落 env 种子值 */
export async function isBoardRewardsEnabled(now = Date.now()): Promise<boolean> {
  if (cache && now < cache.expiresAt) return cache.value;
  const row = await AppSettingModel.findById(KEY).select({ value: 1 }).lean();
  const value = row ? row.value === true : BOARD_REWARDS.enabled;
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/** 翻转开关：写库 + 本实例缓存立即可见（多实例其余实例最迟 30s 收敛） */
export async function setBoardRewardsEnabled(on: boolean): Promise<void> {
  await AppSettingModel.findByIdAndUpdate(
    KEY,
    { value: on, updatedAt: new Date() },
    { upsert: true },
  );
  cache = { value: on, expiresAt: Number.MAX_SAFE_INTEGER };
}

/** 测试专用：清掉进程内缓存，让下一次读重新走库（测「无行=env 缺省」时用） */
export function resetBoardSwitchCacheForTest(): void {
  cache = null;
}
