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
import { creditPoints, debitPoints } from '../src/services/points-ledger.js';
import { pointsOverview, pointsTrend } from '../src/services/points-admin-stats.js';
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
  await creditPoints(String(u), { type: 'signin', title: '签到', points: 60, bizDate: '2026-10-27', idemKey: `${u}:a` }, now);
  await creditPoints(String(u), { type: 'makeup_reward', title: '补签', points: 30, bizDate: '2026-10-26', idemKey: `${u}:b` }, now);
  await debitPoints(String(u), { type: 'exchange', title: '兑换补签卡', points: 200, bizDate: '2026-10-27', idemKey: `${u}:c` }, now)
    .catch(() => {}); // 余额不足也要造出「撤回」行，下面手动补
  await debitPoints(String(u), { type: 'makeup_reward_rollback', title: '撤回补签', points: 30, bizDate: '2026-10-27', idemKey: `${u}:d` }, now);
  const o = await pointsOverview(now);
  assert.equal(o.earnedGross - o.rolledBack - o.spentExchange - o.spentExpire, o.balance,
    'spec §6.5 不变式');
  assert.ok(o.rolledBack >= 30);
  assert.notEqual(o.spentExchange + o.spentExpire, o.totalSpent,
    'totalSpent 混了撤回，不能当消耗用（这条断言就是证据）');
});

test('AS-2 负 delta 的 type 必须全在三族内，否则不变式会静默失真', async () => {
  const known = ['exchange', 'expire', 'makeup_reward_rollback'];
  const odd = await PointRecordModel.distinct('type', { delta: { $lt: 0 } });
  assert.deepEqual(
    odd.filter((t) => !known.includes(t) && !t.endsWith('_rollback')),
    [],
    `出现未登记的扣分类型：${odd.join(', ')}。必须同步进 pointsOverview 的口径式与本文档`,
  );
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
