import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import {
  PointAccountModel, PointCardModel, PointItemModel, PointRecordModel,
} from '../src/models/point.model.js';
import { UserModel } from '../src/models/user.model.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { seedPointItems } from '../src/services/points-catalog.js';
import { createItem } from '../src/services/points-catalog-admin.js';
import { grantItem, listIssuances } from '../src/services/points-grant.js';
import { AppError } from '../src/utils/app-error.js';

/**
 * 后台发放（三来源）与发放记录列表（spec §6.1/§6.4/§7.2，Task 5 用例 GR-1…GR-7）。
 *
 * 共享 dev 库（sport-track-dev）口径：
 * - 用户一律 `new Types.ObjectId()`，用例内 t.after() 清 PointCard/UserModel 行，绝不跨用例复用；
 * - GR-1/2/3 临时把种子行改成 `unlimited:false` + 具体 stock，t.after() + 文件级 after() 都刷回
 *   种子形态（unlimited:true / stock:9999 / 三条免广告仍下架 / makeup_card 仍排第一）；
 * - GR-7 自建道具用 t_ 前缀 key，after() 按 ^t_ 全集兜底删除（闸门退化也不留档）；
 * - 断言只读库（findOne/find/countDocuments）与 service/HTTP 返回值，不看日志。
 */

const ADMIN_USER = 'admin_grant_t5';
const ADMIN_PASS = 'test123456';
const TEST_KEY = 't_grant_item';

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

/** 本用例动过的种子目录行：刷回 POINT_ITEMS_SEED 的库存形态（unlimited 道具的 stock 只是展示位） */
const restoreSeededStock = () => PointItemModel.updateMany(
  { key: { $in: ['makeup_card', 'ad_free_7d', 'ad_free_15d', 'ad_free_30d'] } },
  { $set: { unlimited: true, stock: 9999 } },
);

/** 某个用户的全部发放/账本痕迹：发放不写账本，但清理一律按 userId 扫干净，别给下一个用例留行 */
const cleanupUser = async (userId: Types.ObjectId) => {
  await PointCardModel.deleteMany({ userId });
  await PointRecordModel.deleteMany({ userId });
  await PointAccountModel.deleteMany({ userId });
  await UserModel.deleteOne({ _id: userId });
};

const readStock = async (key: string) => (await PointItemModel.findOne({ key }).lean())!.stock;

before(async () => {
  // buildApp 的 onReady 跑 seedPointItems（$setOnInsert），目录种子在这里就位
  app = await buildApp({ logger: false });
  await app.ready();

  await AdminModel.deleteOne({ username: ADMIN_USER });
  const admin = await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  adminId = String(admin._id);
  const login = await req('POST', '/sport-track/api/admin/login', { username: ADMIN_USER, password: ADMIN_PASS }, false);
  adminToken = login.json().data.token;
  assert.ok(adminToken, '管理员登录应成功');

  await seedPointItems();
  await PointItemModel.deleteMany({ key: /^t_/ });
  await restoreSeededStock();
});

after(async () => {
  await PointItemModel.deleteMany({ key: /^t_/ });
  await PointItemModel.updateOne({ key: 'makeup_card' }, { $set: { active: true, sortOrder: 10 } });
  await PointItemModel.updateMany({ key: /^ad_free_/ }, { $set: { active: false } });
  await PointItemModel.updateOne({ key: 'ad_free_7d' }, { $set: { sortOrder: 20, 'effect.days': 7 } });
  await restoreSeededStock();
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await app.close();
});

