export const POINTS = {
  SIGNIN_MAX: 7,
  DAILY_CAP: 100,
  MAKEUP_CARD_PRICE: 200,
  MAKEUP_CARD_VALID_DAYS: 30,
  VIDEO_REWARD: 5,
  /** 补签段长上限（天）：窗口内未签段超过该值不可补。7 = 窗口本身的大小，等于"窗口内全部可补"
   *  （2026-10-25 用户拍板放宽；产品要收紧只改这个数字）。窗口内没有任何已签行时仍然不可补——
   *  补签只能接在已有记录上，新用户不能凭卡从零买连签 */
  MAX_MAKEUP_GAP_DAYS: 7,
} as const;

export const POINT_TASKS = {
  newbie_profile: { title: '完善头像和昵称', points: 5, period: 'once', claim: 'manual' },
  newbie_first_activity: { title: '首次完成运动', points: 10, period: 'once', claim: 'manual' },
  newbie_first_import: { title: '首次导入轨迹', points: 5, period: 'once', claim: 'manual' },
  daily_activity: { title: '运动记录', points: 1, period: 'daily', claim: 'manual' },
  // claim='manual'：发分走显式 claim 接口。流量主激励视频没有服务端验签接口可接，
  // "看完才发分"只能信任客户端 onClose(isEnded)——刷分风险（现在 5 分 × 3 次/天/号）是接受的资损上限
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
