/**
 * 管理端积分概况与趋势（spec §6.5/§6.6/§7.1）。
 *
 * 口径（§6.5，一条都不能改）：
 * - 一律从 `PointRecord` 按 `type` 聚合，**不读 `PointAccount.totalSpent`**：`debitPoints`
 *   把兑换、过期回收、撤回都记进同一个 totalSpent（points-ledger.ts:264），拿它当「消耗」
 *   会把撤回算成花钱。所以概况 DTO 不下发 totalSpent（避免前端误用），「不能当消耗用」
 *   的证据由 AS-1 直接读 PointAccount 断言；
 * - 不变式：`balance == earnedGross - rolledBack - spentExchange - spentExpire`。
 *   等式右边只列了三族负 delta，所以负 delta 的类型集合也被 AS-2 钉住；
 * - 趋势桶键直接比对库里的东八区 `YYYY-MM-DD`（`dateKey` / `bizDate`），不走 `$dateToString`，
 *   缺日补 0，桶数恒等于窗口大小。
 */
import type { PipelineStage } from 'mongoose';
import {
  PointAccountModel, PointCardModel, PointRecordModel, PointSigninModel,
} from '../models/point.model.js';
import { AppError } from '../utils/app-error.js';
import { bjDateStr } from '../utils/bj-time.js';
import { shiftDateKey } from '../utils/points-domain.js';

const DAY_MS = 86400000;

/** 趋势窗口白名单：只有这三档（spec §6.6 / AS-5） */
const TREND_WINDOWS = [7, 30, 90] as const;

/** 撤回族的唯一判定：概况聚合与用户详情的 per-user 聚合共用（不许各写一份正则） */
export const ROLLBACK_RE = /_rollback$/;

/**
 * 负 delta 的全部已知族；新增扣分类型必须同步进 pointsOverview 的口径式（AS-2 钉这条）。
 * 管道的 `$regexMatch` 用 `ROLLBACK_RE.source`，与这里的判定共用同一份正则，不许散成两份。
 */
export const DEBIT_FAMILIES = {
  exchange: (t: string) => t === 'exchange',
  expire: (t: string) => t === 'expire',
  rollback: (t: string) => ROLLBACK_RE.test(t),
} as const;

export interface PointsOverview {
  /** 毛发放：Σ delta (delta > 0) */
  earnedGross: number;
  /** 撤回：Σ |delta| (type 以 _rollback 结尾) */
  rolledBack: number;
  /** 净发放：earnedGross - rolledBack */
  earnedNet: number;
  /** 兑换消耗：Σ |delta| (type = exchange) */
  spentExchange: number;
  /** 过期回收：Σ |delta| (type = expire) */
  spentExpire: number;
  /** 流通余额：Σ PointAccount.balance */
  balance: number;
  /** 今天（东八区）签到人数，含补签 */
  todaySigninUsers: number;
  /** 近 7 天（含今天）签到人数 */
  weekSigninUsers: number;
  /** 累计签到人数（全表 distinct userId） */
  totalSigninUsers: number;
  /** 持卡未使用人数：status=unused 且 expiresAt > now 的 distinct userId */
  cardsUnusedUsers: number;
}

export interface TrendBucket {
  date: string;
  signinUsers: number;
  makeupUsers: number;
  earned: number;
  exchanged: number;
  expired: number;
}

interface RecordSums {
  earnedGross: number;
  rolledBack: number;
  spentExchange: number;
  spentExpire: number;
}

/** 一条 `$group` 全表扫：正 delta 归毛发放，三族负 delta 各归各的桶 */
const RECORD_SUM_STAGES: PipelineStage[] = [
  {
    $group: {
      _id: null,
      earnedGross: { $sum: { $cond: [{ $gt: ['$delta', 0] }, '$delta', 0] } },
      rolledBack: {
        $sum: {
          $cond: [
            { $regexMatch: { input: '$type', regex: ROLLBACK_RE.source } },
            { $multiply: ['$delta', -1] },
            0,
          ],
        },
      },
      spentExchange: {
        $sum: { $cond: [{ $eq: ['$type', 'exchange'] }, { $multiply: ['$delta', -1] }, 0] },
      },
      spentExpire: {
        $sum: { $cond: [{ $eq: ['$type', 'expire'] }, { $multiply: ['$delta', -1] }, 0] },
      },
    },
  },
];

