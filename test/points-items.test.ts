import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { config } from '../src/config/index.js';
import { POINTS } from '../src/config/points.js';
import {
  PointAccountModel, PointCardModel, PointDailyModel, PointExchangeModel, PointItemModel, PointLotModel, PointRecordModel,
} from '../src/models/point.model.js';
import { creditPoints, debitPoints, getBalance } from '../src/services/points-ledger.js';
import { seedPointItems } from '../src/services/points-catalog.js';
import { exchangeItem, listActiveItems, listExchanges } from '../src/services/points-items.js';
import { pointsOverview } from '../src/services/points-admin-stats.js';
import { bjDateStr } from '../src/utils/bj-time.js';
import { AppError } from '../src/utils/app-error.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 24, 2, 0, 0); // 2026-10-24 10:00 BJ

const created: Types.ObjectId[] = [];

/** 每个用例独立用户：账户/明细/卡/兑换记录都按 userId 隔离 */
function newUser(): Types.ObjectId {
  const id = new Types.ObjectId();
  created.push(id);
  return id;
}

const wipe = (u: Types.ObjectId) => Promise.all([
  PointExchangeModel.deleteMany({ userId: u }),
  PointCardModel.deleteMany({ userId: u }),
  PointRecordModel.deleteMany({ userId: u }),
  PointAccountModel.deleteMany({ userId: u }),
  PointLotModel.deleteMany({ userId: u }),
  PointDailyModel.deleteMany({ userId: u }),
]);

/**
 * 补签卡目录行的实时配置。价格与配图都是后台可改的运营项（2026-10-28 价格 200→49），
 * 用例按实时值算账：把 200 写死在断言里，运营改一次价就挂一片测试。
 */
const makeupCatalog = () => PointItemModel.findOne({ key: 'makeup_card' })
  .select({ price: 1, image: 1 }).lean();

/** 目录行配了图就必须下发签名缩略链，没配图才是空串（私有桶裸链会 403） */
function assertItemImageDto(imageUrl: string, image: string): void {
  if (!image) {
    assert.equal(imageUrl, '', '未配图的道具下发空串');
    return;
  }
  assert.match(imageUrl, /^https:\/\/.+Signature=/, '配了图必须签名下发');
  assert.match(decodeURIComponent(imageUrl), /x-oss-process=image\/resize,w_240/, '下发走缩略档位');
}

/** 造余额：每日上限 100，按业务日拆分发放，凑够 total */
async function seedPoints(u: Types.ObjectId, total: number): Promise<void> {
  let left = total;
  for (let i = 0; left > 0; i++) {
    const at = Date.UTC(2026, 9, 20 + i, 2, 0, 0);
    const points = Math.min(100, left);
    const r = await creditPoints(String(u), {
      type: 'seed',
      title: '测试积分',
      points,
      bizDate: bjDateStr(at),
      idemKey: `${u}:seed:${i}`,
    }, at);
    assert.equal(r.credited, points);
    left -= points;
  }
}

let tempSeq = 0;
/** 用例私有的限量目录行：不去改种子行的 stock/unlimited，避免污染共享库里的其它用例 */
async function tempItem(overrides: Record<string, unknown> = {}): Promise<string> {
  const key = `t_items_${Date.now()}_${tempSeq++}`;
  await PointItemModel.create({
    key, name: '测试道具', subtitle: '', description: '', notes: [],
    price: 200, validDays: 30, effect: { kind: 'makeup', days: 0 },
    kind: 'virtual', stock: 3, unlimited: false, active: true, sortOrder: 999, image: '',
    ...overrides,
  });
  return key;
}

before(async () => {
  // 单文件直跑不会经过 app 的 mongodb 插件，这里自行连接；不连时查询会一直 buffering
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  // 兑换记录唯一索引 (userId, requestId) 是异步建的，幂等/并发断言必须先等 init 完成
  await Promise.all([
    PointExchangeModel.init(), PointRecordModel.init(), PointAccountModel.init(),
    PointDailyModel.init(), PointItemModel.init(),
  ]);
  // 兑换链路改读道具目录：makeup_card 行必须在（幂等种子）
  await seedPointItems();
});

after(async () => {
  for (const u of created) await wipe(u);
  await mongoose.disconnect().catch(() => {});
});

