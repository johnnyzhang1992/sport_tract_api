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
const itemSchema = new Schema({
  key: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  subtitle: { type: String, default: '' },
  description: { type: String, default: '' },
  notes: { type: [String], default: [] },
  price: { type: Number, required: true, min: 1 },
  validDays: { type: Number, required: true, min: 1 },
  effect: {
    kind: { type: String, enum: ['makeup', 'ad_free'], required: true },
    days: { type: Number, default: 0, min: 0 },
  },
  stock: { type: Number, default: 9999, min: 0 },
  unlimited: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
  image: { type: String, default: '' },
}, { timestamps: true, versionKey: false });

export const PointAccountModel = models.PointAccount ?? model('PointAccount', accountSchema);
export const PointRecordModel = models.PointRecord ?? model('PointRecord', recordSchema);
export const PointLotModel = models.PointLot ?? model('PointLot', lotSchema);
export const PointSigninModel = models.PointSignin ?? model('PointSignin', signinSchema);
export const PointTaskModel = models.PointTask ?? model('PointTask', taskSchema);
export const PointCardModel = models.PointCard ?? model('PointCard', cardSchema);
export const PointExchangeModel = models.PointExchange ?? model('PointExchange', exchangeSchema);
export const PointDailyModel = models.PointDaily ?? model('PointDaily', dailySchema);
export const PointItemModel = models.PointItem ?? model('PointItem', itemSchema);
