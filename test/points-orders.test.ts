import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { config } from '../src/config/index.js';
import { POINTS } from '../src/config/points.js';
import {
  PointAccountModel, PointCardModel, PointDailyModel, PointExchangeModel, PointItemModel,
  PointLotModel, PointOrderModel, PointRecordModel,
} from '../src/models/point.model.js';
import { UserModel } from '../src/models/user.model.js';
import { LoginLogModel } from '../src/models/login-log.model.js';
import { buildApp } from '../src/app.js';
import { creditPoints, getBalance } from '../src/services/points-ledger.js';
import { seedPointItems } from '../src/services/points-catalog.js';
import { exchangeItem } from '../src/services/points-items.js';
import {
  confirmReceipt, limitReached, listMyOrders, validateAddress,
} from '../src/services/points-orders.js';
import { bjDateStr } from '../src/utils/bj-time.js';
import { shiftDateKey } from '../src/utils/points-domain.js';
import { AppError } from '../src/utils/app-error.js';

/**
 * 实物兑换与订单（Task 2 / PO-1..PO-8）。
 *
 * 口径：
 * - 实物兑换扣分走同一个账本与同一个 `exchange:${userId}:${requestId}` 幂等键；
 *   不产生 PointCard，只落 PointOrder；虚拟兑换反过来。
 * - 地址与商品名是下单快照：目录改档不影响已落订单。
 * - 过库存闸门之后任何失败（含订单落库失败）都要回到调用前：退分 + 回补库存 + 无订单，
 *   与虚拟兑换复用同一条逆序链（points-ledger.reverseDebit）。
 * - 测试商品一律 `t_` 前缀，用例内自建自清；用户按 userId 清 7 个 Point 集合。
 */

const API = '/sport-track/api';
const ADDRESS = { receiver: '张三', phone: '13800138000', detail: '北京市朝阳区建国路 88 号' };

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  // (userId, requestId) 唯一索引是幂等并发的 DB 级兜底，必须等它建完再跑
  await Promise.all([
    PointExchangeModel.init(), PointRecordModel.init(), PointAccountModel.init(),
    PointDailyModel.init(), PointItemModel.init(), PointOrderModel.init(),
  ]);
});

after(async () => {
  // PO-8 的 app.close() 会断开全局 mongoose 连接；清理前先按需重连
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 }).catch(() => {});
  }
  await PointOrderModel.deleteMany({ requestId: /^t-po-/ }).catch(() => {});
  await mongoose.disconnect().catch(() => {});
});

/** 清场：本用例造的用户按 userId 删干净 7 个 Point 集合 */
const wipe = (u: Types.ObjectId) => Promise.all([
  PointOrderModel.deleteMany({ userId: u }),
  PointExchangeModel.deleteMany({ userId: u }),
  PointCardModel.deleteMany({ userId: u }),
  PointRecordModel.deleteMany({ userId: u }),
  PointAccountModel.deleteMany({ userId: u }),
  PointLotModel.deleteMany({ userId: u }),
  PointDailyModel.deleteMany({ userId: u }),
]);

/** 造余额：creditPoints 有 DAILY_CAP=100/日，按业务日拆分凑够 total（同 points-items-catalog.test.ts） */
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
      idemKey: `${u}:orders-seed:${i}`,
    });
    assert.equal(r.credited, points, `拆分发放不该被日上限截断（第 ${i} 段）`);
    left -= points;
  }
}

let seq = 0;
interface PhysicalOverrides {
  name?: string;
  price?: number;
  stock?: number;
  unlimited?: boolean;
  perUserLimit?: number;
}

/** 每用例一把独立的实物道具（t_ 前缀 + 序号），返回 key；清理由调用方 t.after 负责 */
async function makePhysical(over: PhysicalOverrides = {}): Promise<string> {
  seq += 1;
  const key = `t_physical_${Date.now()}_${seq}`;
  await PointItemModel.create({
    key,
    name: over.name ?? '实物测试奖品',
    subtitle: '',
    description: '',
    notes: [],
    price: over.price ?? 300,
    validDays: 30,
    kind: 'physical',
    detailImages: [],
    perUserLimit: over.perUserLimit ?? 1,
    effect: { kind: 'makeup', days: 0 },
    stock: over.stock ?? 5,
    unlimited: over.unlimited ?? false,
    active: true,
    sortOrder: 999,
    image: '',
  });
  return key;
}