test('PI1 按目录实时价兑换一张卡，30 天有效，兑换记录可查', async (t) => {
  const uid = newUser();
  t.after(() => wipe(uid));
  const catalog = await makeupCatalog();
  const price = catalog?.price ?? 0;
  assert.ok(price > 0, '目录行必须带价格');
  await seedPoints(uid, price);
  assert.equal(await getBalance(String(uid), NOW), price);

  // 商品列表：道具目录驱动，只下发在架项（ad_free_* 种子 active:false，这里只有补签卡）
  const items = await listActiveItems();
  const makeup = items.find((i) => i.key === 'makeup_card');
  assert.ok(makeup, '在架列表里应能查到补签卡');
  // price/imageUrl 是运营实时值，先从 DTO 里摘出来单独断，其余字段锁形状
  const { price: dtoPrice, imageUrl: dtoImage, ...dtoRest } = makeup;
  assert.deepEqual(dtoRest, {
    key: 'makeup_card',
    name: '补签卡',
    subtitle: '恢复连续打卡记录',
    validDays: 30,
    description: '每张仅可使用一次；可补签近 7 天窗口内的漏签日，补一天用一张；兑换后 30 天内有效',
    notes: [
      '每张补签卡仅可使用一次，每个漏签日最多补一次',
      '兑换后 30 天内有效，过期作废',
      '兑换后不退积分',
    ],
    effect: { kind: 'makeup', days: 0 },
    // 实物批次新增的三字段：补签卡是虚拟道具、不限购、无详情图，端上 DTO 必须照样带上
    kind: 'virtual',
    detailImages: [],
    perUserLimit: 0,
    // spec §7.3：unlimited 下发 null（端上显示「不限量」），限量道具下发剩余数
    stockLeft: null,
  });
  assert.equal(dtoPrice, price, 'DTO 价格 = 目录实时价');
  assertItemImageDto(dtoImage, catalog?.image ?? '');

  const r = await exchangeItem(String(uid), 'makeup_card', 'req-1', NOW);
  assert.equal(r.balance, 0);

  const card = await PointCardModel.findById(r.cardId).lean();
  assert.ok(card);
  assert.equal(String(card.userId), String(uid));
  assert.equal(card.itemKey, 'makeup_card');
  assert.equal(card.status, 'unused');
  assert.equal(card.expiresAt, NOW + POINTS.MAKEUP_CARD_VALID_DAYS * DAY);
  assert.equal(card.createdAt, NOW);
  assert.equal(card.usedForDate, '');

  // 扣分明细：兑换一条 −价格，业务日按东八区
  const record = await PointRecordModel.findOne({ userId: uid, type: 'exchange' }).lean();
  assert.ok(record);
  assert.equal(record.delta, -price);
  assert.equal(record.refType, 'item');
  assert.equal(record.refId, 'makeup_card');
  assert.equal(record.bizDate, bjDateStr(NOW));

  // 兑换记录关联刚发的卡
  const ex = await PointExchangeModel.findOne({ userId: uid, requestId: 'req-1' }).lean();
  assert.ok(ex);
  assert.equal(String(ex.cardId), r.cardId);
  assert.equal(ex.itemKey, 'makeup_card');
  assert.equal(ex.cost, price);
  assert.equal(ex.createdAt, NOW);

  const list = await listExchanges(String(uid), NOW);
  assert.equal(list.length, 1);
  assert.equal(list[0].cardId, r.cardId);
  assert.equal(list[0].status, 'unused');
  assert.equal(list[0].statusText, '未使用');
  assert.equal(list[0].expiresAt, NOW + POINTS.MAKEUP_CARD_VALID_DAYS * DAY);
});

test('PI2 同 requestId 重复兑换幂等，不重复扣分/发卡', async (t) => {
  const uid = newUser();
  t.after(() => wipe(uid));
  await seedPoints(uid, POINTS.MAKEUP_CARD_PRICE);

  const first = await exchangeItem(String(uid), 'makeup_card', 'req-1', NOW);
  const again = await exchangeItem(String(uid), 'makeup_card', 'req-1', NOW + 60000);

  assert.equal(again.cardId, first.cardId);
  assert.equal(again.balance, 0);
  assert.equal(await PointCardModel.countDocuments({ userId: uid }), 1);
  assert.equal(await PointExchangeModel.countDocuments({ userId: uid }), 1);
  assert.equal(await PointRecordModel.countDocuments({ userId: uid, type: 'exchange' }), 1);
  assert.equal(await getBalance(String(uid), NOW), 0);
  // 重放不刷新有效期：仍是首次兑换时刻 + 30 天
  assert.equal((await PointCardModel.findById(first.cardId).lean())?.expiresAt, NOW + 30 * DAY);
});