test('GR-1 手动发放不动积分、写 source/grantedBy/note、照样扣库存', async (t) => {
  await seedPointItems();
  const item = await PointItemModel.findOne({ key: 'ad_free_7d' }).lean();
  await PointItemModel.updateOne({ _id: item!._id }, { $set: { unlimited: false, stock: 10 } });
  // benefitDays 断言取的是目录档位：上一次运行把档改挂过也要本用例自己站得住（seed 值就是 7）
  await PointItemModel.updateOne({ _id: item!._id }, { $set: { 'effect.kind': 'ad_free', 'effect.days': 7 } });
  const u = new Types.ObjectId();
  // spec §7.2 的「用户不存在」跳过闸门要求名单是真用户：发放对象先落一行 users（不动积分账本）
  await UserModel.create({ _id: u, openid: `t-grant1-${u}`, nickname: '活动补偿用户' });
  t.after(async () => {
    await cleanupUser(u);
    await restoreSeededStock();
  });

  const r = await grantItem(String(item!._id), { userIds: [String(u)], count: 2, source: 'admin', note: '活动补偿' }, 'admin-1');
  assert.equal(r.granted, 2);
  assert.equal((await PointItemModel.findOne({ key: 'ad_free_7d' }).lean())!.stock, 8, '白送也算出货');
  const cards = await PointCardModel.find({ userId: u }).lean();
  assert.equal(cards.length, 2);
  assert.equal(cards[0].source, 'admin');
  assert.equal(cards[0].grantedBy, 'admin-1');
  assert.equal(cards[0].note, '活动补偿');
  assert.equal(cards[0].benefitDays, 7);
  assert.equal(await PointRecordModel.countDocuments({ userId: u }), 0, '发放不动积分账本');
  assert.equal((await PointAccountModel.findOne({ userId: u }).lean())?.balance ?? 0, 0);
  // 卡的持有有效期按目录 validDays 落（30 天），expiresAt 为 0 等于发卡即过期
  assert.ok(cards[0].expiresAt > Date.now() + 29 * 86400000, 'expiresAt 应按目录 validDays 推 30 天');
  assert.equal(cards[0].status, 'unused', '发放出来的卡是未使用态');
  assert.equal(cards[0].activatedAt, 0, '未激活');
});

test('GR-2 整单库存闸门：不足则一张都不发', async (t) => {
  const item = await PointItemModel.findOne({ key: 'ad_free_15d' }).lean();
  await PointItemModel.updateOne({ _id: item!._id }, { $set: { unlimited: false, stock: 3 } });
  const ids = [1, 2, 3, 4].map(() => new Types.ObjectId());
  t.after(async () => {
    await Promise.all(ids.map(cleanupUser));
    await restoreSeededStock();
  });

  await assert.rejects(
    () => grantItem(String(item!._id), { userIds: ids.map(String), count: 1 }, 'admin-1'),
    (e) => (e as AppError).statusCode === 400 && /库存不足（需要 4，当前 3）/.test((e as Error).message),
  );
  assert.equal(await PointCardModel.countDocuments({ userId: { $in: ids } }), 0);
  assert.equal((await PointItemModel.findOne({ key: 'ad_free_15d' }).lean())!.stock, 3);
  // 文案「对象 + 实际值 + 限制」：点名道具名，运营在后台看得见是哪张卡不够
  await assert.rejects(
    () => grantItem(String(item!._id), { userIds: ids.map(String), count: 1 }, 'admin-1'),
    (e) => e instanceof AppError && /免广告卡·15 天/.test(e.message),
  );
});

test('GR-3 部分用户不存在：跳过并记失败，末尾回补多扣的库存', async (t) => {
  const item = await PointItemModel.findOne({ key: 'ad_free_30d' }).lean();
  await PointItemModel.updateOne({ _id: item!._id }, { $set: { unlimited: false, stock: 5 } });
  // 大写 hex 也是合法 id：这个用户 id 必须带字母，否则 toUpperCase 与原文相同、测不出归一化
  let real = new Types.ObjectId();
  while (String(real).toUpperCase() === String(real)) real = new Types.ObjectId();
  await UserModel.create({ _id: real, openid: `t-grant-${real}`, nickname: '发放测试用户' });
  // 缺一个用户：闸门放行时按 2 人 ×1 张预占 2，实发 1 张 → 末尾必须回补 1
  const ghost = new Types.ObjectId();
  t.after(async () => {
    await Promise.all([real, ghost].map(cleanupUser));
    await restoreSeededStock();
  });

  const r = await grantItem(String(item!._id), { userIds: [String(real), '64b64b64b64b64b64b64b64b'] }, 'admin-1');
  assert.equal(r.granted, 1);
  assert.equal(r.failed.length, 1);
  assert.equal(r.refundFailed, 0, '正常回补没有缺口');
  assert.equal((await PointItemModel.findOne({ key: 'ad_free_30d' }).lean())!.stock, 4, '只扣实际发出那张');
  assert.equal(r.failed[0]!.userId, '64b64b64b64b64b64b64b64b');
  assert.match(r.failed[0]!.reason, /用户不存在/);
  assert.equal(await PointCardModel.countDocuments({ userId: ghost }), 0, '不存在的用户不许落卡');
  assert.equal(await PointCardModel.countDocuments({ userId: real }), 1, '存在的用户正常拿到卡');

  // 大写 hex：known 集合按 String(ObjectId)（小写）建，原始串不归一就会把真用户记成「用户不存在」
  const upper = await grantItem(String(item!._id), { userIds: [String(real).toUpperCase()] }, 'admin-1');
  assert.equal(upper.granted, 1, '大写 hex 必须认成同一个用户');
  assert.equal(upper.failed.length, 0, '大写 hex 不许记成「用户不存在」');
  assert.equal(upper.refundFailed, 0);
  assert.equal((await PointItemModel.findOne({ key: 'ad_free_30d' }).lean())!.stock, 3,
    '大写 id 不许被当成幽灵用户把库存退回去');
});

