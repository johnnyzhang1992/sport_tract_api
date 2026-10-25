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
}, { versionKey: false });
cardSchema.index({ userId: 1, status: 1, expiresAt: 1 });

const exchangeSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  itemKey: { type: String, required: true },
  cost: { type: Number, required: true },
  cardId: { type: Schema.Types.ObjectId, required: true },
  requestId: { type: String, required: true },
  createdAt: { type: Number, required: true },
}, { versionKey: false });
exchangeSchema.index({ userId: 1, requestId: 1 }, { unique: true });

export const PointAccountModel = models.PointAccount ?? model('PointAccount', accountSchema);
export const PointRecordModel = models.PointRecord ?? model('PointRecord', recordSchema);
export const PointLotModel = models.PointLot ?? model('PointLot', lotSchema);
export const PointSigninModel = models.PointSignin ?? model('PointSignin', signinSchema);
export const PointTaskModel = models.PointTask ?? model('PointTask', taskSchema);
export const PointCardModel = models.PointCard ?? model('PointCard', cardSchema);
export const PointExchangeModel = models.PointExchange ?? model('PointExchange', exchangeSchema);
