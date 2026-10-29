import mongoose from 'mongoose';

/**
 * 全局应用设置（KV）：key 直接作 _id。
 * 首个用例是榜单发放开关（boardRewardsEnabled）——运行时可变的运营开关不进环境变量：
 * env 改一次要重新部署重启，运营在后台点一下才是它该有的交互。
 */
const AppSettingSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  value: { type: mongoose.Schema.Types.Mixed },
  updatedAt: { type: Date, default: Date.now },
}, { versionKey: false });

export const AppSettingModel = mongoose.model('AppSetting', AppSettingSchema, 'app_settings');