test('GR-4 入参闸门：空名单 / 超 200 人 / 非法 id / 未知 source', async (t) => {
  const item = await PointItemModel.findOne({ key: 'makeup_card' }).lean();
  const many = Array.from({ length: 201 }, () => new Types.ObjectId());
  t.after(async () => {
    await Promise.all(many.map(cleanupUser));
    await restoreSeededStock();
  });

  await assert.rejects(() => grantItem(String(item!._id), { userIds: [] }, 'a'), /至少选一个用户/);
  await assert.rejects(
    () => grantItem(String(item!._id), { userIds: Array.from({ length: 201 }, () => String(new Types.ObjectId())) }, 'a'),
    (e) => /最多 200 人（当前 201）/.test((e as Error).message),
  );
  await assert.rejects(() => grantItem(String(item!._id), { userIds: ['x'] }, 'a'), /用户 ID 不合法：x/);
  await assert.rejects(() => grantItem(String(item!._id), { userIds: [String(new Types.ObjectId())], source: 'gift' as never }, 'a'),
    /source 仅支持 admin \/ system/);

  // 入参闸门必须先于读目录与库存预占：非法入参一张都不许发、库存一分都不许动
  assert.equal(await PointCardModel.countDocuments({ userId: { $in: many } }), 0);
  assert.equal((await PointItemModel.findOne({ key: 'makeup_card' }).lean())!.stock, 9999);
  // 道具不存在 404（不因为「后台乱点」变成 500）；形态非法的 :id 走 assertObjectIdLike → 404
  await assert.rejects(() => grantItem('not-an-id', { userIds: [String(many[0])] }, 'a'), (e) => {
    const err = e as AppError;
    return err.statusCode === 404 && err.message === '道具不存在';
  });
  await assert.rejects(() => grantItem(String(new Types.ObjectId()), { userIds: [String(many[0])] }, 'a'), (e) => {
    const err = e as AppError;
    return err.statusCode === 404 && err.message === '道具不存在';
  });
  // count 也是入参：0/负数/小数/非数字一律 400 并点名收到的值
  for (const bad of [0, -1, 1.5, 'two' as never]) {
    await assert.rejects(() => grantItem(String(item!._id), { userIds: [String(many[0]!)], count: bad }, 'a'), (e) => {
      const err = e as AppError;
      return err.statusCode === 400 && /每次发放张数/.test(err.message) && err.message.includes(String(bad));
    }, `count=${String(bad)} 应 400 点名实际收到的值`);
  }
});