const stockOf = async (key: string) => (await PointItemModel.findOne({ key }).lean())!.stock;

test('PO-1 实物兑换：扣分、库存−1、无卡、订单 pending_ship、地址与 itemName 是快照', async (t) => {
  const u = new Types.ObjectId();
  const key = await makePhysical({ name: '限量实物奖品', price: 300, stock: 5 });
  t.after(async () => {
    await wipe(u);
    await PointItemModel.deleteMany({ key });
  });
  await seedBalance(u, 1000);

  const r = await exchangeItem(String(u), key, `t-po-1-${u}`, Date.now(), ADDRESS);
  assert.ok(r.orderId, '实物兑换必须回订单 id');
  assert.equal(r.cardId, undefined, '实物兑换不产生卡');
  assert.equal(r.balance, 700, '扣 300 分');
  assert.equal(await PointCardModel.countDocuments({ userId: u }), 0, '实物兑换绝不发 PointCard');
  assert.equal(await stockOf(key), 4, '库存 −1');
  assert.equal(await getBalance(String(u)), 700);

  const order = await PointOrderModel.findOne({ userId: u }).lean();
  assert.ok(order, '订单必须落库');
  assert.equal(String(order._id), r.orderId);
  assert.equal(order.itemKey, key);
  assert.equal(order.cost, 300);
  assert.equal(order.status, 'pending_ship');
  assert.deepEqual(order.address, ADDRESS, '地址三项原样快照');

  // 下单后改目录名/改价：订单上的快照不得被追认
  await PointItemModel.updateOne({ key }, { $set: { name: '改名后奖品', price: 999 } });
  const afterRename = await PointOrderModel.findOne({ userId: u }).lean();
  assert.equal(afterRename!.itemName, '限量实物奖品', 'itemName 是下单快照');
  assert.equal(afterRename!.cost, 300, 'cost 是下单快照');
  const mine = await listMyOrders(String(u));
  assert.equal(mine[0].itemName, '限量实物奖品', '列表也不得 join 目录现名');
  assert.equal(mine[0].cost, 300);
});

test('PO-2 地址非法四例：400 点名该字段与收到的值，余额与库存都不变', async (t) => {
  const u = new Types.ObjectId();
  const key = await makePhysical({ price: 300, stock: 5 });
  t.after(async () => {
    await wipe(u);
    await PointItemModel.deleteMany({ key });
  });
  await seedBalance(u, 1000);

  const cases: { label: string; address: unknown; field: RegExp; value: RegExp }[] = [
    { label: '缺 address', address: undefined, field: /address/, value: /收到 空/ },
    {
      label: '手机号非法',
      address: { ...ADDRESS, phone: '12345' },
      field: /phone/, value: /「12345」/,
    },
    {
      label: '姓名空白',
      address: { ...ADDRESS, receiver: '   ' },
      field: /receiver/, value: /「   」/,
    },
    {
      label: '地址过短',
      address: { ...ADDRESS, detail: '短' },
      field: /detail/, value: /「短」/,
    },
  ];

  for (const [i, c] of cases.entries()) {
    await assert.rejects(
      () => exchangeItem(String(u), key, `t-po-2-${u}-${i}`, Date.now(), c.address),
      (e) => {
        const err = e as AppError;
        return err.statusCode === 400
          && c.field.test(err.message)
          && c.value.test(err.message)
          && /收到/.test(err.message);
      },
      `${c.label} 应 400 并点名字段 ${c.field} 与收到的值`,
    );
    assert.equal(await getBalance(String(u)), 1000, `${c.label}：余额不变`);
    assert.equal(await stockOf(key), 5, `${c.label}：库存不变`);
    assert.equal(await PointOrderModel.countDocuments({ userId: u }), 0, `${c.label}：不落订单`);
  }
});

