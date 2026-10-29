import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { config } from '../src/config/index.js';
import { POINTS } from '../src/config/points.js';
import {
  PointAccountModel, PointCardModel, PointDailyModel, PointDailyQuotaModel, PointExchangeModel,
  PointItemModel, PointLotModel, PointOrderModel, PointRecordModel,
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
  PointOrderModel.deleteMany({ userId: u }),
  PointRecordModel.deleteMany({ userId: u }),
  PointAccountModel.deleteMany({ userId: u }),
  PointLotModel.deleteMany({ userId: u }),
  PointDailyModel.deleteMany({ userId: u }),
  // Task 3 计数器：个人行按 userId 存的是 String(ObjectId)，DQ 用例建的行必须跟着人删干净
  PointDailyQuotaModel.deleteMany({ userId: String(u) }),
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

/** 目录展示行（todayLeft 的数据源＝兑换台账，Task 2 口径） */
const findRow = async (key: string) => (await listActiveItems()).find((i) => i.key === key)!;

/**
 * 强制侧计数器行（Task 3 闸门的数据源）：{key,dateKey,userId}，userId 空串＝当日总量行。
 * dateKey 用**用例捕获的 now** 派生（裁定 3 同款）：闸门建行就按调用方传入的 now，
 * helper 若现取挂钟，用例恰在东八区零点前后跑就会两侧错位、断言假红（修复轮 1 finding 5）。
 */
const quotaRow = (key: string, userId: string, now: number) => PointDailyQuotaModel
  .findOne({ key, dateKey: bjDateStr(now), userId }).lean();

/** 清用例私有的目录行 + 它名下的计数器行（共享库纪律：t_ 前缀行连闸门计数器一起删） */
async function dropTemp(keys: string | string[], ...users: Types.ObjectId[]): Promise<void> {
  const ks = Array.isArray(keys) ? keys : [keys];
  await Promise.all([
    PointItemModel.deleteMany({ key: { $in: ks } }),
    PointDailyQuotaModel.deleteMany({ key: { $in: ks } }),
    ...users.map((u) => wipe(u)),
  ]);
}

before(async () => {
  // 单文件直跑不会经过 app 的 mongodb 插件，这里自行连接；不连时查询会一直 buffering
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  // 兑换记录唯一索引 (userId, requestId) 是异步建的，幂等/并发断言必须先等 init 完成
  // （PointDailyQuotaModel 的 {key,dateKey,userId} unique 同理：基线行并发建行靠它去重）
  await Promise.all([
    PointExchangeModel.init(), PointRecordModel.init(), PointAccountModel.init(),
    PointDailyModel.init(), PointItemModel.init(), PointDailyQuotaModel.init(),
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
    // 2026-10-28 每日投放批次新增的三字段：未配置时 0＝不限，不限时 todayLeft 必须下发 null
    dailyQuota: 0,
    perUserDaily: 0,
    todayLeft: null,
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

/**
 * 每日投放字段（2026-10-28 榜单发积分同批，Task 2）：
 * todayLeft 的数据源＝兑换台账（type:'exchange' + refType:'item' + refId=itemKey + bizDate=当日东八区），
 * 不新建计数器表；当日计数是「全平台」口径——每人每日上限是 Task 3 兑换链的闸门，不混进展示字段。
 * 共享 dev 库纪律：只用自己的 t_ 前缀临时行断言差值，绝不对平台总量做绝对值断言。
 */
test('PI-DQ-1 目录下发每日投放字段，缺省＝不限', async () => {
  const row = (await listActiveItems()).find((i) => i.key === 'makeup_card')!;
  assert.ok(row, '补签卡必须在架');
  assert.equal(row.dailyQuota, 0, '未配置时 0＝不限');
  assert.equal(row.perUserDaily, 0);
  assert.equal(row.todayLeft, null, '不限时下发 null，端上不显示「今日剩余」');
});

test('PI-DQ-2 每日投放数按当日已兑数扣减（全平台台账口径，扣到 0 封底）', async (t) => {
  const uid = newUser();
  // 第二个用户的台账行同样扣 todayLeft：证明这是平台口径，不是用户口径
  const other = newUser();
  const key = await tempItem({ dailyQuota: 2, unlimited: true });
  // Task 3 之后这条真实兑换会顺手建当日计数器行：目录行删了计数器也要跟着删（共享库纪律）
  t.after(() => dropTemp(key, uid, other));

  const findRow = async () => (await listActiveItems()).find((i) => i.key === key)!;
  const row0 = await findRow();
  assert.equal(row0.dailyQuota, 2, '配置要原样下发');
  assert.equal(row0.perUserDaily, 0, '没配每人上限就是 0＝不限');
  assert.equal(row0.todayLeft, 2, '当日没人兑：剩余＝投放数');

  await seedPoints(uid, 200);
  // 台账 bizDate 必须落在真实「今日」：listActiveItems 按当日东八区计数，固定 NOW 的历史时刻对不上
  const now = Date.now();
  await exchangeItem(String(uid), key, 'req-dq-2', now);
  assert.equal((await findRow()).todayLeft, 1, '今日已兑 1 张，剩 1');

  // 直接补写台账的第二、三行（别的用户兑的）：扣减按平台全量，且不能扣成负数
  const synth = (i: number) => PointRecordModel.create({
    userId: other, type: 'exchange', title: '兑换测试道具', delta: -200, balanceAfter: 0,
    bizDate: bjDateStr(now), refType: 'item', refId: key, idemKey: `${other}:dq-synth:${i}`, createdAt: now,
  });
  await synth(1);
  assert.equal((await findRow()).todayLeft, 0, '当日已兑满投放数：剩 0');
  await synth(2);
  assert.equal((await findRow()).todayLeft, 0, '已兑数超出投放数也只能封底 0，不许出负数');
});

test('PI-DQ-3 老目录行物理缺 dailyQuota：兜底 0/不限、todayLeft=null，不报错', async (t) => {
  const key = `t_items_legacy_${Date.now()}`;
  t.after(() => PointItemModel.deleteMany({ key }));
  // raw insert 绕过 schema 默认值：字段上线前入库的 dev 目录行就是这个物理形态（同 PC-10 的老行口径）
  await PointItemModel.collection.insertOne({
    key, name: '老目录道具', subtitle: '', description: '', notes: [],
    price: 100, validDays: 30, effect: { kind: 'makeup', days: 0 },
    stock: 5, unlimited: false, active: true, sortOrder: 998, image: '',
    createdAt: new Date(), updatedAt: new Date(),
  });
  const row = (await listActiveItems()).find((i) => i.key === key)!;
  assert.equal(row.dailyQuota, 0, '物理缺字段按 0＝不限兜底（同 perUserLimit 的惯用法）');
  assert.equal(row.perUserDaily, 0);
  assert.equal(row.todayLeft, null, '不限投放不能下发 0（端上会显示「今日剩余 0 张」）');
});

/**
 * 每日投放的原子闸门（2026-10-28 榜单发积分同批，Task 3）：
 * - 强制侧＝新计数器 PointDailyQuota（条件 $inc 原子抢槽，userId 空串＝当日总量行）；
 * - 展示侧 todayLeft＝兑换台账（Task 2 数据源，不动）；DQ-4/DQ-5 钉「回补后两侧一致」；
 * - 闸门顺序固定：限购 → 每日额度 → 库存 → 扣分（裁定 1；原「兑换满 180 天」已由产品去掉，不许加回）；
 * - dateKey 由调用方传入的 now 派生（裁定 3），不在闸门里现取 Date.now()；
 * - 超限文案为逐字批准版（对象 + 实际值 + 上限 + 刷新时间），不许改写。
 * 共享库纪律：计数器行/目录行都在 t.after 里按 key 删净；台账类断言全部按本用例的 key/userId 收口。
 */
test('DQ-1 当日投放兑完后第 N+1 次 400，逐字文案含对象/张数/每人限/刷新时间，且不碰库存与分', async (t) => {
  const uid = newUser();
  const key = await tempItem({ dailyQuota: 1, perUserDaily: 1 });
  t.after(() => dropTemp(key, uid));
  await seedPoints(uid, 400);
  const now = Date.now();

  await exchangeItem(String(uid), key, 'req-dq1-1', now);
  assert.equal((await quotaRow(key, '', now))?.count, 1, '第一张占了总量行一格');
  assert.equal((await quotaRow(key, String(uid), now))?.count, 1, '并占了个人行一格');

  await assert.rejects(exchangeItem(String(uid), key, 'req-dq1-2', now), (e: unknown) => {
    const err = e as AppError;
    assert.ok(err instanceof AppError, '应为 AppError');
    assert.equal(err.statusCode, 400);
    // 逐字核对批准文案（brief Step 4），别只配半截正则——数字与「明日 00:00 刷新」都是承诺
    assert.equal(err.message, '「测试道具」今日 1 张已兑完（每人每日限 1 张），明日 00:00 刷新');
    assert.match(err.message, /今日 1 张已兑完/);
    return true;
  });

  assert.equal((await quotaRow(key, '', now))?.count, 1, '被拒那次没再占格');
  assert.equal((await PointItemModel.findOne({ key }).lean())!.stock, 2, '额度闸门在库存之前：超限时库存一张没动');
  assert.equal(await PointCardModel.countDocuments({ userId: uid }), 1);
  assert.equal(await PointRecordModel.countDocuments({ userId: uid, type: 'exchange' }), 1, '超限不扣分');
  assert.equal((await findRow(key)).todayLeft, 0, '展示侧（台账口径）同步封到 0');
});

test('DQ-2 每人每日上限独立于总投放：A 兑满不影响 B 抢剩余额度', async (t) => {
  const a = newUser();
  const b = newUser();
  const key = await tempItem({ dailyQuota: 2, perUserDaily: 1 });
  t.after(() => dropTemp(key, a, b));
  await seedPoints(a, 400); // 给足：A 若绕过个人闸门就会扣出第二张
  await seedPoints(b, 200);
  const now = Date.now();

  await exchangeItem(String(a), key, 'req-dq2-a1', now);
  // A 第二次：总量还剩 1（1<2），撞的是每人每日上限——文案点名个人数，且抢到的总量格要回退
  await assert.rejects(exchangeItem(String(a), key, 'req-dq2-a2', now), (e: unknown) => {
    const err = e as AppError;
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /「测试道具」今日已兑 1 张（每人每日限 1 张）/);
    assert.match(err.message, /明日 00:00 刷新/);
    return true;
  });
  assert.equal((await quotaRow(key, '', now))?.count, 1, '个人行挡下：总量行回退，不吃 B 的名额');
  assert.equal((await quotaRow(key, String(a), now))?.count, 1);
  assert.equal(await PointCardModel.countDocuments({ userId: a }), 1);

  // B 正常抢走剩余那格
  await exchangeItem(String(b), key, 'req-dq2-b1', now);
  assert.equal((await quotaRow(key, '', now))?.count, 2);
  assert.equal((await findRow(key)).todayLeft, 0);
  // B 第二次：这次是总量真兑完 → 逐字批准文案
  await assert.rejects(exchangeItem(String(b), key, 'req-dq2-b2', now), (e: unknown) => {
    const err = e as AppError;
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /今日 2 张已兑完（每人每日限 1 张），明日 00:00 刷新/);
    return true;
  });
  assert.equal((await quotaRow(key, String(b), now))?.count, 1, '总量行先拒：B 的个人行没被再占');
});

test('DQ-3 并发抢同一张日额度只发一张（Promise.all 两个用户，不许双花）', async (t) => {
  const a = newUser();
  const b = newUser();
  const key = await tempItem({ dailyQuota: 1, perUserDaily: 1 });
  t.after(() => dropTemp(key, a, b));
  await seedPoints(a, 200);
  await seedPoints(b, 200);
  const now = Date.now();

  const [ra, rb] = await Promise.allSettled([
    exchangeItem(String(a), key, 'req-dq3-a', now),
    exchangeItem(String(b), key, 'req-dq3-b', now),
  ]);
  const ok = [ra, rb].filter((r) => r.status === 'fulfilled');
  const bad = [ra, rb].filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, '只有一格时并发双花就是不许——两个都成功说明闸门没生效');
  assert.equal(bad.length, 1);
  const err = (bad[0] as PromiseRejectedResult).reason as AppError;
  assert.equal(err.statusCode, 400);
  assert.match(err.message, /今日 1 张已兑完/);
  assert.ok((ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof exchangeItem>>>).value.cardId, '胜者拿到卡');

  assert.equal(await PointCardModel.countDocuments({ itemKey: key }), 1);
  assert.equal(await PointExchangeModel.countDocuments({ itemKey: key }), 1);
  assert.equal(await PointRecordModel.countDocuments({ type: 'exchange', refId: key }), 1, '败者没扣到分');
  assert.equal((await quotaRow(key, '', now))?.count, 1, '计数器与台账各 1，同真源');
  assert.equal((await findRow(key)).todayLeft, 0, '展示侧同步');
});

test('DQ-4 抢到额度但扣分失败（余额不足）：日额度回补，todayLeft 回到原值，后来者仍能抢', async (t) => {
  const poor = newUser();
  const rich = newUser();
  const key = await tempItem({ dailyQuota: 1, perUserDaily: 1 });
  t.after(() => dropTemp(key, poor, rich));
  await seedPoints(poor, 100); // price 200：必在扣分闸门上失败
  await seedPoints(rich, 200);
  const now = Date.now();

  await assert.rejects(exchangeItem(String(poor), key, 'req-dq4-poor', now), /积分不足/);
  assert.equal((await quotaRow(key, '', now))?.count, 0, '扣分失败：总量行已由 returnDailyQuota 回补');
  assert.equal((await quotaRow(key, String(poor), now))?.count, 0, '个人行一起回补');
  assert.equal((await findRow(key)).todayLeft, 1,
    '裁定 2 的「两侧一致」：台账侧这次扣分从未落账所以显示 1，计数器侧也回补到 0——都表达「还剩 1 格」');
  await exchangeItem(String(rich), key, 'req-dq4-rich', now);
  assert.equal((await findRow(key)).todayLeft, 0, 'rich 真把回补出来的那格抢走了');
});

test('DQ-5 扣分之后的失败（发卡炸）：计数器与台账两侧一起回到原值，同日可重试成功', async (t) => {
  const uid = newUser();
  const key = await tempItem({ dailyQuota: 1, perUserDaily: 1 });
  t.after(() => dropTemp(key, uid));
  await seedPoints(uid, 200);
  const now = Date.now();

  const cardCreate = patchModel(PointCardModel, 'create');
  cardCreate.set(async () => { throw new Error('card create boom'); });
  try {
    await assert.rejects(() => exchangeItem(String(uid), key, 'req-dq5', now), /card create boom/);
  } finally {
    cardCreate.restore();
  }
  assert.equal((await quotaRow(key, '', now))?.count, 0, 'returnDailyQuota 回补总量行');
  assert.equal((await quotaRow(key, String(uid), now))?.count, 0);
  assert.equal((await findRow(key)).todayLeft, 1,
    '裁定 2 的「两侧一致」：reverseDebit 把扣分行降级出台账，todayLeft 回到原值，与计数器回补同刻成立');

  // 额度真回去了：换新 requestId 当日重试必须成功（摘掉 returnDailyQuota 这里会 400「今日 1 张已兑完」）
  await exchangeItem(String(uid), key, 'req-dq5-retry', now);
  assert.equal((await quotaRow(key, '', now))?.count, 1);
  assert.equal((await findRow(key)).todayLeft, 0);
});

test('DQ-6 闸门顺序钉死：额度在库存之前（超额度报额度不报库存）；库存空时额度回补', async (t) => {
  const a = newUser();
  const b = newUser();
  // 段一：额度与库存同时只剩最后一格——先撞哪个闸门，400 文案就必须是哪个
  const kOrder = await tempItem({ dailyQuota: 1, perUserDaily: 1, stock: 1 });
  // 段二：额度够、库存空——抢了额度的败者要把额度还回去
  const kStock = await tempItem({ dailyQuota: 2, perUserDaily: 2, stock: 1 });
  t.after(() => dropTemp([kOrder, kStock], a, b));
  await seedPoints(a, 400);
  await seedPoints(b, 400);
  const now = Date.now();

  await exchangeItem(String(a), kOrder, 'req-dq6-o1', now); // 库存 0、总量 1 同时发生
  await assert.rejects(exchangeItem(String(b), kOrder, 'req-dq6-o2', now), (e: unknown) => {
    const err = e as AppError;
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /今日 1 张已兑完/, '每日额度闸门在库存之前：这里报的是额度');
    assert.doesNotMatch(err.message, /当前库存/, '若是库存先跑，文案会变成「当前库存 0」——顺序被改就红');
    return true;
  });

  await exchangeItem(String(a), kStock, 'req-dq6-s1', now); // 总量 1、库存 0
  await assert.rejects(exchangeItem(String(b), kStock, 'req-dq6-s2', now), /已兑完（当前库存 0）/);
  assert.equal((await quotaRow(kStock, '', now))?.count, 1, '库存空这一步：b 抢到的额度已回补');
  assert.equal((await quotaRow(kStock, String(b), now))?.count, 0);
  assert.equal((await findRow(kStock)).todayLeft, 1, '台账侧同样只记 a 那一张');
});

test('DQ-7 限购闸门在每日额度之前：超限报「每人限兑」，不碰当日计数器', async (t) => {
  const uid = newUser();
  const key = await tempItem({ dailyQuota: 1, perUserDaily: 1, perUserLimit: 1 });
  t.after(() => dropTemp(key, uid));
  await seedPoints(uid, 400);
  const now = Date.now();

  await exchangeItem(String(uid), key, 'req-dq7-1', now);
  assert.equal((await quotaRow(key, '', now))?.count, 1);
  await assert.rejects(exchangeItem(String(uid), key, 'req-dq7-2', now), (e: unknown) => {
    const err = e as AppError;
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /每人限兑 1 件/, '限购是闸门 1：文案必须是限购口径');
    assert.doesNotMatch(err.message, /已兑完/, '若把每日额度挪到限购前，这里会变成「今日 1 张已兑完」——顺序被改就红');
    return true;
  });
  assert.equal((await quotaRow(key, '', now))?.count, 1, '被限购挡下的那次没进额度闸门');
});