test('PI3 余额不足 400，文案包含当前值与所需值', async (t) => {
  const uid = newUser();
  t.after(() => wipe(uid));
  const price = (await makeupCatalog())?.price ?? 0;
  const short = price - 1; // 差 1 分：按实时价造，改价不会让这条用例悄悄变成恒过
  await seedPoints(uid, short);

  await assert.rejects(exchangeItem(String(uid), 'makeup_card', 'req-low', NOW), (e: Error) => {
    assert.ok(e instanceof AppError, '应为 AppError');
    assert.equal((e as AppError).statusCode, 400);
    assert.ok(
      e.message.includes(`当前 ${short}`) && e.message.includes(`需要 ${price}`),
      `文案要带实时价，实际「${e.message}」`,
    );
    return true;
  });

  // 失败不留痕：不扣分、不发卡、不落兑换记录
  assert.equal(await getBalance(String(uid), NOW), short);
  assert.equal(await PointCardModel.countDocuments({ userId: uid }), 0);
  assert.equal(await PointExchangeModel.countDocuments({ userId: uid }), 0);
  assert.equal(await PointRecordModel.countDocuments({ userId: uid, type: 'exchange' }), 0);

  // 缺少 requestId：直接 400，不触碰账本
  await assert.rejects(exchangeItem(String(uid), 'makeup_card', '  ', NOW), /缺少兑换请求 ID/);
  assert.equal(await getBalance(String(uid), NOW), short);
});

test('PI4 兑换记录按兑换时间倒序，状态与使用日期正确', async (t) => {
  const uid = newUser();
  t.after(() => wipe(uid));

  // 三条记录：未使用（有效期内）/ 已使用 / 未使用但已过期（状态需按 expiresAt 实时推导）
  const unusedCard = await PointCardModel.create({
    userId: uid, status: 'unused', expiresAt: NOW + 10 * DAY, createdAt: NOW - 3 * DAY,
  });
  const usedCard = await PointCardModel.create({
    userId: uid, status: 'used', usedForDate: '2026-10-23', expiresAt: NOW + 10 * DAY, createdAt: NOW - 2 * DAY,
  });
  const expiredCard = await PointCardModel.create({
    userId: uid, status: 'unused', expiresAt: NOW - 1, createdAt: NOW - DAY,
  });
  await PointExchangeModel.create({
    userId: uid, itemKey: 'makeup_card', cost: 200, cardId: unusedCard._id, requestId: 'e-old', createdAt: NOW - 3 * DAY,
  });
  await PointExchangeModel.create({
    userId: uid, itemKey: 'makeup_card', cost: 200, cardId: usedCard._id, requestId: 'e-used', createdAt: NOW - 2 * DAY,
  });
  await PointExchangeModel.create({
    userId: uid, itemKey: 'makeup_card', cost: 200, cardId: expiredCard._id, requestId: 'e-expired', createdAt: NOW - DAY,
  });

  const list = await listExchanges(String(uid), NOW);
  assert.deepEqual(list.map((x) => x.status), ['expired', 'used', 'unused']);
  assert.deepEqual(list.map((x) => x.statusText), ['已过期', '已使用', '未使用']);
  assert.equal(list[0].cardId, String(expiredCard._id));
  assert.equal(list[0].usedForDate, '');
  assert.equal(list[1].usedForDate, '2026-10-23');
  assert.equal(list[2].expiresAt, NOW + 10 * DAY);
  assert.equal(list[0].cost, 200);
  assert.equal(list[0].itemKey, 'makeup_card');
  assert.equal(list[0].createdAt, NOW - DAY);
});

