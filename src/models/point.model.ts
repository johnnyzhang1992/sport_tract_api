import mongoose from 'mongoose';
const { Schema, model, models } = mongoose;

const accountSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, unique: true, index: true },
  balance: { type: Number, default: 0, min: 0 },
  totalEarned: { type: Number, default: 0 },
  totalSpent: { type: Number, default: 0 },
}, { timestamps: true, versionKey: false });

const recordSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  type: { type: String, required: true },
  title: { type: String, required: true },
  delta: { type: Number, required: true },
  balanceAfter: { type: Number, required: true },
  bizDate: { type: String, required: true },
  refType: { type: String, default: '' },
  refId: { type: String, default: '' },
  idemKey: { type: String, required: true, unique: true },
  expireAt: { type: Number, default: null },
  createdAt: { type: Number, required: true },
}, { versionKey: false });
recordSchema.index({ userId: 1, createdAt: -1 });
// 积分页今日剩余（points-items.listActiveItems）：兑换台账聚合 {type,refType,bizDate,refId $in}。
// 键序是这里选定的规范形状（等值 type/refType/bizDate 做前缀，$in 的 refId 收尾），不是 Mongo 硬要求：
// $in 也能按等值绑定，换序仍可能走 IXSCAN；guard-index 按这个 exact 键组合认，换序即判失效。
// 没有这条索引，每次积分页加载都全表扫整个积分台账（COLLSCAN，随账本增长无限放大）。
recordSchema.index({ type: 1, refType: 1, bizDate: 1, refId: 1 });

const lotSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  recordId: { type: Schema.Types.ObjectId, required: true },
  earned: { type: Number, required: true },
  remaining: { type: Number, required: true, min: 0 },
  earnedAt: { type: Number, required: true },
  expireAt: { type: Number, required: true },
}, { versionKey: false });
lotSchema.index({ userId: 1, expireAt: 1 });

const signinSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  dateKey: { type: String, required: true },
  streakDay: { type: Number, required: true },
  points: { type: Number, required: true },
  source: { type: String, enum: ['sign', 'makeup'], required: true },
  createdAt: { type: Number, required: true },
}, { versionKey: false });
signinSchema.index({ userId: 1, dateKey: 1 }, { unique: true });

const taskSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  taskKey: { type: String, required: true },
  periodKey: { type: String, required: true },
  status: { type: String, enum: ['claimed'], default: 'claimed' },
  points: { type: Number, required: true },
  claimedAt: { type: Number, required: true },
}, { versionKey: false });
taskSchema.index({ userId: 1, taskKey: 1, periodKey: 1 }, { unique: true });

const cardSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  itemKey: { type: String, default: 'makeup_card' },
  status: { type: String, enum: ['unused', 'used', 'expired'], default: 'unused' },
  expiresAt: { type: Number, required: true },
  usedForDate: { type: String, default: '' },
  createdAt: { type: Number, required: true },
  source: { type: String, enum: ['exchange', 'admin', 'system'], default: 'exchange' },
  grantedBy: { type: String, default: '' },
  note: { type: String, default: '' },
  activatedAt: { type: Number, default: 0 },
  benefitDays: { type: Number, default: 0 },
}, { versionKey: false });
cardSchema.index({ userId: 1, status: 1, expiresAt: 1 });
// 导出免广告名单：按道具 + 已激活扫全表，避免 {status,benefitDays} 组合走错索引
cardSchema.index({ itemKey: 1, status: 1, activatedAt: 1 });

const exchangeSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  itemKey: { type: String, required: true },
  cost: { type: Number, required: true },
  cardId: { type: Schema.Types.ObjectId, required: true },
  requestId: { type: String, required: true },
  createdAt: { type: Number, required: true },
}, { versionKey: false });
exchangeSchema.index({ userId: 1, requestId: 1 }, { unique: true });

/**
 * 实物订单状态机：pending_ship → shipped → completed（无取消/退分）。
 * 文案与顺序只写这一份，service 的 ORDER_STATUS 也从这里再导出，避免两处各写一张表。
 */
export const ORDER_STATUS = ['pending_ship', 'shipped', 'completed'] as const;
export type OrderStatus = typeof ORDER_STATUS[number];

/**
 * 实物兑换订单：虚拟道具不会写这张表（兑换只发 PointCard）。
 * itemName / cost / address 都是下单快照（后台改目录名/价格、用户改默认地址都不追认）。
 * (userId, requestId) 唯一：与虚拟兑换共用同一个客户端幂等键空间，并发同键只落一张。
 */
const orderSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  itemKey: { type: String, required: true },
  itemName: { type: String, required: true },
  cost: { type: Number, required: true },
  address: {
    receiver: { type: String, required: true },
    phone: { type: String, required: true },
    detail: { type: String, required: true },
  },
  status: { type: String, enum: ORDER_STATUS, default: 'pending_ship' },
  trackingNo: { type: String, default: '' },
  trackingCompany: { type: String, default: '' },
  shippedAt: { type: Number, default: 0 },
  shippedBy: { type: String, default: '' },
  completedAt: { type: Number, default: 0 },
  requestId: { type: String, required: true },
  createdAt: { type: Number, required: true },
  updatedAt: { type: Number, required: true },
}, { versionKey: false });
orderSchema.index({ userId: 1, requestId: 1 }, { unique: true });
orderSchema.index({ status: 1, createdAt: -1 });

/** 每日已入账计数器：DAILY_CAP 的原子闸门（$inc 预占 + 超限退回），替代聚合 check-then-act */
const dailySchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  bizDate: { type: String, required: true },
  earned: { type: Number, required: true, min: 0 },
}, { versionKey: false });
dailySchema.index({ userId: 1, bizDate: 1 }, { unique: true });

/**
 * 道具目录：一条 = 一种可兑换/可发放的道具。
 * 价格与有效期以前写死在 points-items.ts + config/points.ts，落库后那两个常量退化为种子值。
 */
/**
 * effect.kind 的唯一口径：schema 的 enum 和管理端 assertItemInput 都从这一份读，
 * 免得两处各写各的——入参越界的 kind 若在 service 放行，落到 schema 就是 Mongoose
 * ValidationError（非 AppError、非 11000），error-handler 只会回 500 + 内部原文。
 */
export const ITEM_EFFECT_KINDS = ['makeup', 'ad_free'] as const;
export type ItemEffectKind = typeof ITEM_EFFECT_KINDS[number];

/**
 * 道具类型：virtual = 权益/卡（兑换即发 PointCard），physical = 实物（兑换落订单 + 收货地址）。
 * 同样只写这一份：schema 的 enum 与管理端 assertItemInput 都读它，越界才能回 400 而不是 500。
 * default 'virtual' 只对「新建且没表态」生效；存量行物理上没有这个字段，读取侧一律按 virtual 兜底。
 */
export const ITEM_KINDS = ['virtual', 'physical'] as const;
export type ItemKind = typeof ITEM_KINDS[number];

const itemSchema = new Schema({
  key: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  subtitle: { type: String, default: '' },
  description: { type: String, default: '' },
  notes: { type: [String], default: [] },
  price: { type: Number, required: true, min: 1 },
  validDays: { type: Number, required: true, min: 1 },
  kind: { type: String, enum: ITEM_KINDS, default: 'virtual' },
  effect: {
    kind: { type: String, enum: ITEM_EFFECT_KINDS, required: true },
    days: { type: Number, default: 0, min: 0 },
  },
  stock: { type: Number, default: 9999, min: 0 },
  unlimited: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
  image: { type: String, default: '' },
  // 实物详情图：存裸链（签名在读取时现签），条数上限 schema 表达不了，由 assertItemInput 拦
  detailImages: { type: [String], default: [] },
  // 每人限购：0 = 不限。实物「未表态」时由 createItem 落 1；这里只兜住负数（范围/整数在 service 校验）
  perUserLimit: { type: Number, default: 0, min: 0 },
  // 每日投放（2026-10-28 榜单发积分同批）：0＝不限；>0＝每个东八区自然日最多兑 N 张，先到先得
  dailyQuota: { type: Number, default: 0, min: 0 },
  // 每人每日上限：0＝不限。没有这条，一个人能把当日额度扫光
  perUserDaily: { type: Number, default: 0, min: 0 },
}, { timestamps: true, versionKey: false });

export const PointAccountModel = models.PointAccount ?? model('PointAccount', accountSchema);
export const PointRecordModel = models.PointRecord ?? model('PointRecord', recordSchema);
export const PointLotModel = models.PointLot ?? model('PointLot', lotSchema);
export const PointSigninModel = models.PointSignin ?? model('PointSignin', signinSchema);
export const PointTaskModel = models.PointTask ?? model('PointTask', taskSchema);
export const PointCardModel = models.PointCard ?? model('PointCard', cardSchema);
export const PointExchangeModel = models.PointExchange ?? model('PointExchange', exchangeSchema);
export const PointOrderModel = models.PointOrder ?? model('PointOrder', orderSchema);
export const PointDailyModel = models.PointDaily ?? model('PointDaily', dailySchema);
export const PointItemModel = models.PointItem ?? model('PointItem', itemSchema);
