/**
 * 运动徽章配置（2026-11-16 配置化，docs/21 的落地版）
 *
 * ⚠️ 这是徽章体系的**唯一事实来源**。新增/调整徽章只改这里（+ 必要时在
 * `BADGE_KEY_RULES` 里加一条解锁规则），下面这些消费方都会自动跟上，不需要再改：
 *   - exercise-plan.ts   getPlanSummary 的解锁态/获得次数/获得日期
 *   - trophy-rank.ts     「第 N 位迹路者」的解锁日期与排名
 *   - 小程序 plan-history 的卡面（名称/形状/分组）与详情半屏文案
 *     —— 展示元数据由 /plan/summary 直接下发，前端不再有写死的映射表
 *
 * 加徽章的两种情形：
 *   1) 同一系列加档位（最常见）：往对应 `tiers` 数组里加数字即可。
 *   2) 全新系列：加一个 series（含 key 前缀、指标、解锁规则、展示元数据），
 *      并在 `earnKindOf` 覆盖的 EarnKind 里补对应算法（trophy-earn.ts）。
 */
/**
 * 徽章大类（2026-11-16）：决定「在哪个页面展示」。
 *   plan  = 运动计划类——解锁依赖计划周期快照（里程碑/合环/完美周），计划页只展示这类
 *   data  = 运动数据类——只看轨迹本身（新纪录/最坚持/累计/分类型），在「我的徽章」页展示
 */
export type BadgeCategory = 'plan' | 'data';

/** 徽章分组：决定卡片上的分区标题与分区顺序 */
export type BadgeGroup =
  | 'plan'            // 里程碑（原 8 个倍数里程碑，特殊：计数来自周期倍数）
  | 'streak'          // 最坚持
  | 'rings'           // 合上圆环
  | 'total-distance'  // 累计里程
  | 'total-duration'  // 累计时长
  | 'week'            // 完美周
  | 'activity-type';  // 分运动类型（跑步/骑行…的距离/时长/次数）

/** 徽章计数口径（决定 cur 从哪来） */
export type BadgeMetric =
  | 'streakBest'
  | 'ringsClosed'
  | 'totalDistanceKm'
  | 'totalDurationHour'
  | 'perfectWeekAll'
  | 'perfectWeekDistance'
  | 'perfectWeekDuration'
  | 'perfectWeekCount'
  | 'achieved'
  /** 分运动类型的三类累计（见 ActivityTypeSeries，metric 由类型动态拼出） */
  | 'typeDistanceKm'
  | 'typeDurationHour'
  | 'typeCount';

/**
 * 解锁日期算法类型（决定「哪天解锁的」怎么算，名次排名依赖它）：
 *   streak    连续天数第一次达到 N 的那天
 *   rings     第 N 个三项全达成日快照
 *   cumulative 累计量第一次跨过阈值的当天（阈值单位见 series.unit）
 *   perfectWeek 首个合格自然周的最后一天
 *   milestone 原 8 倍数里程碑：计数跨过门槛那个周期的最后一天
 */
export type EarnKind =
  | 'streak'
  | 'rings'
  | 'cumulative'
  | 'perfectWeek'
  | 'milestone'
  /** 某运动类型的累计量跨过阈值（距离 km / 时长 h / 次数） */
  | 'typeCumulative';

/** 徽章形状（前端据 shape 取对应的 CSS class，新增形状需在前端 .wxss 补一条 b-<shape>） */
export type BadgeShape =
  | 'plan'        // 圆牌（里程碑，中央印次数档位）
  | 'dist'        // 盾牌（距离纪录）
  | 'dur'         // 六边形（时长纪录）
  | 'streak'      // 六边形（坚持）
  | 'ring'        // 圆环（合环）
  | 'total-dist'  // 方牌（累计里程）
  | 'total-dur'   // 表盘（累计时长）
  | 'week-all'    // 完美周·全能
  | 'week-distance'
  | 'week-duration'
  | 'week-count';

/** 详情半屏的一句话进度文案模板：{cur} 当前值、{tier} 档位、{valueText} 后端算好的展示值 */
export interface BadgeDetailRule {
  /** 已获得时的文案，如 '已刷新距离纪录 {cur} 次' */
  earned: string;
  /** 未获得时的文案，如 '还差 {remain} 次刷新距离纪录' */
  locked?: string;
}

