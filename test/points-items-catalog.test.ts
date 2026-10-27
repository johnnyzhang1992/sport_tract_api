import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { config } from '../src/config/index.js';
import { POINTS } from '../src/config/points.js';
import {
  PointAccountModel, PointCardModel, PointDailyModel, PointExchangeModel, PointItemModel,
  PointLotModel, PointRecordModel,
} from '../src/models/point.model.js';
import { creditPoints, getBalance } from '../src/services/points-ledger.js';
import { seedPointItems } from '../src/services/points-catalog.js';
import { exchangeItem } from '../src/services/points-items.js';
import { bjDateStr } from '../src/utils/bj-time.js';
import { shiftDateKey } from '../src/utils/points-domain.js';
import { AppError } from '../src/utils/app-error.js';

/**
 * 兑换链路按 itemKey 泛化 + 库存闸门（spec §6.1/§6.2、§9 PT-2/PT-3/PT-4/PT-5 → 这里的 PC-2..PC-7）。
 *
 * 种子状态：三条 ad_free_* 默认 active:false（老端 wx:for 会多出点不动的卡），
 * 所以每个要兑换免广告卡的用例先 onShelf() 上架，after() 里统一改回 false。
 * 库存/不限量在用例里被 $set 覆盖后不会随 seedPointItems() 复原（种子只 $setOnInsert），
 * 因此每个用例开头把自己用的那行重置回本次要的状态——重跑才不会受上一次运行残留影响。
 */

const onShelf = async (key: string) => {
  await PointItemModel.updateOne({ key }, { $set: { active: true } });
};

before(async () => {
  // 单文件直跑不经过 app 的 mongodb 插件，这里自行连接；唯一索引异步建，幂等/并发断言要先等 init
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([
    PointExchangeModel.init(), PointRecordModel.init(), PointAccountModel.init(),
    PointDailyModel.init(), PointItemModel.init(),
  ]);
});

after(async () => {
  await PointItemModel.updateMany({ key: /^ad_free_/ }, { $set: { active: false } });
  await mongoose.disconnect().catch(() => {});
});

/** 清场：本用例造的用户按 userId 删干净 6 个 Point 集合（口径同 points-items.test.ts 的 wipe） */
const wipe = (u: Types.ObjectId) => Promise.all([
  PointExchangeModel.deleteMany({ userId: u }),
  PointCardModel.deleteMany({ userId: u }),
  PointRecordModel.deleteMany({ userId: u }),
  PointAccountModel.deleteMany({ userId: u }),
  PointLotModel.deleteMany({ userId: u }),
  PointDailyModel.deleteMany({ userId: u }),
]);

/**
 * 造余额：creditPoints 有 DAILY_CAP=100/日的闸门（一次给 1000 只会入账 100），
 * 按业务日拆分发放凑够 total——与 points-items.test.ts 的 seedPoints 同一口径；
 * bizDate 只当日上限的分桶键，发放时刻用当前时间，批次到期不受影响。
 */
async function seedBalance(u: Types.ObjectId, total: number): Promise<void> {
  const today = bjDateStr(Date.now());
  let left = total;
  for (let i = 0; left > 0; i += 1) {
    const points = Math.min(POINTS.DAILY_CAP, left);
    const r = await creditPoints(String(u), {
      type: 'signin',
      title: '测试发放',
      points,
      bizDate: shiftDateKey(today, -i),
      idemKey: `${u}:seed:${i}`,
    });
    assert.equal(r.credited, points, `拆分发放不该被日上限截断（第 ${i} 段）`);
    left -= points;
  }
}

