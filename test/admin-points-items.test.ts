import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import { isOssConfigured } from '../src/config/index.js';
import { PointCardModel, PointExchangeModel, PointItemModel } from '../src/models/point.model.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { POINT_ITEMS_SEED, seedPointItems } from '../src/services/points-catalog.js';
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
 * 管理端道具目录：CRUD + 库存改写 + 道具图上传（spec §5.1/§7.2，Task 4 用例 AI-1…AI-9）。
 *
 * 共享 dev 库（sport-track-dev）口径：
 * - 测试道具一律 t_ 前缀 key，before()/t.after()/after() 都走 cleanupItems()
 *   （^t_ 全集 + 闸门退化时写得进去的 another_key），绝不留档；
 * - 行数类断言不写死种子条数，一律现读库（countDocuments）比对，残行/别的任务加行都翻不动它；
 * - ad_free_* / makeup_card 是被用例临时改过 active/sortOrder 的种子行，
 *   各自 t.after() 复原 + 文件级 after() 兜底刷回种子形态（三条免广告 active:false、
 *   makeup_card sortOrder:10 顶第一），别把 dev 库留在实验态；
 * - 断言只读库（findOne/lean、listActiveItems/listItemsForAdmin），不看日志。
 */

const ADMIN_USER = 'admin_items_t4';
const ADMIN_PASS = 'test123456';
const TEST_KEY = 't_admin_item_case';
/** 改名尝试的目标 key：key 不可改闸门一旦退化，'another_key' 就是它写进共享库的行，必须进清理集合 */
const RENAMED_KEY = 'another_key';

const validInput: ItemInput = {
  key: TEST_KEY, name: '测试道具', subtitle: '', description: '', notes: [],
  price: 100, validDays: 30, effect: { kind: 'ad_free' as const, days: 5 },
  stock: 10, unlimited: false, active: true, sortOrder: 900, image: '',
};

/**
 * 本文件会在共享库里碰到的所有 key：^t_ 前缀（含 t_bad_kind）+ 闸门退化时写得进去的 another_key。
 * 清理只删 TEST_KEY 是不够的——AI-3/AI-8 试图写入的 'another_key' 既不带 t_ 前缀也没有别的地方复原它，
 * key 不可改闸门一旦回归，这行就永久留在共享 dev 目录里，下一次跑 AI-1 会因为多出一行而假红
 * （Task 4 首轮变异验证的 mutation-7 就是这么不得不手删残留的）。
 */
const TEST_ITEM_FILTER = { $or: [{ key: /^t_/ }, { key: RENAMED_KEY }] };

/** 统一的清库出口：before()/after()/t.after() 都走它，别各自挑一个 key */
const cleanupItems = () => PointItemModel.deleteMany(TEST_ITEM_FILTER);

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

/** 从合法整行里删掉指定字段：验 PUT 的「内容字段必传」与「不许带库存」 */
function omitFields(body: ItemInput, ...fields: string[]): ItemInput {
  const out: Record<string, unknown> = { ...body };
  for (const f of fields) delete out[f];
  // 故意交出一个「字段缺席」的 body：绕开 TS 的必传声明，让运行期闸门自己去点名
  return out as unknown as ItemInput;
}

const readItem = async (id: string) => PointItemModel.findOne({ _id: id }).lean();

before(async () => {
  // buildApp 的 onReady 会跑 seedPointItems（$setOnInsert），目录种子在这里就位
  app = await buildApp({ logger: false });
  await app.ready();

  await AdminModel.deleteOne({ username: ADMIN_USER });
  await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  const login = await req('POST', '/sport-track/api/admin/login', { username: ADMIN_USER, password: ADMIN_PASS }, false);
  adminToken = login.json().data.token;
  assert.ok(adminToken, '管理员登录应成功');

  // 上一次崩溃/闸门退化残留的行会污染 AI-1 的行数与 409 断言，开跑前先清一遍本文件的 key 全集
  await cleanupItems();
});

