import mongoose from 'mongoose';
import { DEFAULT_WEIGHT_KG } from '../config/constants.js';

const { Schema, model, models } = mongoose;

const userSchema = new Schema(
  {
    openid: { type: String, required: true, unique: true, index: true },
    /** 站内角色：admin 才能收到每日数据统计通知；存量缺省按普通用户 */
    role: { type: String, enum: ['user', 'admin'], default: 'user', index: true },
    uid: { type: Number, sparse: true, unique: true }, // 用户唯一编号（1000 起；sparse 兼容存量用户迁移补号）
    nickname: { type: String, default: '' },
    avatarUrl: { type: String, default: '' },
    gender: { type: Number, enum: [0, 1, 2], default: 0 }, // 0 未知 1 男 2 女
    weightKg: { type: Number, default: DEFAULT_WEIGHT_KG, min: 20, max: 300 }, // 体重 kg（卡路里计算用）
    heightCm: { type: Number, default: 170, min: 50, max: 250 }, // 身高 cm
    profileCompleted: { type: Boolean, default: false }, // 是否主动提交过身高/体重（完善资料引导用；不能拿默认值 60/170 判断，否则永远“已完整”）
    lastLoginAt: { type: Number, default: () => Date.now() }, // 最后登录时间（管理后台排序用）
    settings: {
      unit: { type: String, enum: ['metric', 'imperial'], default: 'metric' },
      defaultType: { type: String, default: 'walking' },
      highAccuracy: { type: Boolean, default: true },
      showBodyData: { type: Boolean, default: true }, // 个人中心是否展示身高体重
      showSportData: { type: Boolean, default: true }, // 他人点开资料卡时是否展示累计运动数据
      privacyMode: { type: Boolean, default: false }, // 隐私模式：运动榜/步数榜上榜条目对他人匿名，资料卡对他人关闭
      kmAnnounce: { type: Boolean, default: true }, // 记录中整公里震动+横幅播报
      dailyStepSync: { type: Boolean, default: true }, // 每天进入小程序时同步微信步数；关闭后仅活动页按需同步
    },
    avatarPreset: { type: String, default: '' }, // 默认头像预设 key（assets/avatars/default-N，avatarUrl 为空时生效）
    note: { type: String, default: '', maxlength: 200 }, // 管理员备注（仅管理后台可见/编辑）
    // 足迹点亮缓存（懒重算：写入只置 dirty，读时 dirty 才重算）
    footprintCache: { type: Schema.Types.Mixed, default: null },
    footprintDirty: { type: Boolean, default: true },
    // 已占用的照片额度（轨迹打点 + 足迹合计）；存量用户可能没这个字段，读时按 0 算
    photoQuotaUsed: { type: Number, default: 0 },
    /**
     * 照片额度的**历史最高值**（高水位）。产品裁定 2026-11-05：
     * 开通会员拿到的 300 张是一次性升级，会员到期**不回落到 100**——这里存拿到过的最大值，
     * 真实上限 = max(100, 本字段, 当前会员权益给的额度)。只在升高时用 $max 写入。
     */
    photoQuotaLimit: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export type User = mongoose.InferSchemaType<typeof userSchema>;

export const UserModel = models.User ?? model('User', userSchema);