test('GR-5 发放记录三来源都能列出且能按来源筛', async (t) => {
  const u = new Types.ObjectId();
  // 同 GR-1：grant 走「用户不存在即跳过」闸门，发放对象要有 users 行
  await UserModel.create({ _id: u, openid: `t-grant5-${u}`, nickname: '三来源用户' });
  const item = await PointItemModel.findOne({ key: 'makeup_card' }).lean();
  t.after(async () => {
    await cleanupUser(u);
    await restoreSeededStock();
  });
  await PointCardModel.create({ userId: u, itemKey: 'makeup_card', status: 'unused', source: 'exchange', expiresAt: Date.now() + 1e9, createdAt: Date.now() });
  // 再压一条「物理缺 source」的老行进来：三来源列表要把老行也算成 exchange，
  // 这样「$addFields 在 $match 之前」这条顺序在来源筛选上也必须表态
  const legacy = await PointCardModel.create({ userId: u, itemKey: 'makeup_card', status: 'unused', expiresAt: Date.now() + 1e9, createdAt: Date.now() });
  await PointCardModel.updateOne({ _id: legacy._id }, { $unset: { source: 1 } });
  await grantItem(String(item!._id), { userIds: [String(u)], source: 'system' }, 'admin-1');
  const all = await listIssuances({ page: 1, pageSize: 50 });
  assert.ok(all.items.some((r) => r.source === 'exchange'));
  assert.ok(all.items.some((r) => r.source === 'system'));
  const only = await listIssuances({ page: 1, pageSize: 50, source: 'system' });
  assert.ok(only.items.length > 0 && only.items.every((r) => r.source === 'system'));
  // 按 exchange 筛：手写 source 的那条 + 物理缺字段的老行都要在（$addFields 挪到 $match 之后就只剩 1 条）
  const exRows = await listIssuances({ page: 1, pageSize: 50, source: 'exchange', userId: String(u) });
  assert.equal(exRows.items.length, 2, 'exchange 筛选要同时捞到手写那条和物理缺字段的老行');

  // admin 这一档也要能被筛出来（三来源 = exchange / admin / system，漏一档后台筛选就是残缺）
  await grantItem(String(item!._id), { userIds: [String(u)], source: 'admin' }, 'admin-1');
  const adminOnly = await listIssuances({ page: 1, pageSize: 50, source: 'admin', userId: String(u) });
  assert.equal(adminOnly.items.length, 1, '同一用户按 admin 筛只剩 admin 那张');
  assert.equal(adminOnly.items[0]!.source, 'admin');
  assert.equal(adminOnly.total, 1, 'total 跟着筛选条件走，不是全表数');
  // 按道具筛：这个用户 4 张（手写 exchange + 物理缺字段的老行 + system + admin）都是 makeup_card
  const byItem = await listIssuances({ page: 1, pageSize: 50, userId: String(u), itemKey: 'makeup_card' });
  assert.equal(byItem.total, 4);
  assert.equal((await listIssuances({ page: 1, pageSize: 50, userId: String(u), itemKey: 'ad_free_7d' })).total, 0);
  // 分页：pageSize=1 时 items 一条、total 不变，翻页取到不同行
  const p1 = await listIssuances({ page: 1, pageSize: 1, userId: String(u) });
  const p2 = await listIssuances({ page: 2, pageSize: 1, userId: String(u) });
  assert.equal(p1.items.length, 1);
  assert.equal(p1.total, 4);
  assert.notEqual(p1.items[0]!.id, p2.items[0]!.id, '翻页不重');
  assert.equal(p1.pageSize, 1, '回显 page/pageSize');
});

test('GR-6 老数据没有 source 字段：按 exchange 归类，不显示成空', async (t) => {
  const u = new Types.ObjectId();
  t.after(() => cleanupUser(u));
  await PointCardModel.create({ userId: u, itemKey: 'makeup_card', expiresAt: Date.now() + 1e9, createdAt: Date.now() });
  await PointCardModel.updateOne({ userId: u }, { $unset: { source: 1 } }); // 模拟 10-27 之前写入的行
  const r = await listIssuances({ page: 1, pageSize: 50, userId: String(u) });
  assert.equal(r.items[0].source, 'exchange');
  // 库里确实是物理缺字段（不是 mongoose 默认值替它补上了），否则这条等于没测
  const raw = await PointCardModel.findOne({ userId: u }).lean();
  assert.equal(raw!.source, undefined, '行本身没有 source 字段');
  assert.equal(r.items[0]!.sourceText, '兑换', '缺 source 的行文案不能是空');
  // 不带筛选时同样要能按来源筛出 exchange：$addFields 必须在 $match 之前
  const only = await listIssuances({ page: 1, pageSize: 50, source: 'exchange', userId: String(u) });
  assert.equal(only.items.length, 1, '按 exchange 筛要捞到这条老行');
});

