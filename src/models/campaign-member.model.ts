import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

/**
 * 一行 = 一个加入段（见计划文档「数据模型的决定」）。
 * 离开后再加入＝插新行，历史段保留，用于统计其贡献时段。
 */
const campaignMemberSchema = new Schema(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['creator', 'member'], default: 'member' },
    state: {
      type: String,
      enum: ['pending', 'joined', 'rejected', 'left', 'removed'],
      required: true,
    },
    joinedAt: { type: Number, default: null },
    leftAt: { type: Number, default: null },
  },
  { timestamps: true, versionKey: false },
);

campaignMemberSchema.index({ campaignId: 1, state: 1 });
campaignMemberSchema.index({ userId: 1, createdAt: -1 });
campaignMemberSchema.index({ campaignId: 1, userId: 1, state: 1 });
// 兜底并发重复加入：同一活动同一用户同时只能有一条 joined
campaignMemberSchema.index(
  { campaignId: 1, userId: 1 },
  {
    unique: true,
    partialFilterExpression: { state: 'joined' },
    name: 'unique_joined_per_campaign_user',
  },
);

export type CampaignMember = mongoose.InferSchemaType<typeof campaignMemberSchema>;
export const CampaignMemberModel =
  models.CampaignMember ?? model('CampaignMember', campaignMemberSchema);
