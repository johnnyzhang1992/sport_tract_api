import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

/**
 * 运动计划：一个用户一份（uid 唯一），周期每天/每周二选一；
 * 三项目标（距离米/时长分钟/次数），完成度按所选周期的已完成轨迹实时聚合（见 services/exercise-plan.ts）。
 */
const exercisePlanSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, unique: true },
    period: { type: String, enum: ['daily', 'weekly'], required: true },
    targets: {
      distanceM: { type: Number, default: 0 }, // 目标距离（米）
      durationMin: { type: Number, default: 0 }, // 目标时长（分钟）
      count: { type: Number, default: 0 }, // 目标次数
    },
  },
  { timestamps: true, versionKey: false },
);

export const ExercisePlanModel = models.ExercisePlan ?? model('ExercisePlan', exercisePlanSchema);