/**
 * 概况六组数一次并发取回。
 * 签到人数用 `distinct userId`：口径是「人」不是「次数」（补签也计入今日/近7天/累计）。
 */
export async function pointsOverview(now = Date.now()): Promise<PointsOverview> {
  const today = bjDateStr(now);
  const weekStart = shiftDateKey(today, -6);

  const [[sums], [accounts], todayUsers, weekUsers, totalUsers, cardUsers] = await Promise.all([
    PointRecordModel.aggregate<RecordSums>(RECORD_SUM_STAGES),
    PointAccountModel.aggregate<{ balance: number }>([
      { $group: { _id: null, balance: { $sum: '$balance' } } },
    ]),
    PointSigninModel.distinct('userId', { dateKey: today }),
    PointSigninModel.distinct('userId', { dateKey: { $gte: weekStart, $lte: today } }),
    PointSigninModel.distinct('userId'),
    PointCardModel.distinct('userId', { status: 'unused', expiresAt: { $gt: now } }),
  ]);

  const earnedGross = sums?.earnedGross ?? 0;
  const rolledBack = sums?.rolledBack ?? 0;
  return {
    earnedGross,
    rolledBack,
    earnedNet: earnedGross - rolledBack,
    spentExchange: sums?.spentExchange ?? 0,
    spentExpire: sums?.spentExpire ?? 0,
    balance: accounts?.balance ?? 0,
    todaySigninUsers: todayUsers.length,
    weekSigninUsers: weekUsers.length,
    totalSigninUsers: totalUsers.length,
    cardsUnusedUsers: cardUsers.length,
  };
}

/**
 * 双趋势（GET /points/trend?days=7|30|90，默认 30）。
 * 桶先按窗口长度铺满并清零，聚合结果只往已有桶里填 —— 缺日补 0，桶数恒等于 days（AS-3）。
 */
export async function pointsTrend(days: number, now = Date.now()): Promise<{ days: number; data: TrendBucket[] }> {
  if (!(TREND_WINDOWS as readonly number[]).includes(days)) {
    throw new AppError(400, `days 仅支持 ${TREND_WINDOWS.join(' / ')}（收到 ${days}）`);
  }
  const buckets: TrendBucket[] = [];
  const start = now - (days - 1) * DAY_MS;
  // bjDateStr 保证桶键与库内 bizDate/dateKey 同一套东八区口径；东八区无夏令时，逐日 +24h 不会错位
  for (let t = start; t <= now; t += DAY_MS) {
    buckets.push({ date: bjDateStr(t), signinUsers: 0, makeupUsers: 0, earned: 0, exchanged: 0, expired: 0 });
  }
  const byDate = new Map(buckets.map((b) => [b.date, b]));
  const from = buckets[0].date;
  const to = buckets[buckets.length - 1].date;

  const [signins, records] = await Promise.all([
    // (userId, dateKey) 上有唯一索引 ⇒ 一行就是一个人，$sum:1 即去重人数，不需要 $addToSet。
    // 若该索引被摘掉，这里会按行数多算（变异验证就是摘索引 + 塞同人同天双行，AS-4 红）。
    PointSigninModel.aggregate<{ _id: { d: string; s: string }; n: number }>([
      { $match: { dateKey: { $gte: from, $lte: to } } },
      { $group: { _id: { d: '$dateKey', s: '$source' }, n: { $sum: 1 } } },
    ]),
    PointRecordModel.aggregate<{ _id: string; earned: number; exchanged: number; expired: number }>([
      { $match: { bizDate: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: '$bizDate',
          earned: { $sum: { $cond: [{ $gt: ['$delta', 0] }, '$delta', 0] } },
          exchanged: { $sum: { $cond: [{ $eq: ['$type', 'exchange'] }, { $multiply: ['$delta', -1] }, 0] } },
          expired: { $sum: { $cond: [{ $eq: ['$type', 'expire'] }, { $multiply: ['$delta', -1] }, 0] } },
        },
      },
    ]),
  ]);

  for (const r of signins) {
    const b = byDate.get(r._id.d);
    if (!b) continue;
    if (r._id.s === 'makeup') b.makeupUsers = r.n; else b.signinUsers = r.n;
  }
  for (const r of records) {
    const b = byDate.get(r._id);
    if (b) Object.assign(b, { earned: r.earned, exchanged: r.exchanged, expired: r.expired });
  }
  return { days, data: buckets };
}
