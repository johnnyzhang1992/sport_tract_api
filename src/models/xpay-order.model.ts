import mongoose from 'mongoose';
// 与仓内其它 model 同口径（point.model.ts / paid-product.model.ts）：mongoose 的 CJS 构建没有
// Schema/model/models 这几个具名 ESM 导出，必须从默认导出上取，否则 node --import tsx 直接 SyntaxError。
const { Schema, model, models } = mongoose;
import type { PaidProductPerks } from './paid-product.model.js';

/** 订单六态（spec §5.2），顺序即状态机的可读顺序 */
export const XPAY_ORDER_STATUS = ['created', 'paid', 'delivered', 'refunding', 'refunded', 'closed'] as const;
export type XpayOrderStatus = typeof XPAY_ORDER_STATUS[number];

export const XPAY_CHANNELS = ['android', 'ios'] as const;
export type XpayChannel = typeof XPAY_CHANNELS[number];

/** 退款收尾的 status（spec §2.3）：5/8 完成，7 失败；其余＝仍在处理 */
export const XPAY_REFUND_DONE_STATUS = [5, 8] as const;
export const XPAY_REFUND_FAILED_STATUS = 7;

/**
 * 虚拟支付订单＝发货与退款的唯一账本（spec §5.2）。
 *
 * 三条纪律：
 * 1) wxOrderId 唯一＝发货幂等键。微信推送未回 ErrCode 0 会重试最多 15 次，没有这条唯一索引
 *    同一笔支付能发两次货，而且全程不报错。
 * 2) periodStart/periodEnd 是**发货那一刻算定的快照**，只服务退款建议、权益截断与 iOS 3 秒问询应答
 *    （问询不许同步调微信接口）；会员到期真相永远是回放（services/entitlements.ts）。
 * 3) leftFee 必须来自最新一次 query_order（leftFeeAt 记下取数时刻），发退款前不刷新＝可能超退。
 */
const xpayOrderSchema = new Schema({
  outTradeNo: { type: String, required: true },
  /** 微信商户单号，取自推送 WeChatPayInfo.MchOrderNo；未支付前为空串（不进唯一索引） */
  wxOrderId: { type: String, default: '' },

  userId: { type: Schema.Types.ObjectId, required: true },
  openid: { type: String, required: true },

  productKey: { type: String, required: true },
  name: { type: String, required: true },
  priceFen: { type: Number, required: true, min: 1 },
  durationDays: { type: Number, required: true, min: 1 },
  /** 发货时的权益快照：目录后来改 perks 不会让历史单凭空长出权益（spec §5.3） */
  perksSnapshot: {
    adFree: { type: Boolean, default: false },
    exportBundle: { type: Boolean, default: false },
    photoQuota: { type: Number, default: 0 },
    subscribeNotice: { type: Boolean, default: false },
  },

  status: { type: String, enum: XPAY_ORDER_STATUS, default: 'created' },
  /** 秒级时间戳区间；未发货前 0（0＝还没排进会员链） */
  periodStart: { type: Number, default: 0 },
  periodEnd: { type: Number, default: 0 },

  attach: { type: String, default: '' },
  channel: { type: String, enum: [...XPAY_CHANNELS, ''], default: '' },

  refundOrderId: { type: String, default: '' },
  /** 累计已退（部分退款不新增状态，spec §7.5） */
  refundedFen: { type: Number, default: 0, min: 0 },
  refundCount: { type: Number, default: 0, min: 0 },
  refundedAt: { type: Number, default: 0 },
  refundReason: { type: String, default: '' },
  /** 退款受理时的权益截断时刻（spec §7.5「按时间截断」的落点）；0＝未截断 */
  truncatedAt: { type: Number, default: 0 },

  leftFeeFen: { type: Number, default: 0 },
  /** leftFeeFen 的取数时刻；刷新前不许拿它当依据 */
  leftFeeAt: { type: Number, default: 0 },

  queryAttempts: { type: Number, default: 0 },
  lastQueryAt: { type: Number, default: 0 },
  deliverAttempts: { type: Number, default: 0 },
  notifiedAt: { type: Number, default: 0 },
  lastError: { type: String, default: '' },
}, { timestamps: true, versionKey: false });

// 正确性防线（两条 unique）。wxOrderId 用 partial 排除空串：未支付的行压根还没有商户单号，
// 不能因为「都没值」被判成重复——同 notifications.dedupeKey 那条教训（裸 sparse 会把 null 收进索引）。
//
// 「排除空串」这里只能用 `$gt: ''`，不能用更直观的 `$ne: ''`：dev 库实测（MongoDB 8.0.17，
// 2026-11-03 建表探针）`$ne` 在 partialFilterExpression 里被服务端直接拒建——
// code 67 CannotCreateIndex「Expression not supported in partial index: $not」（$ne 脱糖成 $not）。
// 写成 $ne 的后果不是「防线弱一点」而是**这条索引根本不存在**：syncIndexes 抛错、
// 发货幂等与「第二笔未支付订单撞键」两条症状一起发生。`$gt: ''` 对字符串语义等价
// （任何非空串 > ''，'' 自己被排除），且 $type: 'string' 继续挡住非字符串的脏值。
// 只写 `$type: 'string'` 也不行——探针实测：两条 wxOrderId='' 的行照样撞 E11000（下单整条路打死）。
xpayOrderSchema.index({ wxOrderId: 1 }, { unique: true, partialFilterExpression: { wxOrderId: { $type: 'string', $gt: '' } } });
xpayOrderSchema.index({ outTradeNo: 1 }, { unique: true });
// 用户读路径（entitlementsOf 回放）：userId 等值 → status 等值 → periodEnd 倒序收尾
xpayOrderSchema.index({ userId: 1, status: 1, periodEnd: -1 });
// 懒查单的过滤器是 {status, lastQueryAt}；管理端主路径是 {status, createdAt}
xpayOrderSchema.index({ status: 1, lastQueryAt: 1 });
xpayOrderSchema.index({ status: 1, createdAt: -1 });

export interface XpayOrderDoc extends mongoose.Document {
  outTradeNo: string;
  wxOrderId: string;
  userId: mongoose.Types.ObjectId;
  openid: string;
  productKey: string;
  name: string;
  priceFen: number;
  durationDays: number;
  perksSnapshot: PaidProductPerks;
  status: XpayOrderStatus;
  periodStart: number;
  periodEnd: number;
  attach: string;
  channel: XpayChannel | '';
  refundOrderId: string;
  refundedFen: number;
  refundCount: number;
  refundedAt: number;
  refundReason: string;
  truncatedAt: number;
  leftFeeFen: number;
  leftFeeAt: number;
  queryAttempts: number;
  lastQueryAt: number;
  deliverAttempts: number;
  notifiedAt: number;
  lastError: string;
  createdAt: Date;
  updatedAt: Date;
}

export const XpayOrderModel = models.XpayOrder
  ?? model<XpayOrderDoc>('XpayOrder', xpayOrderSchema, 'xpayorders');
