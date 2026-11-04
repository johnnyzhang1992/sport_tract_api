import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

/**
 * 订阅消息投递台账：一条 dedupeKey 只发一次（唯一索引）。
 * channel：wechat＝微信服务通知；inapp＝微信发不出去时的站内通知兜底。
 */
const subscribeMessageLogSchema = new Schema(
  {
    dedupeKey: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    templateKey: { type: String, required: true },
    channel: { type: String, enum: ['wechat', 'inapp'], required: true },
    status: { type: String, enum: ['sending', 'sent', 'failed'], required: true },
    errcode: { type: Number, default: null },
    errmsg: { type: String, default: '' },
    createdAt: { type: Number, required: true },
  },
  { versionKey: false },
);

subscribeMessageLogSchema.index({ userId: 1, createdAt: -1 });

export const SubscribeMessageLogModel = models.SubscribeMessageLog
  ?? model('SubscribeMessageLog', subscribeMessageLogSchema, 'subscribe_message_logs');