test('DQ-8 实物链共用同一闸门：超限文案一致，扣分失败回补，两人各占其行', async (t) => {
  const a = newUser();
  const poor = newUser();
  const b = newUser();
  const key = await tempItem({ kind: 'physical', dailyQuota: 2, perUserDaily: 1, unlimited: true });
  t.after(() => dropTemp(key, a, poor, b));
  await seedPoints(a, 200);
  await seedPoints(poor, 100);
  await seedPoints(b, 200);
  const now = Date.now();
  const address = { receiver: '张三', phone: '13800138000', detail: '浙江省杭州市西湖区测试路 100 号' };

  const r = await exchangeItem(String(a), key, 'req-dq8-a', now, address);
  assert.ok(r.orderId, '实物落订单');
  assert.equal(await PointCardModel.countDocuments({ itemKey: key }), 0, '实物不发卡（互斥链照旧）');
  assert.equal((await quotaRow(key, '', now))?.count, 1);

  await assert.rejects(exchangeItem(String(poor), key, 'req-dq8-poor', now, address), /积分不足/);
  assert.equal((await quotaRow(key, '', now))?.count, 1, 'poor 抢到的总量行已回补');
  assert.equal((await quotaRow(key, String(poor), now))?.count, 0, 'poor 的个人行也回补');

  await exchangeItem(String(b), key, 'req-dq8-b', now, address);
  assert.equal((await quotaRow(key, '', now))?.count, 2);
  // a 第二次：个人满 1、总量也满 2 → 逐字总量文案（与虚拟链同一口径）
  await assert.rejects(exchangeItem(String(a), key, 'req-dq8-a2', now, address), (e: unknown) => {
    const err = e as AppError;
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /今日 2 张已兑完（每人每日限 1 张），明日 00:00 刷新/);
    return true;
  });
});