test('PO-3 幂等：同一 requestId 并发 20 次 → 1 张订单、1 次扣分、1 次扣库存', async (t) => {
  const u = new Types.ObjectId();
  const key = await makePhysical({ price: 300, stock: 50, perUserLimit: 0 });
  t.after(async () => {
    await wipe(u);
    await PointItemModel.deleteMany({ key });
  });
  await seedBalance(u, 1000);

  const rs = await Promise.allSettled(
    Array.from({ length: 20 }, () => exchangeItem(String(u), key, `t-po-3-${u}`, Date.now(), ADDRESS)),
  );
  assert.equal(rs.filter((x) => x.status === 'fulfilled').length, 20, '重放一律短路成功');
  assert.equal(await PointOrderModel.countDocuments({ userId: u }), 1, '只落 1 张订单');
  assert.equal(await PointRecordModel.countDocuments({ userId: u, type: 'exchange' }), 1, '只扣一次分');
  assert.equal(await stockOf(key), 49, '只扣 1 张库存');
  assert.equal(await PointCardModel.countDocuments({ userId: u }), 0, '实物不发卡');
  assert.equal(await getBalance(String(u)), 700);
  const order = await PointOrderModel.findOne({ userId: u }).lean();
  assert.equal(order!.requestId, `t-po-3-${u}`);
});

test('PO-4 订单落库失败：退分 + totalSpent 回滚 + 库存回补 + 无订单', async (t) => {
  const u = new Types.ObjectId();
  const key = await makePhysical({ price: 300, stock: 3 });
  t.after(async () => {
    await wipe(u);
    await PointItemModel.deleteMany({ key });
  });
  await seedBalance(u, 400);

  const model = PointOrderModel as unknown as { create: (...args: unknown[]) => Promise<unknown> };
  const realCreate = PointOrderModel.create.bind(PointOrderModel);
  model.create = async () => { throw new Error('order write boom'); };
  try {
    await assert.rejects(
      () => exchangeItem(String(u), key, `t-po-4-${u}`, Date.now(), ADDRESS),
      /order write boom/,
    );
  } finally {
    model.create = realCreate as unknown as typeof model.create;
  }

  assert.equal(await PointOrderModel.countDocuments({ userId: u }), 0, '无订单');
  assert.equal(await stockOf(key), 3, '库存回补');
  assert.equal(await getBalance(String(u)), 400, '余额回到调用前');
  const account = await PointAccountModel.findOne({ userId: u }).lean();
  assert.equal(account!.totalSpent, 0, 'totalSpent 也回滚（不能留下假消耗）');
  assert.equal(await PointRecordModel.countDocuments({ userId: u, type: 'exchange' }), 0,
    '原扣分行已降级为 exchange_reversed');
});

test('PO-5 限购：perUserLimit 1 第二次 400，perUserLimit 0 连兑 3 次', async (t) => {
  const u = new Types.ObjectId();
  const key = await makePhysical({ price: 200, stock: 10, perUserLimit: 1 });
  t.after(async () => {
    await wipe(u);
    await PointItemModel.deleteMany({ key });
  });
  await seedBalance(u, 1000);

  await exchangeItem(String(u), key, `t-po-5-${u}-a`, Date.now(), ADDRESS);
  const item = await PointItemModel.findOne({ key }).lean();
  assert.equal(await limitReached(String(u), item as never, Date.now()), true, '已兑 1 件，限购 1 已触顶');
  await assert.rejects(
    () => exchangeItem(String(u), key, `t-po-5-${u}-b`, Date.now(), ADDRESS),
    (e) => {
      const err = e as AppError;
      return err.statusCode === 400 && /每人限兑 1 件（已兑 1/.test(err.message);
    },
  );
  assert.equal(await PointOrderModel.countDocuments({ userId: u }), 1, '超限不落订单');
  assert.equal(await stockOf(key), 9, '超限不扣库存');
  assert.equal(await getBalance(String(u)), 800, '超限不扣分');

  await PointItemModel.updateOne({ key }, { $set: { perUserLimit: 0 } });
  const unlimitedItem = await PointItemModel.findOne({ key }).lean();
  assert.equal(await limitReached(String(u), unlimitedItem as never, Date.now()), false, '0 = 不限购');
  for (const suffix of ['c', 'd', 'e']) {
    await exchangeItem(String(u), key, `t-po-5-${u}-${suffix}`, Date.now(), ADDRESS);
  }
  assert.equal(await PointOrderModel.countDocuments({ userId: u }), 4);
  assert.equal(await stockOf(key), 6);
  assert.equal(await getBalance(String(u)), 200);
});