/** 一个徽章系列（同系列共享指标/解锁规则/展示语言，各档位各自一座） */
export interface BadgeSeries {
  /** key 前缀，最终 key = `${prefix}-${tier}` */
  prefix: string;
  /**
   * 显式 key（仅当 key 不是 `${prefix}-${tier}` 形式时使用，如完美周的 perfect-week-all）。
   * 与 tiers 一一对应；给了就以它为准。
   */
  keys?: readonly string[];
  group: BadgeGroup;
  metric: BadgeMetric;
  earnKind: EarnKind;
  /** 档位阶梯（每档一座徽章）；顺序即前端展示顺序 */
  tiers: readonly number[];
  /** 徽章中央文字：默认印档位数；固定文案系列（完美周）用固定值 */
  icon: string;
  /** 卡面短名（前端卡面直接显示这个） */
  shortLabel: string;
  shape: BadgeShape;
  /** 长名称（详情半屏标题） */
  label: (tier: number) => string;
  /** 说明（详情半屏描述） */
  desc: (tier: number) => string;
  /** 获得/未获得时的进度文案；缺省用「已达成 {cur} 次 · 目标 {tier} 次」 */
  detail?: BadgeDetailRule;
  /**
   * 累计类阈值的单位换算：计数以「公里/小时」计，阈值按 1 计。
   * 仅 cumulative 需指定，用于说明文案（默认 '公里'）
   */
  unit?: string;
  /** 徽章中央文字覆盖（不填则印档位数字） */
  badgeText?: string;
  /** 是否可重复获得（完美周：次数 = 合格周数） */
  repeatable?: boolean;
  /**
   * 按运动类型族展开（分运动类型徽章）：给了就为每个类型各生成一套，
   * key 形如 `run-dist-100`；metric 由 metricByType 决定。
   */
  types?: readonly ActivityBadgeType[];
  /** 类型族里的指标（仅 types 存在时使用） */
  metricByType?: 'typeDistanceKm' | 'typeDurationHour' | 'typeCount';
}

/** 支持做专属徽章的运动类型（主力 5 类；其余类型先不做，避免徽章爆炸） */
export const ACTIVITY_BADGE_TYPES = ['walking', 'running', 'hiking', 'cycling', 'mountaineering'] as const;
export type ActivityBadgeType = (typeof ACTIVITY_BADGE_TYPES)[number];

/** 各运动类型的徽章命名与 key 前缀 */
export const ACTIVITY_BADGE_META: Record<
  ActivityBadgeType,
  { prefix: string; label: string; unit: string; iconId: string }
> = {
  // iconId 对应小程序 assets/icons/activity-<id>.png（深色版）与 activity-<id>-white.png（浅色版）
  walking: { prefix: 'walk', label: '散步', unit: '公里', iconId: 'walking' },
  running: { prefix: 'run', label: '跑步', unit: '公里', iconId: 'running' },
  hiking: { prefix: 'hike', label: '徒步', unit: '公里', iconId: 'hiking' },
  cycling: { prefix: 'ride', label: '骑行', unit: '公里', iconId: 'cycling' },
  mountaineering: { prefix: 'climb', label: '爬山', unit: '公里', iconId: 'mountaineering' },
};

/** 分类型徽章的档位（按运动类型差别定价：骑行/爬山距离增量大，档位更高） */
export const ACTIVITY_TIER_PRESETS = {
  /**
   * 距离（公里）：2026-11-16 调整——去掉 50 档（太容易拿、跟「首次」没区别），
   * 加上 1000 / 2000 / 5000 / 10000 四个长线档。
   * 各类型起步档不同（骑行/爬山刷得更快，起点更高），所以分类型各自给数组。
   */
  distance: {
    // 2026-11-16：去掉 50 档，**保留 100 档**，新增 1000/2000/5000/10000
    running: [100, 500, 1000, 2000, 5000, 10000],
    walking: [100, 500, 1000, 2000, 5000, 10000],
    hiking: [100, 500, 1000, 2000, 5000, 10000],
    cycling: [100, 500, 1000, 2000, 5000, 10000],
    mountaineering: [100, 500, 1000, 2000, 5000, 10000],
  },
  /** 时长（小时）：去掉 50 档、**保留 100 档**，加 200 / 500 */
  duration: [10, 100, 200, 500],
  /** 次数：加 200 / 500 / 1000 */
  count: [10, 50, 100, 200, 500, 1000],
} as const;

