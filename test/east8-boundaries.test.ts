/**
 * 时间档一律按东八区切，与服务器时区无关。
 *
 * 线上容器（node:22-alpine，Dockerfile/compose 都没设 TZ）跑在 UTC。三处曾直接读
 * 「服务器本地」日期分量，于是东八区 00:00–08:00 之间请求时，UTC 日期还停在昨天：
 *   1. /admin/activity-stats 的今日：`new Date().toLocaleDateString('en-CA')` → 窗口退到昨天 0 点
 *   2. /stats/overview 的今日与 /stats/trend 的桶：`setHours(0,0,0,0)` / `$dateToString`
 *      不带 timezone → 东八日凌晨的活动归到前一天
 *   3. 运动榜 periodStartMs：周榜起点算成「UTC 周一 0 点」，比东八区周一 0 点晚 8 小时
 *
 * 光靠「现在这个时刻」跑不出 1、2（东八区 08:00 之后两种写法恰好重合），所以这里
 * 把进程时区钉成 UTC，并用 mock.timers 把时钟冻结在东八区凌晨 00:30 再请求。
 * 3 是纯函数、直接传时刻，任何机器上都该先红。
 */
process.env.TZ = 'UTC'; // 线上容器口径；必须在任何断言之前生效
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { FootprintRecordModel } from '../src/models/footprint-record.model.js';
import { LoginLogModel } from '../src/models/login-log.model.js';
import { periodStartMs } from '../src/services/leaderboard.js';

const BJ = 8 * 3600000;
const DAY = 86400000;

/** 东八区「墙上时间」→ epoch ms */
const bjMs = (y: number, m: number, d: number, h = 0, mi = 0, s = 0) =>
  Date.UTC(y, m - 1, d, h, mi, s) - BJ;
/** 东八区日期分量 */
const bjParts = (ms: number) => {
  const b = new Date(ms + BJ);
  return { y: b.getUTCFullYear(), m: b.getUTCMonth() + 1, d: b.getUTCDate() };
};
/** 东八区日期串 YYYY-MM-DD */
const bjDateStr = (ms: number) => new Date(ms + BJ).toISOString().slice(0, 10);
/**
 * 东八区自然周起点（周一 0 点）——测试里自己算，不复用实现里的 helper，
 * 否则 helper 写错时两边一起错、用例照样绿。
 */
const weekStartOf = (ms: number) => {
  const b = new Date(ms + BJ);
  const dow = (b.getUTCDay() + 6) % 7; // 周一 = 0
  return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() - dow) - BJ;
};

const ADMIN_USER = 'admin_east8_test';
const ADMIN_PASS = 'test123456';
/** 昨天中午那条的距离：一旦漏进今日，距离差会多出这个数 */
const D_YESTERDAY = 1111;
/** 今天凌晨那条的距离：唯一该被今日算进去的量 */
const D_TODAY = 2222;

let app: FastifyInstance;
let adminToken = '';
let userToken = '';
let userId = '';
/** 登录日志专用用户（概览页 PV/UV 是全站口径，用独立 id 才能干净地看增量） */
const LOGIN_UID = new mongoose.Types.ObjectId();

/** 冻结时刻：真实「东八区今天」的凌晨 00:30（此时 UTC 日期还停在昨天） */
const FROZEN = (() => {
  const { y, m, d } = bjParts(Date.now());
  return bjMs(y, m, d, 0, 30);
})();

before(async () => {
  assert.equal(new Date().getTimezoneOffset(), 0, '本文件必须跑在 TZ=UTC 下，否则这些用例失去意义');
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

  // 先按 code 登录一次拿到 userId，清掉上一轮残留（同一 openid 复跑）
  const pre = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'openid:east8-' },
  });
  const preUser = pre.json().data.user;
  const preId = preUser?.id ?? preUser?._id;
  if (preId) await ActivityModel.deleteMany({ userId: preId });

  const u = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'openid:east8-' },
  });
  userId = u.json().data.user.id;
  userToken = u.json().data.accessToken;
  assert.ok(userToken, '用户登录应成功');
});

after(async () => {
  mock.timers.reset();
  if (userId) {
    await UserModel.deleteOne({ _id: userId }).catch(() => {});
    await ActivityModel.deleteMany({ userId }).catch(() => {});
    await FootprintRecordModel.deleteMany({ userId }).catch(() => {});
  }
  await LoginLogModel.deleteMany({ userId: LOGIN_UID }).catch(() => {});
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

/** 冻结时钟跑一段请求（只冻 Date，不冻 timer，避免拖住 mongo 驱动） */
async function atBjDawn<T>(fn: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ['Date'], now: FROZEN });
  try {
    return await fn();
  } finally {
    mock.timers.reset();
  }
}

