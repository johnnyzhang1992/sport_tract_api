import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import {
  PointCardModel, PointItemModel, PointRecordModel,
} from '../src/models/point.model.js';
import { UserModel } from '../src/models/user.model.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { adFreeRoster, type RosterRow } from '../src/services/points-roster.js';
import { itemsOverview } from '../src/services/points-admin-stats.js';
import { bjDateStr } from '../src/utils/bj-time.js';

/**
 * 道具概况与免广告名单（spec §4/§7.2，Task 8 用例 RS-1…RS-4）。
 *
 * 共享 dev 库（sport-track-dev）口径：
 * - 每个用例用自己的 `new Types.ObjectId()`，t.after() 按 userId 清干净 card/users/record 行；
 * - 名单是**全表**推导（所有已激活的 ad_free 卡），断言一律先按本用例的 openid 圈定，
 *   再对全表补一条「每条都未过期 + 到期日倒序」的结构断言 —— 不写死 rows.length，
 *   否则 dev 库里别人的卡会把用例带成假红/假绿；
 * - 日期一律用显式的 `Date.parse('YYYY-MM-DDT00:00:00+08:00')` 字面量。
 *   不要用 `t0 + 30 * DAY` 这种算式：10 月有 31 天，算式会落到 spec 算例的隔一天
 *   （Task 3 评审已把这条列为 Task 8 的硬约束）；
 * - 断言只读 service 返回值、HTTP 响应与库，不看日志。
 */

const ADMIN_USER = 'admin_points_roster_t8';
const ADMIN_PASS = 'test123456';
const ITEM_KEY = 't_roster_overview_item';

let app: FastifyInstance;
let adminToken = '';

/** 清场：卡/流水/用户按 userId 删干净 */
const wipe = (u: Types.ObjectId) => Promise.all([
  PointCardModel.deleteMany({ userId: u }),
  PointRecordModel.deleteMany({ userId: u }),
  UserModel.deleteOne({ _id: u }),
]);

/** 造用户：不写 uid（sparse unique 允许多个缺省），名单里应按 0 兜底 */
async function makeUser(openid: string, nickname: string): Promise<Types.ObjectId> {
  const u = new Types.ObjectId();
  await UserModel.create({ _id: u, openid, nickname });
  return u;
}

/** 造一张已激活（status:'used'）的免广告卡 */
function usedAdFreeCard(
  userId: Types.ObjectId, activatedAt: number, benefitDays: number, itemKey = 'ad_free_7d',
) {
  return PointCardModel.create({
    userId,
    itemKey,
    status: 'used',
    source: 'exchange',
    benefitDays,
    activatedAt,
    // 卡的持有有效期与权益到期无关：给一个足够远的日期，避免被其它口径误当成过期卡
    expiresAt: Date.parse('2026-12-31T00:00:00+08:00'),
    createdAt: activatedAt,
  });
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/login',
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  adminToken = login.json().data.token;
  assert.ok(adminToken, '管理员登录应成功');
  // 上一次崩溃留下的本文件目录行/卡行：先清掉，避免 byItem 断言被残行污染
  // （卡按 itemKey 清：t.after 没跑到时 userId 已经无从查起）
  await PointItemModel.deleteMany({ key: ITEM_KEY });
  await PointCardModel.deleteMany({ itemKey: ITEM_KEY });
});

after(async () => {
  await PointItemModel.deleteMany({ key: ITEM_KEY });
  await PointCardModel.deleteMany({ itemKey: ITEM_KEY });
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await app.close();
});

