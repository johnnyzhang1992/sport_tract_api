import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import {
  PointAccountModel, PointCardModel, PointDailyModel, PointLotModel,
  PointRecordModel, PointSigninModel,
} from '../src/models/point.model.js';
import { UserModel } from '../src/models/user.model.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { creditPoints, debitPoints, settleExpired } from '../src/services/points-ledger.js';
import { DEBIT_FAMILIES, pointsOverview, pointsTrend } from '../src/services/points-admin-stats.js';
import { AppError } from '../src/utils/app-error.js';
import { bjDateStr } from '../src/utils/bj-time.js';
import { shiftDateKey } from '../src/utils/points-domain.js';

/**
 * 管理端积分概况与双趋势（spec §6.5/§6.6/§7.1，Task 6 用例 AS-1…AS-5）。
 *
 * 共享 dev 库（sport-track-dev）口径：
 * - 每个用例用自己的 `new Types.ObjectId()`，t.after() 按 userId 清干净 6 个 Point 集合 + users 行；
 * - 概况与趋势都是**全表聚合**，所以断言要么用差分（基线 → 插入 → 增量），要么把窗口挪到
 *   库里没有数据的未来区间——dev 库今天的 2026-10-27 已经有别人的签到行，直接写死「今天 1 人」
 *   会在第二次运行时红。零填充用例走未来窗口，仍然逐条断言桶日期与桶数；
 * - 断言只读 service 返回值与库（aggregate/find），不看日志。
 */

const ADMIN_USER = 'admin_points_stats_t6';
const ADMIN_PASS = 'test123456';

let app: FastifyInstance;
let adminToken = '';

/** 清场：本用例造的用户按 userId 删干净（含每日计数器与批次，别给下一个用例留残行） */
const wipe = (u: Types.ObjectId) => Promise.all([
  PointRecordModel.deleteMany({ userId: u }),
  PointAccountModel.deleteMany({ userId: u }),
  PointLotModel.deleteMany({ userId: u }),
  PointDailyModel.deleteMany({ userId: u }),
  PointSigninModel.deleteMany({ userId: u }),
  PointCardModel.deleteMany({ userId: u }),
  UserModel.deleteOne({ _id: u }),
]);

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
});

after(async () => {
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await app.close();
});

