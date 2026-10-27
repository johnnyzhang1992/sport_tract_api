import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { config } from '../src/config/index.js';
import { POINTS } from '../src/config/points.js';
import {
  PointAccountModel, PointCardModel, PointDailyModel, PointExchangeModel, PointItemModel, PointLotModel, PointRecordModel,
} from '../src/models/point.model.js';
import { creditPoints, getBalance } from '../src/services/points-ledger.js';
import { seedPointItems } from '../src/services/points-catalog.js';
import { exchangeItem, listActiveItems, listExchanges } from '../src/services/points-items.js';
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

test('PI1 200 分兑换一张卡，30 天有效，兑换记录可查', async (t) => {
  const uid = newUser();
  t.after(() => wipe(uid));
  await seedPoints(uid, POINTS.MAKEUP_CARD_PRICE);
  assert.equal(await getBalance(String(uid), NOW), 200);

  // 商品列表：道具目录驱动，只下发在架项（ad_free_* 种子 active:false，这里只有补签卡）
  const items = await listActiveItems();
  const makeup = items.find((i) => i.key === 'makeup_card');
  assert.ok(makeup, '在架列表里应能查到补签卡');
  assert.deepEqual(makeup, {
    key: 'makeup_card',
    name: '补签卡',
    subtitle: '恢复连续打卡记录',
    price: 200,
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
    imageUrl: '',
  });

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

  // 扣分明细：兑换一条 -200，业务日按东八区
  const record = await PointRecordModel.findOne({ userId: uid, type: 'exchange' }).lean();
  assert.ok(record);
  assert.equal(record.delta, -200);
  assert.equal(record.refType, 'item');
  assert.equal(record.refId, 'makeup_card');
  assert.equal(record.bizDate, bjDateStr(NOW));

  // 兑换记录关联刚发的卡
  const ex = await PointExchangeModel.findOne({ userId: uid, requestId: 'req-1' }).lean();
  assert.ok(ex);
  assert.equal(String(ex.cardId), r.cardId);
  assert.equal(ex.itemKey, 'makeup_card');
  assert.equal(ex.cost, 200);
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
  await seedPoints(uid, 50);

  await assert.rejects(exchangeItem(String(uid), 'makeup_card', 'req-low', NOW), (e: Error) => {
    assert.ok(e instanceof AppError, '应为 AppError');
    assert.equal((e as AppError).statusCode, 400);
    assert.match(e.message, /积分不足（当前 50，需要 200）/);
    return true;
  });

  // 失败不留痕：不扣分、不发卡、不落兑换记录
  assert.equal(await getBalance(String(uid), NOW), 50);
  assert.equal(await PointCardModel.countDocuments({ userId: uid }), 0);
  assert.equal(await PointExchangeModel.countDocuments({ userId: uid }), 0);
  assert.equal(await PointRecordModel.countDocuments({ userId: uid, type: 'exchange' }), 0);

  // 缺少 requestId：直接 400，不触碰账本
  await assert.rejects(exchangeItem(String(uid), 'makeup_card', '  ', NOW), /缺少兑换请求 ID/);
  assert.equal(await getBalance(String(uid), NOW), 50);
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
  await seedPoints(uid, 2 * POINTS.MAKEUP_CARD_PRICE);

  const [a, b] = await Promise.all([
    exchangeItem(String(uid), 'makeup_card', 'req-race', NOW),
    exchangeItem(String(uid), 'makeup_card', 'req-race', NOW),
  ]);

  assert.equal(a.cardId, b.cardId);
  assert.equal(a.balance, 200);
  assert.equal(b.balance, 200);
  assert.equal(await PointCardModel.countDocuments({ userId: uid }), 1); // 失败方不会留下孤儿卡
  assert.equal(await PointExchangeModel.countDocuments({ userId: uid }), 1);
  assert.equal(await PointRecordModel.countDocuments({ userId: uid, type: 'exchange' }), 1);
  assert.equal(await getBalance(String(uid), NOW), 200);
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

  // 扣分已发生（先扣后发，本轮不引入事务），但卡必须撤回，否则重试等于白得一张
  assert.equal(await PointCardModel.countDocuments({ userId: uid }), 0);
  assert.equal(await PointExchangeModel.countDocuments({ userId: uid }), 0);
  assert.equal(await getBalance(String(uid), NOW), 0);

  // 恢复后重试：账本按 idemKey 重放（不二次扣分），一扣分对应一卡一记录
  restore();
  const r = await exchangeItem(String(uid), 'makeup_card', 'req-orphan', NOW);
  assert.equal(await PointCardModel.countDocuments({ userId: uid }), 1);
  assert.equal(await PointExchangeModel.countDocuments({ userId: uid }), 1);
  assert.equal(await PointRecordModel.countDocuments({ userId: uid, type: 'exchange' }), 1);
  assert.equal(r.balance, 0);
  assert.equal(String((await PointExchangeModel.findOne({ userId: uid, requestId: 'req-orphan' }).lean())?.cardId), r.cardId);
});