test('RS-1 名单只含未过期用户，按到期日倒序', async (t) => {
  // 固定观察时刻：2026-10-26 10:00（东八区），三个用户的到期日分别是 10-27 / 11-13 / 10-02
  const NOW = Date.parse('2026-10-26T10:00:00+08:00');
  const soonUntil = Date.parse('2026-10-27T00:00:00+08:00');
  const laterUntil = Date.parse('2026-11-13T00:00:00+08:00');
  const expiredUntil = Date.parse('2026-10-02T00:00:00+08:00');

  const soonOpenid = `t-roster-soon-${new Types.ObjectId()}`;
  const laterOpenid = `t-roster-later-${new Types.ObjectId()}`;
  const expiredOpenid = `t-roster-expired-${new Types.ObjectId()}`;
  const soon = await makeUser(soonOpenid, '名单-很快到期');
  const later = await makeUser(laterOpenid, '名单-更晚到期');
  const expired = await makeUser(expiredOpenid, '名单-已过期');
  t.after(() => Promise.all([soon, later, expired].map(wipe)));

  // 到期时刻 = 激活时刻 + benefitDays 天；三行的数字全部来自显式字面量，不写算式
  await usedAdFreeCard(soon, Date.parse('2026-10-25T00:00:00+08:00'), 2);
  await usedAdFreeCard(later, Date.parse('2026-10-24T00:00:00+08:00'), 20);
  await usedAdFreeCard(expired, Date.parse('2026-10-01T00:00:00+08:00'), 1);

  const rows = await adFreeRoster(NOW);
  const mine = rows.filter((r) => [soonOpenid, laterOpenid, expiredOpenid].includes(r.openid));

  assert.deepEqual(mine.map((r) => r.openid), [laterOpenid, soonOpenid],
    '只含未过期用户，且按到期日倒序（later 11-13 在 soon 10-27 前面）');
  assert.equal(mine.some((r) => r.openid === expiredOpenid), false, '已过期用户不许进名单');

  const soonRow = mine.find((r) => r.openid === soonOpenid)!;
  assert.equal(soonRow.adFreeUntil, soonUntil, '到期时刻按 replayAdFree 推导');
  assert.equal(soonRow.adFreeUntilDate, '2026-10-27', '到期日按东八区日期串下发（人群包按天生效）');
  assert.equal(mine.find((r) => r.openid === laterOpenid)!.adFreeUntil, laterUntil);
  assert.equal(mine.find((r) => r.openid === laterOpenid)!.adFreeUntilDate, '2026-11-13');
  assert.equal(soonRow.uid, 0, '缺 uid 的用户按 0 兜底');

  // 全表结构断言：共享库里别人的行同样必须未过期且倒序（去掉 until > now 过滤这里必红）
  assert.ok(rows.every((r) => r.adFreeUntil > NOW), '名单里每一条都必须严格晚于观察时刻');
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i - 1].adFreeUntil >= rows[i].adFreeUntil,
      `名单必须按到期日倒序：第 ${i - 1} 行 ${rows[i - 1].adFreeUntil} < 第 ${i} 行 ${rows[i].adFreeUntil}`);
  }
});

test('RS-2 只有 ad_free 生效用户进名单；补签卡持卡人与未激活卡都不进', async (t) => {
  const NOW = Date.parse('2026-10-26T10:00:00+08:00');

  // 补签卡持卡人：status used 但 benefitDays=0（补签卡不走激活，不产生免广告权益）
  const makeupOpenid = `t-roster-makeup-${new Types.ObjectId()}`;
  const makeupUser = await makeUser(makeupOpenid, '名单-补签卡用户');
  // 未激活的免广告卡：status unused，activatedAt 还是 0 —— 没激活就不该生效
  const unusedOpenid = `t-roster-unused-${new Types.ObjectId()}`;
  const unusedUser = await makeUser(unusedOpenid, '名单-未激活卡用户');
  t.after(() => Promise.all([makeupUser, unusedUser].map(wipe)));

  await PointCardModel.create({
    userId: makeupUser,
    itemKey: 'makeup_card',
    status: 'used',
    source: 'exchange',
    benefitDays: 0,
    activatedAt: Date.parse('2026-10-20T00:00:00+08:00'),
    expiresAt: Date.parse('2026-12-31T00:00:00+08:00'),
    createdAt: Date.parse('2026-10-20T00:00:00+08:00'),
  });
  await PointCardModel.create({
    userId: unusedUser,
    itemKey: 'ad_free_7d',
    status: 'unused',
    source: 'exchange',
    benefitDays: 7,
    activatedAt: 0,
    expiresAt: Date.parse('2026-12-31T00:00:00+08:00'),
    createdAt: Date.parse('2026-10-20T00:00:00+08:00'),
  });

  const rows = await adFreeRoster(NOW);
  const openids = new Set(rows.map((r) => r.openid));
  assert.equal(openids.has(makeupOpenid), false, '补签卡持卡人不产生免广告权益');
  assert.equal(openids.has(unusedOpenid), false, '没激活的免广告卡不生效');
});

