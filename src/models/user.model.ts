import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

const userSchema = new Schema(
  {
    openid: { type: String, required: true, unique: true, index: true },
    nickname: { type: String, default: '' },
    avatarUrl: { type: String, default: '' },
    gender: { type: Number, enum: [0, 1, 2], default: 0 }, // 0 未知 1 男 2 女
    settings: {
      unit: { type: String, enum: ['metric', 'imperial'], default: 'metric' },
      defaultType: { type: String, default: 'walking' },
      highAccuracy: { type: Boolean, default: true },
    },
    // 足迹点亮缓存（懒重算：写入只置 dirty，读时 dirty 才重算）
    footprintCache: { type: Schema.Types.Mixed, default: null },
    footprintDirty: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export type User = mongoose.InferSchemaType<typeof userSchema>;

export const UserModel = models.User ?? model('User', userSchema);