/**
 * 修复轮 1（裁定进 spec §4.8 第 2 条）：文案由「实际拦下闸门的那一步」（判别式原因）决定，
 * 不再回读计数器猜分支——猜分支在并发回补时会被降级成禁用文案「每人每日限 0 张」。
 * 批准的两句逐字钉死：
 * - 总量被抢光：「{商品名}」今日 {N} 张已兑完（每人每日限 {M} 张），明日 00:00 刷新；perUserDaily=0（不限）时省略括号
 * - 只剩每人上限：「{商品名}」今日已兑 {K} 张（每人每日限 {M} 张），明日 00:00 刷新；K＝该用户当日自己的张数
 */
test('DQ-9 每人每日不限（perUserDaily=0）时总量兑完文案不带括号；并发回补竞态也不许降级成「限 0 张」', async (t) => {
  const uid = newUser();
  const key = await tempItem({ dailyQuota: 1, perUserDaily: 0 });
  t.after(() => dropTemp(key, uid));
  await seedPoints(uid, 400);
  const now = Date.now();

  await exchangeItem(String(uid), key, 'req-dq9-1', now);
  // 稳定路径：总量行就在那（1>=1），批准文案逐字——perUserDaily=0 时括号整段省略
  await assert.rejects(exchangeItem(String(uid), key, 'req-dq9-2', now), (e: unknown) => {
    const err = e as AppError;
    assert.equal(err.statusCode, 400);
    assert.equal(err.message, '「测试道具」今日 1 张已兑完，明日 00:00 刷新');
    assert.doesNotMatch(err.message, /每人每日限/, 'perUserDaily=0＝不限，「每人每日限 0 张」是批准文案明令禁止的');
    return true;
  });

  // 竞态路径（修复前的降级点）：闸门按总量行拒绝之后、文案重读计数器之前，并发请求把总量行回补了。
  // 读侧打桩模拟这一刻（find 拿回空行）。修复前按「total < cap」猜分支 → 掉进个人文案，
  // 拼出「今日已兑 0 张（每人每日限 0 张）」；修复后文案由拦截步（'total'）决定，根本不读计数器。
  const model = PointDailyQuotaModel as unknown as {
    find: (...args: unknown[]) => { select: () => { lean: () => Promise<unknown[]> } };
  };
  const realFind = PointDailyQuotaModel.find.bind(PointDailyQuotaModel);
  model.find = () => ({ select: () => ({ lean: async () => [] }) });
  try {
    await assert.rejects(exchangeItem(String(uid), key, 'req-dq9-3', now), (e: unknown) => {
      const err = e as AppError;
      assert.equal(err.statusCode, 400);
      assert.equal(err.message, '「测试道具」今日 1 张已兑完，明日 00:00 刷新');
      return true;
    });
  } finally {
    model.find = realFind as unknown as typeof model.find;
  }
});

