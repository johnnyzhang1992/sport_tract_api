/**
 * 订单账本的两条 unique 是正确性防线，不是性能索引（spec §5.2）：
 * - wxOrderId：发货幂等。删了它→同一笔支付能发两次货（资损），而且不报错；
 * - outTradeNo：一个下单号只能有一行。删了它→并发/重试建单会长出重复行，轮询与退款都对不上账。
 * 声明侧（schema 带 options）与库内实际两处都断，同 guard-index 的既有教训：
 * 只断库侧会在「别人手工删过索引但代码还留着声明」时假绿，只断声明侧会在「声明写漏 options」时假绿。
 *
 * wxOrderId 的 partial 里「排除空串」用 `$gt: ''`，**不是** `$ne: ''`（计划原文已按本任务实测更正）：
 * dev 库（MongoDB 8.0.17）对 partial 里的 `$ne` 直接回 CannotCreateIndex /
 * "Expression not supported in partial index: $not"（$ne 脱糖成 $not），整条索引拒建——
 * 写成 $ne 不是「防线弱一点」而是这条 unique 压根不存在（syncIndexes 当场抛错）。
 * `$gt: ''` 对字符串语义等价：非空串都 > ''，'' 自己被排除；$type: 'string' 继续挡非字符串脏值。
 * 两侧都核：XO-2/XO-7 证「已支付行的商户单号唯一」，XO-8 证「未支付的空串不进索引」——
 * partial 的全部意义在后一半，它失效的症状是「用户下第二单莫名失败」，只在首单未付的窗口里出现。
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
  // 共享 dev 库纪律：探针行只认 openid='o_probe'/'o_probe2'，跑完即删净（本集合是新建的，没有别人的单）
  await XpayOrderModel.deleteMany({ openid: 'o_probe' }).catch(() => {});
  await XpayOrderModel.deleteMany({ openid: 'o_probe2' }).catch(() => {});
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
  // 方向在 key 对象里，不在 options 里：schema.indexes() 的第一项才是 {字段: 1|-1}
  assert.ok(shapes.some(([k]) => Object.keys(k).join(',') === 'userId,status,periodEnd' && k.periodEnd === -1), '声明侧缺用户读路径（或方向不对）');
  // 声明侧还要核对 partial 的**形状**：只比 keys+unique 时，「库里手工留着一条对的、声明已经写坏」会假绿
  // （notifications.dedupeKey 那条先例就是声明侧直接 deepEqual 钉住 partial）
  const wx = shapes.find(([k, o]) => Object.keys(k).join(',') === 'wxOrderId' && (o as {unique?: boolean}).unique === true);
  assert.ok(wx, '声明侧缺 wxOrderId unique');
  assert.deepEqual((wx[1] as { partialFilterExpression?: unknown }).partialFilterExpression, { wxOrderId: { $type: 'string', $gt: '' } });
});

test('XO-6 谓词本身会拒「同名但属性不对」的索引', () => {
  assert.equal(hasUniqueWxOrderIndex([{ key: { wxOrderId: 1 } }]), false, '非 unique 不算');
  assert.equal(hasUniqueWxOrderIndex([{ key: { outTradeNo: 1 }, unique: true }]), false, '字段不对不算');
  assert.equal(hasXpayOrderUserReadIndex([{ key: { userId: 1, status: 1, periodEnd: 1 } }]), false, '方向写成升序不算');
});

test('XO-8 两笔**未支付**订单（wxOrderId 都是空串）必须能共存——partial 退化时这正是炸点', async () => {
  await XpayOrderModel.deleteMany({ openid: 'o_probe2' });
  const mk = (n: string) => ({
    outTradeNo: n, userId: new mongoose.Types.ObjectId(), openid: 'o_probe2',
    productKey: 'month_card', name: '会员月卡', priceFen: 199, durationDays: 30, status: 'created' as const,
  });
  await XpayOrderModel.create(mk('PROBE2A'));
  // partial 写成 $type-only / 裸 sparse / 全量 unique 时，这一行会撞 E11000——
  // 症状是「用户下第二单莫名失败」，而且只在第一单还没支付时发生，最难在测试里被发现
  await XpayOrderModel.create(mk('PROBE2B'));
  assert.equal(await XpayOrderModel.countDocuments({ openid: 'o_probe2' }), 2);
  await XpayOrderModel.deleteMany({ openid: 'o_probe2' });
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
