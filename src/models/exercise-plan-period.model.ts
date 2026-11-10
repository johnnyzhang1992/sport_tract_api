import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

/**
 * 运动计划周期快照（2026-11-10）：每个用户每个周期（每天/每周）一条。
 * 为什么要落库：完成度本身是实时聚合算出来的（见 services/exercise-plan.ts），
 * 没有历史表就查不到「上周完成率」「连续达成 N 天」。周期结束后把当时的
 * 目标 + 完成值冻结成一条快照，历史查询页与后续的达成统计都读这里。
 *
 * 幂等：{ userId, period, periodKey } 唯一索引，重复结算不会写两条。
 */
const exercisePlanPeriodSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    /** daily=每天、weekly=每周 */
    period: { type: String, enum: ['daily', 'weekly'], required: true },
    /** 周期键：daily=该日 YYYY-MM-DD；weekly=该周周一 YYYY-MM-DD（东八区） */
    periodKey: { type: String, required: true },
    /** 窗口 [windowStart, windowEnd)（epoch ms，东八区零点对齐） */
    windowStart: { type: Number, required: true },
    windowEnd: { type: Number, required: true },
    /** 该周期结束时的目标（快照，之后改计划不影响历史） */
    targets: {
      distanceM: { type: Number, default: 0 },
      durationMin: { type: Number, default: 0 },
      count: { type: Number, default: 0 },
    },
    /** 该周期最终完成值 */
    progress: {
      distanceM: { type: Number, default: 0 },
      durationSec: { type: Number, default: 0 },
      count: { type: Number, default: 0 },
    },
    /** 三项是否各自达成（目标>0 且 完成>=目标）；allAchieved=三项全部达成 */
    achieved: {
      distance: { type: Boolean, default: false },
      duration: { type: Boolean, default: false },
      count: { type: Boolean, default: false },
    },
    allAchieved: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false },
);

// 一个用户一个周期只有一条；历史查询按用户 + 周期倒序翻页也走这条
exercisePlanPeriodSchema.index({ userId: 1, period: 1, periodKey: 1 }, { unique: true });
exercisePlanPeriodSchema.index({ userId: 1, windowStart: -1 });

export const ExercisePlanPeriodModel =
  models.ExercisePlanPeriod ?? model('ExercisePlanPeriod', exercisePlanPeriodSchema);