test('DQ-10 个人上限文案的 {K} 是该用户当日自己的张数，不是平台当日数', async (t) => {
  const a = newUser();
  const b = newUser();
  const key = await tempItem({ dailyQuota: 5, perUserDaily: 2 });
  t.after(() => dropTemp(key, a, b));
  await seedPoints(a, 600);
  await seedPoints(b, 200);
  const now = Date.now();

  await exchangeItem(String(a), key, 'req-dq10-a1', now);
  await exchangeItem(String(a), key, 'req-dq10-a2', now); // a 个人行 2＝满
  await exchangeItem(String(b), key, 'req-dq10-b1', now); // 平台当日合计 3 张，其中 b 占 1 张

  await assert.rejects(exchangeItem(String(a), key, 'req-dq10-a3', now), (e: unknown) => {
    const err = e as AppError;
    assert.equal(err.statusCode, 400);
    // 逐字：K=2（a 自己兑的张数），不是 3（平台当日总张数）；M=配置的每人上限
    assert.equal(err.message, '「测试道具」今日已兑 2 张（每人每日限 2 张），明日 00:00 刷新');
    return true;
  });
  assert.equal((await quotaRow(key, '', now))?.count, 3, 'a 撞个人上限抢到的总量格已回退，不占平台名额');
});