/** 原 8 个倍数里程碑（group='plan'）：计数来自周期完成倍数，不走 series 阶梯逻辑 */
export interface MilestoneDef {
  key: string;
  label: string;
  desc: string;
  icon: string;
  /** 需要的最低完成倍数（1=达成目标，2=200%…） */
  ratio: number;
  /** 需要达到该倍数的周期次数 */
  times: number;
  shortLabel: string;
  shape: BadgeShape;
}

/** 分组标题与展示顺序（前端分区标题由服务端下发，不再前端写死） */
export const BADGE_GROUPS: ReadonlyArray<{
  key: BadgeGroup;
  title: string;
  /** 所属大类：plan 分组只出现在计划页，data 分组只出现在我的徽章页 */
  category: BadgeCategory;
}> = [
  { key: 'plan', title: '里程碑', category: 'plan' },
  { key: 'rings', title: '合上圆环', category: 'plan' },
  { key: 'week', title: '完美周', category: 'plan' },
  { key: 'streak', title: '最坚持', category: 'data' },
  { key: 'total-distance', title: '累计里程', category: 'data' },
  { key: 'total-duration', title: '累计时长', category: 'data' },
  { key: 'activity-type', title: '分运动类型', category: 'data' },
];

/** 档位阶梯：调这里就调整了对应系列的全部徽章（加档位 = 加一座徽章） */
export const BADGE_TIERS = {
  /**
   * 次数类（新纪录距离/时长、最坚持、合上圆环 共用）：100 / 365 / 500 / 1000。
   * ⚠️ 2026-11-16 去掉了 2000 档：这三类都是「每天最多累计一次」的硬约束
   * （破纪录要天天新高、连续天数要天天运动、合环要天天三项全达成），
   * 2000 次等价于连续 2000 天不中断，实际不可达，放在墙上只是摆设。
   * 三个系列口径一致，所以合成这一个数组，调整时只改这里。
   */
  count: [100, 365, 500, 1000] as const,
  /** 累计里程（公里）：单项累积，没有「每天一次」的约束，档位可以拉长 */
  totalKm: [100, 500, 1000, 2000, 5000, 10000] as const,
  /** 累计时长（小时） */
  totalHour: [10, 50, 100, 200, 500, 1000] as const,
};

/** 倍数里程碑档位（ratio → 该档周期计数）；新加倍数档时同步 MILESTONES */
export const RATIO_TIERS = [1, 2, 3, 4, 5] as const;

/** 原 8 个倍数里程碑 */
export const MILESTONES: readonly MilestoneDef[] = [
  { key: 'first', label: '首次达成', desc: '完成 1 次目标', ratio: 1, times: 1, shortLabel: '首次达成', shape: 'plan', icon: '🥇' },
  { key: 'week', label: '坚持一周', desc: '达成 7 次', ratio: 1, times: 7, shortLabel: '坚持一周', shape: 'plan', icon: '📅' },
  { key: 'habit', label: '习惯养成', desc: '达成 20 次', ratio: 1, times: 20, shortLabel: '习惯养成', shape: 'plan', icon: '💪' },
  { key: 'x2', label: '200%完成目标', desc: '单周期完成倍数达到 200% 即可获得', ratio: 2, times: 1, shortLabel: '200%完成目标', shape: 'plan', icon: '🔥' },
  { key: 'x3', label: '300%完成目标', desc: '单周期完成倍数达到 300% 即可获得', ratio: 3, times: 1, shortLabel: '300%完成目标', shape: 'plan', icon: '👑' },
  { key: 'x4', label: '400%完成目标', desc: '单周期完成倍数达到 400% 即可获得', ratio: 4, times: 1, shortLabel: '400%完成目标', shape: 'plan', icon: '🚀' },
  { key: 'x5', label: '500%完成目标', desc: '单周期完成倍数达到 500% 即可获得', ratio: 5, times: 1, shortLabel: '500%完成目标', shape: 'plan', icon: '🏆' },
];

