import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import { isOssConfigured } from '../src/config/index.js';
import { PointCardModel, PointExchangeModel, PointItemModel } from '../src/models/point.model.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { seedPointItems } from '../src/services/points-catalog.js';
import { listActiveItems } from '../src/services/points-items.js';
import {
  ITEM_KEY_RE,
  assertItemInput,
  createItem,
  listItemsForAdmin,
  setItemStock,
  updateItem,
  type ItemInput,
} from '../src/services/points-catalog-admin.js';
import { AppError } from '../src/utils/app-error.js';

/**
 * 管理端道具目录：CRUD + 库存改写 + 道具图上传（spec §5.1/§7.2，Task 4 用例 AI-1…AI-8）。
 *
 * 共享 dev 库（sport-track-dev）口径：
 * - 测试道具一律 t_ 前缀 key，t.after()/after() 里按 key 删干净，绝不留档；
 * - ad_free_* / makeup_card 是被用例临时改过 active/sortOrder 的种子行，
 *   各自 t.after() 复原 + 文件级 after() 兜底刷回种子形态（三条免广告 active:false、
 *   makeup_card sortOrder:10 顶第一），别把 dev 库留在实验态；
 * - 断言只读库（findOne/lean、listActiveItems/listItemsForAdmin），不看日志。
 */

const ADMIN_USER = 'admin_items_t4';
const ADMIN_PASS = 'test123456';
const TEST_KEY = 't_admin_item_case';

const validInput: ItemInput = {
  key: TEST_KEY, name: '测试道具', subtitle: '', description: '', notes: [],
  price: 100, validDays: 30, effect: { kind: 'ad_free' as const, days: 5 },
  stock: 10, unlimited: false, active: true, sortOrder: 900, image: '',
};

let app: FastifyInstance;
let adminToken = '';

async function req(method: string, url: string, payload?: unknown, withToken = true) {
  return app.inject({
    method: method as 'GET',
    url,
    headers: withToken ? { authorization: `Bearer ${adminToken}` } : {},
    payload: payload as Record<string, unknown> | undefined,
  });
}

before(async () => {
  // buildApp 的 onReady 会跑 seedPointItems（$setOnInsert），目录种子在这里就位
  app = await buildApp({ logger: false });
  await app.ready();

  await AdminModel.deleteOne({ username: ADMIN_USER });
  await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  const login = await req('POST', '/sport-track/api/admin/login', { username: ADMIN_USER, password: ADMIN_PASS }, false);
  adminToken = login.json().data.token;
  assert.ok(adminToken, '管理员登录应成功');

  // 上一次崩溃残留会污染 AI-1 的行数断言，开跑前先清一遍本文件的 key
  await PointItemModel.deleteMany({ key: TEST_KEY });
});

after(async () => {
  await PointItemModel.deleteMany({ key: TEST_KEY });
  await PointItemModel.updateMany({ key: /^ad_free_/ }, { $set: { active: false } });
  await PointItemModel.updateOne({ key: 'ad_free_7d' }, { $set: { sortOrder: 20, 'effect.days': 7 } });
  await PointItemModel.updateOne({ key: 'makeup_card' }, { $set: { sortOrder: 10, active: true } });
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await app.close();
});

test('AI-1 列表含下架项，带兑换数/发放数', async (t) => {
  await seedPointItems();
  // 显式下架一次：不受上一次运行/AI-5 试验残留影响，本用例自给自足
  await PointItemModel.updateOne({ key: 'ad_free_7d' }, { $set: { active: false } });
  const u = new Types.ObjectId();
  t.after(async () => {
    await PointExchangeModel.deleteMany({ userId: u });
    await PointCardModel.deleteMany({ userId: u });
  });

  const before = await listItemsForAdmin();
  assert.equal(before.length, 4, '管理端必须看得到下架项（当前库里应只有四条种子）');
  assert.ok(before.find((r) => r.key === 'ad_free_7d' && r.active === false));
  const seeded = before.find((r) => r.key === 'makeup_card')!;
  assert.equal(seeded.active, true, '补签卡必须默认可见');
  for (const k of ['ad_free_7d', 'ad_free_15d', 'ad_free_30d']) {
    assert.equal(before.find((r) => r.key === k)!.active, false,
      '免广告卡默认下架：小程序发版前老端首页 wx:for 会多出商品卡但点进去全是补签详情（见 Task 14 与部署顺序）');
  }
  assert.equal(typeof seeded.exchangeCount, 'number');
  assert.equal(typeof seeded.grantCount, 'number');

  // 计数不是摆设：造一条兑换 + 一条 admin 发放，两个数字必须各自 +1（写死 0 也蒙不过这条）
  const now = Date.now();
  const mkCard = async (source: 'admin' | 'exchange') => {
    const card = await PointCardModel.create({
      userId: u, itemKey: 'makeup_card', status: 'unused', source, createdAt: now, expiresAt: now + 86400000,
    });
    await PointExchangeModel.create({
      userId: u, itemKey: 'makeup_card', cost: 200, cardId: card._id, requestId: `${u}-ai1-${source}`, createdAt: now,
    });
  };
  await mkCard('admin');
  let row = (await listItemsForAdmin()).find((r) => r.key === 'makeup_card')!;
  assert.equal(row.exchangeCount, seeded.exchangeCount + 1, '兑换数按 itemKey 计数');
  assert.equal(row.grantCount, seeded.grantCount + 1, 'admin 来源发放要计入发放数');
  await mkCard('exchange');
  row = (await listItemsForAdmin()).find((r) => r.key === 'makeup_card')!;
  assert.equal(row.exchangeCount, seeded.exchangeCount + 2);
  assert.equal(row.grantCount, seeded.grantCount + 1, '兑换来源的卡不算发放数（source ∈ {admin,system}）');
});