test('RS-3 openid 只在 roster 接口出现，其它 admin 接口仍不下发', async (t) => {
  const openid = `t-roster-rs3-${new Types.ObjectId()}`;
  const u = await makeUser(openid, 'RS3 免广告用户');
  t.after(() => wipe(u));
  // 走真实时钟：路由的 adFreeRoster() 用 Date.now()，这里让权益从「现在」起算 7 天
  const activatedAt = Date.now();
  await usedAdFreeCard(u, activatedAt, 7);

  const authHeaders = { authorization: `Bearer ${adminToken}` };
  const users = await app.inject({ method: 'GET', url: '/sport-track/api/admin/users', headers: authHeaders });
  assert.equal(users.statusCode, 200, users.body);
  assert.equal(JSON.stringify(users.json()).includes('openid'), false, '用户列表不得带 openid');

  // 另一个用户侧接口同样不许泄露（RS-3 的「其它 admin 接口」口径）
  const pointUsers = await app.inject({ method: 'GET', url: '/sport-track/api/admin/points/users', headers: authHeaders });
  assert.equal(pointUsers.statusCode, 200, pointUsers.body);
  assert.equal(JSON.stringify(pointUsers.json()).includes('openid'), false, '积分用户列表不得带 openid');

  const roster = await app.inject({
    method: 'GET', url: '/sport-track/api/admin/points/ad-free/roster', headers: authHeaders,
  });
  assert.equal(roster.statusCode, 200, roster.body);
  const rows = roster.json().data as RosterRow[];
  assert.ok(Array.isArray(rows), 'roster 的 data 必须是数组');
  assert.ok(rows.every((x) => typeof x.openid === 'string'), 'roster 每行都要带 openid 字符串');
  const row = rows.find((x) => x.openid === openid);
  assert.ok(row, '刚激活的用户必须出现在名单里');
  assert.equal(typeof row!.uid, 'number');
  assert.equal(row!.nickname, 'RS3 免广告用户');
  assert.equal(typeof row!.adFreeUntil, 'number');
  assert.equal(row!.adFreeUntilDate, bjDateStr(row!.adFreeUntil), 'adFreeUntilDate 是到期时刻的东八区日期串');
});

test('RS-4 道具概况：来源分档相加等于总数，道具分档与消耗/免广告人数同样对得上', async (t) => {
  const NOW = Date.parse('2026-10-26T10:00:00+08:00');
  const u = new Types.ObjectId();
  const adFreeUser = new Types.ObjectId();
  t.after(async () => {
    await PointCardModel.deleteMany({ userId: { $in: [u, adFreeUser] } });
    await PointRecordModel.deleteMany({ userId: u });
    await UserModel.deleteMany({ _id: { $in: [u, adFreeUser] } });
    await PointItemModel.deleteMany({ key: ITEM_KEY });
  });

  await PointItemModel.create({
    key: ITEM_KEY, name: '名单概况测试道具', subtitle: '', description: '', notes: [],
    price: 100, validDays: 30, effect: { kind: 'makeup', days: 0 },
    stock: 9999, unlimited: true, active: true, sortOrder: 999, image: '',
  });

  const before = await itemsOverview(NOW);

  // 一张「10-27 之前写的老卡」：物理缺 source 字段（raw insert 绕过 schema 默认值），必须归到 exchange
  await PointCardModel.collection.insertOne({
    userId: u,
    itemKey: ITEM_KEY,
    status: 'unused',
    expiresAt: Date.parse('2026-12-31T00:00:00+08:00'),
    createdAt: Date.parse('2026-10-20T00:00:00+08:00'),
  });
  await PointCardModel.create({
    userId: u, itemKey: ITEM_KEY, status: 'unused', source: 'admin',
    expiresAt: Date.parse('2026-12-31T00:00:00+08:00'),
    createdAt: Date.parse('2026-10-21T00:00:00+08:00'),
  });
  await PointCardModel.create({
    userId: u, itemKey: ITEM_KEY, status: 'unused', source: 'system',
    expiresAt: Date.parse('2026-12-31T00:00:00+08:00'),
    createdAt: Date.parse('2026-10-22T00:00:00+08:00'),
  });
  // 兑换消耗：§6.5 的口径是 PointRecord 的 |exchange delta|（不是 PointExchange.cost）
  await PointRecordModel.create({
    userId: u, type: 'exchange', title: '兑换测试道具', delta: -200, balanceAfter: 0,
    bizDate: '2026-10-23', idemKey: `${u}:rs4-exchange`,
    createdAt: Date.parse('2026-10-23T00:00:00+08:00'),
  });
  // 生效中的免广告用户：从 10-26 00:00 起 1 天 → 10-27 00:00 到期，晚于 NOW
  await UserModel.create({ _id: adFreeUser, openid: `t-roster-rs4-${adFreeUser}`, nickname: 'RS4 免广告用户' });
  await usedAdFreeCard(adFreeUser, Date.parse('2026-10-26T00:00:00+08:00'), 1);

  const o = await itemsOverview(NOW);

  assert.equal(o.totalIssued - before.totalIssued, 4,
    '新增 4 张卡：老卡（无 source）+ admin + system + 免广告生效卡');
  assert.equal(o.bySource.reduce((s, x) => s + x.count, 0), o.totalIssued,
    'RS-4：来源分档相加必须等于发放总数');
  const delta = (source: string) => (o.bySource.find((x) => x.source === source)!.count
    - before.bySource.find((x) => x.source === source)!.count);
  assert.equal(delta('exchange'), 2, '缺 source 的老卡按 exchange 归类；免广告卡也来自兑换');
  assert.equal(delta('admin'), 1);
  assert.equal(delta('system'), 1);

  // 按道具拆：三个来源都算进同一个 key，且与总数一致
  assert.equal(o.byItem.reduce((s, x) => s + x.count, 0), o.totalIssued, '道具分档相加同样等于总数');
  const itemRow = o.byItem.find((x) => x.itemKey === ITEM_KEY);
  assert.ok(itemRow, '按道具拆要包含本用例的道具');
  assert.equal(itemRow!.count, 3);
  assert.equal(itemRow!.itemName, '名单概况测试道具', '道具名要 join 目录当前名称');

  assert.equal(o.totalSpentPoints - before.totalSpentPoints, 200, '累计消耗积分取账本 exchange 的 |delta|');
  assert.equal(o.adFreeUsers - before.adFreeUsers, 1, '生效中免广告人数与名单同一份推导');
});