test('PI5 并发同 requestId 只扣一次分、只发一张卡', async (t) => {
  const uid = newUser();
  t.after(() => wipe(uid));
  // 余额留出两张卡的空间：并发两笔都先过余额闸门，靠账本 idemKey 去重只认一笔
  const price = (await makeupCatalog())?.price ?? 0;
  await seedPoints(uid, 2 * price);

  const [a, b] = await Promise.all([
    exchangeItem(String(uid), 'makeup_card', 'req-race', NOW),
    exchangeItem(String(uid), 'makeup_card', 'req-race', NOW),
  ]);

  assert.equal(a.cardId, b.cardId);
  assert.equal(a.balance, price);
  assert.equal(b.balance, price);
  assert.equal(await PointCardModel.countDocuments({ userId: uid }), 1); // 失败方不会留下孤儿卡
  assert.equal(await PointExchangeModel.countDocuments({ userId: uid }), 1);
  assert.equal(await PointRecordModel.countDocuments({ userId: uid, type: 'exchange' }), 1);
  assert.equal(await getBalance(String(uid), NOW), price);
});

test('PI6 余额恰好用尽的双击：后到请求命中在途兑换记录，返回同一张卡', async (t) => {
  const uid = newUser();
  t.after(() => wipe(uid));

  // 请求 A 的成果：扣光 200 → 余额 0；本用例不造积分，兑换记录在「夹缝」里落库（见下）
  const cardA = await PointCardModel.create({
    userId: uid, status: 'unused', expiresAt: NOW + POINTS.MAKEUP_CARD_VALID_DAYS * DAY, createdAt: NOW,
  });
  const seedExchangeRow = () => PointExchangeModel.create({
    userId: uid, itemKey: 'makeup_card', cost: 200, cardId: cardA._id, requestId: 'req-dbl', createdAt: NOW,
  });

  // 复现「B 的前置查询早于 A 落库、B 的扣分晚于 A 扣分」的窗口：
  // 第一次 findOne 真的查过库（此刻还没有记录），查到之后才让 A 的兑换记录落库
  const model = PointExchangeModel as unknown as {
    findOne: (...args: unknown[]) => { lean: () => Promise<unknown> };
  };
  const realFindOne = PointExchangeModel.findOne.bind(PointExchangeModel);
  let calls = 0;
  model.findOne = (...args: unknown[]) => {
    calls += 1;
    const query = (realFindOne as unknown as typeof model.findOne)(...args);
    if (calls === 1) {
      return {
        lean: async () => {
          const row = await query.lean();
          await seedExchangeRow();
          return row;
        },
      };
    }
    return query;
  };
  t.after(() => { model.findOne = realFindOne as unknown as typeof model.findOne; });

  const r = await exchangeItem(String(uid), 'makeup_card', 'req-dbl', NOW);

  // 命中在途记录：返回 A 的卡，而不是抛 400「积分不足」
  assert.equal(r.cardId, String(cardA._id));
  assert.equal(r.balance, 0);
  assert.equal(calls, 2, '应补查一次兑换记录');
  assert.equal(await PointCardModel.countDocuments({ userId: uid }), 1);
  assert.equal(await PointExchangeModel.countDocuments({ userId: uid }), 1);
  assert.equal(await PointRecordModel.countDocuments({ userId: uid }), 0); // 没有第二次扣分
});

test('PI7 兑换记录写失败不留孤儿卡，重试仍只对应一次扣分', async (t) => {
  const uid = newUser();
  t.after(() => wipe(uid));
  await seedPoints(uid, POINTS.MAKEUP_CARD_PRICE);

  const model = PointExchangeModel as unknown as {
    create: (...args: unknown[]) => Promise<unknown>;
  };
  const realCreate = PointExchangeModel.create.bind(PointExchangeModel);
  const restore = () => { model.create = realCreate as unknown as typeof model.create; };
  t.after(restore);

  // 非重复键失败：卡已发出但兑换记录写不进去
  model.create = async () => { throw new Error('exchange write boom'); };
  await assert.rejects(exchangeItem(String(uid), 'makeup_card', 'req-orphan', NOW), /exchange write boom/);

  // M1/M2 不变量（A）：扣分必须真正撤销，卡与库存一起回滚——不能留下「扣了分没卡」
  assert.equal(await PointCardModel.countDocuments({ userId: uid }), 0);
  assert.equal(await PointExchangeModel.countDocuments({ userId: uid }), 0);
  assert.equal(await getBalance(String(uid), NOW), POINTS.MAKEUP_CARD_PRICE, '失败后余额回到扣分前');
  const failedAcc = await PointAccountModel.findOne({ userId: uid }).lean();
  assert.equal(failedAcc?.totalSpent, 0, 'totalSpent 也必须回滚');

  // 恢复后重试：原扣分行已撤销，重新扣一次分；净结果仍是一扣分对应一卡一记录
  restore();
  const r = await exchangeItem(String(uid), 'makeup_card', 'req-orphan', NOW);
  assert.equal(await PointCardModel.countDocuments({ userId: uid }), 1);
  assert.equal(await PointExchangeModel.countDocuments({ userId: uid }), 1);
  assert.equal(await PointRecordModel.countDocuments({ userId: uid, type: 'exchange' }), 1);
  assert.equal(r.balance, 0);
  assert.equal(String((await PointExchangeModel.findOne({ userId: uid, requestId: 'req-orphan' }).lean())?.cardId), r.cardId);
});