test('AI-2 新增：key 非法/重复、ad_free 缺 days 各自报清楚', async (t) => {
  t.after(() => PointItemModel.deleteMany({ key: TEST_KEY }));
  await assert.rejects(() => createItem({ ...validInput, key: 'Bad Key' }), (e) =>
    (e as AppError).statusCode === 400 && /道具 key/.test((e as Error).message));
  await createItem(validInput);
  await assert.rejects(() => createItem(validInput), (e) => (e as AppError).statusCode === 409
    && /道具 key 已存在：t_admin_item_case/.test((e as Error).message));
  await assert.rejects(() => createItem({ ...validInput, key: 'x2', effect: { kind: 'ad_free', days: 0 } }),
    /免广告道具必须填天数/);

  // 其余 schema 表达不了的校验（assertItemInput 直调，不落库）：文案必须带对象+实际值+上限
  const cases: Array<{ patch: Partial<ItemInput>; copy: RegExp }> = [
    { patch: { name: '名'.repeat(21) }, copy: /道具名称最多 20 字（当前 21 字）/ },
    { patch: { name: '  ' }, copy: /道具名称不能为空/ },
    { patch: { price: 0 }, copy: /兑换价至少 1 分（收到 0）/ },
    { patch: { validDays: 0 }, copy: /卡有效期至少 1 天（收到 0）/ },
    { patch: { notes: Array.from({ length: 9 }, (_, i) => `说明${i}`) }, copy: /兑换说明最多 8 条（当前 9 条）/ },
  ];
  for (const { patch, copy } of cases) {
    assert.throws(() => assertItemInput({ ...validInput, ...patch }), (e) =>
      e instanceof AppError && e.statusCode === 400 && copy.test(e.message), `应报「${copy}」：${JSON.stringify(patch)}`);
  }
  // key 形状正反面：2–40 位小写开头 a-z0-9_
  assert.ok(ITEM_KEY_RE.test('ab') && ITEM_KEY_RE.test('a'.repeat(40)));
  assert.ok(!ITEM_KEY_RE.test('a') && !ITEM_KEY_RE.test('A_b') && !ITEM_KEY_RE.test('1x') && !ITEM_KEY_RE.test('a'.repeat(41)));
});

test('AI-3 编辑不许改 key（台账靠它关联）', async (t) => {
  t.after(() => PointItemModel.deleteMany({ key: TEST_KEY }));
  const row = await createItem(validInput);
  await assert.rejects(() => updateItem(String(row._id), { ...validInput, key: 'another_key' }), (e) => {
    const err = e as AppError;
    // 400 且把原 key 与收到的 key 都点名（错误文案「对象+实际值+限制」口径）
    return err.statusCode === 400 && /key 创建后不可修改/.test(err.message)
      && err.message.includes(TEST_KEY) && err.message.includes('another_key');
  });
  // 同 key 回填（后台表单整行原样提交）是合法更新
  const r = await updateItem(String(row._id), { ...validInput, price: 321 });
  assert.equal(r.price, 321);
  assert.equal((await PointItemModel.findOne({ _id: row._id }).lean())!.price, 321, '改完库里要读得到');
});

