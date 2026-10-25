export const POINTS = {
  SIGNIN_MAX: 7,
  DAILY_CAP: 100,
  MAKEUP_CARD_PRICE: 200,
  MAKEUP_CARD_VALID_DAYS: 30,
  VIDEO_REWARD: 5,
} as const;

export const POINT_TASKS = {
  newbie_profile: { title: '完善头像和昵称', points: 5, period: 'once', claim: 'manual' },
  newbie_first_activity: { title: '首次完成运动', points: 10, period: 'once', claim: 'manual' },
  newbie_first_import: { title: '首次导入轨迹', points: 5, period: 'once', claim: 'manual' },
  daily_activity: { title: '运动记录', points: 1, period: 'daily', claim: 'manual' },
  daily_video: { title: '观看广告视频', points: POINTS.VIDEO_REWARD, period: 'daily', claim: 'auto' },
} as const;

export type TaskKey = keyof typeof POINT_TASKS;