test('PC-2 按 itemKey 取价：7 天卡扣 200，30 天卡扣 600', async (t) => {
  const u = new Types.ObjectId();
  t.after(() => wipe(u));
  await seedPointItems();
  // 重置回种子形态：unlimited 不占库存，本用例只盯价格与快照
  await PointItemModel.updateOne({ key: 'ad_free_7d' }, { $set: { unlimited: true, stock: 9999 } });
  await PointItemModel.updateOne({ key: 'ad_free_30d' }, { $set: { unlimited: true, stock: 9999 } });
  await onShelf('ad_free_7d');
  await onShelf('ad_free_30d');
  await seedBalance(u, 1000);

  const r7 = await exchangeItem(String(u), 'ad_free_7d', `${u}-r7`);
  assert.equal(r7.balance, 800, '7 天卡价 200');
  const card7 = await PointCardModel.findOne({ userId: u }).lean();
  assert.equal(card7!.itemKey, 'ad_free_7d');
  assert.equal(card7!.benefitDays, 7, '发卡时把 effect.days 抄进卡，目录改档不影响已售');
  assert.equal(card7!.source, 'exchange');

  // 「不影响已售」要落地验证：改档后卡上的快照天数必须还是发出去那天
  await PointItemModel.updateOne({ key: 'ad_free_7d' }, { $set: { 'effect.days': 10 } });
  t.after(() => PointItemModel.updateOne({ key: 'ad_free_7d' }, { $set: { 'effect.days': 7 } }));
  const afterEdit = await PointCardModel.findOne({ userId: u, itemKey: 'ad_free_7d' }).lean();
  assert.equal(afterEdit!.benefitDays, 7, '目录改到 10 天不该追认到已售卡');

  await exchangeItem(String(u), 'ad_free_30d', `${u}-r30`);
  assert.equal(await getBalance(String(u)), 200, '30 天卡价 600');
});

test('PC-3 库存闸门：stock=1 两人抢，一人成一人 400；unlimited 不扣库存', async (t) => {
  await seedPointItems();
  await PointItemModel.updateOne({ key: 'ad_free_7d' }, { $set: { unlimited: false, stock: 1 } });
  await onShelf('ad_free_7d');
  const a = new Types.ObjectId(); const b = new Types.ObjectId();
  t.after(() => wipe(a));
  t.after(() => wipe(b));
  for (const u of [a, b]) {
    await seedBalance(u, 600);
  }
  await exchangeItem(String(a), 'ad_free_7d', `${a}-x`);
  await assert.rejects(() => exchangeItem(String(b), 'ad_free_7d', `${b}-x`), (e) => {
    const err = e as AppError;
    // 错误文案必须含对象 + 实际值（「错误提示要具体」口径）
    return err.statusCode === 400 && /免广告卡·7 天/.test(err.message) && /当前库存 0/.test(err.message);
  });
  assert.equal((await PointItemModel.findOne({ key: 'ad_free_7d' }).lean())!.stock, 0);

  // unlimited 那条走另一分支：兑换后库存原样不动
  await PointItemModel.updateOne({ key: 'ad_free_15d' }, { $set: { unlimited: true, stock: 9999 } });
  await onShelf('ad_free_15d');
  await exchangeItem(String(a), 'ad_free_15d', `${a}-y`);
  assert.equal((await PointItemModel.findOne({ key: 'ad_free_15d' }).lean())!.stock, 9999,
    'unlimited 分支绝不能仍然 $inc -1');
});

test('PC-4 回滚：余额不足时库存不被吃掉', async (t) => {
  await seedPointItems();
  await PointItemModel.updateOne({ key: 'ad_free_30d' }, { $set: { unlimited: false, stock: 5 } });
  await onShelf('ad_free_30d');
  const u = new Types.ObjectId();
  t.after(() => wipe(u));
  await seedBalance(u, 10);
  await assert.rejects(() => exchangeItem(String(u), 'ad_free_30d', `${u}-z`), /积分不足/);
  assert.equal((await PointItemModel.findOne({ key: 'ad_free_30d' }).lean())!.stock, 5,
    '先扣库存后扣分：扣分失败必须回补库存');
  assert.equal(await PointCardModel.countDocuments({ userId: u }), 0);
});