test('AS-1 概况不变式：balance == 毛发放 − 撤回 − 兑换 − 过期', async (t) => {
  const u = new Types.ObjectId();
  t.after(() => wipe(u));
  const now = Date.parse('2026-10-27T10:00:00+08:00');
  // 概况是全表聚合：本用例用「基线 → 造数 → 增量」断言五个词各自的精确值，
  // 这样共享 dev 库上别人的流水（以及并发写入）不会把断言变成「差不多就行」
  const before = await pointsOverview(now);
  const [beforeAcc] = await PointAccountModel.aggregate<{ totalSpent: number }>([
    { $group: { _id: null, totalSpent: { $sum: '$totalSpent' } } },
  ]);

  await creditPoints(String(u), { type: 'signin', title: '签到', points: 60, bizDate: '2026-10-27', idemKey: `${u}:a` }, now);
  await creditPoints(String(u), { type: 'makeup_reward', title: '补签', points: 30, bizDate: '2026-10-26', idemKey: `${u}:b` }, now);
  // 先攒够 200：原 fixture 只有 90 分，兑换被 catch 吞掉，spentExchange 从来没被任何用例读过
  await creditPoints(String(u), { type: 'signin', title: '攒够兑换', points: 100, bizDate: '2026-10-25', idemKey: `${u}:c0` }, now);
  await creditPoints(String(u), { type: 'signin', title: '攒够兑换', points: 100, bizDate: '2026-10-24', idemKey: `${u}:c1` }, now);
  await creditPoints(String(u), { type: 'signin', title: '攒够兑换', points: 20, bizDate: '2026-10-23', idemKey: `${u}:c2` }, now);
  await debitPoints(String(u), { type: 'exchange', title: '兑换补签卡', points: 200, bizDate: '2026-10-27', idemKey: `${u}:c` }, now);
  await debitPoints(String(u), { type: 'makeup_reward_rollback', title: '撤回补签', points: 30, bizDate: '2026-10-27', idemKey: `${u}:d` }, now);
  // 过期也走真账本：再入 40，把它那一批的 expireAt 改到过去，settleExpired 会写一条真的 expire 流水
  await creditPoints(String(u), { type: 'signin', title: '即将过期', points: 40, bizDate: '2026-10-22', idemKey: `${u}:e` }, now);
  const expiringLot = await PointLotModel.findOne({ userId: u, earned: 40, remaining: 40 }).lean();
  await PointLotModel.updateOne({ _id: expiringLot!._id }, { $set: { expireAt: now - 1 } });
  await settleExpired(String(u), now);

  const o = await pointsOverview(now);
  const [afterAcc] = await PointAccountModel.aggregate<{ totalSpent: number }>([
    { $group: { _id: null, totalSpent: { $sum: '$totalSpent' } } },
  ]);
  const delta = {
    earnedGross: o.earnedGross - before.earnedGross,
    rolledBack: o.rolledBack - before.rolledBack,
    spentExchange: o.spentExchange - before.spentExchange,
    spentExpire: o.spentExpire - before.spentExpire,
    balance: o.balance - before.balance,
  };
  assert.equal(delta.earnedGross, 350, '毛发放增量 = 60 + 30 + 100 + 100 + 20 + 40');
  assert.equal(delta.rolledBack, 30, '撤回增量 = 那条 makeup_reward_rollback');
  assert.equal(delta.spentExchange, 200, '真 exchange 行必须计进兑换消耗');
  assert.equal(delta.spentExpire, 40, '真 expire 行必须计进过期消耗');
  assert.equal(delta.balance, 80, '余额增量 = 350 − 30 − 200 − 40');
  assert.equal(o.earnedGross - o.rolledBack - o.spentExchange - o.spentExpire, o.balance,
    `spec §6.5 不变式：earnedGross ${o.earnedGross} − rolledBack ${o.rolledBack} − `
    + `spentExchange ${o.spentExchange} − spentExpire ${o.spentExpire} 应等于 balance ${o.balance}`);
  // totalSpent 只留在 PointAccount 里（概况 DTO 不再下发这个 foot-gun）。
  // spec §6.5 的等式是 Σ totalSpent == spentExchange + rolledBack：本用例兑换 200 + 撤回 30 都进它 → 增量 230，
  // 而过期回收走 settleExpired 只减余额、不动 totalSpent，所以真消耗是 240（200+40），两者差 10
  const deltaTotalSpent = (afterAcc?.totalSpent ?? 0) - (beforeAcc?.totalSpent ?? 0);
  assert.equal(deltaTotalSpent, 230, 'PointAccount.totalSpent 把撤回也记成消耗');
  assert.equal(delta.spentExchange + delta.spentExpire, 240, '真正的消耗只有兑换 200 + 过期 40');
  assert.notEqual(delta.spentExchange + delta.spentExpire, deltaTotalSpent,
    'totalSpent 混了撤回，不能当消耗用（概况 DTO 不下发它，AS-1 直接读 PointAccount）');
});

test('AS-2 负 delta 的 type 必须全在三族内，否则不变式会静默失真', async (t) => {
  // 单源：族判定只认 service 导出的 DEBIT_FAMILIES，测试不再自带第二份清单
  const known = (type: string) => Object.values(DEBIT_FAMILIES).some((is) => is(type));
  const oddUser = new Types.ObjectId();
  const probeKey = `${oddUser}:probe`;
  const oddTypes = async () => (await PointRecordModel.distinct('type', { delta: { $lt: 0 } }))
    .filter((type) => !known(type));
  t.after(async () => {
    await PointRecordModel.deleteMany({ userId: oddUser });
    await PointRecordModel.deleteOne({ idemKey: probeKey });
  });

  // 投一条未登记类型的扣分流水：判定必须把它揪出来，否则「全在三族内」永远是空转
  await PointRecordModel.create({
    userId: oddUser, type: 'task_reward_revoke', title: '未登记扣分', delta: -1,
    balanceAfter: 0, bizDate: '2026-10-27', idemKey: probeKey, createdAt: Date.now(),
  });
  const flagged = await oddTypes();
  assert.ok(flagged.includes('task_reward_revoke'),
    `未登记的扣分类型 task_reward_revoke 必须被 AS-2 揪出，实际：${flagged.join(', ')}`);

  // 探针行删掉后，库里的负 delta 类型必须全部落在三族内
  await PointRecordModel.deleteMany({ userId: oddUser });
  const rest = await oddTypes();
  assert.deepEqual(rest, [],
    `出现未登记的扣分类型：${rest.join(', ')}。必须同步进 pointsOverview 的口径式、DEBIT_FAMILIES 与本文档`);
});

