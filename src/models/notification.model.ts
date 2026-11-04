import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

/** 系统通知：webAdmin 发布，小程序端内展示（纯文本，保留换行） */
const notificationSchema = new Schema(
  {
    title: { type: String, required: true },
    content: { type: String, required: true },
    /**
     * 消息中心分类：system=系统通知、member=会员服务、reward=榜单奖励。
     * 2026-11-04 之前的历史行没有这个字段，读路径一律按 system 处理（见 notification service）。
     */
    category: { type: String, enum: ['system', 'member', 'reward'], default: 'system' },
    published: { type: Boolean, default: false },
    publishedAt: { type: Number, default: null },
    /** 定向收件人（方案 A/D14：榜单结算等系统流水只发给赢家）；null/缺省＝全站广播 */
    userId: { type: Schema.Types.ObjectId, default: null },
    /**
     * 投递幂等键（修复轮 1 / I-1）：系统流水（榜单到账/撤回）一事件一键，
     * `board:credit|revoke:{type}:{period}:{periodKey}:{userId}`。普通广播/公告不填（null）。
     * 唯一性由下面的 partial unique 索引裁决：同键第二次 create 撞 E11000 ⇒ 视为「已经发过」。
     */
    dedupeKey: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);

notificationSchema.index({ published: 1, publishedAt: -1 });
// 用户侧读路径：{published:true, $or:[{userId:null},{userId:me}]}（含游客 {userId:null}）
// 每个 $or 分支都是 userId+published 等值前缀、publishedAt 倒序收尾；见 guard-index 自检。
notificationSchema.index({ userId: 1, published: 1, publishedAt: -1 });
// 投递幂等键：**只对带键的系统流水**唯一。不能用裸 sparse——字段 default:null，广播行
// 显式写 null，sparse 只跳过「字段缺失」，null 照样进索引 ⇒ 第二条广播就撞键。
// partial $type:'string' 让 null/缺省值完全不在索引里；guard-index 两侧自检钉住这个形状。
notificationSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
);

export type Notification = mongoose.InferSchemaType<typeof notificationSchema>;
export const NotificationModel = models.Notification ?? model('Notification', notificationSchema);
