import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

/** 系统通知：webAdmin 发布，小程序端内展示（纯文本，保留换行） */
const notificationSchema = new Schema(
  {
    title: { type: String, required: true },
    content: { type: String, required: true },
    published: { type: Boolean, default: false },
    publishedAt: { type: Number, default: null },
  },
  { timestamps: true, versionKey: false },
);

notificationSchema.index({ published: 1, publishedAt: -1 });

export type Notification = mongoose.InferSchemaType<typeof notificationSchema>;
export const NotificationModel = models.Notification ?? model('Notification', notificationSchema);