test('AS-3 趋势缺日补 0 且桶数等于窗口', async (t) => {
  // 未来窗口：dev 库在 2027-02 没有任何签到/流水，桶计数才能写成绝对值（见文件头注释）
  const now = Date.parse('2027-02-10T10:00:00+08:00');
  const u = new Types.ObjectId();
  t.after(() => wipe(u));
  await PointSigninModel.create({ userId: u, dateKey: '2027-02-10', streakDay: 1, points: 1, source: 'sign', createdAt: now });
  const { data, days } = await pointsTrend(7, now);
  assert.equal(days, 7);
  assert.equal(data.length, 7, '必须正好 7 个桶，一天都不能少');
  assert.deepEqual(data.map((d) => d.date), ['2027-02-04', '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', '2027-02-10']);
  assert.equal(data[6].signinUsers, 1);
  assert.equal(data[0].signinUsers, 0, '空日补 0 而不是跳过');
  assert.equal(data[0].earned, 0);
});

test('AS-4 签到与补签分开计数', async (t) => {
  const now = Date.parse('2027-03-10T10:00:00+08:00');
  const a = new Types.ObjectId(); const b = new Types.ObjectId();
  t.after(() => wipe(a));
  t.after(() => wipe(b));
  await PointSigninModel.insertMany([
    { userId: a, dateKey: '2027-03-10', streakDay: 1, points: 1, source: 'sign', createdAt: now },
    { userId: b, dateKey: '2027-03-10', streakDay: 2, points: 2, source: 'makeup', createdAt: now },
  ]);
  const { data } = await pointsTrend(7, now);
  assert.equal(data[6].signinUsers, 1);
  assert.equal(data[6].makeupUsers, 1);
});

test('AS-5 days 白名单：非 7/30/90 一律 400 并列出允许值', async () => {
  await assert.rejects(() => pointsTrend(15), (e) =>
    (e as AppError).statusCode === 400 && /仅支持 7 \/ 30 \/ 90/.test((e as Error).message));
});

test('AS-3b 趋势的发放/兑换/过期都按 bizDate 落桶', async (t) => {
  const now = Date.parse('2027-04-10T10:00:00+08:00');
  const u = new Types.ObjectId();
  t.after(() => wipe(u));
  await creditPoints(String(u), { type: 'signin', title: '签到', points: 50, bizDate: '2027-04-05', idemKey: `${u}:e` }, now);
  await debitPoints(String(u), { type: 'exchange', title: '兑换', points: 20, bizDate: '2027-04-06', idemKey: `${u}:x` }, now);
  // 过期结算要造真实批次，这里只验趋势桶的归类：直接落一条 expire 流水（t.after 会清掉）
  await PointRecordModel.create({
    userId: u, type: 'expire', title: '积分过期', delta: -5, balanceAfter: 25,
    bizDate: '2027-04-07', idemKey: `${u}:exp`, createdAt: now,
  });
  const { data } = await pointsTrend(7, now);
  const at = (d: string) => data.find((b) => b.date === d)!;
  assert.equal(at('2027-04-05').earned, 50, '正 delta 按 bizDate 落到发放桶');
  assert.equal(at('2027-04-06').exchanged, 20, 'exchange 的 |delta| 落到兑换桶');
  assert.equal(at('2027-04-06').earned, 0, '兑换日不应同时记成发放');
  assert.equal(at('2027-04-07').expired, 5, 'expire 的 |delta| 落到过期桶');
});