/** 徽章系列（每个 tiers 项展开成一座独立徽章） */
export const BADGE_SERIES: readonly BadgeSeries[] = [
  {
    prefix: 'streak',
    group: 'streak',
    metric: 'streakBest',
    earnKind: 'streak',
    tiers: BADGE_TIERS.count,
    icon: '🔥',
    shortLabel: '最坚持',
    shape: 'streak',
    label: (t) => `最坚持·连续${t}天`,
    desc: (t) => `连续 ${t} 天每天都有运动记录`,
    detail: { earned: '最长连续运动 {cur} 天', locked: '还差 {remain} 天连续运动' },
  },
  {
    prefix: 'ring',
    group: 'rings',
    metric: 'ringsClosed',
    earnKind: 'rings',
    tiers: BADGE_TIERS.count,
    icon: '⭕',
    shortLabel: '合上圆环',
    shape: 'ring',
    label: (t) => `合上圆环·${t}次`,
    desc: (t) => `三圆环全合（当日三项目标全部达成）累计 ${t} 次`,
    detail: { earned: '已合上圆环 {cur} 次', locked: '还差 {remain} 次合上圆环' },
  },
  {
    prefix: 'total-dist',
    group: 'total-distance',
    metric: 'totalDistanceKm',
    earnKind: 'cumulative',
    tiers: BADGE_TIERS.totalKm,
    icon: '📏',
    shortLabel: '累计里程',
    shape: 'total-dist',
    label: (t) => `累计里程·${t}km`,
    desc: (t) => `累计运动里程达到 ${t} 公里`,
    detail: { earned: '已累计 {valueText}', locked: '还差 {remain} 公里' },
    unit: '公里',
  },
  {
    prefix: 'total-dur',
    group: 'total-duration',
    metric: 'totalDurationHour',
    earnKind: 'cumulative',
    tiers: BADGE_TIERS.totalHour,
    icon: '⏱️',
    shortLabel: '累计时长',
    shape: 'total-dur',
    label: (t) => `累计时长·${t}小时`,
    desc: (t) => `累计运动时长达到 ${t} 小时`,
    detail: { earned: '已累计 {valueText}', locked: '还差 {remain} 小时' },
    unit: '小时',
  },
  // 完美周：可重复获得（次数 = 合格自然周数），每座阈值恒 1（拿到首个即解锁）
  {
    prefix: 'perfect-week',
    keys: ['perfect-week-all'],
    group: 'week',
    metric: 'perfectWeekAll',
    earnKind: 'perfectWeek',
    tiers: [1],
    icon: '🌟',
    shortLabel: '完美周·全能',
    shape: 'week-all',
    label: () => '完美周·全能',
    desc: () => '一个自然周（周一至周日）里，七天都达成全部目标',
    detail: { earned: '已获得 {cur} 个完美周', locked: '还差一个七天全达成的自然周' },
    badgeText: '🌟',
    repeatable: true,
  },
  {
    prefix: 'perfect-week-distance',
    keys: ['perfect-week-distance'],
    group: 'week',
    metric: 'perfectWeekDistance',
    earnKind: 'perfectWeek',
    tiers: [1],
    icon: '📏',
    shortLabel: '完美周·距离',
    shape: 'week-distance',
    label: () => '完美周·距离',
    desc: () => '一个自然周（周一至周日）里，七天都达成距离目标',
    detail: { earned: '已获得 {cur} 个距离完美周', locked: '还差一个七天全达成距离目标的自然周' },
    badgeText: '📏',
    repeatable: true,
  },
  {
    prefix: 'perfect-week-duration',
    keys: ['perfect-week-duration'],
    group: 'week',
    metric: 'perfectWeekDuration',
    earnKind: 'perfectWeek',
    tiers: [1],
    icon: '⏱️',
    shortLabel: '完美周·时长',
    shape: 'week-duration',
    label: () => '完美周·时长',
    desc: () => '一个自然周里，七天都达成时长目标',
    detail: { earned: '已获得 {cur} 个时长完美周', locked: '还差一个七天全达成时长目标的自然周' },
    badgeText: '⏱️',
    repeatable: true,
  },
  {
    prefix: 'perfect-week-count',
    keys: ['perfect-week-count'],
    group: 'week',
    metric: 'perfectWeekCount',
    earnKind: 'perfectWeek',
    tiers: [1],
    icon: '🔢',
    shortLabel: '完美周·次数',
    shape: 'week-count',
    label: () => '完美周·次数',
    desc: () => '一个自然周里，七天都达成次数目标',
    detail: { earned: '已获得 {cur} 个次数完美周', locked: '还差一个七天全达成次数目标的自然周' },
    badgeText: '🔢',
    repeatable: true,
  },

  /* ── 分运动类型（2026-11-16）：5 个主力类型 × 距离/时长/次数，按类型族展开 ── */
  {
    prefix: 'type-dist',
    group: 'activity-type',
    metric: 'typeDistanceKm',
    metricByType: 'typeDistanceKm',
    earnKind: 'typeCumulative',
    tiers: ACTIVITY_TIER_PRESETS.distance.running,
    types: ACTIVITY_BADGE_TYPES,
    icon: '📍',
    shortLabel: '类型里程',
    shape: 'dist',
    label: (t) => `累计里程·${t}km`,
    desc: (t) => `累计里程达到 ${t} 公里`,
    detail: { earned: '已累计 {valueText}', locked: '还差 {remain} 公里' },
  },
  {
    prefix: 'type-dur',
    group: 'activity-type',
    metric: 'typeDurationHour',
    metricByType: 'typeDurationHour',
    earnKind: 'typeCumulative',
    tiers: ACTIVITY_TIER_PRESETS.duration,
    types: ACTIVITY_BADGE_TYPES,
    icon: '⏱️',
    shortLabel: '类型时长',
    shape: 'dur',
    label: (t) => `累计时长·${t}小时`,
    desc: (t) => `累计时长达到 ${t} 小时`,
    detail: { earned: '已累计 {valueText}', locked: '还差 {remain} 小时' },
  },
  {
    prefix: 'type-count',
    group: 'activity-type',
    metric: 'typeCount',
    metricByType: 'typeCount',
    earnKind: 'typeCumulative',
    tiers: ACTIVITY_TIER_PRESETS.count,
    types: ACTIVITY_BADGE_TYPES,
    icon: '🔢',
    shortLabel: '类型次数',
    shape: 'ring',
    label: (t) => `运动次数·${t}次`,
    desc: (t) => `累计运动 ${t} 次`,
    detail: { earned: '已完成 {cur} 次', locked: '还差 {remain} 次' },
  },
]
/** 展开后的一座徽章（series + tier） */
export interface BadgeDef {
  key: string;
  group: BadgeGroup;
  metric: BadgeMetric;
  earnKind: EarnKind;
  tier: number;
  icon: string;
  shortLabel: string;
  shape: BadgeShape;
  label: string;
  desc: string;
  detail?: BadgeDetailRule;
  unit?: string;
  badgeText?: string;
  repeatable: boolean;
  /** 徽章中央文字（不填则印档位数字；'plan' 形状始终印档位） */
  centerText: string;
  /** 分运动类型徽章属于哪个类型（普通徽章为空） */
  activityType?: ActivityBadgeType;
  /** 卡面显示用的运动类型名（分类型徽章才有，如「跑步」） */
  activityLabel?: string;
  /** 运动类型图标 id（对应小程序 activity-<id>.png），分类型徽章才有 */
  activityIconId?: string;
}

