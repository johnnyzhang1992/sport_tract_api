import { Schema, model } from 'mongoose';

/**
 * 专题（官方信息页）：web 管理端创建/管理，小程序首页入口 → 专题详情
 * - content 为 markdown 正文；图片走 OSS（库内存裸 URL，展示时签名）
 * - published + effectiveAt/expiresAt 控制生效窗口：到期后自动从展示列表消失
 */
const topicSchema = new Schema(
  {
    title: { type: String, required: true }, // 标题
    coverUrl: { type: String, default: '' }, // 封面图（首页入口卡片用，可空）
    content: { type: String, default: '' }, // 正文（markdown）
    published: { type: Boolean, default: false }, // 是否发布
    effectiveAt: { type: Number, required: true }, // 生效时间（epoch ms）
    expiresAt: { type: Number, default: null }, // 过期时间（epoch ms；null=长期有效）
  },
  { timestamps: true, versionKey: false },
);

topicSchema.index({ published: 1, effectiveAt: -1 });

export const TopicModel = model('Topic', topicSchema);
