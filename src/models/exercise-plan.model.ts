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
    /**
     * 周计划锚点（东八区某天 0 点，epoch ms）：从锚点起固定 7 天一期，不在期内逐日平移。
     * 新建周计划＝创建当天；存量周计划首次读取时锚到当天（见 getPlan）；每天计划为 0。
     */
    periodStart: { type: Number, default: 0 },
    targets: {
      distanceM: { type: Number, default: 0 }, // 目标距离（米）
      durationMin: { type: Number, default: 0 }, // 目标时长（分钟）
      count: { type: Number, default: 0 }, // 目标次数
    },
    /**
     * 改计划不追溯（2026-11-10）：保存新计划的瞬间，把「该周期窗口内、改动之前」的已完成进度冻结成基线。
     * 展示进度 = 基线 + 改动之后的新轨迹；改计划不会让已完成的进度倒退或跳增。
     * baselineWindowStart 是冻结时所属窗口的起点：换天/换周后窗口变了，基线自动失效（不跨周期沿用）。
     */
    baseline: {
      distanceM: { type: Number, default: 0 },
      durationSec: { type: Number, default: 0 },
      count: { type: Number, default: 0 },
    },
    baselineWindowStart: { type: Number, default: 0 },
    baselineAt: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);

export const ExercisePlanModel = models.ExercisePlan ?? model('ExercisePlan', exercisePlanSchema);
