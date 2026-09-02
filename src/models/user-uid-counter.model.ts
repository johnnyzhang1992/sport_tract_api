import { Schema, model } from 'mongoose';

/** 用户 UID 发号器（1000 起；原子递增防并发重号） */
const userUidCounterSchema = new Schema(
  {
    _id: { type: String, required: true },
    value: { type: Number, default: 999 }, // 首次分配 +1 = 1000
  },
  { versionKey: false },
);

export const UserUidCounterModel = model('UserUidCounter', userUidCounterSchema, 'user_uid_counters');
