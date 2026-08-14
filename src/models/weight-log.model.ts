import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

/**
 * 体重记录（趋势）：每次用户保存体重且与上次不同时插入一条
 */
const weightLogSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    weightKg: { type: Number, required: true },
    createdAt: { type: Number, default: () => Date.now() }, // 时间戳
  },
  { _id: true, versionKey: false },
);

weightLogSchema.index({ userId: 1, createdAt: -1 });

export type WeightLog = { userId: unknown; weightKg: number; createdAt: number };

export const WeightLogModel = models.WeightLog ?? model('WeightLog', weightLogSchema);
