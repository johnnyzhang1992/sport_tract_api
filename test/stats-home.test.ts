import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { UserModel } from '../src/models/user.model.js';
import { collectSection } from '../src/utils/section.js';
import { pickFirstRanked, homeLeaderboardSummary } from '../src/services/leaderboard.js';

/**
 * 首页合并接口：GET /stats/home（overview + footprint + heat 一次下发，按段降级）
 * 与 GET /stats/leaderboard-regions?me=1（全国人数 + 我的榜名次，周期回退放服务端）。
 *
 * 为什么要按段降级：三张卡原先各打一个接口，一个 500 只拖垮自己那张卡（3cb2d5e）。
 * 合并成一个响应后，「某一段 500」必须仍然只影响那一段 —— 否则合并会把老 bug 请回来。
 * 所以服务端用 collectSection 把每段包成 {ok,data|error}，失败信息原样带回，200 照发。
 *
 * 跑法：WX_MOCK_LOGIN=true node --import tsx --test test/stats-home.test.ts
 */

let app: FastifyInstance;
const DAY = 86400000;

type Who = { id: string; token: string };

/** 独立 openid 命名空间：mock 登录按码点和 %10000 折叠，不加前缀会和别的文件撞用户 */
async function loginMock(tag: string): Promise<Who> {
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: `openid:home-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  return { id: data.user?.id ?? data.user?._id, token: data.accessToken };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const get = (url: string, token?: string) =>
  app.inject({ method: 'GET', url: `/sport-track/api${url}`, headers: token ? auth(token) : {} });

const madeUids: string[] = [];

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  if (madeUids.length) await ActivityModel.deleteMany({ userId: { $in: madeUids } });
  if (madeUids.length) await UserModel.deleteMany({ _id: { $in: madeUids } });
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

async function freshUser(tag: string): Promise<Who> {
  const who = await loginMock(tag);
  madeUids.push(who.id);
  return who;
}

/* ───────────── 1. collectSection：按段降级的唯一实现 ───────────── */

test('SH1 collectSection：成功包装 data，失败包装 error 且不抛', async () => {
  const ok = await collectSection(async () => ({ n: 1 }));
  assert.deepEqual(ok, { ok: true, data: { n: 1 } });

  const bad = await collectSection(async () => {
    throw new Error('统计炸了');
  });
  assert.deepEqual(bad, { ok: false, error: '统计炸了' }, '失败原因要原样带给端上，卡片才能点名');
});

test('SH2 collectSection：非 Error 的抛出也要有可读文案，不能变成 undefined', async () => {
  const bad = await collectSection(async () => {
    throw '字符串异常';
  });
  assert.equal(bad.ok, false);
  assert.equal((bad as { error: string }).error, '字符串异常');
});

/* ───────────── 2. GET /stats/home ───────────── */

test('SH3 /stats/home 需要登录', async () => {
  assert.equal((await get('/stats/home')).statusCode, 401);
});

test('SH4 /stats/home 一次返回三段且各自 ok:true（新用户是全 0 + 365 天日历）', async () => {
  const me = await freshUser('shape');
  const res = await get('/stats/home', me.token);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json().data;

  assert.deepEqual(Object.keys(body).sort(), ['footprint', 'heat', 'overview'], '三段缺一不可');
  assert.equal(body.overview.ok, true);
  assert.equal(body.overview.data.total.count, 0, '新用户累计轨迹数为 0');
  assert.equal(body.footprint.ok, true);
  assert.equal(body.footprint.data.provinceCount, 0);
  assert.equal(body.footprint.data.cityCount, 0);
  assert.equal(body.heat.ok, true);
  assert.equal(body.heat.data.data.length, 365, '日历仍是近 365 天按天');
  assert.equal(body.overview.error, undefined, '成功段不该带 error 字段');
});

/* ───────────── 3. 榜名次的周期优先级 ───────────── */

test('SH5 pickFirstRanked：按周期顺序找，找到就早退（不是「取第一个非空结果」也不是全查完）', async () => {
  const month = [{ type: 'hiking', rank: 1 }];
  const year = [{ type: 'running', rank: 3 }];
  const all = [{ type: 'cycling', rank: 9 }];
  const byPeriod: Record<string, { type: string; rank: number }[]> = { week: [], month, year, all };
  const calls: string[] = [];

  const got = await pickFirstRanked(['week', 'month', 'year', 'all'], async (period) => {
    calls.push(period);
    return byPeriod[period];
  });

  assert.deepEqual(got, { period: 'month', ranks: month }, '周榜空 → 月榜有就取月榜');
  assert.deepEqual(calls, ['week', 'month'], '月榜命中后不该再查年榜/总榜（首页每多一次聚合都是全表扫）');

  const none = await pickFirstRanked(['week', 'month', 'year', 'all'], async () => []);
  assert.deepEqual(none, { period: null, ranks: [] }, '四个周期都没上榜 → null，端上走默认文案');
});

test('SH6 homeLeaderboardSummary：本周有成绩就走周榜（与 leaderboard/me?period=week 同口径）', async () => {
  const me = await freshUser('rank-summary');
  await ActivityModel.create({
    userId: me.id,
    type: 'running',
    status: 'finished',
    startTime: Date.now() - 1000,
    distance: 5000,
    duration: 1800,
  });

  const summary = await homeLeaderboardSummary(me.id);
  assert.equal(summary.period, 'week', '刚才那条就在本周窗口内');
  const mine = summary.ranks.find((r) => r.type === 'running');
  assert.ok(mine, '跑步榜必须包含本人');
  assert.equal(mine!.type, 'running');
  assert.ok(mine!.rank >= 1);
});

/* ───────────── 4. regions?me=1 ───────────── */

test('SH7 leaderboard-regions 默认不带 me（老调用方零变化）', async () => {
  const me = await freshUser('regions-plain');
  const res = await get('/stats/leaderboard-regions', me.token);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json().data;
  assert.equal(typeof body.totalUsers, 'number');
  assert.equal('me' in body, false, '不传 me=1 就不该多出字段');
});

test('SH8 leaderboard-regions?me=1：一次带回总人数 + 我的名次（没上榜 period=null）', async () => {
  const me = await freshUser('regions-me');
  const res = await get('/stats/leaderboard-regions?me=1', me.token);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json().data;
  assert.equal(typeof body.totalUsers, 'number');
  assert.deepEqual(body.me, { period: null, ranks: [] }, '没跑过的人不该编一个名次');
});

test('SH9 leaderboard-regions?me=1 游客可看、me 为 null（2026-10-26 改可选鉴权）', async () => {
  const res = await get('/stats/leaderboard-regions?me=1');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.me, null, '游客无"我的榜名次"');
});

test('SH10 首页榜摘要与日历的时间窗互不影响：10 天前的成绩在月榜、不在周榜', async () => {
  const me = await freshUser('rank-window');
  await ActivityModel.create({
    userId: me.id,
    type: 'hiking',
    status: 'finished',
    startTime: Date.now() - 10 * DAY,
    distance: 8000,
    duration: 3600,
  });

  const summary = await homeLeaderboardSummary(me.id);
  // 10 天前一定在「本月」窗口内、也一定在「本周」之外（周最多 7 天）——月榜必须兜住它。
  // 若当前是月初不足 10 天，这条只可能落在上月（年窗口内）或去年（仅总榜），
  // 所以这里只钉「周榜空时不会返回空」与「周期不为周」，不写死成 month。
  assert.notEqual(summary.period, 'week', '10 天前的成绩不可能进周榜');
  assert.notEqual(summary.period, null, '月/年/总榜必有一个兜住它');
  assert.ok(summary.ranks.some((r) => r.type === 'hiking'));
});

/* ───────────── 5. 合并后的按段降级（3cb2d5e 的回归防线） ───────────── */

test('SH11 某一段挂掉只影响自己：footprint 抛错时另两段照常下发，200 不整请求失败', async () => {
  const me = await freshUser('section-fail');
  // footprint 是唯一走 UserModel.findById 的一段；打桩它＝只让这一段炸
  const orig = UserModel.findById;
  (UserModel as unknown as { findById: unknown }).findById = () => {
    throw new Error('足迹统计炸了');
  };
  try {
    const res = await get('/stats/home', me.token);
    assert.equal(res.statusCode, 200, '合并接口不能因为一段失败就整请求 500——那会把三张卡一起弄没');
    const body = res.json().data;
    assert.deepEqual(body.footprint, { ok: false, error: '足迹统计炸了' }, '失败原因要原样给端上，卡片才能点名');
    assert.equal(body.overview.ok, true, '累计数据不受影响');
    assert.equal(body.heat.ok, true, '日历不受影响');
    assert.equal(body.heat.data.data.length, 365, '日历仍是完整 365 天');
  } finally {
    (UserModel as unknown as { findById: unknown }).findById = orig;
  }
});
