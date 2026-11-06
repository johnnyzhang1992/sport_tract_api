import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { WerunDayModel } from '../src/models/werun-day.model.js';
import { LoginLogModel } from '../src/models/login-log.model.js';

let app: FastifyInstance;
let tokenA = '';
let userIdA = '';
const OPENIDS = ['wrboard_a', 'wrboard_b', 'wrboard_c', 'wrboard_d'];

/** 东八区当天零点（秒）→ 与微信 stepInfoList 同口径 */
function bjMidnightSec(dateStr: string): number {
  return Math.floor(new Date(`${dateStr}T00:00:00+08:00`).getTime() / 1000);
}

/** 东八区今天 YYYY-MM-DD */
function bjToday(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86_400_000 + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 本周一（东八区）YYYY-MM-DD */
function bjMonday(offsetWeeks = 0): string {
  const d = new Date(Date.now() + 8 * 3600_000);
  const dow = d.getUTCDay();
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((dow + 6) % 7) * 86_400_000;
  return new Date(monday + offsetWeeks * 7 * 86_400_000).toISOString().slice(0, 10);
}

function board(query: string, withToken: string | null = tokenA) {
  return app.inject({
    method: 'GET',
    url: `/sport-track/api/werun/board${query}`,
    headers: withToken ? { authorization: `Bearer ${withToken}` } : {},
  });
}

async function addDays(openid: string, entries: { date: string; step: number }[]) {
  const user = await UserModel.findOne({ openid });
  const uid = user!._id;
  for (const e of entries) {
    await WerunDayModel.updateOne(
      { userId: uid, date: e.date },
      { $set: { step: e.step, syncedAt: Date.now() } },
      { upsert: true },
    );
  }
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  await WerunDayModel.deleteMany({});
  await LoginLogModel.deleteMany({ userId: { $exists: true }, province: { $in: ['广东省', '浙江省', '河北省'] } });
  const users = await UserModel.find({ openid: { $in: OPENIDS.map((o) => `${o}`) } }).select('_id');
  await UserModel.deleteMany({ _id: { $in: users.map((u) => u._id) } });

  // 三个用户各带省份（最近一次登录日志）+ A 登录拿 token
  const tokenOf = async (openid: string) => {
    const res = await app.inject({ method: 'POST', url: '/sport-track/api/auth/login', payload: { code: `openid:${openid}` } });
    return res.json().data.accessToken;
  };
  tokenA = await tokenOf('wrboard_a');
  await tokenOf('wrboard_b'); // 登录即建档：b/c 也要先有用户，下面才能挂省份日志
  await tokenOf('wrboard_c');
  const userA = await UserModel.findOne({ openid: 'wrboard_a' });
  userIdA = String(userA!._id);
  for (const [openid, province] of [
    ['wrboard_a', '广东省'],
    ['wrboard_b', '广东省'],
    ['wrboard_c', '浙江省'],
  ] as const) {
    const u = await UserModel.findOne({ openid });
    // createdAt 显式放到未来：登录本身会异步补写一条 province=null 的登录日志（locateByIp 后置落库），
    // 种子日志必须是这些用户「最新」的一条，省份口径才不被冲掉
    await LoginLogModel.create({ userId: u!._id, ip: '127.0.0.1', province, city: '', createdAt: new Date(Date.now() + 3600_000) });
  }

  // 步数种子（断言的期望值全部由 test/fixtures 里同一套日期运算推出，任何一天跑都成立）：
  //   A：今天 3000 / 本月 1 号 40000（月榜锚点，月窗口必含）/ 上周一 7000（上周标记）
  //   B：今天 5000 / 本周一 10000（本周窗口必含）
  //   C：今天 8000
  await addDays('wrboard_a', [
    { date: bjToday(0), step: 3000 },
    { date: monthFirst(), step: 40000 },
    { date: bjMonday(-1), step: 7000 },
  ]);
  await addDays('wrboard_b', [
    { date: bjToday(0), step: 5000 },
    { date: bjMonday(0), step: 10000 },
  ]);
  await addDays('wrboard_c', [{ date: bjToday(0), step: 8000 }]);
});

