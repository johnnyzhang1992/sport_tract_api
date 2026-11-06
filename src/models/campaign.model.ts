import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

const campaignSchema = new Schema(
  {
    creatorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    visibility: { type: String, enum: ['public', 'private'], required: true },
    /** PK 类型：activity=普通运动PK（按轨迹），steps=步数PK（只按微信步数） */
    kind: { type: String, enum: ['activity', 'steps'], default: 'activity' },
    /** 普通运动PK 是否开启微信步数辅助（成员半屏按天对比）；步数PK恒为 false/不展示 */
    stepAuxEnabled: { type: Boolean, default: false },
    /** 空数组 = 不限制类型；否则白名单（决策 §2-3）；步数PK忽略此字段 */
    allowedTypes: { type: [String], default: [] },
    /** null = 不限人数（决策 §2-6） */
    memberLimit: { type: Number, default: null },
    /** epoch ms，东八区「开始日 00:00」 */
    startAt: { type: Number, required: true },
    /** epoch ms，东八区「结束日 24:00」＝次日 00:00（左闭右开） */
    endAt: { type: Number, required: true },
    status: { type: String, enum: ['active', 'ended', 'dissolved'], default: 'active' },
  },
  { timestamps: true, versionKey: false },
);

campaignSchema.index({ creatorId: 1, createdAt: -1 });
campaignSchema.index({ status: 1, endAt: -1 });

export type Campaign = mongoose.InferSchemaType<typeof campaignSchema>;
export const CampaignModel = models.Campaign ?? model('Campaign', campaignSchema);