test('DQ-11 个人行那步抛异常：已抢到的总量格当场退回，不许悬空（hold leak）', async (t) => {
  const uid = newUser();
  const key = await tempItem({ dailyQuota: 1, perUserDaily: 1 });
  t.after(() => dropTemp(key, uid));
  await seedPoints(uid, 400);
  const now = Date.now();

  const fua = patchModel(PointDailyQuotaModel, 'findOneAndUpdate');
  const realFua = PointDailyQuotaModel.findOneAndUpdate.bind(PointDailyQuotaModel);
  let calls = 0;
  // 调用序：1＝总量行条件 $inc（成功抢到），2＝个人行条件 $inc（这里炸）——此刻 releaseQuota 还不存在
  fua.set((...args: unknown[]) => {
    calls += 1;
    if (calls === 2) throw new Error('quota personal row boom');
    return (realFua as unknown as (...a: unknown[]) => unknown)(...args);
  });
  try {
    await assert.rejects(() => exchangeItem(String(uid), key, 'req-dq11', now), /quota personal row boom/);
  } finally {
    fua.restore();
  }
  assert.equal(calls, 2, '前置条件：确实炸在个人行那一步');
  assert.equal((await quotaRow(key, '', now))?.count, 0, '总量行回到请求前的值：异常路径的回补补上了');
  assert.equal((await quotaRow(key, String(uid), now))?.count ?? 0, 0, '个人行没被占住');

  // 那一格真回去了：换新 requestId 当日重试必须成功（没回补的话总量行还压着 1，这里会 400）
  await exchangeItem(String(uid), key, 'req-dq11-retry', now);
  assert.equal((await quotaRow(key, '', now))?.count, 1);
});

