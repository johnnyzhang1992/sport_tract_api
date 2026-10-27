import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { PointOrderModel } from '../src/models/point.model.js';
import { UserModel } from '../src/models/user.model.js';
import { itemsOverview } from '../src/services/points-admin-stats.js';
import { completeOrder, listOrders, shipOrder } from '../src/services/points-orders.js';
import { AppError } from '../src/utils/app-error.js';

/**
 * 管理端实物订单（Task 3 / AO-1..AO-6）：列表 / 发货 / 代确认 / 概况计数。
 *
 * 共享 dev 库口径：
 * - 用户与订单全部用例内自建：用户 openid / 订单 requestId 一律 `t-ao-` 前缀，
 *   t.after() 按 userId 清订单与用户，文件级 after() 再按前缀兜底；
 * - 手机号打码是硬约束：AO-1 把整个响应体 stringify 后断言不含完整号码；
 * - 订单状态机只有 pending_ship → shipped → completed，不合法转移一律 400 点名当前状态。
 */

const API = '/sport-track/api';
const ADMIN_USER = 'admin_orders_t3';
const ADMIN_PASS = 'test123456';
const FULL_PHONE = '13800138000';

let app: FastifyInstance;
let adminToken = '';
let adminId = '';

async function req(method: string, url: string, payload?: unknown, withToken = true) {
  return app.inject({
    method: method as 'GET',
    url,
    headers: withToken ? { authorization: `Bearer ${adminToken}` } : {},
    payload: payload as Record<string, unknown> | undefined,
  });
}

/** uid 是 sparse unique：取数值档最大值 +1 起连号（dev 库混着 int/string 两档，只筛数值档） */
async function nextUids(count: number): Promise<number[]> {
  const [agg] = await UserModel.aggregate<{ maxUid: number | null }>([
    { $match: { uid: { $type: 'number' } } },
    { $group: { _id: null, maxUid: { $max: '$uid' } } },
  ]);
  const base = Number(agg?.maxUid ?? 0) + 1;
  return Array.from({ length: count }, (_, i) => base + i);
}

async function makeUser(nickname: string, uid: number): Promise<Types.ObjectId> {
  const id = new Types.ObjectId();
  await UserModel.create({ _id: id, openid: `t-ao-${id}`, nickname, uid });
  return id;
}

type OrderStatus = 'pending_ship' | 'shipped' | 'completed';

interface OrderOverrides {
  status?: OrderStatus;
  createdAt?: number;
  phone?: string;
  receiver?: string;
  detail?: string;
  itemKey?: string;
  itemName?: string;
  cost?: number;
  trackingNo?: string;
  trackingCompany?: string;
  shippedAt?: number;
  shippedBy?: string;
  completedAt?: number;
}

let seq = 0;