test('PO-5b 限购对虚拟道具同样生效：数该用户的持卡数', async (t) => {
  const u = new Types.ObjectId();
  const key = `t_virtual_limit_${Date.now()}`;
  t.after(async () => {
    await wipe(u);
    await PointItemModel.deleteMany({ key });
  });
  await PointItemModel.create({
    key, name: '虚拟限购道具', subtitle: '', description: '', notes: [], price: 100, validDays: 30,
    kind: 'virtual', effect: { kind: 'makeup', days: 0 }, detailImages: [], perUserLimit: 1,
    stock: 9999, unlimited: true, active: true, sortOrder: 999, image: '',
  });
  await seedBalance(u, 300);

  await exchangeItem(String(u), key, `t-po-5b-${u}-a`);
  const item = await PointItemModel.findOne({ key }).lean();
  assert.equal(await limitReached(String(u), item as never, Date.now()), true, '已持 1 张，限购 1 已触顶');
  await assert.rejects(
    () => exchangeItem(String(u), key, `t-po-5b-${u}-b`),
    (e) => (e as AppError).statusCode === 400 && /每人限兑 1 件（已兑 1/.test((e as Error).message),
  );
  assert.equal(await PointCardModel.countDocuments({ userId: u }), 1, '超限不再发卡');
  assert.equal(await PointOrderModel.countDocuments({ userId: u }), 0, '虚拟兑换不落订单');
  assert.equal(await getBalance(String(u)), 200, '超限不扣分');
});

test('PO-6 双向隔离：虚拟兑换不产生订单，实物兑换不产生卡', async (t) => {
  const u = new Types.ObjectId();
  const key = await makePhysical({ price: 300, stock: 5, perUserLimit: 0 });
  t.after(async () => {
    await wipe(u);
    await PointItemModel.deleteMany({ key });
  });
  await seedPointItems();
  await PointItemModel.updateOne({ key: 'makeup_card' }, { $set: { unlimited: true, stock: 9999 } });
  await seedBalance(u, 600);

  const v = await exchangeItem(String(u), 'makeup_card', `t-po-6-${u}-v`);
  assert.ok(v.cardId);
  assert.equal(v.orderId, undefined, '虚拟兑换不回订单');
  assert.equal(await PointOrderModel.countDocuments({ userId: u }), 0, '虚拟兑换绝不落订单');
  assert.equal(await PointCardModel.countDocuments({ userId: u }), 1);

  const p = await exchangeItem(String(u), key, `t-po-6-${u}-p`, Date.now(), ADDRESS);
  assert.ok(p.orderId);
  assert.equal(p.cardId, undefined, '实物兑换不回卡');
  assert.equal(await PointCardModel.countDocuments({ userId: u }), 1, '实物兑换不额外发卡');
  assert.equal(await PointOrderModel.countDocuments({ userId: u }), 1);
});

test('PO-7 listMyOrders 只含本人倒序；confirmReceipt 只能 shipped → completed', async (t) => {
  const a = new Types.ObjectId();
  const b = new Types.ObjectId();
  t.after(async () => {
    await wipe(a);
    await wipe(b);
  });
  const base = {
    itemKey: 't_order_item', itemName: '订单快照商品', cost: 100,
    address: ADDRESS, trackingNo: '', trackingCompany: '', shippedAt: 0, shippedBy: '',
    completedAt: 0, updatedAt: 1000,
  };
  const pending = await PointOrderModel.create({
    ...base, userId: a, status: 'pending_ship', requestId: `t-po-7-${a}-p`, createdAt: 1000,
  });
  const shipped = await PointOrderModel.create({
    ...base, userId: a, status: 'shipped', requestId: `t-po-7-${a}-s`, createdAt: 2000,
  });
  const other = await PointOrderModel.create({
    ...base, userId: b, status: 'shipped', requestId: `t-po-7-${b}-s`, createdAt: 3000,
  });

  const mine = await listMyOrders(String(a));
  assert.deepEqual(mine.map((o) => o.id), [String(shipped._id), String(pending._id)],
    '只含本人且按 createdAt 倒序');

  await assert.rejects(() => confirmReceipt(String(a), String(pending._id)), (e) => {
    const err = e as AppError;
    return err.statusCode === 400 && /待发货/.test(err.message);
  });
  await assert.rejects(() => confirmReceipt(String(a), String(other._id)), (e) =>
    (e as AppError).statusCode === 404 && /订单不存在/.test((e as Error).message));
  await assert.rejects(() => confirmReceipt(String(a), 'not-an-id'), (e) =>
    (e as AppError).statusCode === 404 && /订单不存在/.test((e as Error).message));

  const done = await confirmReceipt(String(a), String(shipped._id));
  assert.equal(done.status, 'completed');
  const row = await PointOrderModel.findById(shipped._id).lean();
  assert.equal(row!.status, 'completed');
  assert.ok((row!.completedAt ?? 0) > 0, 'completedAt 落库');
});