test('AI-4 库存改写传目标值，返回改前改后；负数 400', async (t) => {
  t.after(() => PointItemModel.deleteMany({ key: TEST_KEY }));
  const row = await createItem(validInput);
  const r = await setItemStock(String(row._id), 7);
  // before 取的是创建时传的 10（不是 schema 默认 9999）：createItem 丢字段也能被这条抓住
  assert.deepEqual(r, { before: 10, after: 7 });
  // 目标值语义：连改两次不累加，第二次 before 就是上一次结果（写成 $inc 这里必红）
  assert.deepEqual(await setItemStock(String(row._id), 3), { before: 7, after: 3 });
  assert.equal((await PointItemModel.findOne({ _id: row._id }).lean())!.stock, 3);
  await assert.rejects(() => setItemStock(String(row._id), -1), (e) =>
    (e as AppError).statusCode === 400 && /库存不能为负（收到 -1）/.test((e as Error).message));
});

test('AI-5 active 过滤真的生效（不是靠种子默认值蒙过）', async () => {
  await seedPointItems();
  const items = await listActiveItems();
  assert.equal(items[0].key, 'makeup_card', 'sortOrder 必须把补签卡顶在第一位（老客户端只读 items[0]）');
  assert.equal(items.some((i) => i.key === 'ad_free_7d'), false, '种子默认下架');
  // 关键一步：显式上架后必须出现，否则「过滤」这条断言会因为种子默认值而恒过
  await PointItemModel.updateOne({ key: 'ad_free_7d' }, { $set: { active: true } });
  assert.ok((await listActiveItems()).some((i) => i.key === 'ad_free_7d'), '上架后端上要能读到');
  await PointItemModel.updateOne({ key: 'ad_free_7d' }, { $set: { active: false } });
  assert.equal((await listActiveItems()).some((i) => i.key === 'ad_free_7d'), false, '再下架要消失');
});

test('AI-6 道具图上传：入库裸链、后台展示签名链、端上下发走缩略档', async (t) => {
  t.after(() => PointItemModel.deleteMany({ key: TEST_KEY }));
  // 1x1 PNG（最小合法图，AI-6 走完整 multipart→OSS 链路）
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const boundary = '----sporttrackitemtest';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="item.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/points/items/image',
    payload,
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  if (!isOssConfigured()) {
    // 本地没配 OSS 凭证：uploadBuffer 必须明确 503，不许假成功回个坏 url
    assert.equal(res.statusCode, 503, res.body);
    return;
  }
  assert.equal(res.statusCode, 200, res.body);
  const { url, previewUrl } = res.json().data as { url: string; previewUrl: string };
  assert.ok(!url.includes('Signature=') && !url.includes('x-oss-process='), `入库必须是裸链，实际 ${url}`);
  assert.match(previewUrl, /[?&]Signature=/, '后台展示要签名链（私有桶裸链进 <img> 403）');

  const row = await createItem(validInput);
  await updateItem(String(row._id), { ...validInput, image: url });
  assert.equal((await PointItemModel.findOne({ _id: row._id }).lean())!.image, url, '库里存裸链，不存签名参数');

  const item = (await listActiveItems()).find((i) => i.key === TEST_KEY)!;
  assert.ok(item.imageUrl, '端上下发 imageUrl 不能为空');
  assert.ok(item.imageUrl.startsWith(`${url}?`), `端上下发应是签名链，实际 ${item.imageUrl}`);
  // 缩略档（thumb：w_240）没走就是原图灌进小程序列表——签名参数里能验出档位
  assert.match(decodeURIComponent(item.imageUrl), /x-oss-process=image\/resize,w_240/, '下发必须走缩略档位');

  // 管理列表同口径：image 保持裸链（编辑表单回填的就是入库值），展示取 previewUrl
  const adminRow = (await listItemsForAdmin()).find((r) => r.key === TEST_KEY)!;
  assert.equal(adminRow.image, url, '管理列表的 image 字段仍是裸链');
  assert.match(adminRow.previewUrl, /[?&]Signature=/, '管理列表要带签名 previewUrl（后台 <img> 用裸链会 403）');
});