/**
 * M1/M2 不变量（A：all-or-nothing）：
 * 过了库存闸门之后的任何失败，balance / totalSpent / 批次 / 库存 / 卡 / 兑换记录都必须回到调用前。
 * 失败注入只打「发卡」与「兑换记录」两步；补偿走账本里的 exchange_reversed（原扣分行降级）+
 * exchange_refund（+N），两者都不进概况的发放/消耗口径。
 */
const patchModel = (model: object, method: string) => {
  const box = model as Record<string, unknown>;
  const real = (box[method] as (...args: unknown[]) => unknown).bind(model);
  return {
    set: (impl: unknown) => { box[method] = impl; },
    restore: () => { box[method] = real; },
  };
};

test('X1 发卡失败：余额/累计消耗/批次/库存/卡/兑换记录全部回到调用前', async (t) => {
  const uid = newUser();
  const key = await tempItem();
  t.after(async () => { await wipe(uid); await PointItemModel.deleteMany({ key }); });
  await seedPoints(uid, 200);
  const beforeLots = await PointLotModel.find({ userId: uid }).sort({ _id: 1 }).lean();
  assert.equal(beforeLots.length, 2, '前置条件：两笔 100 的批次');

  const cardCreate = patchModel(PointCardModel, 'create');
  cardCreate.set(async () => { throw new Error('card create boom'); });
  try {
    await assert.rejects(() => exchangeItem(String(uid), key, 'rid-x1', NOW), /card create boom/);
  } finally {
    cardCreate.restore();
  }

  const acc = await PointAccountModel.findOne({ userId: uid }).lean();
  assert.equal(acc?.balance, 200, '余额必须回到扣分前');
  assert.equal(acc?.totalSpent, 0, 'totalSpent 必须一起回滚（不是只把余额加回来）');
  assert.equal(await PointCardModel.countDocuments({ userId: uid }), 0, '不许留孤儿卡');
  assert.equal(await PointExchangeModel.countDocuments({ userId: uid }), 0, '不许落兑换记录');
  assert.equal((await PointItemModel.findOne({ key }).lean())!.stock, 3, '库存回到调用前');
  const lots = await PointLotModel.find({ userId: uid }).sort({ _id: 1 }).lean();
  assert.deepEqual(lots.map((l) => l.remaining), beforeLots.map((l) => l.remaining), '批次剩余原样恢复');
  assert.equal(await PointRecordModel.countDocuments({ userId: uid, type: 'exchange' }), 0,
    '失败的扣分不能留在 exchange 口径里');
  assert.equal(await PointRecordModel.countDocuments({ userId: uid, type: 'exchange_refund' }), 1,
    '必须留下补偿明细');
  const [sum] = await PointRecordModel.aggregate<{ sum: number }>([
    { $match: { userId: uid } }, { $group: { _id: null, sum: { $sum: '$delta' } } },
  ]);
  assert.equal(sum.sum, 200, 'Σdelta 仍等于余额（补偿行必须真实入账）');
});

