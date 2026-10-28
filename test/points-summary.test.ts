/**
 * 积分页两张新卡要的数据：过期提示 + 连签百分位。
 *
 * 分两层钉：
 * - 纯函数（`expiringNotice` / `streakPercentile`）拿算例逐个钉死口径，含 30 天边界两侧、
 *   同到期日合并、并列不算被超过、mine=0 归 0、分母被造数污染时的钳位；
 * - service/路由只验「取数对不对」——共享 dev 库里全用户分布随时变，断言具体百分位数值会假红，
 *   所以这里只比对它读到的 totalUsers / mine / 活跃链集合。
 */
process.env.TZ = 'UTC'; // 线上容器口径；必须在任何断言之前生效（同 east8-boundaries 的做法）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { PointLotModel, PointSigninModel } from '../src/models/point.model.js';
import { UserModel } from '../src/models/user.model.js';
import { expiringNotice, previousDateKey, streakPercentile } from '../src/utils/points-domain.js';
import { streakPopulation } from '../src/services/points-summary.js';
import { bjDateStr } from '../src/utils/bj-time.js';

const API = '/sport-track/api';
const DAY = 86400000;
// 参考时刻取真实时钟：所有日期档都从它派生，与被测代码同一时钟
// （streakPopulation 显式传 NOW；路由内部用 Date.now()，NOW+Ns 的相对档位对它同样成立），
// 不再写死日历日——写死的那天一过，「今天/昨天」的 fixture 就整体错位。
const NOW = Date.now();
const TODAY = bjDateStr(NOW);            // 东八区「今天」，随真实日期滚动
const YESTERDAY = previousDateKey(TODAY); // 东八区「昨天」

let app: FastifyInstance;
let token = '';
let userId = '';
let uid: Types.ObjectId;

const auth = () => ({ authorization: `Bearer ${token}` });
const data = <T>(res: { json: () => { data: T } }): T => res.json().data;

const lot = (remaining: number, expireAt: number) => PointLotModel.create({
  userId: uid, recordId: new Types.ObjectId(), earned: remaining, remaining,
  earnedAt: expireAt - 300 * DAY, expireAt,
});