/** 由 series × tiers 展开出的全部徽章（不含原 8 倍数里程碑） */
/** 把「按类型分档」的系列补足每档阈值（types 系列允许各类型档位不同） */
function tiersOfType(series: BadgeSeries, type: ActivityBadgeType): readonly number[] {
  if (series.metricByType === 'typeDistanceKm') {
    const preset = ACTIVITY_TIER_PRESETS.distance[type as keyof typeof ACTIVITY_TIER_PRESETS.distance];
    return preset || series.tiers;
  }
  return series.tiers;
}

export const BADGE_DEFS: readonly BadgeDef[] = BADGE_SERIES.flatMap((s) => {
  // 分运动类型：每个类型各生成一套（key 前缀换成该类型的 walk-/run-/…）
  if (s.types && s.types.length) {
    return s.types.flatMap((type) => {
      const meta = ACTIVITY_BADGE_META[type];
      const tiers = tiersOfType(s, type);
      return tiers.map((t) => ({
        key: `${meta.prefix}-${s.prefix.replace('type-', '')}-${t}`,
        group: s.group,
        metric: (s.metricByType || s.metric) as BadgeMetric,
        earnKind: s.earnKind,
        tier: t,
        icon: s.icon,
        // 卡面短名带上类型，如「跑步里程」
        shortLabel: `${meta.label}${s.shortLabel.replace('类型', '')}`,
        shape: s.shape,
        label: `${meta.label}·${s.label(t)}`,
        desc: `「${meta.label}」${s.desc(t)}`,
        detail: s.detail,
        unit: meta.unit,
        badgeText: undefined,
        repeatable: false,
        centerText: String(t),
        activityType: type,
        activityLabel: meta.label,
        activityIconId: meta.iconId,
      }));
    });
  }
  return s.tiers.map((t, i) => ({
    key: (s.keys && s.keys[i]) || `${s.prefix}-${t}`,
    group: s.group,
    metric: s.metric,
    earnKind: s.earnKind,
    tier: t,
    icon: s.icon,
    shortLabel: s.shortLabel,
    shape: s.shape,
    label: s.label(t),
    desc: s.desc(t),
    detail: s.detail,
    unit: s.unit,
    badgeText: s.badgeText,
    repeatable: !!s.repeatable,
    centerText: s.badgeText || String(t),
  }));
});

