import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import { POINTS } from '../src/config/points.js';
import {
  PointAccountModel, PointCardModel, PointDailyModel, PointLotModel,
  PointRecordModel, PointSigninModel,
} from '../src/models/point.model.js';
import { UserModel } from '../src/models/user.model.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { creditPoints, debitPoints, listPointRecords } from '../src/services/points-ledger.js';
import {
  pointsAdminUserCards, pointsAdminUserDetail, pointsAdminUserRecords, pointsAdminUsers,
} from '../src/services/points-admin-users.js';
import { AppError } from '../src/utils/app-error.js';
import { bjDateStr } from '../src/utils/bj-time.js';
import { shiftDateKey } from '../src/utils/points-domain.js';

/**
 * 管理端用户积分列表与详情（spec §6.7/§7.1，Task 7 用例 AU-1…AU-8）。
 *
 * 共享 dev 库（sport-track-dev）口径：
 * - 用户一律 new Types.ObjectId() + 文件级 uid 计数器（uid 是 sparse unique），t.after() 按 userId 清干净；
 * - `creditPoints` 有 DAILY_CAP=100/日，造 >100 分要按业务日拆段（与 points-items-catalog 的 seedBalance 同口径，
 *   这里额外支持 `earnedAt` 以便 AU-2 造出先后两个发放时刻）；
 * - 排序/关键词用例要看「我们造的这几个人」时一律带 nickname 里的用例 token 过滤：
 *   dev 库有 480+ 用户，直接取 items[0] 会被别人的数据带跑（AU-2 尤其）；
 * - 断言只读 service 返回值与库，不看日志。
 */

const ADMIN_USER = 'admin_points_users_t7';
const ADMIN_PASS = 'test123456';

let app: FastifyInstance;
let adminToken = '';
let uidSeq = 1000;

/** 清场：本用例造的用户按 userId 删干净（含批次与每日计数器） */
const wipe = (u: Types.ObjectId) => Promise.all([
  PointRecordModel.deleteMany({ userId: u }),
  PointAccountModel.deleteMany({ userId: u }),
  PointLotModel.deleteMany({ userId: u }),
  PointDailyModel.deleteMany({ userId: u }),
  PointSigninModel.deleteMany({ userId: u }),
  PointCardModel.deleteMany({ userId: u }),
  UserModel.deleteOne({ _id: u }),
]);

/** 造一个真实用户行（uid 单调递增，避免撞 sparse unique） */
async function makeUser(t: TestContext, nickname?: string): Promise<{ id: string; oid: Types.ObjectId }> {
  const oid = new Types.ObjectId();
  uidSeq += 1;
  await UserModel.create({
    _id: oid,
    openid: `t-t7-${oid}`,
    nickname: nickname ?? `T7用户${uidSeq}`,
    uid: uidSeq,
  });
  t.after(() => wipe(oid));
  return { id: String(oid), oid };
}

/**
 * 造余额：按业务日拆段绕开 DAILY_CAP=100；`earnedAt` 是这些发放行的 createdAt
 * （AU-2 要用它拉开先后，默认取当前时刻）。
 */
async function seedPoints(userId: string, total: number, earnedAt?: number): Promise<void> {
  const now = earnedAt ?? Date.now();
  const today = bjDateStr(now);
  let left = total;
  for (let i = 0; left > 0; i += 1) {
    const points = Math.min(POINTS.DAILY_CAP, left);
    const r = await creditPoints(userId, {
      type: 'signin',
      title: '测试发放',
      points,
      bizDate: shiftDateKey(today, -i),
      idemKey: `${userId}:seed:${i}`,
    }, now);
    assert.equal(r.credited, points, `拆分发放不该被日上限截断（第 ${i} 段）`);
    left -= points;
  }
}

async function makeUserWithPoints(
  t: TestContext,
  total: number,
  opts: { nickname?: string; earnedAt?: number } = {},
): Promise<string> {
  const { id } = await makeUser(t, opts.nickname);
  await seedPoints(id, total, opts.earnedAt);
  return id;
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

  // uid 计数器从库里数值档的最大值起（dev 库混着 int/string 两种 BSON 类型，只筛数值档）
  const [agg] = await UserModel.aggregate<{ max: number | null }>([
    { $match: { uid: { $type: 'number' } } },
    { $group: { _id: null, max: { $max: '$uid' } } },
  ]);
  uidSeq = Number(agg?.max ?? 1000);
});

after(async () => {
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await app.close();
});

