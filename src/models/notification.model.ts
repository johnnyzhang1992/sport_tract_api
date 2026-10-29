import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

/** 系统通知：webAdmin 发布，小程序端内展示（纯文本，保留换行） */
const notificationSchema = new Schema(
  {
    title: { type: String, required: true },
    content: { type: String, required: true },
    published: { type: Boolean, default: false },
    publishedAt: { type: Number, default: null },
    /** 定向收件人（方案 A/D14：榜单结算等系统流水只发给赢家）；null/缺省＝全站广播 */
    userId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, versionKey: false },
);

notificationSchema.index({ published: 1, publishedAt: -1 });
// 用户侧读路径：{published:true, $or:[{userId:null},{userId:me}]}（含游客 {userId:null}）
// 每个 $or 分支都是 userId+published 等值前缀、publishedAt 倒序收尾；见 guard-index 自检。
notificationSchema.index({ userId: 1, published: 1, publishedAt: -1 });

export type Notification = mongoose.InferSchemaType<typeof notificationSchema>;
export const NotificationModel = models.Notification ?? model('Notification', notificationSchema);
