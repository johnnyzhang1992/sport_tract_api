import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

const userSchema = new Schema(
  {
    openid: { type: String, required: true, unique: true, index: true },
    uid: { type: Number, sparse: true, unique: true }, // 用户唯一编号（1000 起；sparse 兼容存量用户迁移补号）
    nickname: { type: String, default: '' },
    avatarUrl: { type: String, default: '' },
    gender: { type: Number, enum: [0, 1, 2], default: 0 }, // 0 未知 1 男 2 女
    weightKg: { type: Number, default: 60, min: 20, max: 300 }, // 体重 kg（卡路里计算用）
    heightCm: { type: Number, default: 170, min: 50, max: 250 }, // 身高 cm
    lastLoginAt: { type: Number, default: () => Date.now() }, // 最后登录时间（管理后台排序用）
    settings: {
      unit: { type: String, enum: ['metric', 'imperial'], default: 'metric' },
      defaultType: { type: String, default: 'walking' },
      highAccuracy: { type: Boolean, default: true },
      showBodyData: { type: Boolean, default: true }, // 个人中心是否展示身高体重
      kmAnnounce: { type: Boolean, default: true }, // 记录中整公里震动+横幅播报
    },
    // 足迹点亮缓存（懒重算：写入只置 dirty，读时 dirty 才重算）
    footprintCache: { type: Schema.Types.Mixed, default: null },
    footprintDirty: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export type User = mongoose.InferSchemaType<typeof userSchema>;

export const UserModel = models.User ?? model('User', userSchema);
