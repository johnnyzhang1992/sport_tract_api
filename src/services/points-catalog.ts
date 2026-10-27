/**
 * 道具目录：种子 + 用户端读取。
 * 种子只用 $setOnInsert —— 后台改过价格/库存/文案后重跑启动钩子不得冲掉（PI-2 钉这条）。
 */
import { Types } from 'mongoose';
import { PointItemModel } from '../models/point.model.js';

export const POINT_ITEM_KEYS = {
  makeupCard: 'makeup_card',
  adFree7: 'ad_free_7d',
  adFree15: 'ad_free_15d',
  adFree30: 'ad_free_30d',
} as const;

export interface ItemDoc {
  _id: Types.ObjectId;
  key: string;
  name: string;
  subtitle: string;
  description: string;
  notes: string[];
  price: number;
  validDays: number;
  effect: { kind: 'makeup' | 'ad_free'; days: number };
  stock: number;
  unlimited: boolean;
  active: boolean;
  sortOrder: number;
  image: string;
}

const MAKEUP_NOTES = [
  '每张补签卡仅可使用一次，每个漏签日最多补一次',
  `兑换后 30 天内有效，过期作废`,
  '兑换后不退积分',
];

const adFreeNotes = (days: number) => [
  `激活后 ${days} 天内不再展示广告，卡包内激活起算`,
  '封面广告需平台侧同步名单，激活次日才生效（非即时）',
  '多张可叠加，按激活先后顺延',
  '兑换后不退积分',
];

/** 免广告三档价格（spec §3 口径 6）。不要写成 days*20 之类的公式，那个公式给不出 200/400/600。 */
const AD_FREE_PRICE: Record<number, number> = { 7: 200, 15: 400, 30: 600 };

export const POINT_ITEMS_SEED: Omit<ItemDoc, '_id'>[] = [
  {
    key: POINT_ITEM_KEYS.makeupCard, name: '补签卡', subtitle: '恢复连续打卡记录',
    description: '每张仅可使用一次；可补签近 7 天窗口内的漏签日，补一天用一张；兑换后 30 天内有效',
    notes: MAKEUP_NOTES, price: 200, validDays: 30,
    effect: { kind: 'makeup', days: 0 },
    stock: 9999, unlimited: true, active: true, sortOrder: 10, image: '',
  },
  ...([7, 15, 30] as const).map((days, i) => ({
    key: `ad_free_${days}d`, name: `免广告卡·${days} 天`, subtitle: `激活后 ${days} 天内免广告`,
    description: `兑换后 30 天内需激活，激活起 ${days} 天免广告；封面广告次日生效`,
    notes: adFreeNotes(days), price: AD_FREE_PRICE[days], validDays: 30,
    effect: { kind: 'ad_free' as const, days },
    // active:false 起步：老端首页商品区是 wx:for，后台一上架就会多出点不动的卡，等 Task 14 发版后再开
    stock: 9999, unlimited: true, active: false, sortOrder: 20 + i * 10, image: '',
  })),
];

/** 幂等种子：只补种缺失的 key。返回目录总数。 */
export async function seedPointItems(): Promise<number> {
  await PointItemModel.bulkWrite(POINT_ITEMS_SEED.map((it) => ({
    updateOne: { filter: { key: it.key }, update: { $setOnInsert: it }, upsert: true },
  })));
  return PointItemModel.countDocuments({});
}