test('PC-5 幂等：同一 requestId 并发 20 次只扣一次分、发一张卡、扣一次库存', async (t) => {
  await seedPointItems();
  await PointItemModel.updateOne({ key: 'ad_free_7d' }, { $set: { unlimited: false, stock: 50 } });
  await onShelf('ad_free_7d');
  const u = new Types.ObjectId();
  t.after(() => wipe(u));
  await seedBalance(u, 200);
  const rs = await Promise.allSettled(
    Array.from({ length: 20 }, () => exchangeItem(String(u), 'ad_free_7d', 'same-rid')),
  );
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 20, '重放一律短路成功');
  assert.equal(await PointCardModel.countDocuments({ userId: u }), 1);
  assert.equal(await PointExchangeModel.countDocuments({ userId: u }), 1);
  assert.equal((await PointItemModel.findOne({ key: 'ad_free_7d' }).lean())!.stock, 49, '库存只扣一张');
  assert.equal(await getBalance(String(u)), 0);
});

test('PC-6 下架与不存在的道具不可兑换（下架断言要先证明在架时能过闸门）', async (t) => {
  await seedPointItems();
  await assert.rejects(() => exchangeItem(String(new Types.ObjectId()), 'nope', 'r'), (e) =>
    (e as AppError).statusCode === 404 && /道具不存在：nope/.test((e as Error).message));

  const u = new Types.ObjectId();
  t.after(() => wipe(u));
  // 先上架：兑换要能走过下架闸门（这里允许撞余额不足，说明闸门不在这一层）
  await PointItemModel.updateOne({ key: 'ad_free_30d' }, { $set: { unlimited: false, stock: 5 } });
  await onShelf('ad_free_30d');
  await assert.rejects(() => exchangeItem(String(u), 'ad_free_30d', 'r1'), /积分不足/);
  // 再下架：同一个用户同一个 key，报错必须换成「已下架」
  await PointItemModel.updateOne({ key: 'ad_free_30d' }, { $set: { active: false } });
  await assert.rejects(() => exchangeItem(String(u), 'ad_free_30d', 'r2'), /已下架/);
});

test('PC-7 发卡后记录落库失败：卡撤回、库存回补，重试只对应一次扣分与一张卡', async (t) => {
  await seedPointItems();
  await PointItemModel.updateOne({ key: 'ad_free_15d' }, { $set: { unlimited: false, stock: 3 } });
  await onShelf('ad_free_15d');
  const u = new Types.ObjectId();
  t.after(() => wipe(u));
  await seedBalance(u, 400); // 15 天卡目录价 400，恰好一张

  const model = PointExchangeModel as unknown as {
    create: (...args: unknown[]) => Promise<unknown>;
  };
  const realCreate = PointExchangeModel.create.bind(PointExchangeModel);
  model.create = async () => { throw new Error('exchange write boom'); };
  await assert.rejects(() => exchangeItem(String(u), 'ad_free_15d', `${u}-p7`), /exchange write boom/);
  model.create = realCreate as unknown as typeof model.create;

  // 卡撤回、这次占掉的库存必须回来（否则重试等于消耗两张库存）
  assert.equal(await PointCardModel.countDocuments({ userId: u }), 0);
  assert.equal((await PointItemModel.findOne({ key: 'ad_free_15d' }).lean())!.stock, 3,
    '兑换记录落库失败要回补库存');

  // 同 requestId 重试：账本按 idemKey 重放不二次扣分，最终一卡一记录、净扣一张库存
  const r = await exchangeItem(String(u), 'ad_free_15d', `${u}-p7`);
  assert.equal(await PointCardModel.countDocuments({ userId: u }), 1);
  assert.equal(await PointExchangeModel.countDocuments({ userId: u }), 1);
  assert.equal((await PointItemModel.findOne({ key: 'ad_free_15d' }).lean())!.stock, 2);
  assert.equal(await getBalance(String(u)), 0);
  assert.equal(r.cardId, String((await PointExchangeModel.findOne({ userId: u }).lean())!.cardId));
});

