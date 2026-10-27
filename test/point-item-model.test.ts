import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { PointItemModel } from '../src/models/point.model.js';
import { seedPointItems, POINT_ITEM_KEYS } from '../src/services/points-catalog.js';

/**
 * PI-1 四条种子齐全且价格/有效期符合 spec §5.3
 * PI-2 种子幂等：改过价格再跑一次不被覆盖
 * PI-3 effect 校验：ad_free 必须带 days>0（schema 表达不了，留给 service，本条先钉住现状）
 */
before(async () => {
  await mongoose.connect(config.mongodbUri);
  await PointItemModel.init();
});
// PI-2 中途断言失败会把 price=777 之类的脏值留在共享 dev 库里，且幂等种子永远冲不掉它；
// after 统一「删了重种」兜底，保证本文件无论成败都以干净种子退出。
after(async () => {
  await PointItemModel.deleteMany({ key: { $in: Object.values(POINT_ITEM_KEYS) } });
  await seedPointItems();
  await mongoose.disconnect();
});

test('PI-1 四条种子', async () => {
  await seedPointItems();
  const rows = await PointItemModel.find({ key: { $in: Object.values(POINT_ITEM_KEYS) } }).lean();
  assert.equal(rows.length, 4, '四条道具种子必须都在');
  const byKey = new Map(rows.map((r) => [r.key, r]));
  assert.equal(byKey.get('makeup_card')!.price, 200);
  assert.equal(byKey.get('ad_free_7d')!.price, 200);
  assert.equal(byKey.get('ad_free_15d')!.price, 400);
  assert.equal(byKey.get('ad_free_30d')!.price, 600);
  for (const r of rows) {
    assert.equal(r.validDays, 30, '卡本身有效期统一 30 天');
    assert.equal(r.unlimited, true, '四条默认都不限量');
    assert.equal(r.stock, 9999);
  }
  assert.equal(byKey.get('ad_free_15d')!.effect.days, 15);
  assert.equal(byKey.get('makeup_card')!.effect.kind, 'makeup');
  // 上架状态：只有补签卡 active（老端首页是 wx:for 渲染，ad_free 三档等客户端能按 key 路由后再开）
  assert.equal(byKey.get('makeup_card')!.active, true, 'makeup_card 必须上架');
  for (const k of ['ad_free_7d', 'ad_free_15d', 'ad_free_30d']) {
    assert.equal(byKey.get(k)!.active, false, `${k} 起步不上架`);
  }
});

test('PI-2 种子幂等，不覆盖后台改动', async () => {
  await PointItemModel.updateOne({ key: 'ad_free_7d' }, { $set: { price: 777, stock: 3, unlimited: false } });
  await seedPointItems();
  const r = await PointItemModel.findOne({ key: 'ad_free_7d' }).lean();
  assert.equal(r!.price, 777, '重跑种子不得把后台改过的价格冲掉');
  assert.equal(r!.stock, 3);
  assert.equal(r!.unlimited, false);
  await PointItemModel.deleteOne({ _id: r!._id }); // 清掉本用例的脏值，让 PI-1 的断言可重跑
  await seedPointItems();
});