test('PO-8 HTTP：exchange 透传 address，GET /orders，POST /orders/:id/confirm', async (t) => {
  const app: FastifyInstance = await buildApp({ logger: false });
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: `${API}/auth/login`,
    payload: { code: `openid:points-orders-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  assert.equal(login.statusCode, 200, login.body);
  const auth = login.json().data;
  const uid = new Types.ObjectId(auth.user?.id ?? auth.user?._id);
  const key = await makePhysical({ price: 300, stock: 5, perUserLimit: 3 });
  t.after(async () => {
    await wipe(uid);
    await LoginLogModel.deleteMany({ userId: uid }).catch(() => {});
    await UserModel.deleteMany({ _id: uid });
    await PointItemModel.deleteMany({ key });
    await app.close();
  });
  await seedBalance(uid, 1000);
  const headers = { authorization: `Bearer ${auth.accessToken}` };

  const res = await app.inject({
    method: 'POST',
    url: `${API}/points/items/${key}/exchange`,
    headers,
    payload: { requestId: `t-po-8-${uid}`, address: ADDRESS },
  });
  assert.equal(res.statusCode, 200, res.body);
  const orderId = res.json().data.orderId as string;
  assert.ok(orderId, '兑换响应带 orderId');
  const saved = await PointOrderModel.findById(orderId).lean();
  assert.deepEqual(saved!.address, ADDRESS, '路由必须把 address 透传到服务层');

  const list = await app.inject({ method: 'GET', url: `${API}/points/orders`, headers });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().data.length, 1);
  assert.equal(list.json().data[0].id, orderId);

  const early = await app.inject({
    method: 'POST', url: `${API}/points/orders/${orderId}/confirm`, headers,
  });
  assert.equal(early.statusCode, 400, 'pending_ship 不能确认收货');
  assert.match(early.json().message, /待发货/);

  await PointOrderModel.updateOne({ _id: orderId }, { $set: { status: 'shipped' } });
  const ok = await app.inject({
    method: 'POST', url: `${API}/points/orders/${orderId}/confirm`, headers,
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().data.status, 'completed');
});

// validateAddress 直接单测（服务层错误文案口径：对象 + 实际值 + 限制）
test('PO-9 validateAddress 归一：trim 后落库，边界 20/120 字可过', () => {
  const v = validateAddress({ receiver: '  李四  ', phone: '13900139000', detail: '  上海市浦东新区世纪大道 1 号  ' });
  assert.deepEqual(v, { receiver: '李四', phone: '13900139000', detail: '上海市浦东新区世纪大道 1 号' });
  const twenty = '名'.repeat(20);
  const hundredTwenty = '址'.repeat(120);
  assert.deepEqual(
    validateAddress({ receiver: twenty, phone: '13900139000', detail: hundredTwenty }),
    { receiver: twenty, phone: '13900139000', detail: hundredTwenty },
  );
  assert.throws(() => validateAddress({ receiver: '名'.repeat(21), phone: '13900139000', detail: hundredTwenty }), (e) => {
    const err = e as AppError;
    return err.statusCode === 400 && /receiver/.test(err.message) && /1–20/.test(err.message);
  });
  assert.throws(() => validateAddress({ receiver: '李四', phone: '13900139000', detail: '址'.repeat(121) }), (e) => {
    const err = e as AppError;
    return err.statusCode === 400 && /detail/.test(err.message) && /5–120/.test(err.message);
  });
});