test('DQ-12 额度回补失败要像库存缺口一样报出来：400 保留主文案、尾注格数、data 带 quotaRefundFailed', async (t) => {
  const uid = newUser();
  const key = await tempItem({ dailyQuota: 1, perUserDaily: 1 });
  t.after(() => dropTemp(key, uid));
  await seedPoints(uid, 100); // price 200：必在扣分闸门失败，链走到 releaseQuota
  const now = Date.now();

  const upd = patchModel(PointDailyQuotaModel, 'updateOne');
  const realUpd = PointDailyQuotaModel.updateOne.bind(PointDailyQuotaModel);
  // 只炸「回退一格」那步（$inc count:-1，undoQuota 专用）：ensureQuotaRow 的 $setOnInsert 照常放行
  upd.set((...args: unknown[]) => {
    const inc = (args[1] as { $inc?: { count?: number } } | undefined)?.$inc;
    if (inc?.count === -1) throw new Error('quota refund boom');
    return (realUpd as unknown as (...a: unknown[]) => unknown)(...args);
  });
  // undoQuota 仍会 console.error 留底（同库存 backStock 口径），测试里压掉噪音
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(() => exchangeItem(String(uid), key, 'req-dq12', now), (e: unknown) => {
      const err = e as AppError;
      assert.equal(err.statusCode, 400, '主状态码保留（前端按「积分不足」引导赚分）');
      assert.match(err.message, /^积分不足/, '主文案原样，缺口以尾注追加');
      assert.match(err.message, /（另：每日额度回补失败 2 格，请人工核对）/, '总量行＋个人行都没退回去');
      assert.equal(err.extra?.quotaRefundFailed, 2);
      return true;
    });
  } finally {
    upd.restore();
    console.error = originalError;
  }
  assert.equal((await quotaRow(key, '', now))?.count, 1, '退不回去的那格就是缺口——现在文案点名，不再无声少发');
});