test('GR-7 路由接线：鉴权闸门、grantedBy 取 token 里的管理员 id、行字段齐全', async (t) => {
  const row = await createItem({
    key: TEST_KEY, name: '发放测试卡', subtitle: '', description: '', notes: [],
    price: 100, validDays: 30, effect: { kind: 'ad_free', days: 3 },
    stock: 5, unlimited: false, active: false, // 故意下架：客服补发/活动补偿恰恰要发已经下架的卡
    sortOrder: 900, image: '',
  });
  const id = String(row._id);
  const u = new Types.ObjectId();
  const ghost = new Types.ObjectId();
  // uid 是 sparse unique：取数值档最大值 +1，别写死一个可能已被占用的号（撞号 = 假红）。
  // dev 库的 uid 混着 int 与 string 两种 BSON 类型，$max 按类型分档会先取到 string 档，所以只筛数值档
  const [uidAgg] = await UserModel.aggregate<{ maxUid: number | null }>([
    { $match: { uid: { $type: 'number' } } },
    { $group: { _id: null, maxUid: { $max: '$uid' } } },
  ]);
  const testUid = Number(uidAgg?.maxUid ?? 0) + 1;
  await UserModel.create({ _id: u, openid: `t-grant7-${u}`, nickname: '名单用户', uid: testUid });
  t.after(async () => {
    await Promise.all([u, ghost].map(cleanupUser));
    await PointItemModel.deleteMany({ key: /^t_/ });
  });

  // 两条新路由都必须挂 adminAuth
  for (const [method, url] of [
    ['POST', `/sport-track/api/admin/points/items/${id}/grant`],
    ['GET', '/sport-track/api/admin/points/issuances'],
  ] as const) {
    const res = await req(method, url, {}, false);
    assert.equal(res.statusCode, 401, `${method} ${url} 未登录必须 401：${res.body}`);
  }

  // 下架道具照样能发（spec §6.1：发放不看 active）；count 是「每个用户几张」
  const granted = await req('POST', `/sport-track/api/admin/points/items/${id}/grant`, {
    userIds: [String(u), String(ghost)], count: 2, note: '客服补发',
  });
  assert.equal(granted.statusCode, 200, granted.body);
  assert.deepEqual(granted.json().data, { granted: 2, failed: [{ userId: String(ghost), reason: '用户不存在' }], refundFailed: 0 });
  // 预占 2 人 ×2 张 = 4，实发 2 → 库存 5-2
  assert.equal(await readStock(TEST_KEY), 3, '回补多占的库存');
  const body = (await listIssuances({ page: 1, pageSize: 50, userId: String(u), itemKey: TEST_KEY }));
  assert.equal(body.items.length, 2);
  const line = body.items[0]!;
  // grantedBy 来自 admin token 的 id（adminAuth 只校验不挂字段，route 侧显式取 payload.id）
  assert.equal(line.grantedBy, adminId, 'grantedBy 要落到具体管理员');
  assert.equal(line.source, 'admin', 'body 不传 source 时默认后台手动');
  assert.equal(line.sourceText, '后台手动');
  assert.equal(line.note, '客服补发');
  assert.equal(line.itemName, '发放测试卡', 'itemName 关联目录（含下架项）');
  assert.equal(line.itemKey, TEST_KEY);
  assert.equal(line.nickname, '名单用户');
  assert.equal(line.uid, testUid);
  assert.equal(line.status, 'unused');
  assert.equal(line.statusText, '未使用');
  assert.equal(line.benefitDays, 3, 'benefitDays 发卡时从目录 effect.days 快照');
  assert.equal(line.userId, String(u));
  assert.ok(line.id && line.createdAt > 0 && line.expiresAt > line.createdAt);

  // 发放记录接口：HTTP 读得到、按来源筛、非法 source 400 点名、非法 userId 404 不泄露 500
  const list = await req('GET', `/sport-track/api/admin/points/issuances?itemKey=${TEST_KEY}&source=admin&pageSize=10`);
  assert.equal(list.statusCode, 200, list.body);
  const page = list.json().data as { total: number; page: number; pageSize: number; items: Array<{ source: string }> };
  assert.equal(page.total, 2);
  assert.equal(page.pageSize, 10);
  assert.equal(page.items.length, 2);
  assert.ok(page.items.every((r) => r.source === 'admin'));
  const badSource = await req('GET', '/sport-track/api/admin/points/issuances?source=gift');
  assert.equal(badSource.statusCode, 400, `未知来源要 400 而不是静默空列表：${badSource.body}`);
  assert.match(badSource.json().message, /筛选来源只能是 exchange \/ admin \/ system（收到「gift」）/);
  const badUser = await req('GET', '/sport-track/api/admin/points/issuances?userId=not-an-id');
  assert.equal(badUser.statusCode, 400, `查询参数里的非法 userId 是 400（路径 id 才 404）：${badUser.body}`);
  const badGrant = await req('POST', `/sport-track/api/admin/points/items/not-an-id/grant`, { userIds: [String(u)] });
  assert.equal(badGrant.statusCode, 404, `非法 :id 应 404：${badGrant.body}`);
  assert.equal(badGrant.json().message, '道具不存在');
  const tooMany = await req('POST', `/sport-track/api/admin/points/items/${id}/grant`, {
    userIds: Array.from({ length: 201 }, () => String(new Types.ObjectId())),
  });
  assert.equal(tooMany.statusCode, 400, tooMany.body);
  assert.match(tooMany.json().message, /最多 200 人（当前 201）/);
  assert.equal((await PointItemModel.findOne({ _id: id }).lean())!.stock, 3, '入参闸门被拒不动库存');
});

