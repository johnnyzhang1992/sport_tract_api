/**
 * 运动榜上榜通知定时投递（2026-11-09）。
 *
 * 背景：上榜通知（notifyOnTheListOfBoards）此前只挂在懒结算上——用户访问积分/榜单页
 * 才触发，且发分开关关闭时懒结算整体不跑，实际收不到。本模块给它一个确定性的调度：
 * 每周一 ≥09:00（东八）发上周周榜、每月 1 日 ≥09:00 发上月月榜。
 *
 * 与既有机制的协作：直调 notifyOnTheListOfBoards，全部业务口径（前 10 名含并列、
 * 多榜按用户合并、参与 ≤10 人不发、已发到账/撤回者排除、settleFrom 闸门、
 * dedupeKey 幂等）都在那一边；本模块只管「什么时候算哪个单元 + 别重复聚合」。
 * 懒结算路径保留作漏发兜底，两边撞车由 dedupeKey 挡住，不会重发。
 *
 * 容器里没有 cron（沿用 weekly-sports / admin-daily-stats 的进程内定时先例）。
 */
import { notifyOnTheListOfBoards } from './points-board.js';
import { BJ_OFFSET_MS, bjDateStr, bjIsoWeekStart } from '../utils/bj-time.js';

const DAY_MS = 86_400_000;

/** 一个待投递单元：哪个周期 + 聚合窗口右界 */
export interface OnTheListScheduleUnit {
  period: 'week' | 'month';
  periodKey: string;
  endMs: number;
}

/** 依赖缝：测试替换投递函数，避免共享 dev 库真发通知 */
export const onthelistJobDeps: {
  notify: (period: 'week' | 'month', periodKey: string, endMs: number, now: number) => Promise<{ notified: number }>;
} = {
  notify: notifyOnTheListOfBoards,
};

/** 上周周榜单元：periodKey = 上周一（东八）日期串；窗口右界 = 本周一 00:00（东八） */
export function lastWeekUnit(now: number): OnTheListScheduleUnit {
  const lastMonday = bjIsoWeekStart(now) - 7 * DAY_MS;
  const periodKey = bjDateStr(lastMonday);
  return { period: 'week', periodKey, endMs: lastMonday + 7 * DAY_MS };
}

/** 上月月榜单元：periodKey = 上月 `YYYY-MM`；窗口右界 = 本月 1 日 00:00（东八） */
export function lastMonthUnit(now: number): OnTheListScheduleUnit {
  const b = new Date(now + BJ_OFFSET_MS);
  const py = b.getUTCMonth() === 0 ? b.getUTCFullYear() - 1 : b.getUTCFullYear();
  const pm = b.getUTCMonth() === 0 ? 12 : b.getUTCMonth();
  const periodKey = `${py}-${String(pm).padStart(2, '0')}`;
  return { period: 'month', periodKey, endMs: Date.UTC(py, pm, 1) - BJ_OFFSET_MS };
}

/** 已投递单元（periodKey 级）：当月/当周内的后续 tick 不再重复聚合。进程重启即清空——重跑幂等无害 */
const doneUnits = new Set<string>();

/** 单元投递：先占 done 再跑；抛错回滚 done 让下一 tick 重试（通知侧幂等，重跑不会重发） */
export async function runOnTheListUnit(unit: OnTheListScheduleUnit, now: number): Promise<number> {
  const key = `${unit.period}:${unit.periodKey}`;
  if (doneUnits.has(key)) return -1;
  doneUnits.add(key);
  try {
    const r = await onthelistJobDeps.notify(unit.period, unit.periodKey, unit.endMs, now);
    return r.notified;
  } catch (e) {
    doneUnits.delete(key);
    console.error(`[board-onthelist] ${key} 投递失败（下一 tick 重试，通知幂等）`, e);
    return 0;
  }
}

/** 东八闸门：周一/每月 1 日 ≥09:00 才投对应单元；其余时刻整轮跳过 */
export async function tickOnTheListJob(now: number = Date.now()): Promise<void> {
  const b = new Date(now + BJ_OFFSET_MS);
  if (b.getUTCHours() < 9) return;
  if (b.getUTCDay() === 1) await runOnTheListUnit(lastWeekUnit(now), now);
  if (b.getUTCDate() === 1) await runOnTheListUnit(lastMonthUnit(now), now);
}

/** 每小时扫一次（单实例进程内定时）；测试/显式关闭时不启动 */
export function startBoardOnTheListJob(intervalMs = 60 * 60 * 1000): NodeJS.Timeout | null {
  if (process.env.NODE_ENV === 'test' || process.env.BOARD_ON_THE_LIST_JOB === 'off') return null;
  const timer = setInterval(() => {
    tickOnTheListJob().catch((err) => console.error('[board-onthelist] 扫描失败：', err));
  }, intervalMs);
  timer.unref?.();
  const first = setTimeout(() => {
    tickOnTheListJob().catch((err) => console.error('[board-onthelist] 扫描失败：', err));
  }, 60_000);
  first.unref?.();
  return timer;
}

export function resetOnTheListJobStateForTest(): void {
  doneUnits.clear();
}