/** 某座展开后的徽章属于哪个系列（取 tiers/nextTier 等阶梯信息用） */
export function seriesOfBadge(def: BadgeDef): BadgeSeries {
  const found = BADGE_SERIES.find((s) => {
    if (s.group !== def.group) return false;
    if (s.keys) return s.keys.includes(def.key);
    // 分类型系列：key 形如 run-dist-100；档位按「该类型自己的预设」判断
    // （骑行距离档位与其它类型不同，不能用 s.tiers 统一校验）
    if (s.types && def.activityType) {
      const meta = ACTIVITY_BADGE_META[def.activityType];
      if (!def.key.startsWith(`${meta.prefix}-`)) return false;
      return tiersOfType(s, def.activityType).includes(def.tier);
    }
    return def.key.startsWith(`${s.prefix}-`) && s.tiers.includes(def.tier);
  });
  if (!found) throw new Error(`徽章 ${def.key} 找不到所属系列（配置不一致）`);
  return found;
}

/** 分组属于哪个大类（plan 计划类 / data 运动数据类） */
export function categoryOfGroup(group: BadgeGroup): BadgeCategory {
  const g = BADGE_GROUPS.find((x) => x.key === group);
  return g ? g.category : 'data';
}

/** 按大类取分组（顺序按 BADGE_GROUPS） */
export function groupsOfCategory(category: BadgeCategory): ReadonlyArray<{ key: BadgeGroup; title: string }> {
  return BADGE_GROUPS.filter((g) => g.category === category);
}

/** 按分组取该组的展示标题 */
export function groupTitleOf(group: BadgeGroup): string {
  const g = BADGE_GROUPS.find((x) => x.key === group);
  return g ? g.title : '徽章';
}

/**
 * 某系列在某个「口径值」下已解锁的最高档位（0 = 一档都没到）。
 * 用于把「cur 计数」映射成「解锁到第几档」。
 */
export function reachedTier(tiers: readonly number[], cur: number): number {
  let reached = 0;
  for (const t of tiers) if (cur >= t) reached = t;
  return reached;
}

/**
 * 全部徽章 key（含普通系列 + 里程碑），供测试与完整性校验用。
 */
export function allBadgeKeys(): string[] {
  return [...MILESTONES.map((m) => m.key), ...BADGE_DEFS.map((d) => d.key)];
}

/** 某大类下的全部徽章（计划页只要 plan，我的徽章页要全部） */
export function badgesOfCategory(category?: BadgeCategory): BadgeDef[] {
  if (!category) return [...BADGE_DEFS];
  return BADGE_DEFS.filter((d) => categoryOfGroup(d.group) === category);
}