test('GR-8 发卡中途抛错：已落库的张数算出货，只退真没发出去的那部分库存', async (t) => {
  await seedPointItems();
  const item = await PointItemModel.findOne({ key: 'ad_free_15d' }).lean();
  await PointItemModel.updateOne({ _id: item!._id }, { $set: { unlimited: false, stock: 5 } });
  const u = new Types.ObjectId();
  await UserModel.create({ _id: u, openid: `t-grant8-${u}`, nickname: '半单失败用户' });

  const model = PointCardModel as unknown as { insertMany: (...args: unknown[]) => Promise<unknown> };
  const realInsertMany = model.insertMany.bind(PointCardModel);
  const restore = () => { model.insertMany = realInsertMany; };
  t.after(async () => {
    restore();
    await cleanupUser(u);
    await restoreSeededStock();
  });

  // ordered insertMany 抛错时已落库的文档挂在 error.insertedDocs 上（mongoose 口径）：
  // 这里让第 1 张真进库、整批再抛错，验的就是「已出货不退、只退空占的那张」
  model.insertMany = async (...args: unknown[]) => {
    const docs = args[0] as unknown[];
    const landed = await realInsertMany([docs[0]]);
    throw Object.assign(new Error('card write boom'), { insertedDocs: landed });
  };
  const r = await grantItem(String(item!._id), { userIds: [String(u)], count: 2 }, 'admin-1');
  assert.equal(r.granted, 1, '已落库那张要算出货');
  assert.equal(r.failed.length, 1, '失败明细仍要点名');
  assert.match(r.failed[0]!.reason, /card write boom/);
  // 预占 2、实发 1 → 只退 1：5-2+1=4（把 insertedDocs 忽略掉就是 5，等于白送一张卡的库存）
  assert.equal(await readStock('ad_free_15d'), 4, '回补只退真没发出去那张');
  assert.equal(await PointCardModel.countDocuments({ userId: u }), 1);
});

test('GR-9 keyword 按持卡人昵称/UID 字面量筛发放记录，元字符不当通配', async (t) => {
  const a = new Types.ObjectId(); const b = new Types.ObjectId(); const near = new Types.ObjectId();
  // uid 是 sparse unique：取数值档最大值 +1（dev 库混着 int/string 两档，只筛数值档）
  const [uidAgg] = await UserModel.aggregate<{ maxUid: number | null }>([
    { $match: { uid: { $type: 'number' } } },
    { $group: { _id: null, maxUid: { $max: '$uid' } } },
  ]);
  const testUid = Number(uidAgg?.maxUid ?? 0) + 1;
  // 共享库上别的行也可能命中同样的关键词：先取基线，之后只断言「本用例新增的命中数」
  const countKeyword = async (keyword: string) => (await listIssuances({ keyword, pageSize: 1 })).total;
  const beforeHit = await countKeyword('(测试)');
  const beforeLiteral = await countKeyword('张三.*');
  const beforeUid = await countKeyword(String(testUid));
  // 昵称里带正则元字符 ( 与 .：不转义时 '(测试)' 会当分组、'张三.*' 会当通配
  await UserModel.create({ _id: a, openid: `t-grant9-${a}`, nickname: '张三(测试)' });
  await UserModel.create({ _id: b, openid: `t-grant9-${b}`, nickname: '李四', uid: testUid });
  // 近义昵称：不转义时 '(测试)' 会把捕获组「测试」也匹配到这里，正例因此能失败
  await UserModel.create({ _id: near, openid: `t-grant9-${near}`, nickname: '张三测试' });
  t.after(() => Promise.all([a, b, near].map(cleanupUser)));
  const now = Date.now();
  await PointCardModel.create([
    { userId: a, itemKey: 'makeup_card', status: 'unused', expiresAt: now + 1e9, createdAt: now },
    { userId: b, itemKey: 'makeup_card', status: 'unused', expiresAt: now + 1e9, createdAt: now + 1 },
    { userId: near, itemKey: 'makeup_card', status: 'unused', expiresAt: now + 1e9, createdAt: now + 2 },
  ]);

  const hit = await listIssuances({ keyword: '(测试)', pageSize: 50 });
  assert.equal(hit.total, beforeHit + 1,
    `元字符按字面量匹配，本用例只新增张三 (测试) 一张（基线 ${beforeHit}）`);
  assert.ok(hit.items.some((r) => r.userId === String(a) && r.nickname === '张三(测试)'));

  // 不转义时 '张三.*' 会命中「张三(测试)」与「张三测试」（+2）；转义后按字面量搜不到任何人
  const literal = await listIssuances({ keyword: '张三.*', pageSize: 50 });
  assert.equal(literal.total, beforeLiteral, '转义后按字面量匹配，不能当通配');

  const byUid = await listIssuances({ keyword: String(testUid), pageSize: 50 });
  assert.equal(byUid.total, beforeUid + 1, '纯数字关键词按 UID 命中');
  assert.ok(byUid.items.some((r) => r.userId === String(b)));

  // 路由层把 keyword 透传下去（HTTP 入口同样按字面量）
  const http = await req('GET', `/sport-track/api/admin/points/issuances?keyword=${encodeURIComponent('(测试)')}`);
  assert.equal(http.statusCode, 200, http.body);
  assert.equal(http.json().data.total, beforeHit + 1);
  assert.ok((http.json().data.items as Array<{ nickname: string }>).some((r) => r.nickname === '张三(测试)'));
});