/** 东八区本月 1 号 */
function monthFirst(): string {
  return `${bjToday(0).slice(0, 7)}-01`;
}

/** 各用户「今日」步数的期望值（B 的周一种子恰逢今天时，今天的日榜也会含它） */
function expectedTodaySteps() {
  const today = bjToday(0);
  const mondayThis = bjMonday(0);
  const aDay = 3000 + (monthFirst() === today ? 40000 : 0);
  const bDay = 5000 + (mondayThis === today ? 10000 : 0);
  return { today, mondayThis, aDay, bDay, cDay: 8000 };
}

after(async () => {
  await WerunDayModel.deleteMany({});
  await LoginLogModel.deleteMany({ province: { $in: ['广东省', '浙江省'] } });
  const users = await UserModel.find({ openid: { $in: OPENIDS.map((o) => `${o}`) } }).select('_id');
  await UserModel.deleteMany({ _id: { $in: users.map((u) => u._id) } });
  await app.close();
});

test('WB1 日榜：步数降序、全国口径、带用户资料与我的排名', async () => {
  const { aDay, bDay, cDay } = expectedTodaySteps();
  const res = await board('?period=day');
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  assert.equal(d.period, 'day');
  assert.equal(d.province, '全国');
  assert.equal(d.players, 3);
  const expected = [aDay, bDay, cDay].sort((x, y) => y - x);
  assert.deepEqual(d.top.map((r: { step: number }) => r.step), expected, '按步数降序');
  assert.ok(d.top[0].name.length > 0, '昵称来自用户资料');
  assert.equal(d.me.step, aDay, 'A 的今日步数与种子推算一致');
  assert.equal(d.me.rank, expected.indexOf(aDay) + 1, '我的排名与步数位次一致');
  assert.ok(d.window, '日榜应有当期窗口');
  assert.ok(d.window.text.includes('年'), '窗口文案形如 2026年11月6日');
  assert.ok(d.prevPeriodKey, '上一期恒有');
  assert.equal(d.nextPeriodKey, null, '今天的下一期不存在');
});

test('WB2 周榜：跨天求和、历史周用 periodKey 翻页', async () => {
  const { mondayThis } = expectedTodaySteps();
  const mondayLast = bjMonday(-1);
  const monthFirstKey = monthFirst();
  // A 本周 = 今天 3000 + （本月 1 号若落在本周内的 40000）；B 本周 = 5000 + 10000（周一种子必在本周窗口）
  const aThisWeek = 3000 + (monthFirstKey >= mondayThis ? 40000 : 0);
  const thisWeek = await board('?period=week');
  const d = thisWeek.json().data;
  assert.equal(d.players, 3);
  const bRow = d.top.find((r: { step: number }) => r.step === 15000);
  assert.ok(bRow, 'B 本周 = 今天 5000 + 本周一 10000 跨天求和');
  assert.equal(d.me.step, aThisWeek, 'A 本周合计与种子推算一致');

  // 历史周：A 上周一标记 7000 必在；本月 1 号落在 [上周一, 本周一) 时 A 还有 40000 也在上周（两条都是 A，人数不变）
  const inLastWeek = monthFirstKey >= mondayLast && monthFirstKey < mondayThis;
  const aLastWeek = 7000 + (inLastWeek ? 40000 : 0);
  const lastWeek = await board(`?period=week&periodKey=${mondayLast}`);
  const lw = lastWeek.json().data;
  assert.equal(lw.players, 1, '上周只有 A 一人有数据');
  assert.ok(lw.top.find((r: { step: number }) => r.step === aLastWeek), `A 上周合计应为 ${aLastWeek}`);
  assert.ok(lw.nextPeriodKey, '历史周存在下一期翻页键');
});