test('AS-6 概况的签到人数（今日/近7天/累计）与持卡未使用人数按 distinct 用户数', async (t) => {
  const now = Date.now();
  const today = bjDateStr(now);
  const a = new Types.ObjectId(); const b = new Types.ObjectId(); const c = new Types.ObjectId();
  t.after(() => wipe(a));
  t.after(() => wipe(b));
  t.after(() => wipe(c));
  const before = await pointsOverview(now);
  await PointSigninModel.insertMany([
    { userId: a, dateKey: today, streakDay: 1, points: 1, source: 'sign', createdAt: now },
    { userId: b, dateKey: shiftDateKey(today, -6), streakDay: 1, points: 1, source: 'makeup', createdAt: now },
  ]);
  // 同一人两张有效未使用卡只算一个人；过期卡不算
  await PointCardModel.insertMany([
    { userId: c, itemKey: 'makeup_card', status: 'unused', expiresAt: now + 86400000, createdAt: now },
    { userId: c, itemKey: 'makeup_card', status: 'unused', expiresAt: now + 86400000, createdAt: now },
    { userId: c, itemKey: 'makeup_card', status: 'unused', expiresAt: now - 1, createdAt: now },
  ]);
  const after = await pointsOverview(now);
  assert.equal(after.todaySigninUsers, before.todaySigninUsers + 1, '今日签到人数按东八区今天');
  assert.equal(after.weekSigninUsers, before.weekSigninUsers + 2, '近 7 天含今天与今天-6');
  assert.equal(after.totalSigninUsers, before.totalSigninUsers + 2, '累计按 distinct userId');
  assert.equal(after.cardsUnusedUsers, before.cardsUnusedUsers + 1, '持卡未使用按 distinct userId，过期卡不算');
});

test('AS-7 路由接线：鉴权 + 概况/趋势 200、非法 days 400', async () => {
  const noAuth = await app.inject({ method: 'GET', url: '/sport-track/api/admin/points/overview' });
  assert.equal(noAuth.statusCode, 401, noAuth.body);

  const ov = await app.inject({
    method: 'GET', url: '/sport-track/api/admin/points/overview',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(ov.statusCode, 200, ov.body);
  assert.equal(typeof ov.json().data.balance, 'number');
  assert.equal(typeof ov.json().data.todaySigninUsers, 'number');

  const tr = await app.inject({
    method: 'GET', url: '/sport-track/api/admin/points/trend?days=7',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(tr.statusCode, 200, tr.body);
  assert.equal(tr.json().data.days, 7);
  assert.equal(tr.json().data.data.length, 7);

  const bad = await app.inject({
    method: 'GET', url: '/sport-track/api/admin/points/trend?days=15',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.match(bad.json().message, /仅支持 7 \/ 30 \/ 90/);
});

test('AS-8 发放人数 = delta > 0 的 distinct userId（只出不进的人不算，赚完再花仍算一人）', async (t) => {
  const now = Date.parse('2027-05-10T10:00:00+08:00');
  const earner = new Types.ObjectId(); const spender = new Types.ObjectId();
  t.after(() => wipe(earner));
  t.after(() => wipe(spender));
  // 概况是全表聚合：用差分断言，dev 库别人的正向流水不影响
  const before = await pointsOverview(now);
  // 赚过分、之后又花掉：仍是同一个「发放对象」，不能因为花光就不算
  await creditPoints(String(earner), { type: 'signin', title: '签到', points: 100, bizDate: '2027-05-10', idemKey: `${earner}:e` }, now);
  await debitPoints(String(earner), { type: 'exchange', title: '兑换', points: 30, bizDate: '2027-05-10', idemKey: `${earner}:x` }, now);
  // 只有负向流水（过期回收）：没被发放过，不能进发放人数
  await PointRecordModel.create({
    userId: spender, type: 'expire', title: '积分过期', delta: -5, balanceAfter: 0,
    bizDate: '2027-05-10', idemKey: `${spender}:exp`, createdAt: now,
  });
  const after = await pointsOverview(now);
  assert.equal(after.earnedUsers, before.earnedUsers + 1,
    '两个用户各有一条流水，但发放人数只多 1：只有 delta > 0 的那个人算');
  // 直接读库对齐口径：earner 在 distinct 里且只出现一次，spender 不在
  const earners = (await PointRecordModel.distinct('userId', { delta: { $gt: 0 } })).map(String);
  assert.equal(earners.filter((id) => id === String(earner)).length, 1, '赚过又花掉的用户只算一次');
  assert.ok(!earners.includes(String(spender)), '只有负向流水的用户不算发放人数');
});