test('GR-10 目录行缺 validDays：400 点名道具，不落 NaN 有效期、不动库存', async (t) => {
  const id = new Types.ObjectId();
  const key = 't_grant_bad_valid_days';
  // 绕过 schema 写入一条历史脏目录行：validDays 物理缺失（required/min 是写入时校验，拦不住存量行）
  await PointItemModel.collection.insertOne({
    _id: id, key, name: '档期缺失卡', price: 100, effect: { kind: 'makeup', days: 0 },
    stock: 5, unlimited: false, active: true, sortOrder: 999,
  });
  t.after(async () => {
    await PointItemModel.deleteMany({ key });
    await restoreSeededStock();
  });
  const u = new Types.ObjectId();
  t.after(() => cleanupUser(u));

  await assert.rejects(
    () => grantItem(String(id), { userIds: [String(u)] }, 'admin-1'),
    (e) => (e as AppError).statusCode === 400
      && /档期缺失卡/.test((e as Error).message) && /validDays/.test((e as Error).message),
    '缺 validDays 的目录行必须 400 点名道具，而不是发一张 NaN 过期的卡',
  );
  assert.equal((await PointItemModel.findOne({ key }).lean())!.stock, 5, '校验在库存预占之前，库存一分不能动');
  assert.equal(await PointCardModel.countDocuments({ userId: u }), 0, '一张卡都不许落');
});

test('GR-11 回补库存失败不吞错：refundFailed 报出没退回去的张数', async (t) => {
  const item = await PointItemModel.findOne({ key: 'ad_free_15d' }).lean();
  await PointItemModel.updateOne({ _id: item!._id }, { $set: { unlimited: false, stock: 5 } });
  const real = new Types.ObjectId();
  const ghost = new Types.ObjectId();
  await UserModel.create({ _id: real, openid: `t-grant11-${real}`, nickname: '回补失败用户' });

  const model = PointItemModel as unknown as { updateOne: (...args: unknown[]) => Promise<unknown> };
  const realUpdateOne = model.updateOne.bind(PointItemModel);
  const originalError = console.error;
  t.after(async () => {
    model.updateOne = realUpdateOne;
    console.error = originalError;
    await Promise.all([real, ghost].map(cleanupUser));
    await restoreSeededStock();
  });
  // 只让「回补库存」那一笔 updateOne 失败（预占走 findOneAndUpdate，不受影响）；控制台输出在用例里静音
  model.updateOne = async () => { throw new Error('stock refund boom'); };
  console.error = () => {};

  const r = await grantItem(String(item!._id), { userIds: [String(real), String(ghost)] }, 'admin-1');
  assert.equal(r.granted, 1);
  assert.equal(r.failed.length, 1);
  assert.equal(r.refundFailed, 1, '回补失败的那 1 张必须报出来，不许假装回补成功');
  assert.equal(await readStock('ad_free_15d'), 3, '库存确实停在「多扣了 1」的状态（正常回补后应是 4）');
});

/** 用例私有的发放目录行：不碰四条种子，库存断言不受并行/历史用例影响 */
let grantTempSeq = 0;
async function tempGrantItem(stock = 10, unlimited = false) {
  const key = `t_grant_cap_${Date.now()}_${grantTempSeq++}`;
  const row = await PointItemModel.create({
    key, name: '发放上限道具', subtitle: '', description: '', notes: [],
    price: 100, validDays: 30, effect: { kind: 'makeup', days: 0 },
    kind: 'virtual', stock, unlimited, active: true, sortOrder: 999, image: '',
  });
  return { key, id: String(row._id) };
}

const cardCountFor = (ids: string[]) =>
  PointCardModel.countDocuments({ userId: { $in: ids.map((id) => new Types.ObjectId(id)) } });