/** 造一条 finished 轨迹（本文件测统计聚合，直接写库，不走 finish 的无效轨迹守卫） */
async function seedFinishedAt(startTs: number, distance: number, createdAt?: number) {
  await ActivityModel.create({
    userId,
    type: 'walking',
    status: 'finished',
    startTime: startTs,
    endTime: startTs + 60000,
    duration: 60,
    distance,
    trackPoints: [],
    markers: [],
    ...(createdAt ? { createdAt: new Date(createdAt) } : {}),
  });
}

/** 造一条足迹记录（/admin/footprint-stats 按 createdAt 分档） */
async function seedFootprintAt(createdAt: number) {
  await FootprintRecordModel.create({
    userId,
    visitDate: bjDateStr(createdAt),
    title: '时区用例',
    location: { latitude: 31.23, longitude: 121.47, province: '上海市', city: '上海市' },
    photos: [],
    createdAt: new Date(createdAt),
  });
}

/** 东八区昨天中午 + 今天凌晨各一条：只有后者该进「今日」 */
async function seedAroundBjMidnight() {
  const { y, m, d } = bjParts(FROZEN);
  await seedFinishedAt(bjMs(y, m, d - 1, 12, 0), D_YESTERDAY);
  await seedFinishedAt(bjMs(y, m, d, 0, 10), D_TODAY);
}

async function adminToday(): Promise<{ count: number; distance: number }> {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/admin/activity-stats',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 200);
  return res.json().data.today as { count: number; distance: number };
}

async function userOverview(): Promise<Record<string, { count: number; distance: number }>> {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/stats/overview',
    headers: { authorization: `Bearer ${userToken}` },
  });
  assert.equal(res.statusCode, 200);
  return res.json().data;
}