after(async () => {
  await cleanupItems();
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
  // 条数不写死 4，取库里的真实行数：共享 dev 目录被别的任务加行、或上一轮闸门退化留下残行，
  // 都不该把「管理端看得到下架项」这条变成假红（首轮变异验证就为这多手删过一次 another_key）。
  // 列表必须等于全表，才是这条断言的本意；四条种子的可见性由下面的按 key 断言负责。
  const dbRows = await PointItemModel.countDocuments({});
  assert.equal(before.length, dbRows, `管理端列表要覆盖全表（含下架项）：列表 ${before.length} 行 / 库里 ${dbRows} 行`);
  assert.ok(dbRows >= POINT_ITEMS_SEED.length, `种子行要在库里（期望 ≥${POINT_ITEMS_SEED.length}，实际 ${dbRows}）`);
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
  t.after(cleanupItems);
  await assert.rejects(() => createItem({ ...validInput, key: 'Bad Key' }), (e) =>
    (e as AppError).statusCode === 400 && /道具 key/.test((e as Error).message));
  await createItem(validInput);
  await assert.rejects(() => createItem(validInput), (e) => (e as AppError).statusCode === 409
    && /道具 key 已存在：t_admin_item_case/.test((e as Error).message));
  // 这条也走 t_ 前缀：ad_free 天数闸门万一退化，落库的残行必须在清理集合里
  await assert.rejects(() => createItem({ ...validInput, key: 't_ad_free_no_days', effect: { kind: 'ad_free', days: 0 } }),
    /免广告道具必须填天数/);

  // 其余 schema 表达不了的校验（assertItemInput 直调，不落库）：文案必须带对象+实际值+上限
  const cases: Array<{ patch: Partial<ItemInput>; copy: RegExp }> = [
    { patch: { name: '名'.repeat(21) }, copy: /道具名称最多 20 字（当前 21 字）/ },
    { patch: { name: '  ' }, copy: /道具名称不能为空/ },
    { patch: { price: 0 }, copy: /兑换价至少 1 分（收到 0）/ },
    { patch: { validDays: 0 }, copy: /卡有效期至少 1 天（收到 0）/ },
    { patch: { notes: Array.from({ length: 9 }, (_, i) => `说明${i}`) }, copy: /兑换说明最多 8 条（当前 9 条）/ },
    // effect.kind 越界：enum 只写在 schema 里，不在 service 闸门就会冒到 error-handler 变 500 带内部文案
    { patch: { effect: { kind: 'xxx' as never, days: 1 } }, copy: /道具效果类型只能是 makeup 或 ad_free（收到「xxx」）/ },
    { patch: { effect: { kind: 'MAKEUP' as never, days: 1 } }, copy: /道具效果类型只能是 makeup 或 ad_free（收到「MAKEUP」）/ },
    { patch: { effect: undefined }, copy: /道具效果必须提供 effect 对象/ },
    { patch: { effect: null as never }, copy: /道具效果必须提供 effect 对象/ },
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
  t.after(cleanupItems);
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

test('AI-4 库存改写传目标值，返回改前改后；负数 400；unlimited 由这条独占', async (t) => {
  t.after(cleanupItems);
  const row = await createItem(validInput);
  const r = await setItemStock(String(row._id), { stock: 7 });
  // before 取的是创建时传的 10（不是 schema 默认 9999）：createItem 丢字段也能被这条抓住
  assert.deepEqual(r, { before: { stock: 10, unlimited: false }, after: { stock: 7, unlimited: false } });
  // 目标值语义：连改两次不累加，第二次 before 就是上一次结果（写成 $inc 这里必红）
  assert.deepEqual(await setItemStock(String(row._id), { stock: 3 }),
    { before: { stock: 7, unlimited: false }, after: { stock: 3, unlimited: false } });
  assert.equal((await readItem(String(row._id)))!.stock, 3);
  await assert.rejects(() => setItemStock(String(row._id), { stock: -1 }), (e) =>
    (e as AppError).statusCode === 400 && /库存不能为负（收到 -1）/.test((e as Error).message));

  // unlimited 单独改：不必带 stock，改完两个字段都要报出来（库存数字不能被顺手抹掉）
  assert.deepEqual(await setItemStock(String(row._id), { unlimited: true }),
    { before: { stock: 3, unlimited: false }, after: { stock: 3, unlimited: true } });
  assert.equal((await readItem(String(row._id)))!.stock, 3, '只改 unlimited 不许动库存');
  // 两个都不传：至少传一个，否则等于没说要改什么
  await assert.rejects(() => setItemStock(String(row._id), {}), (e) =>
    (e as AppError).statusCode === 400 && /stock/.test((e as Error).message) && /unlimited/.test((e as Error).message));
  await assert.rejects(() => setItemStock(String(row._id), { unlimited: 'yes' as never }), (e) =>
    (e as AppError).statusCode === 400 && /unlimited 只能是 true 或 false（收到「yes」）/.test((e as Error).message));
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
  t.after(cleanupItems);
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
  t.after(cleanupItems);
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

  // effect.kind 越界必须落 400 并点名收到的值：漏了这道闸门就是 Mongoose ValidationError
  // → error-handler 通用分支 500，非生产环境还会把内部原文回显给后台
  const badKindPost = await req('POST', '/sport-track/api/admin/points/items', { ...validInput, key: 't_bad_kind', effect: { kind: 'xxx', days: 1 } });
  assert.equal(badKindPost.statusCode, 400, `effect.kind 越界应 400 而非 500：${badKindPost.body}`);
  assert.match(badKindPost.json().message, /道具效果类型只能是 makeup 或 ad_free（收到「xxx」）/);
  const badKindPut = await req('PUT', `/sport-track/api/admin/points/items/${id}`, { ...validInput, effect: { kind: 'xxx', days: 1 } });
  assert.equal(badKindPut.statusCode, 400, `PUT 的 effect.kind 越界同样要 400：${badKindPut.body}`);
  assert.match(badKindPut.json().message, /道具效果类型只能是 makeup 或 ad_free（收到「xxx」）/);
  assert.equal(await PointItemModel.countDocuments({ key: 't_bad_kind' }), 0, '被拒的入参不许留下道具行');

  // 形态非法的 :id 走 assertObjectIdLike → 资源级 404，不许 CastError 落 500
  const ghostPut = await req('PUT', '/sport-track/api/admin/points/items/not-an-id', validInput);
  assert.equal(ghostPut.statusCode, 404, `PUT 非法 id 应 404：${ghostPut.body}`);
  assert.equal(ghostPut.json().message, '道具不存在');
  const ghostPatch = await req('PATCH', '/sport-track/api/admin/points/items/not-an-id/stock', { stock: 1 });
  assert.equal(ghostPatch.statusCode, 404, `PATCH 非法 id 应 404：${ghostPatch.body}`);
  assert.equal(ghostPatch.json().message, '道具不存在');

  // PUT 不带 stock：库存必须原样（这条排在改价前，验证的是「缺字段不复活默认值」）
  const putNoStock = await req('PUT', `/sport-track/api/admin/points/items/${id}`, omitFields(validInput, 'stock', 'unlimited'));
  assert.equal(putNoStock.statusCode, 200, `PUT 不带库存也要合法（库存归 PATCH）：${putNoStock.body}`);
  assert.equal((await readItem(id))!.stock, 10, 'PUT 缺 stock 不许把库存刷成默认 9999');

  const upd = await req('PUT', `/sport-track/api/admin/points/items/${id}`, { ...validInput, price: 150 });
  assert.equal(upd.statusCode, 200, upd.body);
  assert.equal(upd.json().data.price, 150);

  const stock = await req('PATCH', `/sport-track/api/admin/points/items/${id}/stock`, { stock: 4 });
  assert.deepEqual(stock.json().data,
    { before: { stock: 10, unlimited: false }, after: { stock: 4, unlimited: false } }, '库存改写回 {before, after}');
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

test('AI-9 PUT 只拥有内容字段：绝不写 stock/unlimited，缺内容字段 400 点名', async (t) => {
  t.after(cleanupItems);
  const row = await createItem(validInput);
  const id = String(row._id);
  // 先把行改成「售罄 + 非不限量 + 有图」，PUT 之后这三个状态必须原样还在
  await PointItemModel.updateOne({ _id: row._id }, { $set: { stock: 0, unlimited: false, image: 't_items/old.png' } });
  // 整行内容（含当前图）——PUT 的正确姿势，只是不带库存与不限量
  const content = { ...validInput, image: 't_items/old.png' };

  // 内容齐全但不带库存：PUT 200，库存/不限量一个都不许被默认值复活
  const ok = await updateItem(id, omitFields(content, 'stock', 'unlimited'));
  assert.equal(ok.price, validInput.price);
  let db = await readItem(id);
  assert.equal(db!.stock, 0, 'PUT 不许把售罄改回 9999（目标值语义只属于 PATCH /stock）');
  assert.equal(db!.unlimited, false, 'PUT 不许写 unlimited');
  assert.equal(db!.image, 't_items/old.png', 'PUT 带的 image 与库里一致，不该被抹掉');

  // 后台表单会把整行（含库存）原样提交回来：带着也不许写
  await updateItem(id, { ...content, stock: 9999, unlimited: true });
  db = await readItem(id);
  assert.equal(db!.stock, 0, 'PUT 带了 stock 也要忽略');
  assert.equal(db!.unlimited, false, 'PUT 带了 unlimited 也要忽略');

  // 十个内容字段全必传：缺哪个就 400 点名哪个，没有默认值兜底
  for (const field of ['name', 'subtitle', 'description', 'notes', 'price', 'validDays', 'effect', 'active', 'sortOrder', 'image']) {
    await assert.rejects(() => updateItem(id, omitFields(content, field)), (e) => {
      const err = e as AppError;
      return err.statusCode === 400 && err.message.includes(field);
    }, `缺「${field}」的 PUT 必须 400 并点名该字段`);
  }
  // null 也算没传（String(null) 会把 'null' 写进库）
  await assert.rejects(() => updateItem(id, { ...content, image: null as never }), (e) =>
    (e as AppError).statusCode === 400 && /image/.test((e as Error).message));
  db = await readItem(id);
  assert.equal(db!.image, 't_items/old.png', '被拒的 PUT 一个字都不该改（校验先于写）');
  assert.equal(db!.price, validInput.price, '被拒的 PUT 不许留下半行改写');

  // 路由层同样落码：缺 image 的 PUT 是 400（点名 image），不是 200 后悄悄清图
  const missingImage = await req('PUT', `/sport-track/api/admin/points/items/${id}`, omitFields(content, 'image'));
  assert.equal(missingImage.statusCode, 400, `PUT 缺 image 要 400：${missingImage.body}`);
  assert.match(missingImage.json().message, /image/);
  assert.equal((await readItem(id))!.image, 't_items/old.png', '400 之后图还在库里（不清图、不孤立已上传对象）');

  // PATCH 是库存与不限量的唯一出口：HTTP 只改 unlimited 也要生效，且两个字段都报改前改后
  const onlyUnlimited = await req('PATCH', `/sport-track/api/admin/points/items/${id}/stock`, { unlimited: true });
  assert.equal(onlyUnlimited.statusCode, 200, onlyUnlimited.body);
  assert.deepEqual(onlyUnlimited.json().data,
    { before: { stock: 0, unlimited: false }, after: { stock: 0, unlimited: true } });
  assert.equal((await readItem(id))!.unlimited, true);
  const emptyPatch = await req('PATCH', `/sport-track/api/admin/points/items/${id}/stock`, {});
  assert.equal(emptyPatch.statusCode, 400, `PATCH 空 body 要 400：${emptyPatch.body}`);
  assert.match(emptyPatch.json().message, /stock/);
});

test('AI-10 effect.days 非数字与 notes 非数组：400 点名对象+实际值，不是 500 内部报错', async (t) => {
  t.after(cleanupItems);

  // 闸门本身：两类入参都必须在 assertItemInput 被拦下（schema 只会抛 CastError/TypeError → 500）
  const direct: Array<{ patch: Partial<ItemInput>; copy: RegExp }> = [
    // makeup 分支不查 days，'abc' 会一路走到 Number('abc')=NaN → Mongoose CastError（500）
    { patch: { effect: { kind: 'makeup', days: 'abc' as never } }, copy: /道具效果天数 effect\.days 必须是 ≥0 的有限数字（收到「abc」）/ },
    // 负数同样过不了 schema 的 min:0（也是 500），文案要带收到的值
    { patch: { effect: { kind: 'makeup', days: -5 } }, copy: /道具效果天数 effect\.days 必须是 ≥0 的有限数字（收到「-5」）/ },
    // notes 非数组：normalize 里的 .map 会 TypeError（500）
    { patch: { notes: 'not-an-array' as never }, copy: /兑换说明 notes 必须是字符串数组，最多 8 条（收到「not-an-array」）/ },
    { patch: { notes: {} as never }, copy: /兑换说明 notes 必须是字符串数组，最多 8 条（收到「\{\}」）/ },
  ];
  for (const { patch, copy } of direct) {
    assert.throws(() => assertItemInput({ ...validInput, ...patch }), (e) =>
      e instanceof AppError && e.statusCode === 400 && copy.test(e.message),
    `应报「${copy}」：${JSON.stringify(patch)}`);
  }

  // POST 经路由：状态码必须是 400 而不是 500（error-handler 的通用分支还会回显内部原文）
  const badDays = await req('POST', '/sport-track/api/admin/points/items', {
    ...validInput, key: 't_bad_effect_days', effect: { kind: 'makeup', days: 'abc' },
  });
  assert.equal(badDays.statusCode, 400, `非数字 effect.days 应 400 而非 500：${badDays.body}`);
  assert.match(badDays.json().message, /effect\.days/);
  assert.match(badDays.json().message, /「abc」/);
  assert.equal(await PointItemModel.countDocuments({ key: 't_bad_effect_days' }), 0, '被拒的入参不许落库');

  const badNotes = await req('POST', '/sport-track/api/admin/points/items', {
    ...validInput, key: 't_bad_notes', notes: 'not-an-array',
  });
  assert.equal(badNotes.statusCode, 400, `notes 非数组应 400 而非 500：${badNotes.body}`);
  assert.match(badNotes.json().message, /notes/);
  assert.match(badNotes.json().message, /「not-an-array」/);
  assert.equal(await PointItemModel.countDocuments({ key: 't_bad_notes' }), 0, '被拒的入参不许落库');

  // PUT 走同一条闸门：库里原值一个字都不许被半截写入
  const created = await req('POST', '/sport-track/api/admin/points/items', validInput);
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().data._id as string;
  const putBadDays = await req('PUT', `/sport-track/api/admin/points/items/${id}`, {
    ...validInput, effect: { kind: 'makeup', days: 'abc' },
  });
  assert.equal(putBadDays.statusCode, 400, `PUT 非数字 effect.days 应 400 而非 500：${putBadDays.body}`);
  assert.match(putBadDays.json().message, /effect\.days/);
  const putBadNotes = await req('PUT', `/sport-track/api/admin/points/items/${id}`, {
    ...validInput, notes: {},
  });
  assert.equal(putBadNotes.statusCode, 400, `PUT notes 非数组应 400 而非 500：${putBadNotes.body}`);
  assert.match(putBadNotes.json().message, /notes/);

  const db = await readItem(id);
  assert.equal(db!.effect.kind, 'ad_free', '被拒的 PUT 不许改写 effect');
  assert.equal(db!.effect.days, 5);
  assert.deepEqual(db!.notes, []);
});
