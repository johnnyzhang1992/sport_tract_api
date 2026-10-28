export const POINTS = {
  SIGNIN_MAX: 7,
  DAILY_CAP: 100,
  /** 过期提醒阈值（天）：最早到期批次只剩这么多天以内才在积分页提示（2026-10-28 用户拍板 30） */
  EXPIRE_NOTICE_DAYS: 30,
  MAKEUP_CARD_VALID_DAYS: 30,
  /**
   * 补签卡**种子默认价**：只在目录行不存在时写入（`$setOnInsert`），改价走后台道具编辑，
   * 存量行不会被这个值冲掉。2026-10-28 从 200 降到 49：一张卡的收益上限是 28 分
   * （补签日 7 分 + 后面 6 天爬坡差额 21 分），200 分等于没人补得起，49 分留 21 分净回收。
   */
  MAKEUP_CARD_PRICE: 49,
  /**
   * 激励视频单次分值：2026-10-28 用户拍板 5 → 10，配合榜单发分抬累计速度；
   * 见 specs/2026-10-28-points-board-rewards-design.md
   */
  VIDEO_REWARD: 10,
  /** 补签段长上限（天）：窗口内未签段超过该值不可补。7 = 窗口本身的大小，等于"窗口内全部可补"
   *  （2026-10-25 用户拍板放宽；产品要收紧只改这个数字）。窗口内没有任何已签行时仍然不可补——
   *  补签只能接在已有记录上，新用户不能凭卡从零买连签 */
  MAX_MAKEUP_GAP_DAYS: 7,
} as const;

export const POINT_TASKS = {
  newbie_profile: { title: '完善头像和昵称', points: 5, period: 'once', claim: 'manual' },
  newbie_first_activity: { title: '首次完成运动', points: 10, period: 'once', claim: 'manual' },
  newbie_first_import: { title: '首次导入轨迹', points: 5, period: 'once', claim: 'manual' },
  // 2026-10-28 用户拍板，配合榜单发分抬累计速度（1 → 5）；见 specs/2026-10-28-points-board-rewards-design.md
  daily_activity: { title: '运动记录', points: 5, period: 'daily', claim: 'manual' },
  // claim='manual'：发分走显式 claim 接口。流量主激励视频没有服务端验签接口可接，
  // "看完才发分"只能信任客户端 onClose(isEnded)——刷分风险（现在 10 分 × 3 次/天/号）是接受的资损上限
  daily_video: {
    title: '观看广告视频',
    points: POINTS.VIDEO_REWARD,
    period: 'daily',
    claim: 'manual',
    /** 每天可领几次（2026-10-28 用户拍板 1 → 3）；periodKey 逐次记成「日期#n」，唯一键保证逐槽幂等 */
    dailyTimes: 3,
  },
} as const;

export type TaskKey = keyof typeof POINT_TASKS;