async function userTrend(type: string): Promise<{ date: string; count: number }[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/sport-track/api/stats/trend?type=${type}`,
    headers: { authorization: `Bearer ${userToken}` },
  });
  assert.equal(res.statusCode, 200);
  return res.json().data.data;
}

async function adminActivityWeek(): Promise<{ count: number; distance: number }> {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/admin/activity-stats',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 200);
  return res.json().data.week as { count: number; distance: number };
}

async function adminStatsWeek(): Promise<{ newActivities: number }> {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/admin/stats',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 200);
  return res.json().data.week as { newActivities: number };
}

async function adminStatsToday(): Promise<{ pv: number; uv: number }> {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/admin/stats',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 200);
  return res.json().data.today as { pv: number; uv: number };
}

/** 造一条登录日志：createdAt 钉死在 ms（只测窗口边界，不走真实登录链路，免得触发限流） */
async function seedLoginAt(ts: number) {
  await LoginLogModel.create({ userId: LOGIN_UID, createdAt: new Date(ts) });
}

async function adminFootprintWeek(): Promise<{ total: number }> {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/admin/footprint-stats',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 200);
  return res.json().data.week as { total: number };
}

/* ------------------------------ 1. 管理端今日 ------------------------------ */

test('管理端概况：东八区凌晨请求，今日不含「昨天中午」（TZ=UTC）', async () => {
  // 全站口径，差分断言（dev 库里还有别人的数据）
  const base = await atBjDawn(adminToday);
  await seedAroundBjMidnight();
  const after = await atBjDawn(adminToday);

  assert.equal(after.count - base.count, 1, '今日只该多出今天凌晨那条（差 2 说明昨天整天被算进来了）');
  assert.equal(
    after.distance - base.distance,
    D_TODAY,
    `今日距离只该加今天凌晨那条 ${D_TODAY}（多出 ${D_YESTERDAY} 说明昨天被算进来了）`,
  );
});

/* ------------------------------ 2. 用户端今日 ------------------------------ */

test('用户端 overview：东八区凌晨请求，今日不含「昨天中午」', async () => {
  const base = (await atBjDawn(userOverview)).today;
  await seedAroundBjMidnight();
  const after = (await atBjDawn(userOverview)).today;

  assert.equal(after.count - base.count, 1, '今日只该多出今天凌晨那条');
  assert.equal(after.distance - base.distance, D_TODAY, '今日距离只该加今天凌晨那条');
});

/* ------------------------------ 3. 用户端趋势桶 ------------------------------ */

test('用户端 trend：末桶是东八区今天，凌晨记录不落到昨天那根柱子', async () => {
  await seedAroundBjMidnight();
  const rows = await atBjDawn(() => userTrend('week'));

  assert.equal(rows.length, 7);
  assert.equal(rows[rows.length - 1].date, bjDateStr(FROZEN), '末桶必须是东八区今天');
  assert.equal(rows[rows.length - 2].date, bjDateStr(FROZEN - DAY), '倒数第二桶是东八区昨天');
  assert.ok(rows[rows.length - 1].count >= 1, '今天凌晨那条应落在末桶');
  assert.ok(rows[rows.length - 2].count >= 1, '昨天中午那条应落在昨天的桶');
});

test('用户端 trend(daily365)：末桶是东八区今天（首页日历热力图读它）', async () => {
  const rows = await atBjDawn(() => userTrend('daily365'));
  assert.equal(rows[rows.length - 1].date, bjDateStr(FROZEN), '日历热力图的最后一格应是东八区今天');
});

/* --------------------------- 4. 运动榜周期起点（纯函数） --------------------------- */

test('运动榜周期起点按东八区自然周/月/年（不是服务器本地）', async () => {
  const monday = new Date(bjMs(2026, 10, 5, 0, 30)); // 2026-10-05 是周一，东八区 00:30
  assert.equal(periodStartMs('week', monday), bjMs(2026, 10, 5, 0, 0), '周榜应从东八区周一 0 点起');
  assert.equal(periodStartMs('month', monday), bjMs(2026, 10, 1, 0, 0), '月榜应从东八区 1 号 0 点起');
  assert.equal(periodStartMs('year', monday), bjMs(2026, 1, 1, 0, 0), '年榜应从东八区元旦 0 点起');
  assert.equal(periodStartMs('all', monday), null);
});

/* ------------------- 5. 「本周」= 自然周（东八区周一 0 点起，非滚动 7 天） ------------------- */

/**
 * 造两条：本周一 0 点前一小时（＝上周日 23:00）与本周一 00:10。
 * 「本周」只该收后者；前者属于上一周（prevWeek）。
 */
const WEEK_S1_D = 3333; // 上周日 23:00 那条的距离（一旦漏进本周，距离差会多出它）
const WEEK_S2_D = 4444; // 本周一 00:10 那条的距离

async function seedAroundWeekStart() {
  const ws = weekStartOf(FROZEN);
  await seedFinishedAt(ws - 3600000, WEEK_S1_D);
  await seedFinishedAt(ws + 600000, WEEK_S2_D);
}

test('用户端 overview：本周按自然周（本周一 0 点起），上周日 23:00 归 prevWeek', async () => {
  const base = (await atBjDawn(userOverview)).week;
  await seedAroundWeekStart();
  const after = await atBjDawn(userOverview);

  assert.equal(after.week.count - base.count, 1, '「本周」只该收本周一 0 点之后那条（差 2 说明还是滚动近 7 天）');
  assert.equal(
    after.week.distance - base.distance,
    WEEK_S2_D,
    `本周距离只该加本周一那条 ${WEEK_S2_D}（多出 ${WEEK_S1_D} 说明上周日被算进来了）`,
  );
  assert.ok(after.prevWeek.count >= 1, '上周日 23:00 那条应落在「上周」');
});

test('管理端概况 activity-stats：本周按自然周（不是滚动近 7 天）', async () => {
  const base = await atBjDawn(adminActivityWeek);
  await seedAroundWeekStart();
  const after = await atBjDawn(adminActivityWeek);

  assert.equal(after.count - base.count, 1, '本周只该多出本周一那条');
  assert.equal(after.distance - base.distance, WEEK_S2_D, `本周距离只该加 ${WEEK_S2_D}`);
});

test('管理端 /stats（数据概览）：本周按自然周（createdAt 口径）', async () => {
  const ws = weekStartOf(FROZEN);
  const base = await atBjDawn(adminStatsWeek);
  await seedFinishedAt(ws - 3600000, WEEK_S1_D, ws - 3600000);
  await seedFinishedAt(ws + 600000, WEEK_S2_D, ws + 600000);
  const after = await atBjDawn(adminStatsWeek);

  assert.equal(after.newActivities - base.newActivities, 1, '本周新增轨迹只该多出本周一那条');
});

test('管理端 footprint-stats：本周按自然周（createdAt 口径）', async () => {
  const ws = weekStartOf(FROZEN);
  const base = await atBjDawn(adminFootprintWeek);
  await seedFootprintAt(ws - 3600000);
  await seedFootprintAt(ws + 600000);
  const after = await atBjDawn(adminFootprintWeek);

  assert.equal(after.total - base.total, 1, '本周新增足迹只该多出本周一那条');
});

/* ------------- 6. 登录 PV/UV「今日」边界（概览页用户段「登录 PV·UV」那行） ------------- */

test('管理端 /stats：登录 PV/UV 的「今日」也以东八区 0 点为界，且 UV 去重（TZ=UTC）', async () => {
  const { y, m, d } = bjParts(FROZEN);
  const base = await atBjDawn(adminStatsToday);
  // 同一用户今天凌晨登录两次（PV+2、UV 只 +1）；另一条落在昨天中午（不该进今日）
  await seedLoginAt(bjMs(y, m, d, 0, 10));
  await seedLoginAt(bjMs(y, m, d, 0, 20));
  await seedLoginAt(bjMs(y, m, d - 1, 12, 0));
  const after = await atBjDawn(adminStatsToday);

  assert.equal(
    after.pv - base.pv,
    2,
    '今日 PV 只该数东八区 0 点后的两次登录（为 0 说明窗口退到了服务器本地 0 点＝UTC 0 点）',
  );
  assert.equal(after.uv - base.uv, 1, '同一用户两次登录，UV 去重后只 +1');
});
