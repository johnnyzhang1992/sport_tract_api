import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

/**
 * 账号注销审计（2026-11-17）
 *
 * 为什么要这张表：注销会把 users 文档、loginlogs、业务数据全部删掉，
 * 之后**没有任何痕迹**能回答「谁在什么时候注销过」「这是同一微信第几次注销」。
 * 这张表只追加、不随用户删除（它自己也不按 userId 清理）。
 *
 * 隐私口径（最小化收集，别把「删干净」的承诺做成谎言）：
 *   - **不存 openid 原文**，只存 HMAC 哈希：够判断「同一个微信反复注销/重注册」，反推不出是谁
 *   - 昵称可选（客服对账时最好用，默认记下；不想要就调 recordAccountDeletion 的入参）
 *   - 不存轨迹坐标、不存任何内容型数据，只存**删除条数**（stats）
 *   - TTL 180 天自动过期：既够客服追溯与防刷判定，又不会无限期留着
 *
 * 防刷用途：`seq` = 同一 openid 的第几次注销（1 = 第一次）。
 * 「注册 → 领新人/活动奖励 → 注销 → 再注册」会在同一个 openidHash 上累积 seq，
 * 后台「注销记录」页可按「仅看重复注销」筛出来。
 */
const accountDeletionSchema = new Schema(
  {
    /** 注销那一刻的 users._id（该文档已被删除，留着用于和历史数据/订单对上） */
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    /** 站内编号（客服最好用的定位键）；老账号可能没有 → 0 */
    uid: { type: Number, default: 0, index: true },
    /** openid 的 HMAC-SHA256（盐 = JWT_SECRET，见 services/account-audit.ts） */
    openidHash: { type: String, required: true, index: true },
    /** 同一 openidHash 的第几次注销（1 = 首次；>1 = 反复注销，防刷关注点） */
    seq: { type: Number, required: true, min: 1 },
    /** 注销时的昵称（客服对账用；可能为空串 = 从没设过） */
    nickname: { type: String, default: '' },
    /** 注销时刻（毫秒）—— TTL 就挂在这个字段上 */
    deletedAt: { type: Number, required: true },
    /** 账号持有天数（注销时刻 - 注册时刻，取整；新注册就注销会很短） */
    ageDays: { type: Number, default: 0 },
    /** 各集合删除条数（PurgeStats 原样落库）：删了什么、删了多少，客服举证靠它 */
    stats: { type: Schema.Types.Mixed, default: {} },
    /** 取证字段（同 loginlog 口径；产品未要求服务端强制记录，缺省空串） */
    ip: { type: String, default: '' },
    platform: { type: String, default: '' },
    system: { type: String, default: '' },
    appVersion: { type: String, default: '' },
  },
  { timestamps: true, versionKey: false },
);

/** 列表默认按时间倒序；TTL 只在 deletedAt 上建一条过期索引（不要和普通索引重复建） */
accountDeletionSchema.index({ deletedAt: -1 }, { expireAfterSeconds: 180 * 24 * 3600 });
/** 防刷查询：同 openidHash 的全部记录 */
accountDeletionSchema.index({ openidHash: 1, deletedAt: -1 });

export type AccountDeletion = mongoose.InferSchemaType<typeof accountDeletionSchema>;
export const AccountDeletionModel =
  models.AccountDeletion ?? model('AccountDeletion', accountDeletionSchema);