test('X2 兑换记录写失败：同一不变量成立（全部回到调用前）', async (t) => {
  const uid = newUser();
  const key = await tempItem();
  t.after(async () => { await wipe(uid); await PointItemModel.deleteMany({ key }); });
  await seedPoints(uid, 200);
  const beforeLots = await PointLotModel.find({ userId: uid }).sort({ _id: 1 }).lean();

  const exCreate = patchModel(PointExchangeModel, 'create');
  exCreate.set(async () => { throw new Error('exchange write boom'); });
  try {
    await assert.rejects(() => exchangeItem(String(uid), key, 'rid-x2', NOW), /exchange write boom/);
  } finally {
    exCreate.restore();
  }

  const acc = await PointAccountModel.findOne({ userId: uid }).lean();
  assert.equal(acc?.balance, 200);
  assert.equal(acc?.totalSpent, 0);
  assert.equal(await PointCardModel.countDocuments({ userId: uid }), 0);
  assert.equal(await PointExchangeModel.countDocuments({ userId: uid }), 0);
  assert.equal((await PointItemModel.findOne({ key }).lean())!.stock, 3);
  const lots = await PointLotModel.find({ userId: uid }).sort({ _id: 1 }).lean();
  assert.deepEqual(lots.map((l) => l.remaining), beforeLots.map((l) => l.remaining));
  assert.equal(await PointRecordModel.countDocuments({ userId: uid, type: 'exchange' }), 0);
  assert.equal(await PointRecordModel.countDocuments({ userId: uid, type: 'exchange_refund' }), 1);
});

