import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

/**
 * 微信运动步数（按天）：/werun/sync 解密 stepInfoList 后逐日落库。
 * (userId, date) 唯一——微信按天给总量，重同步直接覆盖（后到的大口径为准，不做增量）。
 * date 是东八区 YYYY-MM-DD：微信 timestamp 是当天零点（北京时区），映射见 services/werun.ts。
 */
const werunDaySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    date: { type: String, required: true }, // 东八区 YYYY-MM-DD
    step: { type: Number, required: true, min: 0 },
    syncedAt: { type: Number, default: () => Date.now() }, // 最近一次同步时间戳
  },
  { versionKey: false },
);

// 唯一索引兜底并发双写；userId 单列索引服务「某用户全部步数」查询
werunDaySchema.index({ userId: 1, date: 1 }, { unique: true });
werunDaySchema.index({ userId: 1, date: -1 });
// 步数榜按「日期区间」聚合（不带 userId 等值），上面两条 {userId,date} 帮不上忙
werunDaySchema.index({ date: 1, userId: 1 });

export type WerunDay = { userId: unknown; date: string; step: number; syncedAt: number };

export const WerunDayModel = models.WerunDay ?? model('WerunDay', werunDaySchema);
