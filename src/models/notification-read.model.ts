import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

/** 一行 = 某用户读过某条通知；唯一复合索引保证重复上报不增生 */
const notificationReadSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    notificationId: { type: Schema.Types.ObjectId, ref: 'Notification', required: true },
    readAt: { type: Number, required: true },
  },
  { versionKey: false },
);

notificationReadSchema.index({ userId: 1, notificationId: 1 }, { unique: true });

export type NotificationRead = mongoose.InferSchemaType<typeof notificationReadSchema>;
export const NotificationReadModel =
  models.NotificationRead ?? model('NotificationRead', notificationReadSchema);