test('X3 部分失败后同 requestId 重放：至多一卡、一次扣分、一条兑换记录', async (t) => {
  const uid = newUser();
  const key = await tempItem();
  t.after(async () => { await wipe(uid); await PointItemModel.deleteMany({ key }); });
  await seedPoints(uid, 200);

  const exCreate = patchModel(PointExchangeModel, 'create');
  const realCreate = PointExchangeModel.create.bind(PointExchangeModel);
  let calls = 0;
  exCreate.set(async (...args: unknown[]) => {
    calls += 1;
    if (calls === 1) throw new Error('exchange write boom');
    return (realCreate as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
  });
  try {
    await assert.rejects(() => exchangeItem(String(uid), key, 'rid-x3', NOW), /exchange write boom/);
    const r = await exchangeItem(String(uid), key, 'rid-x3', NOW);
    const card = await PointCardModel.findById(r.cardId).lean();
    assert.ok(card, '重放必须返回真实存在的卡');
  } finally {
    exCreate.restore();
  }

  assert.equal(await PointCardModel.countDocuments({ userId: uid }), 1);
  assert.equal(await PointExchangeModel.countDocuments({ userId: uid }), 1);
  assert.equal(await PointRecordModel.countDocuments({ userId: uid, type: 'exchange' }), 1,
    '只有成功那次留在 exchange 口径里');
  assert.equal(await PointRecordModel.countDocuments({ userId: uid, type: 'exchange_refund' }), 1);
  const acc = await PointAccountModel.findOne({ userId: uid }).lean();
  assert.equal(acc?.balance, 0);
  assert.equal(acc?.totalSpent, 200, '净扣仍只有一次');
  assert.equal((await PointItemModel.findOne({ key }).lean())!.stock, 2, '库存只扣成功那张');
});

test('X4 补偿行不污染管理端口径：失败兑换前后概况增量全 0，不变式仍成立', async (t) => {
  const uid = newUser();
  const key = await tempItem();
  t.after(async () => { await wipe(uid); await PointItemModel.deleteMany({ key }); });
  await seedPoints(uid, 200);
  const before = await pointsOverview(NOW);

  const exCreate = patchModel(PointExchangeModel, 'create');
  exCreate.set(async () => { throw new Error('exchange write boom'); });
  try {
    await assert.rejects(() => exchangeItem(String(uid), key, 'rid-x4', NOW), /exchange write boom/);
  } finally {
    exCreate.restore();
  }

  const after = await pointsOverview(NOW);
  assert.deepEqual({
    earnedGross: after.earnedGross - before.earnedGross,
    rolledBack: after.rolledBack - before.rolledBack,
    spentExchange: after.spentExchange - before.spentExchange,
    spentExpire: after.spentExpire - before.spentExpire,
    balance: after.balance - before.balance,
  }, { earnedGross: 0, rolledBack: 0, spentExchange: 0, spentExpire: 0, balance: 0 },
  '撤销对（exchange_reversed + exchange_refund）既不是发放也不是消耗，余额也复原');
  assert.equal(after.earnedGross - after.rolledBack - after.spentExchange - after.spentExpire, after.balance,
    'spec §6.5 不变式在补偿之后仍成立');
});

test('X5 兑换记录指向已删除的卡：重放不返回死 id，按账本重放补发一张卡', async (t) => {
  const uid = newUser();
  const key = await tempItem();
  t.after(async () => { await wipe(uid); await PointItemModel.deleteMany({ key }); });
  await seedPoints(uid, 200);
  const r = await debitPoints(String(uid), {
    type: 'exchange', title: '兑换测试道具', points: 200, bizDate: bjDateStr(NOW),
    refType: 'item', refId: key, idemKey: `exchange:${uid}:rid-x5`,
  }, NOW);
  assert.equal(r.balance, 0);
  const dead = await PointCardModel.create({
    userId: uid, itemKey: key, status: 'unused', expiresAt: NOW + 30 * DAY, createdAt: NOW,
  });
  await PointCardModel.deleteOne({ _id: dead._id });
  await PointExchangeModel.create({
    userId: uid, itemKey: key, cost: 200, cardId: dead._id, requestId: 'rid-x5', createdAt: NOW,
  });

  const again = await exchangeItem(String(uid), key, 'rid-x5', NOW);
  assert.notEqual(again.cardId, String(dead._id), '不能把已删除卡的 id 返回给端上');
  assert.ok(await PointCardModel.findById(again.cardId).lean(), '返回的卡必须真实存在');
  assert.equal(again.balance, 0, '账本重放不二次扣分');
  assert.equal(await PointCardModel.countDocuments({ userId: uid }), 1);
  assert.equal(await PointExchangeModel.countDocuments({ userId: uid }), 1);
  assert.equal(String((await PointExchangeModel.findOne({ userId: uid }).lean())!.cardId), again.cardId);
});

test('X6 effect.days 非有限数：400 点名道具，先于库存闸门与发卡', async (t) => {
  const uid = newUser();
  const key = `t_items_nan_days_${Date.now()}`;
  t.after(async () => { await wipe(uid); await PointItemModel.deleteMany({ key }); });
  await seedPoints(uid, 200);
  await PointItemModel.collection.insertOne({
    key, name: '脏权益天数道具', subtitle: '', description: '', notes: [],
    price: 200, validDays: 30, effect: { kind: 'ad_free', days: NaN },
    stock: 5, unlimited: false, active: true, sortOrder: 999, image: '',
    createdAt: new Date(), updatedAt: new Date(),
  });

  await assert.rejects(() => exchangeItem(String(uid), key, 'rid-x6', NOW), (e) => {
    const err = e as AppError;
    return err.statusCode === 400 && /脏权益天数道具/.test(err.message)
      && /effect\.days/.test(err.message) && /NaN/.test(err.message);
  });
  assert.equal(await PointCardModel.countDocuments({ userId: uid }), 0);
  assert.equal((await PointItemModel.findOne({ key }).lean())!.stock, 5, '校验先于库存闸门');
});

test('X7 删卡失败不阻断库存回补与扣分撤销（S4）', async (t) => {
  const uid = newUser();
  const key = await tempItem();
  t.after(async () => { await wipe(uid); await PointItemModel.deleteMany({ key }); });
  await seedPoints(uid, 200);

  const exCreate = patchModel(PointExchangeModel, 'create');
  const cardDelete = patchModel(PointCardModel, 'deleteOne');
  const originalError = console.error;
  exCreate.set(async () => { throw new Error('exchange write boom'); });
  cardDelete.set(async () => { throw new Error('card delete boom'); });
  console.error = () => {};
  try {
    await assert.rejects(() => exchangeItem(String(uid), key, 'rid-x7', NOW), /exchange write boom/);
  } finally {
    exCreate.restore();
    cardDelete.restore();
    console.error = originalError;
  }

  assert.equal((await PointItemModel.findOne({ key }).lean())!.stock, 3,
    '删卡失败也必须先把库存退回来，不能把异常冒泡到库存回补之前');
  const acc = await PointAccountModel.findOne({ userId: uid }).lean();
  assert.equal(acc?.balance, 200, '扣分撤销不依赖删卡成功');
  assert.equal(acc?.totalSpent, 0);
});
