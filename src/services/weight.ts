/**
 * 卡路里的体重口径：只认服务端档案 user.weightKg。
 *
 * 之前只有 finish 传了体重、且传的是**客户端上报值**，其余 4 条会落卡路里的路径
 * （自动收尾 / 纠偏 / 改类型 / GPX 导入）都掉到 60kg 默认值。结果是同一用户
 * 「手录」和「导入」两条记录卡路里差几倍，改完档案后纠偏还会把卡路里往回拽。
 * 所有算卡路里的地方从这里取一次，客户端上报值不再参与。
 */
import { UserModel } from '../models/user.model.js';
import { DEFAULT_WEIGHT_KG } from '../config/constants.js';
import { isObjectIdLike, type ObjectIdLike } from '../utils/object-id.js';

export async function resolveWeightKg(userId: ObjectIdLike | null | undefined): Promise<number> {
  if (!isObjectIdLike(userId)) return DEFAULT_WEIGHT_KG;
  const user = await UserModel.findById(userId).select('weightKg').lean();
  return user?.weightKg ?? DEFAULT_WEIGHT_KG;
}
