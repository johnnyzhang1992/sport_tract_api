/**
 * 新手/每日任务：状态判定与领取。
 *
 * 口径（需求 §5）：
 * - 任务表只落「已领取」行（PointTaskModel.status 只有 claimed）；claimable/locked 全由条件实时推导，
 *   避免把可领取/过期状态持久化后再回填；
 * - once 任务 periodKey 恒为 'once'，daily 任务为东八区日期串：同一
 *   (userId, taskKey, periodKey) 唯一键既保证领取幂等，也让每日任务天然跨天重置；
 * - 领取先占任务行再发分：并发/重复提交只有占行成功的那一次会调用账本；
 * - 账本 idemKey 带 userId 前缀（明细表唯一索引是全局的），否则第二个用户领同一任务会被误判为重放。
 */
import { POINT_TASKS, type TaskKey } from '../config/points.js';
import { AppError } from '../utils/app-error.js';
import { bjDateStr, bjToday0 } from '../utils/bj-time.js';
import { PointTaskModel } from '../models/point.model.js';
import { UserModel } from '../models/user.model.js';
import { ActivityModel } from '../models/activity.model.js';
import { creditPoints } from './points-ledger.js';

export type TaskStatus = 'claimable' | 'claimed' | 'expired' | 'locked';

export interface TaskRow {
  key: TaskKey;
  title: string;
  points: number;
  status: TaskStatus;
  actionText: string;
}

export interface ClaimResult {
  alreadyClaimed: boolean;
  credited: number;
}

const DAY_MS = 86400000;
const DUPLICATE_KEY = 11000;

function isDuplicateKey(e: unknown): boolean {
  return (e as { code?: number } | null)?.code === DUPLICATE_KEY;
}

/** once 任务全生命周期一个周期；daily 任务以东八区日期串为周期 */
function periodKeyFor(key: TaskKey, todayKey: string): string {
  return POINT_TASKS[key].period === 'once' ? 'once' : todayKey;
}

async function conditionMet(userId: string, key: TaskKey, now: number): Promise<boolean> {
  switch (key) {
    case 'newbie_profile': {
      // 昵称 + 头像（上传头像或预设头像）都齐才算完善
      const u = await UserModel.findById(userId).select('nickname avatarUrl avatarPreset').lean();
      return !!u?.nickname && !!(u.avatarUrl || u.avatarPreset);
    }
    case 'newbie_first_activity':
      return (await ActivityModel.countDocuments({ userId, status: 'finished' })) > 0;
    case 'newbie_first_import':
      return (await ActivityModel.countDocuments({
        userId,
        'deviceInfo.filename': { $exists: true, $ne: '' },
      })) > 0;
    case 'daily_activity': {
      // 只认「开始时间落在今天（东八区）」的已完成轨迹，昨天完成的不能顶今天
      const start = bjToday0(now);
      return (await ActivityModel.countDocuments({
        userId,
        status: 'finished',
        startTime: { $gte: start, $lt: start + DAY_MS },
      })) > 0;
    }
    case 'daily_video':
      return true; // 完播由客户端保证，服务端只防重复发分
    default:
      return false;
  }
}

export async function getTaskRows(userId: string, now: number = Date.now()): Promise<TaskRow[]> {
  const todayKey = bjDateStr(now);
  const rows = await PointTaskModel.find({ userId }).select({ taskKey: 1, periodKey: 1 }).lean();
  const claimed = new Set(rows.map((r) => `${r.taskKey}:${r.periodKey}`));

  return Promise.all((Object.keys(POINT_TASKS) as TaskKey[]).map(async (key): Promise<TaskRow> => {
    const def = POINT_TASKS[key];
    if (claimed.has(`${key}:${periodKeyFor(key, todayKey)}`)) {
      return { key, title: def.title, points: def.points, status: 'claimed', actionText: '已领取' };
    }
    const ok = await conditionMet(userId, key, now);
    return {
      key,
      title: def.title,
      points: def.points,
      status: ok ? 'claimable' : 'locked',
      actionText: ok ? (key === 'daily_video' ? '去观看' : '领取') : (key === 'daily_activity' ? '去运动' : '未完成'),
    };
  }));
}

export async function claimTask(userId: string, taskKey: string, now: number = Date.now()): Promise<ClaimResult> {
  const key = taskKey as TaskKey;
  const def = POINT_TASKS[key];
  if (!def) throw new AppError(404, '任务不存在');
  // 先校验条件再占行：条件不满足时不能在任务表留下 claimed 行
  if (!(await conditionMet(userId, key, now))) throw new AppError(400, '任务条件未完成');

  const periodKey = periodKeyFor(key, bjDateStr(now));
  // 唯一键 (userId, taskKey, periodKey) 先占位：并发/重复领取只有一次能继续发分
  const row = await PointTaskModel.create({
    userId,
    taskKey: key,
    periodKey,
    status: 'claimed',
    points: def.points,
    claimedAt: now,
  }).catch((e: unknown) => {
    if (isDuplicateKey(e)) return null;
    throw e;
  });
  if (!row) return { alreadyClaimed: true, credited: 0 };

  try {
    const c = await creditPoints(userId, {
      type: `task_${key}`,
      title: def.title,
      points: def.points,
      bizDate: bjDateStr(now),
      refType: 'task',
      refId: `${key}:${periodKey}`,
      // 账本唯一键全局生效，必须带 userId，否则多用户同任务会互相判重放
      idemKey: `${userId}:task:${key}:${periodKey}`,
    }, now);
    return { alreadyClaimed: false, credited: c.credited };
  } catch (e) {
    // 发分失败：撤回任务行，允许用户重试（否则 once 任务会永久显示已领取却没得分）
    await PointTaskModel.deleteOne({ _id: row._id });
    throw e;
  }
}
