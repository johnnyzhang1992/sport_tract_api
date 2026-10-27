/**
 * 管理端积分概况与趋势（spec §6.5/§6.6/§7.1）。
 *
 * 口径（§6.5，一条都不能改）：
 * - 一律从 `PointRecord` 按 `type` 聚合，**不读 `PointAccount.totalSpent`**：`debitPoints`
 *   把兑换与撤回都记进同一个 totalSpent（points-ledger.ts:264），拿它当「消耗」会把撤回算成花钱；
 *   过期回收更是只减 `balance`、完全不进 totalSpent（points-ledger.ts:141-164），两处口径都不对。
 *   所以概况 DTO 不下发 totalSpent（避免前端误用），「不能当消耗用」的证据由 AS-1 直接读 PointAccount 断言；
 * - 不变式：`balance == earnedGross - rolledBack - spentExchange - spentExpire`。
 *   等式右边只列了三族负 delta，所以负 delta 的类型集合也被 AS-2 钉住；
 * - 趋势桶键直接比对库里的东八区 `YYYY-MM-DD`（`dateKey` / `bizDate`），不走 `$dateToString`，
 *   缺日补 0，桶数恒等于窗口大小。
 */
import type { PipelineStage } from 'mongoose';
import {
  PointAccountModel, PointCardModel, PointItemModel, PointRecordModel, PointSigninModel,
} from '../models/point.model.js';
import { AppError } from '../utils/app-error.js';
import { bjDateStr } from '../utils/bj-time.js';
import { shiftDateKey } from '../utils/points-domain.js';
import { adFreeRoster } from './points-roster.js';

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

/** 道具概况的来源白名单：与 spec §6.4 的三来源一致（顺序就是后台三个指标格的顺序） */
const ISSUED_SOURCES = ['exchange', 'admin', 'system'] as const;
export type IssuedSource = typeof ISSUED_SOURCES[number];

export interface ItemsOverviewSourceRow {
  source: IssuedSource;
  count: number;
}

export interface ItemsOverviewItemRow {
  itemKey: string;
  itemName: string;
  count: number;
}

/** 道具概况（GET /points/items/overview，spec §7.2） */
export interface ItemsOverview {
  /** 发放总数：PointCard 全量（三来源都算） */
  totalIssued: number;
  /** 按来源拆；恒为三行（没有的档补 0），相加必须等于 totalIssued（RS-4） */
  bySource: ItemsOverviewSourceRow[];
  /** 按道具拆；只列有卡的道具，itemName 跟目录当前名称走 */
  byItem: ItemsOverviewItemRow[];
  /** 累计消耗积分：Σ PointRecord 的 |exchange delta|（§6.5 口径，不另立 PointExchange.cost 事实源） */
  totalSpentPoints: number;
  /** 生效中免广告人数：与名单同一份 replayAdFree 推导，长度等于当天名单行数 */
  adFreeUsers: number;
}

/**
 * 道具概况六格（发/兑换/手动/系统/消耗/免广告人数）。
 * - 发放总数与来源分档来自 PointCard `$group`：老卡物理缺 source 时先 `$ifNull` 成 exchange
 *   再分组（与发放记录 GR-6 同口径，先筛后补会漏掉全部 10-27 之前的行）；
 * - bySource 固定三行、总数取全部来源分组之和 —— 若库里出现第四种 source，两者不相等，
 *   RS-4 会直接红（与 AS-2「未登记负 delta 类型」同一种防静默失真）；
 * - 按道具拆在 JS 里 join 目录（`$lookup` 的集合名一旦写错在共享库上是静默空表）；
 * - 免广告人数直接取 `adFreeRoster` 的长度：它是「当天有效名单」的唯一出口，
 *   指标格与导出的行数必须一字不差（不许在概况里再写一份到期推导）。
 */
export async function itemsOverview(now = Date.now()): Promise<ItemsOverview> {
  const [sourceRows, itemRows, [sums], roster] = await Promise.all([
    PointCardModel.aggregate<{ _id: string; count: number }>([
      { $addFields: { source: { $ifNull: ['$source', 'exchange'] } } },
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ]),
    PointCardModel.aggregate<{ _id: string; count: number }>([
      // 存量卡若缺 itemKey，按 schema 默认值当补签卡（与读取侧 `?? 'makeup_card'` 同口径）
      { $addFields: { itemKey: { $ifNull: ['$itemKey', 'makeup_card'] } } },
      { $group: { _id: '$itemKey', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
    ]),
    PointRecordModel.aggregate<RecordSums>(RECORD_SUM_STAGES),
    adFreeRoster(now),
  ]);

  const countBySource = new Map(sourceRows.map((r) => [String(r._id), Number(r.count)]));
  const bySource: ItemsOverviewSourceRow[] = ISSUED_SOURCES.map((source) => ({
    source,
    count: countBySource.get(source) ?? 0,
  }));
  // 总数取「全部分组之和」而不是三行之和：多出未登记来源时让 RS-4 红了报出来，而不是悄悄吞掉
  const totalIssued = sourceRows.reduce((s, r) => s + Number(r.count), 0);

  const keys = itemRows.map((r) => String(r._id ?? ''));
  const items = keys.length
    ? await PointItemModel.find({ key: { $in: keys } }).select({ key: 1, name: 1 }).lean()
    : [];
  const nameOf = new Map(items.map((it) => [String(it.key), String(it.name ?? '')]));
  const byItem: ItemsOverviewItemRow[] = itemRows.map((r) => {
    const itemKey = String(r._id ?? '');
    return { itemKey, itemName: nameOf.get(itemKey) ?? '', count: Number(r.count) };
  });

  return {
    totalIssued,
    bySource,
    byItem,
    totalSpentPoints: sums?.spentExchange ?? 0,
    adFreeUsers: roster.length,
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
