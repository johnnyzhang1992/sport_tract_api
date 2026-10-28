import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

/**
 * 广告位：webAdmin 配置，小程序按 key 取 unit-id 与开关。
 * 目前只支持模板广告（原生模板 `<ad-custom>`），kind 先固定 'template'。
 */
const adSlotSchema = new Schema(
  {
    /** 端上代码引用的稳定标识（如 home_bottom），创建后不可改 */
    key: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    /** 流量主后台的广告单元 id（adunit-xxx） */
    unitId: { type: String, required: true, trim: true },
    kind: { type: String, enum: ['template'], default: 'template' },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);

adSlotSchema.index({ active: 1, sortOrder: 1 });

export type AdSlot = mongoose.InferSchemaType<typeof adSlotSchema>;
export const AdSlotModel = models.AdSlot ?? model('AdSlot', adSlotSchema);