test('GR-12 count 上限 100：超限直接 400 点名收到值与上限，不发卡不动库存', async (t) => {
  const item = await tempGrantItem(10);
  const u = new Types.ObjectId();
  t.after(async () => {
    await cleanupUser(u);
    await PointItemModel.deleteMany({ key: item.key });
  });

  for (const bad of [101, 1e8]) {
    await assert.rejects(() => grantItem(item.id, { userIds: [String(u)], count: bad }, 'admin-1'), (e) => {
      const err = e as AppError;
      return err.statusCode === 400
        && /每次发放张数不能超过 100/.test(err.message)
        && err.message.includes(String(bad));
    }, `count=${bad} 必须 400 并点名收到的值与上限`);
  }
  assert.equal(await cardCountFor([String(u)]), 0);
  assert.equal((await PointItemModel.findOne({ key: item.key }).lean())!.stock, 10, '入参闸门被拒不动库存');
});

test('GR-13 userIds 先去重再算 need：同一 id 重复出现只发一次', async (t) => {
  const item = await tempGrantItem(10);
  const u = new Types.ObjectId();
  await UserModel.create({ _id: u, openid: `t-grant13-${u}`, nickname: '重复名单用户' });
  t.after(async () => {
    await cleanupUser(u);
    await PointItemModel.deleteMany({ key: item.key });
  });

  const r = await grantItem(item.id, { userIds: [String(u), String(u).toUpperCase(), String(u)], count: 2 }, 'admin-1');
  assert.equal(r.granted, 2, '去重后 1 人 × 2 张');
  assert.equal(r.failed.length, 0);
  assert.equal(await PointCardModel.countDocuments({ userId: u }), 2, '不能因为名单重复发 6 张');
  assert.equal((await PointItemModel.findOne({ key: item.key }).lean())!.stock, 8, 'need 按去重后人数算');
});

test('GR-14 单次发放总数上限：需要 2100 张直接 400，不预占库存', async (t) => {
  const item = await tempGrantItem(9999, true);
  const ids = Array.from({ length: 21 }, () => String(new Types.ObjectId()));
  t.after(() => PointItemModel.deleteMany({ key: item.key }));

  await assert.rejects(() => grantItem(item.id, { userIds: ids, count: 100 }, 'admin-1'), (e) => {
    const err = e as AppError;
    return err.statusCode === 400
      && /单次发放总数不能超过 2000/.test(err.message)
      && err.message.includes('2100');
  });
  assert.equal(await cardCountFor(ids), 0, '闸门被拒一张都不发');
});

test('GR-15 用户查询失败不丢库存预占：lookup 抛错时库存原样', async (t) => {
  const item = await tempGrantItem(10);
  const u = new Types.ObjectId();
  t.after(async () => {
    await cleanupUser(u);
    await PointItemModel.deleteMany({ key: item.key });
  });

  const box = UserModel as unknown as { find: unknown };
  const realFind = UserModel.find.bind(UserModel);
  box.find = () => { throw new Error('lookup boom'); };
  try {
    await assert.rejects(() => grantItem(item.id, { userIds: [String(u)] }, 'admin-1'), /lookup boom/);
  } finally {
    box.find = realFind;
  }
  assert.equal((await PointItemModel.findOne({ key: item.key }).lean())!.stock, 10,
    '预占之后抛错必须回补，否则白扣一张库存');
  assert.equal(await cardCountFor([String(u)]), 0);
});

test('GR-16 effect.days 非有限数：400 点名道具，先于库存预占与发卡', async (t) => {
  const id = new Types.ObjectId();
  const key = `t_grant_nan_days_${Date.now()}`;
  t.after(() => PointItemModel.deleteMany({ key }));
  await PointItemModel.collection.insertOne({
    _id: id, key, name: '脏权益天数道具', price: 100, validDays: 30, effect: { kind: 'ad_free', days: NaN },
    stock: 5, unlimited: false, active: true, sortOrder: 999,
  });
  const u = new Types.ObjectId();
  t.after(() => cleanupUser(u));

  await assert.rejects(() => grantItem(String(id), { userIds: [String(u)] }, 'admin-1'), (e) => {
    const err = e as AppError;
    return err.statusCode === 400 && /脏权益天数道具/.test(err.message)
      && /effect\.days/.test(err.message) && /NaN/.test(err.message);
  });
  assert.equal((await PointItemModel.findOne({ key }).lean())!.stock, 5, '校验先于库存预占');
  assert.equal(await cardCountFor([String(u)]), 0);
});