/** 造一张订单（requestId 带 t-ao- 前缀，用例内自清） */
async function makeOrder(userId: Types.ObjectId, over: OrderOverrides = {}) {
  seq += 1;
  const createdAt = over.createdAt ?? Date.now() + seq;
  return PointOrderModel.create({
    userId,
    itemKey: over.itemKey ?? 't_ao_item',
    itemName: over.itemName ?? 'AO 测试实物',
    cost: over.cost ?? 100,
    address: {
      receiver: over.receiver ?? '张三',
      phone: over.phone ?? FULL_PHONE,
      detail: over.detail ?? '北京市朝阳区建国路 88 号',
    },
    status: over.status ?? 'pending_ship',
    trackingNo: over.trackingNo ?? '',
    trackingCompany: over.trackingCompany ?? '',
    shippedAt: over.shippedAt ?? 0,
    shippedBy: over.shippedBy ?? '',
    completedAt: over.completedAt ?? 0,
    requestId: `t-ao-${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt,
    updatedAt: createdAt,
  });
}

function cleanupUsers(...ids: Types.ObjectId[]) {
  return async () => {
    await PointOrderModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  };
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  await AdminModel.deleteOne({ username: ADMIN_USER });
  const admin = await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  adminId = String(admin._id);
  const login = await req('POST', `${API}/admin/login`, { username: ADMIN_USER, password: ADMIN_PASS }, false);
  assert.equal(login.statusCode, 200, login.body);
  adminToken = login.json().data.token as string;
  assert.ok(adminToken, '管理员登录应成功');
});

after(async () => {
  // 兜底：即使某个用例中途失败也按前缀清干净，不给共享库留行
  await PointOrderModel.deleteMany({ requestId: /^t-ao-/ }).catch(() => {});
  await UserModel.deleteMany({ openid: /^t-ao-/ }).catch(() => {});
  await AdminModel.deleteOne({ username: ADMIN_USER }).catch(() => {});
  await app.close();
});

test('AO-1 列表：状态筛选、昵称/UID 搜索、手机号打码且整个响应不含完整号码', async (t) => {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const [uidA] = await nextUids(1);
  const a = await makeUser(`订单甲${tag}`, uidA);
  const b = await makeUser(`订单乙${tag}`, uidA + 1);
  t.after(cleanupUsers(a, b));

  const pending = await makeOrder(a, { status: 'pending_ship', phone: FULL_PHONE });
  const shipped = await makeOrder(a, {
    status: 'shipped', phone: FULL_PHONE,
    trackingNo: 'SF1001', trackingCompany: '顺丰', shippedAt: 111, shippedBy: 'admin-x',
  });
  // 另一个用户的待发货单：关键词必须把它挡在外面
  await makeOrder(b, { status: 'pending_ship', phone: '13900139000', createdAt: Date.now() + 999999 });

  const filtered = await listOrders({ status: 'shipped' });
  assert.ok(filtered.items.every((r) => r.status === 'shipped'), '按状态筛只回该状态');
  assert.ok(filtered.items.some((r) => r.id === String(shipped._id)), '本用例的已发货单要在结果里');
  assert.ok(!filtered.items.some((r) => r.id === String(pending._id)), '待发货不能混进已发货');

  const byNick = await listOrders({ keyword: `订单甲${tag}` });
  assert.equal(byNick.total, 2, '昵称子串命中本用户的两张订单（另一个用户的不算）');
  assert.deepEqual(
    new Set(byNick.items.map((r) => r.userId)),
    new Set([String(a)]),
    '只回该昵称用户的订单',
  );

  const row = byNick.items.find((r) => r.id === String(pending._id))!;
  assert.ok(row, '待发货行必须在列表里');
  assert.equal(row.userId, String(a));
  assert.equal(row.uid, uidA, 'uid 以数字下发');
  assert.equal(row.nickname, `订单甲${tag}`);
  assert.equal(row.itemKey, 't_ao_item');
  assert.equal(row.itemName, 'AO 测试实物');
  assert.equal(row.cost, 100);
  assert.equal(row.receiver, '张三');
  assert.equal(row.detail, '北京市朝阳区建国路 88 号');
  assert.equal(row.status, 'pending_ship');
  assert.equal(row.statusText, '待发货');
  assert.equal(row.trackingNo, '');
  assert.equal(row.trackingCompany, '');
  assert.ok(row.createdAt > 0);

  const shippedRow = byNick.items.find((r) => r.id === String(shipped._id))!;
  assert.equal(shippedRow.statusText, '已发货');
  assert.equal(shippedRow.trackingNo, 'SF1001');
  assert.equal(shippedRow.trackingCompany, '顺丰');
  assert.equal(shippedRow.shippedAt, 111);

  // 打码：前 3 + **** + 后 4；整个列表响应体里不能出现完整号码
  assert.equal(row.phoneMasked, '138****8000');
  assert.equal(shippedRow.phoneMasked, '138****8000');
  assert.ok(!JSON.stringify(byNick).includes(FULL_PHONE), '整个列表响应体不能出现完整手机号');

  // UID 精确命中（纯数字关键词走 UID 档，同时昵称子串也仍然生效）
  const byUid = await listOrders({ keyword: String(uidA) });
  assert.ok(
    byUid.items.some((r) => r.userId === String(a) && r.id === String(pending._id)),
    '纯数字关键词要能按 UID 命中持单人订单',
  );

  // HTTP 入口同样打码、筛选条件透传
  const http = await req(
    'GET',
    `${API}/admin/points/orders?status=pending_ship&keyword=${encodeURIComponent(`订单甲${tag}`)}`,
  );
  assert.equal(http.statusCode, 200, http.body);
  const data = http.json().data as {
    total: number; page: number; pageSize: number; items: Array<{ id: string; status: string; phoneMasked: string }>;
  };
  assert.equal(data.total, 1);
  assert.equal(data.items[0]!.id, String(pending._id));
  assert.equal(data.items[0]!.status, 'pending_ship');
  assert.equal(data.items[0]!.phoneMasked, '138****8000');
  assert.ok(!http.body.includes(FULL_PHONE), 'HTTP 响应体也不能出现完整手机号');
});

test('AO-2 发货：pending_ship → shipped 写四字段；重复发货/空单号 400 点名', async (t) => {
  const a = await makeUser('发货测试用户', (await nextUids(1))[0]!);
  t.after(cleanupUsers(a));

  const order = await makeOrder(a);
  const shipped = await shipOrder(
    String(order._id),
    { trackingCompany: ' 顺丰速运 ', trackingNo: ' SF1234567890 ' },
    adminId,
  );
  assert.equal(shipped.status, 'shipped');
  assert.equal(shipped.statusText, '已发货');
  assert.equal(shipped.trackingNo, 'SF1234567890', '单号 trim 后落库并回显');
  assert.equal(shipped.trackingCompany, '顺丰速运');

  const row = await PointOrderModel.findById(order._id).lean();
  assert.equal(row!.status, 'shipped', '状态转 shipped');
  assert.equal(row!.trackingNo, 'SF1234567890');
  assert.equal(row!.trackingCompany, '顺丰速运');
  assert.ok((row!.shippedAt ?? 0) > 0, 'shippedAt 落时间');
  assert.equal(row!.shippedBy, adminId, 'shippedBy 落管理员 id');

  // 重复发货：400 点名当前状态（已发货），且不覆盖第一次的单号
  await assert.rejects(
    () => shipOrder(String(order._id), { trackingCompany: '圆通', trackingNo: 'YT999' }, adminId),
    (e) => {
      const err = e as AppError;
      return err.statusCode === 400 && /已发货/.test(err.message) && /只有待发货/.test(err.message);
    },
    '重复发货必须 400 并点名当前状态',
  );
  const again = await PointOrderModel.findById(order._id).lean();
  assert.equal(again!.trackingNo, 'SF1234567890', '重复发货不覆盖第一次的单号');

  // 空白单号：400 点名 trackingNo 字段，订单停在待发货
  const blank = await makeOrder(a);
  await assert.rejects(
    () => shipOrder(String(blank._id), { trackingCompany: '顺丰', trackingNo: '   ' }, adminId),
    (e) => {
      const err = e as AppError;
      return err.statusCode === 400 && /trackingNo/.test(err.message) && /不能为空/.test(err.message);
    },
    '空白快递单号必须 400 并点名 trackingNo',
  );
  const untouched = await PointOrderModel.findById(blank._id).lean();
  assert.equal(untouched!.status, 'pending_ship', '单号非法不推进状态');
  assert.equal(untouched!.shippedAt, 0);
});

test('AO-3 代确认：shipped → completed；pending_ship 代确认 400 点名当前状态', async (t) => {
  const a = await makeUser('代确认测试用户', (await nextUids(1))[0]!);
  t.after(cleanupUsers(a));

  const shippedOrder = await makeOrder(a, {
    status: 'shipped', trackingNo: 'SF1', trackingCompany: '顺丰', shippedAt: 1000, shippedBy: 'admin-x',
  });
  const done = await completeOrder(String(shippedOrder._id), adminId);
  assert.equal(done.status, 'completed');
  assert.equal(done.statusText, '已完成');

  const row = await PointOrderModel.findById(shippedOrder._id).lean();
  assert.equal(row!.status, 'completed', '状态转 completed');
  assert.ok((row!.completedAt ?? 0) > 0, 'completedAt 落时间');

  const pending = await makeOrder(a);
  await assert.rejects(
    () => completeOrder(String(pending._id), adminId),
    (e) => {
      const err = e as AppError;
      return err.statusCode === 400 && /待发货/.test(err.message) && /只有已发货/.test(err.message);
    },
    '待发货订单不能跳过发货直接被代确认',
  );
  const untouched = await PointOrderModel.findById(pending._id).lean();
  assert.equal(untouched!.status, 'pending_ship', '非法转移不改状态');
  assert.equal(untouched!.completedAt, 0);
});

test('AO-4 道具概况 physicalPendingShip 只数 pending_ship', async (t) => {
  const beforeOverview = await itemsOverview();
  const a = await makeUser('概况计数用户', (await nextUids(1))[0]!);
  t.after(cleanupUsers(a));

  await makeOrder(a, { status: 'pending_ship' });
  await makeOrder(a, { status: 'shipped' });
  assert.equal(await PointOrderModel.countDocuments({ userId: a }), 2, '本用例确实造了 1 待发货 + 1 已发货');

  const afterOverview = await itemsOverview();
  const baseline = Number(beforeOverview.physicalPendingShip ?? 0);
  assert.equal(
    Number(afterOverview.physicalPendingShip) - baseline,
    1,
    'physicalPendingShip 只数 pending_ship：新增 1 待发货 + 1 已发货时增量必须是 1',
  );
});

test('AO-5 分页与排序：25 单 pageSize=10 翻三页不重不漏且全局 createdAt 不升', async (t) => {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const [uid] = await nextUids(1);
  const a = await makeUser(`分页用户${tag}`, uid);
  t.after(cleanupUsers(a));

  const base = Date.now() - 1_000_000;
  for (let i = 0; i < 25; i += 1) {
    await makeOrder(a, {
      status: 'pending_ship',
      itemKey: 't_ao_paging',
      createdAt: base + i * 1000,
    });
  }

  const pages = [] as Array<Awaited<ReturnType<typeof listOrders>>>;
  for (const page of [1, 2, 3]) {
    pages.push(await listOrders({ keyword: `分页用户${tag}`, page, pageSize: 10 }));
  }
  assert.deepEqual(pages.map((p) => p.items.length), [10, 10, 5], '三页条数 10/10/5');
  assert.deepEqual(pages.map((p) => p.total), [25, 25, 25], 'total 跟筛选条件走，不随页码变');

  const ids = pages.flatMap((p) => p.items.map((r) => r.id));
  assert.equal(new Set(ids).size, 25, '翻三页拼起来不重不漏');

  const expected = await PointOrderModel.find({ userId: a })
    .sort({ createdAt: -1, _id: -1 })
    .select({ _id: 1 })
    .lean();
  assert.deepEqual(ids, expected.map((r) => String(r._id)), '全局按 createdAt 倒序（不是每页各排各的）');

  const stamps = pages.flatMap((p) => p.items.map((r) => r.createdAt));
  for (let i = 1; i < stamps.length; i += 1) {
    assert.ok(stamps[i - 1]! >= stamps[i]!, `第 ${i} 条 createdAt 不能比前一条新`);
  }
});

test('AO-6 非法入参：不存在/畸形订单 id 404，非法状态筛选 400', async (t) => {
  const ghost = new Types.ObjectId();
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['发货：订单不存在', () => shipOrder(String(ghost), { trackingCompany: '顺丰', trackingNo: 'SF1' }, adminId)],
    ['发货：畸形 id', () => shipOrder('not-an-id', { trackingCompany: '顺丰', trackingNo: 'SF1' }, adminId)],
    ['代确认：订单不存在', () => completeOrder(String(ghost), adminId)],
    ['代确认：畸形 id', () => completeOrder('not-an-id', adminId)],
  ];
  for (const [label, fn] of cases) {
    await assert.rejects(fn, (e) => {
      const err = e as AppError;
      return err.statusCode === 404 && err.message === '订单不存在';
    }, `${label} 应 404 订单不存在`);
  }

  // 查询参数里的非法状态是 400（路径 id 才是 404），文案点名收到的值与允许值
  await assert.rejects(
    () => listOrders({ status: 'gift' }),
    (e) => {
      const err = e as AppError;
      return err.statusCode === 400
        && /pending_ship \/ shipped \/ completed/.test(err.message)
        && /gift/.test(err.message);
    },
    '非法状态筛选必须 400 点名允许值',
  );

  // HTTP 入口：路径 id 的 404 惯例不能退化成 500
  const httpGhost = await req(
    'PATCH', `${API}/admin/points/orders/${ghost}/ship`,
    { trackingCompany: '顺丰', trackingNo: 'SF1' },
  );
  assert.equal(httpGhost.statusCode, 404, httpGhost.body);
  assert.equal(httpGhost.json().message, '订单不存在');

  const httpMalformed = await req('PATCH', `${API}/admin/points/orders/not-an-id/complete`);
  assert.equal(httpMalformed.statusCode, 404, httpMalformed.body);
  assert.equal(httpMalformed.json().message, '订单不存在');

  const httpBadStatus = await req('GET', `${API}/admin/points/orders?status=gift`);
  assert.equal(httpBadStatus.statusCode, 400, httpBadStatus.body);
  assert.match(httpBadStatus.json().message, /pending_ship \/ shipped \/ completed/);

  // 未登录必须 401（adminAuth 闸门；Task 4 会把三条路由并入鉴权清单）
  const anonymous = await req('GET', `${API}/admin/points/orders`, undefined, false);
  assert.equal(anonymous.statusCode, 401, anonymous.body);
});