test('PC-8 目录行 validDays 非法（0）→ 400 点名道具，校验先于库存与发卡', async (t) => {
  const key = 't_dirty_valid_days';
  const u = new Types.ObjectId();
  t.after(async () => {
    await wipe(u);
    await PointItemModel.deleteMany({ key });
  });
  // raw insert 绕过 schema 的 min:1：模拟历史脏目录行（validDays=0 会让 expiresAt=now，卡发出去即过期）
  await PointItemModel.collection.insertOne({
    key, name: '脏目录道具', subtitle: '', description: '', notes: [],
    price: 100, validDays: 0, effect: { kind: 'ad_free', days: 7 },
    stock: 5, unlimited: false, active: true, sortOrder: 999, image: '',
    createdAt: new Date(), updatedAt: new Date(),
  });

  await assert.rejects(() => exchangeItem(String(u), key, `${u}-dirty`), (e) => {
    const err = e as AppError;
    // 文案点名道具 + 实际值 + 限制（与发放路径 validDays 校验同一口径）
    return err.statusCode === 400 && /脏目录道具/.test(err.message)
      && /validDays/.test(err.message) && /（validDays=0/.test(err.message);
  });
  assert.equal(await PointCardModel.countDocuments({ userId: u }), 0, '校验先于发卡');
  assert.equal((await PointItemModel.findOne({ key }).lean())!.stock, 5, '校验先于库存闸门，库存一分不动');
});

test('PC-9 回补库存失败要报出来：缺口进 data.refundFailed，不再只打日志', async (t) => {
  await seedPointItems();
  await PointItemModel.updateOne({ key: 'ad_free_30d' }, { $set: { unlimited: false, stock: 3 } });
  await onShelf('ad_free_30d');
  const u = new Types.ObjectId();
  const model = PointItemModel as unknown as { updateOne: (...args: unknown[]) => Promise<unknown> };
  const realUpdateOne = model.updateOne.bind(PointItemModel);
  const originalError = console.error;
  // 还原必须排在清场之前：清场自己也要用 PointItemModel.updateOne 刷回种子库存，
  // 若先跑清场会再撞一次被 mock 的抛错（PC-9b 的 before 就会连带红）
  t.after(async () => {
    model.updateOne = realUpdateOne;
    console.error = originalError;
    await wipe(u);
    // 刷回种子形态：unlimited 道具的 stock 只是展示位
    await PointItemModel.updateOne({ key: 'ad_free_30d' }, { $set: { unlimited: true, stock: 9999 } });
  });
  // 只让「回补库存」那一笔 updateOne 失败（抢库存走 findOneAndUpdate，不受影响）；控制台输出在用例里静音
  model.updateOne = async () => { throw new Error('stock refund boom'); };
  console.error = () => {};

  // 余额 0 → 扣分失败 → 回补库存；回补这一笔抛错。主文案仍是「积分不足」（前端据此引导赚分），
  // 但库存缺口必须进 data 与文案尾注，不许被 .catch(console.error) 吞掉。
  await assert.rejects(() => exchangeItem(String(u), 'ad_free_30d', `${u}-refund`), (e) => {
    const err = e as AppError;
    return err.statusCode === 400
      && /积分不足/.test(err.message)
      && /库存回补失败 1 张/.test(err.message)
      && err.extra?.refundFailed === 1;
  });
  assert.equal((await PointItemModel.findOne({ key: 'ad_free_30d' }).lean())!.stock, 2,
    '库存确实停在「扣了 1 张没退回」的状态（正常回补后应是 3）：这条断言证明刚才报出的缺口是真的');
  assert.equal(await PointCardModel.countDocuments({ userId: u }), 0);
});

test('PC-9b 正常兑换结果带 refundFailed: 0（成功路径也要有缺口字段）', async (t) => {
  await seedPointItems();
  await PointItemModel.updateOne({ key: 'makeup_card' }, { $set: { unlimited: true, stock: 9999 } });
  const u = new Types.ObjectId();
  t.after(() => wipe(u));
  await seedBalance(u, 200);

  const r = await exchangeItem(String(u), 'makeup_card', `${u}-ok`);
  assert.equal(r.refundFailed, 0, '没有回滚就没有缺口，字段仍要在（前端只是展示，不做缺失判断）');
  assert.equal(r.balance, 0);
});
