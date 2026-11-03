/**
 * 订单账本的两条 unique 是正确性防线，不是性能索引（spec §5.2）：
 * - wxOrderId：发货幂等。删了它→同一笔支付能发两次货（资损），而且不报错；
 * - outTradeNo：一个下单号只能有一行。删了它→并发/重试建单会长出重复行，轮询与退款都对不上账。
 * 声明侧（schema 带 options）与库内实际两处都断，同 guard-index 的既有教训：
 * 只断库侧会在「别人手工删过索引但代码还留着声明」时假绿，只断声明侧会在「声明写漏 options」时假绿。
 *
 * 与 Task 4 brief 的唯一偏差（已被本任务的探针实测钉死）：wxOrderId 的 partial 里
 * 「排除空串」只能用 `$gt: ''`，不能用 brief 原文写的 `$ne: ''`——dev 库（MongoDB 8.0.17）
 * 对 `$ne` 直接回 CannotCreateIndex / "Expression not supported in partial index: $not"，
 * 索引根本建不起来（syncIndexes 当场抛错）。语义完全等价：`$gt: ''` 对字符串就是「非空串」，
 * 未支付行的 '' 不进索引、已支付行的商户单号照常唯一。谓词与本文件都按 $gt 口径认。
 *
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/xpay-order-index.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { XpayOrderModel, XPAY_ORDER_STATUS } from '../src/models/xpay-order.model.js';
import {
  hasUniqueWxOrderIndex, hasUniqueOutTradeIndex, hasXpayOrderUserReadIndex,
} from '../src/utils/guard-index.js';

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  // 让 autoIndex 真的建完：先 syncIndexes（本集合只有我们自己，不碰别的集合）
  await XpayOrderModel.syncIndexes();
});
after(async () => {
  // 共享 dev 库纪律：探针行只认 openid='o_probe'，跑完即删净（本集合是新建的，没有别人的单）
  await XpayOrderModel.deleteMany({ openid: 'o_probe' }).catch(() => {});
  await mongoose.disconnect().catch(() => {});
});

test('XO-1 状态枚举逐字＝spec §5.2 的六态', () => {
  assert.deepEqual([...XPAY_ORDER_STATUS], ['created', 'paid', 'delivered', 'refunding', 'refunded', 'closed']);
});

test('XO-2 库内 wxOrderId unique 防线真在', async () => {
  const idx = await XpayOrderModel.collection.indexes();
  assert.ok(hasUniqueWxOrderIndex(idx), `防线不在！现有索引：${JSON.stringify(idx.map((i) => ({ name: i.name, unique: i.unique, key: i.key })))}`);
});

test('XO-3 库内 outTradeNo unique 防线真在', async () => {
  const idx = await XpayOrderModel.collection.indexes();
  assert.ok(hasUniqueOutTradeIndex(idx));
});

test('XO-4 用户读路径索引真在（会员到期回放按 userId+status 收窄、periodEnd 倒序收尾）', async () => {
  const idx = await XpayOrderModel.collection.indexes();
  assert.ok(hasXpayOrderUserReadIndex(idx));
});

test('XO-5 声明侧的 schema index 与谓词一致（防「库里有旧索引但声明已删」的假绿）', () => {
  // 只用公开访问器 schema.indexes()：返回 [fields, options] 数组，声明侧写了 options 才读得到 unique
  const shapes = XpayOrderModel.schema.indexes() as Array<[{ [k: string]: number }, { unique?: boolean }]>;
  assert.ok(shapes.length >= 5, `schema 上应声明 5 条索引，实际 ${shapes.length}`);
  assert.ok(shapes.some(([k, o]) => Object.keys(k).join(',') === 'wxOrderId' && o?.unique === true), '声明侧缺 wxOrderId unique');
  assert.ok(shapes.some(([k, o]) => Object.keys(k).join(',') === 'outTradeNo' && o?.unique === true), '声明侧缺 outTradeNo unique');
  assert.ok(shapes.some(([k]) => Object.keys(k).join(',') === 'userId,status,periodEnd'), '声明侧缺用户读路径');
});

test('XO-6 谓词本身会拒「同名但属性不对」的索引', () => {
  assert.equal(hasUniqueWxOrderIndex([{ key: { wxOrderId: 1 } }]), false, '非 unique 不算');
  assert.equal(hasUniqueWxOrderIndex([{ key: { outTradeNo: 1 }, unique: true }]), false, '字段不对不算');
  assert.equal(hasXpayOrderUserReadIndex([{ key: { userId: 1, status: 1, periodEnd: 1 } }]), false, '方向写成升序不算');
});

test('XO-7 重复 wxOrderId 落库必撞 E11000（幂等防线的可执行证明）', async () => {
  const oid = new mongoose.Types.ObjectId();
  const mk = (n: string) => ({
    outTradeNo: n, wxOrderId: 'wx_dup_probe', userId: oid, openid: 'o_probe',
    productKey: 'month_card', name: '会员月卡', priceFen: 199, durationDays: 30,
    status: 'delivered' as const, periodStart: Date.now(), periodEnd: Date.now() + 30 * 86400000,
  });
  await XpayOrderModel.deleteMany({ openid: 'o_probe' });
  await XpayOrderModel.create(mk('probeA'));
  await assert.rejects(() => XpayOrderModel.create(mk('probeB')), (e: { code?: number }) => e.code === 11000);
  await XpayOrderModel.deleteMany({ openid: 'o_probe' });
});