test('WB3 月榜：本月合计含月锚点与今日；年榜窗口', async () => {
  const monthFirstKey = monthFirst();
  const mondayThis = bjMonday(0);
  // A 本月 = 1 号 40000 + 今天 3000 + （上周一标记若也落在本月内再 +7000）
  const mondayLast = bjMonday(-1);
  const aMonth = 40000 + 3000 + (mondayLast >= monthFirstKey && mondayLast < mondayThis ? 7000 : 0);
  const month = await board('?period=month');
  const m = month.json().data;
  assert.ok(
    m.top.find((r: { step: number }) => r.step === aMonth),
    `A 本月合计应为 ${aMonth}`,
  );
  assert.match(m.window.text, /^\d{4}年\d+月$/, '月榜文案形如 2026年11月');

  const year = await board('?period=year');
  assert.equal(year.statusCode, 200);
  assert.match(year.json().data.window.text, /^\d{4}年$/, '年榜文案形如 2026年');
});

test('WB4 省份过滤：默认全国；指定省份只出该省用户；无数据省份空榜', async () => {
  const { aDay, bDay, cDay } = expectedTodaySteps();
  const gd = await board('?period=day&province=' + encodeURIComponent('广东省'));
  const g = gd.json().data;
  assert.equal(g.players, 2, '广东省只有 A/B（按最近登录省份口径）');
  assert.deepEqual(g.top.map((r: { step: number }) => r.step), [bDay, aDay].sort((x, y) => y - x));

  const empty = await board('?period=day&province=' + encodeURIComponent('河北省'));
  const e = empty.json().data;
  assert.equal(e.players, 0);
  assert.deepEqual(e.top, []);
  assert.equal(e.me, null, 'A 不在河北省，me 为 null');
});

test('WB5 TOP50 上限：52 人有步数时只出前 50，players 仍为 52，me 在 51 名也返回真实排名', async () => {
  // 造 49 个新用户（加原 3 个 = 52），步数都比 A 高
  const now = Date.now();
  for (let i = 0; i < 49; i++) {
    // login 的 code 带 'openid:' 前缀，落库的 openid 是去前缀的裸值（mock 口径）
    const code = `openid:wrboard_pad_${i}`;
    await app.inject({ method: 'POST', url: '/sport-track/api/auth/login', payload: { code } });
    const u = await UserModel.findOne({ openid: `wrboard_pad_${i}` });
    await WerunDayModel.updateOne(
      { userId: u!._id, date: bjToday(0) },
      { $set: { step: 10000 + i, syncedAt: now } },
      { upsert: true },
    );
  }
  const res = await board('?period=day');
  const d = res.json().data;
  assert.equal(d.players, 52);
  assert.equal(d.top.length, 50, '榜单只出 50 名');
  assert.equal(d.top[0].rank, 1);
  assert.equal(d.top.at(-1).rank, 50);
  assert.ok(d.me, 'A 有步数必有真实排名');
  assert.ok(d.me.rank > 50, `A 步数垫底，排名应 > 50，实际 ${d.me.rank}`);
  // 清理垫底用户，避免影响其他文件（独立 openid 前缀也做了隔离）
  const padUsers = await UserModel.find({ openid: /^wrboard_pad_/ }).select('_id');
  await WerunDayModel.deleteMany({ userId: { $in: padUsers.map((u) => u._id) } });
  await UserModel.deleteMany({ _id: { $in: padUsers.map((u) => u._id) } });
});

test('WB6 游客可看榜：me 为 null；非法周期键 400', async () => {
  const guest = await board('?period=day', null);
  assert.equal(guest.statusCode, 200);
  assert.equal(guest.json().data.me, null);
  assert.equal(guest.json().data.players, 3);

  const badKey = await board('?period=week&periodKey=2026-11-08'); // 周日，不是周一
  assert.equal(badKey.statusCode, 400);
  assert.match(badKey.json().message, /周一/);

  const badPeriod = await board('?period=all');
  assert.equal(badPeriod.statusCode, 400);
  assert.match(badPeriod.json().message, /周期不合法/);
});

test('WB7 省份选择器：来自登录日志省份（人数降序），广东省在列', async () => {
  const res = await app.inject({ method: 'GET', url: '/sport-track/api/werun/board-provinces' });
  assert.equal(res.statusCode, 200);
  const provinces = res.json().data.provinces;
  const gd = provinces.find((p: { name: string }) => p.name === '广东省');
  assert.ok(gd, '广东省应在列');
  assert.equal(gd.users, 2);
});
