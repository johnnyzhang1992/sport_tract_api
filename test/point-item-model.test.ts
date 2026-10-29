import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { POINTS } from '../src/config/points.js';
import { PointItemModel } from '../src/models/point.model.js';
import { seedPointItems, POINT_ITEM_KEYS } from '../src/services/points-catalog.js';

/**
 * PI-0 启动钩子接线：buildApp+ready 后 onReady 必须把目录播种出来（本用例不直连 seedPointItems）
 * PI-1 四条种子齐全且价格/有效期符合 spec §5.3
 * PI-2 种子幂等：改过价格再跑一次不被覆盖（自给自足：先播种再改价，且断言 updateOne 命中）
 * PI-3 effect 校验：ad_free 必须带 days>0，makeup_card 是 makeup 效果（schema 表达不了，留给 service，本条钉住现状）
 */
/**
 * 这四行在共享 dev 库里就是**运营配置**（价格、配图、上架状态都在后台改过，不在代码里）。
 * 本文件为了验种子定义必须先删后种，所以收尾不能只种回默认值——那会把后台配的道具图冲成空串
 * （2026-10-28 起每跑一次全量回归就冲一次，商品页 hero 跟着退化成首字占位）。
 * 口径改成：开跑前快照、收尾按快照还原；库里本来没行（新库）才退回默认种子。
 */
let seedSnapshot: Record<string, unknown>[] = [];
before(async () => {
  await mongoose.connect(config.mongodbUri);
  await PointItemModel.init();
  const rows = await PointItemModel.find({ key: { $in: Object.values(POINT_ITEM_KEYS) } }).lean();
  seedSnapshot = rows.map(({ _id, ...rest }) => rest as Record<string, unknown>);
});
// PI-2 中途断言失败会把 price=777 之类的脏值留在共享 dev 库里，且幂等种子永远冲不掉它；
// after 统一「删了重种」兜底，保证本文件无论成败都以干净种子退出。
// PI-0 在 app 上挂了 onClose→mongoose.disconnect()，须在种完干净数据后才 close（见 admin-user-stats.test.ts 同款收尾）。
let bootApp: FastifyInstance | undefined;
after(async () => {
  await PointItemModel.deleteMany({ key: { $in: Object.values(POINT_ITEM_KEYS) } });
  if (seedSnapshot.length === 0) {
    await seedPointItems();
  } else {
    await Promise.all(seedSnapshot.map((r) => PointItemModel.updateOne(
      { key: r.key }, { $set: r }, { upsert: true },
    )));
  }
  await bootApp?.close();
  await mongoose.disconnect();
});

test('PI-0 启动钩子真的会播种', async () => {
  // 先把四行删干净，让断言只可能由 onReady 里的 seedPointItems() 满足——
  // 谁把它从 onReady 摘掉，本用例必须红（PI-1/PI-2/PI-3 直连 seedPointItems()，抓不到接线回归）。
  await PointItemModel.deleteMany({ key: { $in: Object.values(POINT_ITEM_KEYS) } });
  bootApp = await buildApp({ logger: false });
  await bootApp.ready();
  const seeded = await PointItemModel.findOne({ key: 'makeup_card' });
  assert.ok(seeded, 'buildApp+ready 后 makeup_card 必须已由 onReady 钩子播种进库');
});

test('PI-1 四条种子', async () => {
  // kind / detailImages / perUserLimit 是实物批次后加的字段：老库里的四行物理上没有它们，
  // 而幂等种子只 $setOnInsert 补不上（PI-2 钉这条「不覆盖」）。先删后种，断言针对的是种子定义本身。
  await PointItemModel.deleteMany({ key: { $in: Object.values(POINT_ITEM_KEYS) } });
  await seedPointItems();
  const rows = await PointItemModel.find({ key: { $in: Object.values(POINT_ITEM_KEYS) } }).lean();
  assert.equal(rows.length, 4, '四条道具种子必须都在');
  const byKey = new Map(rows.map((r) => [r.key, r]));
  // 补签卡价引用 config 常量（2026-10-29 定稿 99）：这条断言要的是「种子价 == 代码默认价」，
  // 不是那个数字本身；免广告三档没抽常量，仍按种子字面值钉
  assert.equal(byKey.get('makeup_card')!.price, POINTS.MAKEUP_CARD_PRICE);
  assert.equal(byKey.get('ad_free_7d')!.price, 200);
  assert.equal(byKey.get('ad_free_15d')!.price, 400);
  assert.equal(byKey.get('ad_free_30d')!.price, 600);
  for (const r of rows) {
    assert.equal(r.validDays, 30, '卡本身有效期统一 30 天');
    assert.equal(r.unlimited, true, '四条默认都不限量');
    assert.equal(r.stock, 9999);
    // 四条种子全是虚拟道具：实物由后台显式新建（默认限购 1），种子一个都不许变成实物
    assert.equal(r.kind, 'virtual', `${r.key} 种子必须是 virtual`);
    assert.equal(r.perUserLimit, 0, `${r.key} 种子不限购（0 = 不限）`);
    assert.deepEqual(r.detailImages, [], `${r.key} 种子没有详情图`);
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
  await seedPointItems(); // 自给自足：不依赖 PI-1/PI-0 先跑过，新库上下面的 updateOne 才不会落空
  const upd = await PointItemModel.updateOne({ key: 'ad_free_7d' }, { $set: { price: 777, stock: 3, unlimited: false } });
  assert.equal(upd.matchedCount, 1, '前置 updateOne 必须命中 ad_free_7d，否则幂等断言是空跑');
  await seedPointItems();
  const r = await PointItemModel.findOne({ key: 'ad_free_7d' }).lean();
  assert.equal(r!.price, 777, '重跑种子不得把后台改过的价格冲掉');
  assert.equal(r!.stock, 3);
  assert.equal(r!.unlimited, false);
  await PointItemModel.deleteOne({ _id: r!._id }); // 清掉本用例的脏值，让 PI-1 的断言可重跑
  await seedPointItems();
});

test('PI-3 effect 校验：ad_free 必带 days>0，makeup_card 是 makeup 效果', async () => {
  await seedPointItems();
  const rows = await PointItemModel.find({ key: { $in: Object.values(POINT_ITEM_KEYS) } }).lean();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const days of [7, 15, 30]) {
    const r = byKey.get(`ad_free_${days}d`)!;
    assert.equal(r.effect.kind, 'ad_free', `ad_free_${days}d 的 effect.kind 必须是 ad_free`);
    assert.ok(r.effect.days > 0, `ad_free_${days}d 的 effect.days 必须 >0`);
  }
  assert.equal(byKey.get('makeup_card')!.effect.kind, 'makeup');
});
