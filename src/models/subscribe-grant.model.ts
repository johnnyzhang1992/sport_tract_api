import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

/**
 * 一次性订阅授权额度（一条授权 = 一条可发消息，按 user × template 分格）。
 * 微信不提供「剩余额度」查询，所以额度必须由我们自己记账：
 * - granted：用户点了允许，尚未消耗
 * - consumed：已用于一次成功下发
 * - invalid：下发时微信回 43101（用户拒收或额度已用完）
 */
const subscribeGrantSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    templateKey: { type: String, required: true },
    templateId: { type: String, required: true },
    scene: { type: String, default: '' },
    status: { type: String, enum: ['granted', 'consumed', 'invalid'], default: 'granted' },
    grantedAt: { type: Number, required: true },
    consumedAt: { type: Number, default: null },
    invalidReason: { type: String, default: '' },
  },
  { versionKey: false },
);

subscribeGrantSchema.index({ userId: 1, templateKey: 1, status: 1, grantedAt: 1 });

export const SubscribeGrantModel = models.SubscribeGrant
  ?? model('SubscribeGrant', subscribeGrantSchema, 'subscribe_grants');