test('RS-5 脏卡行（userId 不是 24 位 hex）：名单与道具概况都不许 500，也不许算进免广告人数', async (t) => {
  const NOW = Date.parse('2026-10-26T10:00:00+08:00');
  const DIRTY = 'not-a-valid-objectid';
  const good = new Types.ObjectId();
  // 清理要绕开 Mongoose 的 cast：脏行的 userId 是字符串，用 Model.deleteMany 会被强转成 ObjectId 而删不掉
  t.after(async () => {
    await PointCardModel.collection.deleteMany({ userId: DIRTY });
    await PointCardModel.deleteMany({ userId: good });
    await UserModel.deleteOne({ _id: good });
  });

  await UserModel.create({ _id: good, openid: `t-roster-rs5-${good}`, nickname: 'RS5 正常用户' });
  await usedAdFreeCard(good, Date.parse('2026-10-26T00:00:00+08:00'), 1);
  // raw insert 绕过 schema：库里真躺着一张 userId 不是 ObjectId 的已激活免广告卡（迁移/历史脏数据）
  await PointCardModel.collection.insertOne({
    userId: DIRTY,
    itemKey: 'ad_free_7d',
    status: 'used',
    source: 'exchange',
    benefitDays: 7,
    activatedAt: Date.parse('2026-10-25T00:00:00+08:00'),
    expiresAt: Date.parse('2026-12-31T00:00:00+08:00'),
    createdAt: NOW,
  });
  assert.equal(await PointCardModel.collection.countDocuments({ userId: DIRTY }), 1, '脏行要真的在库里，否则用例是空跑');

  // 两个接口共用 activeAdFree：以前 new Types.ObjectId(脏串) 抛错 → 一起 500
  const rows = await adFreeRoster(NOW);
  const mine = rows.filter((r) => r.openid === `t-roster-rs5-${good}`);
  assert.equal(mine.length, 1, '脏行不许牵连正常用户：该进名单的还是要进');
  assert.equal(rows.filter((r) => !r.openid).length, 0, '也不许冒出一条空 openid 的假行');

  const o = await itemsOverview(NOW);
  assert.equal(o.adFreeUsers, rows.length, '概况的免广告人数与名单同一条推导、同一个结果（脏行两边都不算）');
});