test('AI-7 sortOrder 升序是真保障：两行同时上架互证', async (t) => {
  await seedPointItems();
  const restore = () => Promise.all([
    PointItemModel.updateOne({ key: 'makeup_card' }, { $set: { sortOrder: 10 } }),
    PointItemModel.updateOne({ key: 'ad_free_7d' }, { $set: { sortOrder: 20, active: false } }),
  ]);
  // t.after：断言中途炸了也要把种子行刷回原态，after() 只是兜底
  t.after(restore);

  // 档 A：ad_free_7d 上架且 sortOrder 压到补签卡之前 → 首位必须换成它（只有一行 active 时
  // items[0] 的断言分不清「排序」和「运气」，这里凑两行让排序必须表态）
  await PointItemModel.updateOne({ key: 'ad_free_7d' }, { $set: { active: true, sortOrder: 5 } });
  const a = await listActiveItems();
  assert.deepEqual(a.slice(0, 2).map((i) => i.key), ['ad_free_7d', 'makeup_card'],
    'sortOrder 升序：5 的免广告卡必须排在 10 的补签卡前面');

  // 档 B：把它抬到补签卡之后 → 顺序必须跟着翻转（只验单向等于没验方向）
  await PointItemModel.updateOne({ key: 'ad_free_7d' }, { $set: { sortOrder: 15 } });
  const b = await listActiveItems();
  assert.deepEqual(b.slice(0, 2).map((i) => i.key), ['makeup_card', 'ad_free_7d'],
    'sortOrder 升序方向：15 必须排回 10 后面');

  await restore();
  const c = await listActiveItems();
  assert.equal(c[0].key, 'makeup_card', '复原后补签卡回到第一位（老客户端 items[0] 兼容）');
  assert.equal(c.some((i) => i.key === 'ad_free_7d'), false, '复原后免广告档回到下架态');
});

test('AI-8 路由接线：鉴权闸门 + CRUD/库存全走 HTTP，非法 id 404 不泄露 500', async (t) => {
  t.after(() => PointItemModel.deleteMany({ key: TEST_KEY }));
  await seedPointItems();
  const GHOST = 'ffffffffffffffffffffffff';
  // 每条路由都必须挂 adminAuth：没 token 一律 401，不能因新节漏挂变公开接口
  for (const [method, url] of [
    ['GET', '/sport-track/api/admin/points/items'],
    ['POST', '/sport-track/api/admin/points/items'],
    ['PUT', `/sport-track/api/admin/points/items/${GHOST}`],
    ['PATCH', `/sport-track/api/admin/points/items/${GHOST}/stock`],
    ['POST', '/sport-track/api/admin/points/items/image'],
  ] as const) {
    const res = await req(method, url, {}, false);
    assert.equal(res.statusCode, 401, `${method} ${url} 未登录必须 401：${res.body}`);
  }

  const created = await req('POST', '/sport-track/api/admin/points/items', validInput);
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().data._id as string;
  assert.ok(id, 'POST 要回 _id 供后续编辑');

  const dup = await req('POST', '/sport-track/api/admin/points/items', validInput);
  assert.equal(dup.statusCode, 409, `重复 key 经路由要落 409：${dup.body}`);
  assert.match(dup.json().message, /道具 key 已存在：t_admin_item_case/);

  const badKey = await req('PUT', `/sport-track/api/admin/points/items/${id}`, { ...validInput, key: 'another_key' });
  assert.equal(badKey.statusCode, 400, badKey.body);
  assert.match(badKey.json().message, /key 创建后不可修改/);

  // 形态非法的 :id 走 assertObjectIdLike → 资源级 404，不许 CastError 落 500
  const ghostPut = await req('PUT', '/sport-track/api/admin/points/items/not-an-id', validInput);
  assert.equal(ghostPut.statusCode, 404, `PUT 非法 id 应 404：${ghostPut.body}`);
  assert.equal(ghostPut.json().message, '道具不存在');
  const ghostPatch = await req('PATCH', '/sport-track/api/admin/points/items/not-an-id/stock', { stock: 1 });
  assert.equal(ghostPatch.statusCode, 404, `PATCH 非法 id 应 404：${ghostPatch.body}`);
  assert.equal(ghostPatch.json().message, '道具不存在');

  const upd = await req('PUT', `/sport-track/api/admin/points/items/${id}`, { ...validInput, price: 150 });
  assert.equal(upd.statusCode, 200, upd.body);
  assert.equal(upd.json().data.price, 150);

  const stock = await req('PATCH', `/sport-track/api/admin/points/items/${id}/stock`, { stock: 4 });
  assert.deepEqual(stock.json().data, { before: 10, after: 4 }, '库存改写回 {before, after}');
  const badStock = await req('PATCH', `/sport-track/api/admin/points/items/${id}/stock`, {});
  assert.equal(badStock.statusCode, 400, `缺 stock 要 400 报实际值：${badStock.body}`);
  assert.match(badStock.json().message, /库存/);

  const list = await req('GET', '/sport-track/api/admin/points/items');
  assert.equal(list.statusCode, 200);
  const row = (list.json().data as Array<{ key: string; price: number; stock: number }>)
    .find((r) => r.key === TEST_KEY);
  assert.ok(row, 'HTTP 列表能读回刚建的道具');
  assert.equal(row!.price, 150);
  assert.equal(row!.stock, 4);
});
