import { Schema, model, Types } from 'mongoose';

/** 登录日志（UV/PV 统计用）：每次登录成功插入一条 */
export interface LoginLog {
  userId: Types.ObjectId;
  createdAt: Date;
}

const loginLogSchema = new Schema<LoginLog>({
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  createdAt: { type: Date, default: Date.now },
});

export const LoginLogModel = model<LoginLog>('LoginLog', loginLogSchema);