before(async () => {
  assert.equal(new Date().getTimezoneOffset(), 0, '本文件必须跑在 TZ=UTC 下，否则这些用例失去意义');
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  await PointSigninModel.init();
  app = await buildApp({ logger: false });
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: `${API}/auth/login`,
    payload: { code: `openid:points-summary-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  assert.equal(login.statusCode, 200, login.body);
  const d = login.json().data;
  token = d.accessToken;
  userId = d.user?.id ?? d.user?._id;
  uid = new Types.ObjectId(userId);
});

after(async () => {
  await Promise.all([PointLotModel.deleteMany({ userId: uid }), PointSigninModel.deleteMany({ userId: uid })]);
  await app.close();
  await mongoose.disconnect();
});

// ---------- 过期提示：纯函数算例 ----------

test('EN-1 最早到期批次 ≤30 天才出话，天数按整天向下取整', () => {
  const near = [{ remaining: 84, expireAt: NOW + 23.5 * DAY }];
  assert.deepEqual(expiringNotice(near, NOW, 30), { points: 84, daysLeft: 23 });
  // 边界两侧：整 30 天出、30.5 天（向下取整后仍是 30）出、31 天不出
  assert.equal(expiringNotice([{ remaining: 5, expireAt: NOW + 30 * DAY }], NOW, 30)?.daysLeft, 30);
  assert.equal(expiringNotice([{ remaining: 5, expireAt: NOW + 31 * DAY }], NOW, 30), null, '超过阈值不该打扰用户');
});

test('EN-2 只报最早那一批，同到期日合并求和', () => {
  const lots = [
    { remaining: 40, expireAt: NOW + 45 * DAY },   // 更晚的一批不参与本次提示
    { remaining: 84, expireAt: NOW + 23 * DAY },
    { remaining: 16, expireAt: NOW + 23 * DAY },   // 与上一批同到期日 → 合并
  ];
  assert.deepEqual(expiringNotice(lots, NOW, 30), { points: 100, daysLeft: 23 });
});

test('EN-3 空批次/已过期/剩余 0 都不出话', () => {
  assert.equal(expiringNotice([], NOW, 30), null);
  assert.equal(expiringNotice([{ remaining: 10, expireAt: NOW - DAY }], NOW, 30), null, '已到期时刻不该再提示');
  assert.equal(expiringNotice([{ remaining: 0, expireAt: NOW + 3 * DAY }], NOW, 30), null, '批次被扣光是 0 分');
});

// ---------- 连签百分位：纯函数算例 ----------

test('SP-1 分母是全部注册用户，没签过到的人算 0 天', () => {
  // 12 人里只有 3 人链还活着（9/6/6），其余 9 人都是 0 天
  assert.equal(streakPercentile({ totalUsers: 12, activeStreaks: [9, 6, 6], mine: 6 }), 75);
  assert.equal(streakPercentile({ totalUsers: 12, activeStreaks: [9, 6, 6], mine: 9 }), 91, '向下取整，91.6 → 91');
  // 1 天与 6 天同为 75%：中间没人连签 1~5 天，被超过的只有那 9 个 0 天的人
  assert.equal(streakPercentile({ totalUsers: 12, activeStreaks: [9, 6, 6], mine: 1 }), 75);
  assert.equal(streakPercentile({ totalUsers: 12, activeStreaks: [9, 6, 6, 2], mine: 6 }), 75,
    '8 个 0 天 + 1 个 2 天 = 9 人被超过，仍是 75%');
});

test('SP-2 并列不算被超过；连签 0 天归 0', () => {
  assert.equal(streakPercentile({ totalUsers: 10, activeStreaks: [5, 5], mine: 5 }), 80, '另一个 5 天的人不算被我超过');
  assert.equal(streakPercentile({ totalUsers: 10, activeStreaks: [5], mine: 0 }), 0, '我 0 天时不该显示「超过 0%」以外的数');
  assert.equal(streakPercentile({ totalUsers: 1, activeStreaks: [5], mine: 5 }), 0, '全库只有我时没人被超过');
});

test('SP-3 活跃链人数超过注册数（脏行）时钳到 0，不出负数', () => {
  assert.equal(streakPercentile({ totalUsers: 3, activeStreaks: [5, 6, 7, 8], mine: 4 }), 0);
  assert.equal(streakPercentile({ totalUsers: 0, activeStreaks: [], mine: 7 }), 0, '分母 0 不能除');
});

// ---------- 路由下发 ----------

test('SUM-1 summary 下发 expiring：无批次 null、近端批次出话、远端批次仍 null', async () => {
  await PointLotModel.deleteMany({ userId: uid });
  const base = data<{ expiring: unknown; streakPercentile: unknown }>(
    await app.inject({ method: 'GET', url: `${API}/points/summary`, headers: auth() }),
  );
  assert.equal(base.expiring, null, '没有未过期批次时下发 null（端上整行不渲染）');
  assert.equal(typeof base.streakPercentile, 'number');

  await lot(84, NOW + 23 * DAY);
  await PointSigninModel.deleteMany({ userId: uid });
  await PointSigninModel.create({ userId: uid, dateKey: TODAY, streakDay: 6, points: 6, source: 'sign', createdAt: NOW });
  const withNear = data<{ expiring: { points: number; daysLeft: number } | null }>(
    await app.inject({ method: 'GET', url: `${API}/points/summary`, headers: auth() }),
  );
  assert.equal(withNear.expiring?.points, 84);
  // 真实 now 与 NOW 不同一天时天数会差 0~1，这里只钉「在 30 以内且不是 0」
  assert.ok((withNear.expiring?.daysLeft ?? -1) >= 22 && (withNear.expiring?.daysLeft ?? 99) <= 23,
    `daysLeft 应贴着 23，实际 ${withNear.expiring?.daysLeft}`);

  await PointLotModel.deleteMany({ userId: uid });
  await lot(50, Date.now() + 45 * DAY);
  const far = data<{ expiring: unknown }>(
    await app.inject({ method: 'GET', url: `${API}/points/summary`, headers: auth() }),
  );
  assert.equal(far.expiring, null, '阈值判定在服务端，端上不再算数');
});

test('SUM-2 streakPopulation 读到的口径：mine = 当前连签、活跃链含本人', async () => {
  await PointSigninModel.deleteMany({ userId: uid });
  // 今天有行 → mine 取今天的值，本人也进活跃链
  await PointSigninModel.create({ userId: uid, dateKey: TODAY, streakDay: 1, points: 1, source: 'sign', createdAt: NOW });
  const mine = await streakPopulation(userId, NOW);
  assert.equal(mine.totalUsers, await UserModel.countDocuments({}), '分母 = 全部注册用户');
  assert.ok(mine.activeStreaks.length >= 1 && mine.activeStreaks.every((s) => s >= 1), '活跃链只收 ≥1 天的人');
  assert.ok(mine.activeStreaks.includes(1), '今天有行 → 本人以今天的库存值进活跃链');

  await PointSigninModel.deleteMany({ userId: uid, dateKey: TODAY });
  // 今天没签、昨天签过 → 链还活着，mine 取昨天的值（2026-10-28 用户拍板：今天还没过去，仍有可能）
  await PointSigninModel.create({
    userId: uid, dateKey: YESTERDAY, streakDay: 6, points: 6, source: 'sign', createdAt: NOW,
  });
  const y = await streakPopulation(userId, NOW);
  assert.equal(y.mine, 6, '只有昨天的行时按昨天那条算，不能归 0');
  // 共享库里别人也可能连签 6 天，includes(6) 会被代打（变异验证实测逃过一次）：
  // 差分要成立必须先真的删掉本人行取基线，光换个 userId 没用——活跃链本来就不按 userId 过滤
  await PointSigninModel.deleteMany({ userId: uid });
  const baseline = (await streakPopulation(userId, NOW)).activeStreaks;
  assert.equal((await streakPopulation(userId, NOW)).mine, 0, '删干净后本人归 0');
  await PointSigninModel.create({
    userId: uid, dateKey: YESTERDAY, streakDay: 6, points: 6, source: 'sign', createdAt: NOW,
  });
  const withMe = (await streakPopulation(userId, NOW)).activeStreaks;
  const added = [...withMe];
  for (const s of baseline) {
    const i = added.indexOf(s);
    if (i >= 0) added.splice(i, 1);
  }
  assert.deepEqual(added, [6], '本人以昨天的值进活跃链，且只进一个');

  await PointSigninModel.deleteMany({ userId: uid });
  // 远古日期是故意的：本用例要的正是「落在今/昨天窗口外」，它不随日历滚动，安全
  await PointSigninModel.create({ userId: uid, dateKey: '2020-01-01', streakDay: 30, points: 3, source: 'sign', createdAt: NOW });
  const stale = await streakPopulation(userId, NOW);
  assert.equal(stale.mine, 0, '最近一次签到在窗口外 → 当前连签归 0，历史值不算');
});
