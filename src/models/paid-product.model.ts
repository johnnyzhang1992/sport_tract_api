import mongoose, { type Types } from 'mongoose';

// 与仓内其它 model 同口径（point.model.ts / ad-slot.model.ts）：mongoose 的 CJS 构建没有
// Schema/model/models 这几个具名 ESM 导出，必须从默认导出上取，否则 node --import tsx 直接 SyntaxError。
const { Schema, model, models } = mongoose;

/** perks 的键名唯一口径：schema 的 Object.keys 与管理端 assertPaidProductInput 都读这一份 */
export const PAID_PRODUCT_PERK_KEYS = ['adFree', 'exportBundle', 'photoQuota', 'subscribeNotice'] as const;

export interface PaidProductPerks {
  adFree: boolean;
  exportBundle: boolean;
  /** 会员期间的照片上限；0＝不给加成（沿用非会员的 MAX_USER_PHOTOS） */
  photoQuota: number;
  subscribeNotice: boolean;
}

/**
 * 现金商品目录（spec §5.1）：一条＝一档可花钱买的会员卡。
 *
 * 与 PointItem（积分道具）故意分表：价格单位（积分 vs 人民币分）、有效期语义（卡本身会过期 vs
 * 买多少天会员）、以及「key 必须等于 MP 后台道具 productId」这条外部约束只对它成立。
 * 混在一张表里会让积分道具的行被当成可支付档位，那是资损面。
 */
const paidProductSchema = new Schema({
  key: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  subtitle: { type: String, default: '' },
  /** 人民币「分」：与 MP 后台道具价（单位元）两处必须一致，代码侧不做自动换算兜底 */
  priceFen: { type: Number, required: true, min: 1 },
  durationDays: { type: Number, required: true, min: 1 },
  perks: {
    adFree: { type: Boolean, default: false },
    exportBundle: { type: Boolean, default: false },
    photoQuota: { type: Number, default: 0, min: 0 },
    subscribeNotice: { type: Boolean, default: false },
  },
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
  notes: { type: [String], default: [] },
}, { timestamps: true, versionKey: false });

paidProductSchema.index({ active: 1, sortOrder: 1 });

export interface PaidProductDoc extends mongoose.Document {
  key: string;
  name: string;
  subtitle: string;
  priceFen: number;
  durationDays: number;
  perks: PaidProductPerks;
  active: boolean;
  sortOrder: number;
  notes: string[];
}

/**
 * 目录行的「读出口」形态：`.lean()` 查出来就是它（计划契约里写的 PaidProduct 指这个，不是 Document）。
 * 与 PaidProductDoc 的差别只在 _id/时间戳——Doc 给写入侧（model.create 的参数与返回），
 * 这里给只读消费方（Task 6 权益唯一读取层、Task 7 会员页按 paidProductOf 取档位）。
 * 后台展示另有一套 PaidProductDto（见 services/paid-products.ts）。
 */
export interface PaidProduct {
  _id: Types.ObjectId;
  key: string;
  name: string;
  subtitle: string;
  priceFen: number;
  durationDays: number;
  perks: PaidProductPerks;
  active: boolean;
  sortOrder: number;
  notes: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

export const PaidProductModel = models.PaidProduct
  ?? model<PaidProductDoc>('PaidProduct', paidProductSchema, 'paidproducts');
