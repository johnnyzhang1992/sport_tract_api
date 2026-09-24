/**
 * 业务常量：运动类型、打点类型、MET 系数等
 * 类型配置化（决策 D7），新增类型只需在此扩展
 */

export const ACTIVITY_TYPES = [
  'hiking',
  'walking',
  'running',
  'cycling',
  'mountaineering',
  'swimming',
  'skiing',
  'rowing',
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const MARKER_TYPES = ['checkpoint', 'rest', 'photo', 'note'] as const;
export type MarkerType = (typeof MARKER_TYPES)[number];

export const ACTIVITY_STATUS = ['in_progress', 'finished', 'cancelled'] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUS)[number];

/** 运动类型元数据（前端 icon/文案与后端 MET 系数共用同一份心智模型） */
export interface ActivityTypeMeta {
  type: ActivityType;
  label: string;
  /** 代谢当量，卡路里估算用 kcal = MET * 体重(kg) * 时长(h) */
  met: number;
}

export const ACTIVITY_TYPE_META: Record<ActivityType, ActivityTypeMeta> = {
  hiking: { type: 'hiking', label: '徒步', met: 4.3 },
  walking: { type: 'walking', label: '散步', met: 3.5 },
  running: { type: 'running', label: '跑步', met: 9.8 },
  cycling: { type: 'cycling', label: '骑行', met: 7.5 },
  mountaineering: { type: 'mountaineering', label: '登山', met: 8.0 },
  swimming: { type: 'swimming', label: '游泳', met: 8.0 },
  skiing: { type: 'skiing', label: '滑雪', met: 6.0 },
  rowing: { type: 'rowing', label: '划船', met: 7.0 },
};

/** 轨迹点数组保护上限（超出提示客户端抽稀） */
export const MAX_TRACK_POINTS = 20_000;

/**
 * 有效运动最小距离（米）：finish/惰性清理重算距离低于该值视为无效运动
 * （原地不动结束、GPS 漂移点全被过滤），自动作废（cancelled）不产生 finished 记录，
 * 避免距离为 0 的"无意义轨迹"污染列表与统计
 */
export const MIN_EFFECTIVE_DISTANCE_M = 10;

/**
 * 有效运动最小轨迹点数：少于该值无法构成轨迹（单点无位移，两点只是直线段，
 * GPS 长时间丢点时会画出假直线），即使距离达标也作废
 */
export const MIN_EFFECTIVE_POINTS = 3;

/**
 * 可信配速下限（秒/公里）：男子 1000m 世界纪录 2'11"05 ≈ 131 s/km，比这还快的"最快 1km"
 * 只可能是 GPS 漂移或把乘车段算成了运动量（线上实测过一条 5.95km 轨迹里的 2.76km 车速段
 * 刷出 3'41" 并占了全国榜第一）。纪录榜与个人最佳按此过滤，不把不可能的数字当纪录挂着；
 * 轨迹详情照实显示，不做隐藏。
 */
export const MIN_PLAUSIBLE_PACE_SEC_PER_KM = 130;

/**
 * 档案缺失时的兜底体重（kg）：卡路里 = MET × 体重 × 小时，必须有个体重才能算。
 * 正常路径取 user.weightKg（user.model 的 default 就是这个值），只有查不到用户文档才会用到这里。
 */
export const DEFAULT_WEIGHT_KG = 60;

/** 列表分页默认值 */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