async function adminGet(url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${adminToken}` } });
}

test('AU-1 默认按余额倒序；无积分用户排尾且 tie-break 稳定', async (t) => {
  // 关键词圈定本用例的三个人：dev 库有 480+ 用户，不圈的话「顺序正确」可能只是大家余额都是 0
  await makeUserWithPoints(t, 50, { nickname: 'T7AU1-a' });
  await makeUserWithPoints(t, 300, { nickname: 'T7AU1-b' });
  await makeUserWithPoints(t, 50, { nickname: 'T7AU1-c' });
  const r = await pointsAdminUsers({ keyword: 'T7AU1', page: 1, pageSize: 100 });
  assert.equal(r.items.length, 3);
  const balances = r.items.map((i) => i.balance);
  assert.deepEqual(balances, [300, 50, 50], '默认按余额倒序');
  assert.ok(balances.every((v, i) => i === 0 || balances[i - 1] >= v), '必须单调不升');
  // 同余额两人按 uid 升序（tie-break 稳定，翻页才有确定顺序）
  assert.ok(r.items[1].uid < r.items[2].uid);
});

test('AU-2 lastEarnedAt 排序：取该用户 delta>0 的最近一次，撤回行不参与', async (t) => {
  const early = await makeUserWithPoints(t, 10, {
    nickname: 'T7AU2-earlier', earnedAt: Date.parse('2026-10-20T10:00:00+08:00'),
  });
  const late = await makeUserWithPoints(t, 10, {
    nickname: 'T7AU2-later', earnedAt: Date.parse('2026-10-27T10:00:00+08:00'),
  });
  // 给 early 再写一条撤回（delta<0，时间更晚）——排序不许被它带跑
  await debitPoints(early, { type: 'makeup_reward_rollback', title: '撤回', points: 5, bizDate: '2026-10-27', idemKey: `${early}:rb` });
  const desc = await pointsAdminUsers({ keyword: 'T7AU2', sortBy: 'lastEarnedAt', order: 'desc', pageSize: 100 });
  assert.equal(desc.items.length, 2, '关键词只命中本用例两个人');
  assert.equal(desc.items.find((i) => i.id === late)!.lastEarnedAt > desc.items.find((i) => i.id === early)!.lastEarnedAt, true);
  assert.equal(desc.items[0].id, late);
  // 撤回行必须被 delta>0 的闸门滤掉：early 的 lastEarnedAt 仍是 10-20 那次发放
  assert.equal(desc.items.find((i) => i.id === early)!.lastEarnedAt, Date.parse('2026-10-20T10:00:00+08:00'));
});

test('AU-3 排序在分页之前：翻两页拼起来全局不升、不重不漏', async (t) => {
  // 关键词圈定这 25 人：不圈的话首页会被 dev 库的老用户占满，
  // 先切片再排序也照样「碰巧」跨页单调（变异验证就是这么发现用例失效的）
  for (let i = 1; i <= 25; i++) await makeUserWithPoints(t, i * 7, { nickname: `T7AU3-${i}` }); // 极值必然跨页
  const p1 = await pointsAdminUsers({ keyword: 'T7AU3', sortBy: 'balance', order: 'desc', page: 1, pageSize: 10 });
  const p2 = await pointsAdminUsers({ keyword: 'T7AU3', sortBy: 'balance', order: 'desc', page: 2, pageSize: 10 });
  const all = [p1.items, p2.items].flat();
  assert.equal(p1.total, 25);
  assert.equal(p2.total, 25);
  assert.equal(new Set(all.map((r) => r.id)).size, all.length, '翻页不能重行');
  assert.ok(all.every((r, i) => i === 0 || all[i - 1].balance >= r.balance), '跨页仍须单调');
  assert.equal(p1.total, p2.total);
});

test('AU-4 非法 sortBy → 400 且 message 列出允许值；空 sortBy 走默认', async () => {
  const SORT_FIELDS = ['balance', 'lastEarnedAt', 'totalEarned', 'exchanges'];
  await assert.rejects(() => pointsAdminUsers({ sortBy: 'nickname' }), (e) =>
    (e as AppError).statusCode === 400 && SORT_FIELDS.every((f) => (e as Error).message.includes(f)));
  const ok = await pointsAdminUsers({ sortBy: '' });
  assert.ok(Array.isArray(ok.items));
});

test('AU-5 keyword 按昵称/UID 字面量搜，元字符不当通配', async (t) => {
  const u = await makeUserWithPoints(t, 10, { nickname: '张三(测试)' });
  assert.equal((await pointsAdminUsers({ keyword: '(测试)' })).items.some((i) => i.id === u), true);
  assert.equal((await pointsAdminUsers({ keyword: '张三.*' })).items.length, 0, '转义后按字面量匹配');
  // UID 精确搜索：关键词是纯数字时同时按 uid 命中（昵称里没有这个号）
  const row = (await pointsAdminUsers({ keyword: '张三(测试)' })).items.find((i) => i.id === u)!;
  const byUid = await pointsAdminUsers({ keyword: String(row.uid) });
  assert.equal(byUid.items.some((i) => i.id === u), true, 'UID 搜索要能命中本人');
});

test('AU-6 详情：概况与列表行同口径，且带 adFreeUntil 与当前连续', async (t) => {
  const u = await makeUserWithPoints(t, 120, { nickname: 'T7AU6-主人翁' });
  // 花掉 20：余额 ≠ 累计获得，共用口径一旦被详情重算成毛发放，下面的相等就会红
  await debitPoints(u, { type: 'exchange', title: '兑换补签卡', points: 20, bizDate: '2026-10-27', idemKey: `${u}:ex` });
  const row = (await pointsAdminUsers({ keyword: 'T7AU6-主人翁', pageSize: 100 })).items.find((i) => i.id === u)!;
  const d = await pointsAdminUserDetail(u);
  assert.equal(d.balance, row.balance, '跨页同指标口径必须一致');
  assert.equal(d.totalEarned, row.totalEarned);
  assert.equal(d.balance, 100, '余额已扣掉兑换的 20');
  assert.equal(d.totalEarned, 120);
  assert.equal(d.totalSpent, 20, '累计消耗 = 兑换 + 过期，不含撤回');
  assert.equal(typeof d.adFreeUntil, 'number');
  assert.equal(typeof d.streakDay, 'number');
});

test('AU-7 管理端明细 pageSize 上限 100（用户端仍是 50）', async (t) => {
  const { id: u } = await makeUser(t);
  for (let i = 0; i < 60; i++) {
    await creditPoints(u, { type: 'signin', title: `x${i}`, points: 1, bizDate: '2026-10-27', idemKey: `${u}:${i}` });
  }
  const admin = await pointsAdminUserRecords(u, 1, 100);
  assert.equal(admin.items.length, 60, '管理端要能一次取回 60 行');
  assert.equal(admin.pageSize, 100);
  const userSide = await listPointRecords(u, 1, 100);
  assert.equal(userSide.pageSize, 50, '用户端上限不许被顺手放宽');
  assert.equal(userSide.items.length, 50);
});

test('AU-8 非法用户 id → 400；不存在 → 404 带对象名', async () => {
  await assert.rejects(() => pointsAdminUserDetail('bad-id'), (e) => (e as AppError).statusCode === 400);
  await assert.rejects(() => pointsAdminUserDetail(String(new Types.ObjectId())), (e) =>
    (e as AppError).statusCode === 404 && /用户不存在/.test((e as Error).message));
});

test('AU-9 路由接线：四条都挂 adminAuth，详情/明细/卡片字段齐全', async (t) => {
  const u = await makeUserWithPoints(t, 30, { nickname: 'T7AU9-路由' });
  // 一张卡（含来源文案）与一条签到，供 cards/详情断言
  await PointCardModel.create({
    userId: u, itemKey: 'makeup_card', status: 'unused', expiresAt: Date.now() + 86400000, createdAt: Date.now(),
  });
  await PointSigninModel.create({ userId: u, dateKey: bjDateStr(Date.now()), streakDay: 1, points: 1, source: 'sign', createdAt: Date.now() });

  for (const url of [
    '/sport-track/api/admin/points/users',
    `/sport-track/api/admin/points/users/${u}`,
    `/sport-track/api/admin/points/users/${u}/records`,
    `/sport-track/api/admin/points/users/${u}/cards`,
  ]) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 401, `${url} 未登录必须 401：${res.body}`);
  }

  const list = await adminGet('/sport-track/api/admin/points/users?keyword=T7AU9-路由&pageSize=10');
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().data.items.length, 1);
  const row = list.json().data.items[0];
  assert.equal(row.id, u);
  assert.equal(row.balance, 30);
  assert.equal(typeof row.lastEarnedAt, 'number');
  assert.equal(typeof row.uid, 'number');

  const detail = await adminGet(`/sport-track/api/admin/points/users/${u}`);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().data.signinDays, 1);
  assert.equal(detail.json().data.cardsUnused, 1);

  const records = await adminGet(`/sport-track/api/admin/points/users/${u}/records?pageSize=100`);
  assert.equal(records.statusCode, 200, records.body);
  assert.equal(records.json().data.items.length, 1);
  assert.equal(records.json().data.pageSize, 100);

  const cards = await adminGet(`/sport-track/api/admin/points/users/${u}/cards`);
  assert.equal(cards.statusCode, 200, cards.body);
  assert.equal(cards.json().data.length, 1);
  assert.equal(cards.json().data[0].sourceText, '兑换');
  assert.equal(cards.json().data[0].statusText, '未使用');
  assert.equal(cards.json().data[0].itemName, '补签卡', '卡片行关联目录名');

  const bad = await adminGet('/sport-track/api/admin/points/users/not-an-id');
  assert.equal(bad.statusCode, 400, bad.body);
  const ghost = await adminGet(`/sport-track/api/admin/points/users/${new Types.ObjectId()}/cards`);
  assert.equal(ghost.statusCode, 404, ghost.body);
  assert.equal(ghost.json().message, '用户不存在');
});
