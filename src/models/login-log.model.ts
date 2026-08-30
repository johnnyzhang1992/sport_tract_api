import { Schema, model, Types } from 'mongoose';

/** 登录日志：每次登录成功插入一条，记录 IP + 设备信息 */
export interface LoginLog {
  userId: Types.ObjectId;
  ip?: string;           // 客户端 IP（取 x-forwarded-for 第一个或 request.ip）
  province?: string;     // IP 归属省
  city?: string;         // IP 归属市
  platform?: string;     // 小程序平台：weapp / ios / android / devtools
  system?: string;       // 操作系统：iOS 17.5 / Android 14 / Windows 10 等
  brand?: string;        // 设备品牌：Apple / Huawei / Xiaomi 等
  model?: string;        // 设备型号：iPhone 15 Pro / SM-S9180 等
  sdkVersion?: string;   // 微信基础库版本
  appVersion?: string;   // 小程序版本号
  createdAt: Date;
}

const loginLogSchema = new Schema<LoginLog>({
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  ip: { type: String },
  province: { type: String },
  city: { type: String },
  platform: { type: String },
  system: { type: String },
  brand: { type: String },
  model: { type: String },
  sdkVersion: { type: String },
  appVersion: { type: String },
  createdAt: { type: Date, default: Date.now, index: true },
});

export const LoginLogModel = model<LoginLog>('LoginLog', loginLogSchema);
