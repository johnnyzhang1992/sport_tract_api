/**
 * 现金商品目录（spec §5.1）：形状校验、PUT 只改内容、种子幂等、管理端鉴权。
 * 共享 dev 库纪律：key 一律带 pp_test_ 前缀并在 after 删干净；
 * 三条真档位用 spec §4 的字面值（month_card/season_card/year_card）——它们同时被 seedPaidProducts 写，
 * 断言按「集合相等」不按「计数」，避免与别的会话的目录行互相干扰。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/paid-products.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import mongoose, { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { PaidProductModel, PAID_PRODUCT_PERK_KEYS } from '../src/models/paid-product.model.js';
import {
  assertPaidProductInput, createPaidProduct, listPaidProductsForAdmin,
  seedPaidProducts, paidProductPerksOf, setPaidProductActive, activePaidProducts, paidProductOf,
} from '../src/services/paid-products.js';

let app: FastifyInstance;
let adminToken: string;

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  app = await buildApp({ logger: false });
  await app.ready();
  // admin token：照现有后台测试的取法（/admin/login），不新造鉴权路径
  const res = await app.inject({
    method: 'POST',
    url: `${config.apiPrefix}/admin/login`,
    payload: { username: config.adminUsername, password: config.adminPassword },
  });
  adminToken = res.json().data.token as string;
});
beforeEach(async () => {
  await PaidProductModel.deleteMany({ key: { $regex: '^pp_test_' } });
});
after(async () => {
  await PaidProductModel.deleteMany({ key: { $regex: '^pp_test_' } });
  // PP-7 会把 month_card/season_card/year_card 三档删掉（收尾又删一次）：
  // 别的会话与 Task 7 的 member-order.test.ts 都依赖这三行存在，必须补跑种子复原（$setOnInsert 只补不覆盖）。
  // 注意要赶在 app.close() 之前——onClose 钩子会断开 mongoose。
  await seedPaidProducts();
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

test('PP-1 key 形状闸门：大写/短于 3 位/带连字符全部 400', () => {
  const base = { name: 'x', priceFen: 199, durationDays: 30 };
  for (const key of ['Month', 'ab', 'month-card', '', 'a'.repeat(33)]) {
    assert.throws(() => assertPaidProductInput({ ...base, key }, { partial: false }), /道具 ID/, `应拒: ${JSON.stringify(key)}`);
  }
  assert.doesNotThrow(() => assertPaidProductInput({ ...base, key: 'month_card' }, { partial: false }));
});

test('PP-2 priceFen/durationDays 必须正整数；0、负数、小数、缺字段都 400', () => {
  const base = { key: 'pp_test_a', name: 'x' };
  for (const priceFen of [0, -1, 1.5, '199', undefined]) {
    assert.throws(() => assertPaidProductInput({ ...base, priceFen, durationDays: 30 } as never, { partial: false }), /价格/);
  }
  for (const durationDays of [0, -3, 30.5, undefined]) {
    assert.throws(() => assertPaidProductInput({ ...base, priceFen: 199, durationDays } as never, { partial: false }), /天数/);
  }
});

test('PP-3 perks 只认白名单四键，未知键 400（防前端拼错键静默丢权益）', () => {
  assert.throws(
    () => assertPaidProductInput({ key: 'pp_test_a', name: 'x', priceFen: 199, durationDays: 30, perks: { addFree: true } as never }, { partial: false }),
    /权益/,
  );
  assert.deepEqual(PAID_PRODUCT_PERK_KEYS, ['adFree', 'exportBundle', 'photoQuota', 'subscribeNotice']);
});

test('PP-4 创建后管理端列表能读到，priceYuanText 是分→元（不是分）', async () => {
  await createPaidProduct({ key: 'pp_test_a', name: '会员月卡', priceFen: 199, durationDays: 30, perks: { adFree: true } });
  const rows = (await listPaidProductsForAdmin()).filter((r) => r.key.startsWith('pp_test_'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].priceYuanText, '1.99');
  assert.equal(rows[0].perks.adFree, true);
  assert.equal(rows[0].perks.photoQuota, 0, '缺省不写＝不给额度加成');
});

test('PP-5 PUT 只改内容：带 active 字段被拒（上架/下架走 PATCH active）', async () => {
  const created = await createPaidProduct({ key: 'pp_test_b', name: 'x', priceFen: 499, durationDays: 90 });
  const res = await app.inject({
    method: 'PUT',
    url: `${config.apiPrefix}/admin/xpay/products/${created.id}`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'y', active: false },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /上架/);
});

test('PP-6 七条 xpay 管理路由都要过鉴权，且不许是 404（没挂上的路由同样回 404）', async () => {
  // payload 的类型取 inject 接受的形态（string | object | Buffer | ReadableStream）：
  // 写成 unknown 会让 tsc 拒掉，method 同理要用字面量联合（照 admin-points-auth.test.ts 的既有写法）
  const cases: Array<['GET' | 'POST' | 'PUT' | 'PATCH', string, Record<string, unknown> | undefined]> = [
    ['GET', '/admin/xpay/products', undefined],
    ['POST', '/admin/xpay/products', { key: 'pp_test_c', name: 'x', priceFen: 199, durationDays: 30 }],
    ['PUT', `/admin/xpay/products/${new Types.ObjectId()}`, { name: 'x' }],
    ['PATCH', `/admin/xpay/products/${new Types.ObjectId()}/active`, { active: false }],
    ['PATCH', `/admin/xpay/products/${new Types.ObjectId()}/sort-order`, { sortOrder: 3 }],
    ['GET', '/admin/xpay/member-switch', undefined],
    ['POST', '/admin/xpay/member-switch', { enabled: true }],
  ];
  for (const [method, path, payload] of cases) {
    const res = await app.inject({ method, url: `${config.apiPrefix}${path}`, payload });
    assert.ok(res.statusCode === 401 || res.statusCode === 403, `${method} ${path} 落到了 ${res.statusCode}`);
    assert.notEqual(res.statusCode, 404);
  }
});

test('PP-7 seedPaidProducts 幂等：跑两次不新增、且不覆盖后台改过的价', async () => {
  const SEED_KEYS = ['month_card', 'season_card', 'year_card'];
  try {
    // 先把三档删干净，断言才是「无条件必跑」而不是「库里恰好有数据才跑」的条件守卫
    await PaidProductModel.deleteMany({ key: { $in: SEED_KEYS } });
    assert.equal(await seedPaidProducts(), 3, '首次应插入 3 条');
    assert.equal(await seedPaidProducts(), 0, '重跑不新增');
    await PaidProductModel.updateOne({ key: 'month_card' }, { $set: { priceFen: 1 } });
    assert.equal(await seedPaidProducts(), 0);
    const row = await PaidProductModel.findOne({ key: 'month_card' }).lean();
    assert.equal(row?.priceFen, 1, '$setOnInsert 不许把后台改价刷回种子值');
  } finally {
    // 无论断言是否中途抛错，都要把三档删干净，交给 after 的 seedPaidProducts() 以种子价重建。
    // 若只靠末行的正常路径收尾：一旦上面的 assert 红了，month_card 会被留在 1 分，
    // after 的 $setOnInsert 刷不动已存在的脏行，Task 7 的 MO-2 会读到脏目录——症状出现在别人的用例上。
    await PaidProductModel.deleteMany({ key: { $in: SEED_KEYS } });
  }
});

test('PP-8 paidProductPerksOf 目录被删时返回空 perks（历史单不能凭空长出权益）', () => {
  assert.deepEqual(paidProductPerksOf(undefined), { adFree: false, exportBundle: false, photoQuota: 0, subscribeNotice: false });
  assert.deepEqual(paidProductPerksOf({ perks: { adFree: true, photoQuota: 300 } }), { adFree: true, exportBundle: false, photoQuota: 300, subscribeNotice: false });
});

test('PP-9 两条 PATCH 的往返：下架/上架与改排序真的落库（Task 13 的目录页靠这两条）', async () => {
  const created = await createPaidProduct({ key: 'pp_test_p9', name: 'x', priceFen: 199, durationDays: 30, sortOrder: 7 });
  assert.equal(created.active, true);
  const off = await app.inject({
    method: 'PATCH', url: `${config.apiPrefix}/admin/xpay/products/${created.id}/active`,
    headers: { authorization: `Bearer ${adminToken}` }, payload: { active: false },
  });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().data.active, false);
  const row = await PaidProductModel.findOne({ key: 'pp_test_p9' }).lean();
  assert.equal(row?.active, false, 'PATCH 必须真写库，不能只回 DTO');

  const bad = await app.inject({
    method: 'PATCH', url: `${config.apiPrefix}/admin/xpay/products/${created.id}/sort-order`,
    headers: { authorization: `Bearer ${adminToken}` }, payload: { sortOrder: 1.5 },
  });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().message, /1\.5/);

  const moved = await app.inject({
    method: 'PATCH', url: `${config.apiPrefix}/admin/xpay/products/${created.id}/sort-order`,
    headers: { authorization: `Bearer ${adminToken}` }, payload: { sortOrder: 3 },
  });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal((await PaidProductModel.findOne({ key: 'pp_test_p9' }).lean())?.sortOrder, 3);
  // 排序只碰 sortOrder 一列：上下架状态不受影响
  assert.equal((await PaidProductModel.findOne({ key: 'pp_test_p9' }).lean())?.active, false);
});

test('PP-10 两条读路径真有输出：activePaidProducts 只出在售档位并按价升序，paidProductOf 认 key', async () => {
  await createPaidProduct({ key: 'pp_test_y', name: 'y', priceFen: 499, durationDays: 90, sortOrder: 2 });
  await createPaidProduct({ key: 'pp_test_m', name: 'm', priceFen: 199, durationDays: 30, sortOrder: 1 });
  await setPaidProductActive((await PaidProductModel.findOne({ key: 'pp_test_y' }).lean())!._id as unknown as string, false);
  const keys = (await activePaidProducts()).filter((i) => i.key.startsWith('pp_test_')).map((i) => i.key);
  assert.deepEqual(keys, ['pp_test_m'], '下架的档位不许出现在用户侧目录里');
  const one = await paidProductOf('pp_test_m');
  assert.equal(one?.key, 'pp_test_m');
  assert.equal(one?.priceFen, 199);
  assert.equal(await paidProductOf('pp_test_missing'), null, '查不到就是 null，调用方自行 400/404');
});

test('PP-11 每条上限与 PUT 结构性拒绝都要能用例抓住（删掉任一行 throw 都必须有测试变红）', async () => {
  const base = { key: 'pp_test_v', name: 'x', priceFen: 199, durationDays: 30 };
  const reject = (over: Record<string, unknown>, re: RegExp, label: string) => {
    assert.throws(() => assertPaidProductInput({ ...base, ...over }, { partial: false }), re, label);
  };
  reject({ name: '  ' }, /名称不能为空/, '空名称');
  reject({ name: '名'.repeat(21) }, /名称不能超过 20 字（当前 21 字）/, '名称超长要带实际值');
  reject({ subtitle: '副'.repeat(31) }, /副标题不能超过 30 字（当前 31 字）/, '副标题超长');
  reject({ priceFen: 1000001 }, /超过单笔上限（当前 1000001 分/, '价格上限');
  reject({ durationDays: 3661 }, /会员天数超过上限（当前 3661 天/, '天数上限');
  reject({ perks: 'yes' }, /权益必须是一个对象/, 'perks 形态');
  reject({ perks: { photoQuota: -1 } }, /照片额度必须是 0–10000 的整数（收到 -1/, '额度下界');
  reject({ perks: { photoQuota: 10001 } }, /收到 10001/, '额度上界');
  reject({ notes: Array.from({ length: 11 }, (_, i) => String(i)) }, /备注条数超过上限（当前 11 条/, '备注条数');
  reject({ sortOrder: 1.5 }, /排序必须是整数/, '创建时排序非整数');
  // PUT 分支的三条结构性拒绝（「PUT 只改内容」这条裁定的落点）
  const partialReject = (over: Record<string, unknown>, re: RegExp, label: string) => {
    assert.throws(() => assertPaidProductInput(over, { partial: true }), re, label);
  };
  partialReject({ sortOrder: 5 }, /排序请用 PATCH \/sort-order 入口/, 'PUT 改排序');
  partialReject({ key: 'month_card' }, /道具 ID 创建后不可改/, 'PUT 改 key');
  partialReject({ active: false }, /上架/, 'PUT 改上下架');
  // 空 body 的 PUT 不能静默成功
  await createPaidProduct(base);
  const id = (await PaidProductModel.findOne({ key: 'pp_test_v' }).lean())!._id as unknown as string;
  const res = await app.inject({
    method: 'PUT', url: `${config.apiPrefix}/admin/xpay/products/${id}`,
    headers: { authorization: `Bearer ${adminToken}` }, payload: {},
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /没有需要更新的内容/);
});
