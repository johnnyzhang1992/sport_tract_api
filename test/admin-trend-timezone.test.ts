/**
 * GET /admin/trend 的时间桶口径
 *
 * 这个接口是概览页「数据趋势」图的数据源，四个维度（day/week/month/year）都按 createdAt 分桶。
 * 它原先是唯一漏了 `timezone: '+08:00'` 的 trend 接口（user-trend / activity-trend /
 * footprint-trend 都有），而 $dateToString 不写 timezone 就是 **UTC 日界，与服务器时区无关**，
 * 所以下面这些用例在任何机器上都该先红：东八区凌晨 00:00:01 的记录会被归到前一天 / 上一周 /
 * 上一月 / 上一个半年。
 *
 * 只往 users 里造数：三个集合用的是同一个 idExpr，一条边界证据就够；
 * 且 dev 库始终有别人的数据，一律走差分断言。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { UserModel } from '../src/models/user.model.js';

const ADMIN_USER = 'admin_trend_tz_test';
const ADMIN_PASS = 'test123456';
const OPENID_PREFIX = /^trendtz_openid/;
const DAY = 86400000;

/** 东八区今日 0 点（epoch ms） */
const bjToday0 = () => {
  const bj = new Date(Date.now() + 8 * 3600000);
  return Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - 8 * 3600000;
};
/** epoch ms → 东八区日期串 */
const bjDateStr = (ms: number) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
/** 东八区「墙上时间」→ epoch ms */
const bjMs = (y: number, m: number, d: number, h = 0, mi = 0, s = 0) =>
  Date.UTC(y, m - 1, d, h, mi, s) - 8 * 3600000;
/** 此刻的东八区 年/月/日 */
const bjNow = () => {
  const b = new Date(Date.now() + 8 * 3600000);
  return { y: b.getUTCFullYear(), m: b.getUTCMonth() + 1, d: b.getUTCDate() };
};

let app: FastifyInstance;
let adminToken = '';
let seq = 0;

type Bucket = { date: string; newUsers: number; newActivities: number; newFootprints: number };

async function trend(type: string): Promise<Bucket[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/sport-track/api/admin/trend?type=${type}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 200);
  return res.json().data.data as Bucket[];
}

/** 造一个注册用户，createdAt 钉死在东八区的某个时刻 */
async function seedUserAt(ms: number) {
  seq += 1;
  await UserModel.create({ openid: `trendtz_openid-${seq}`, nickname: `时区测试-${seq}`, createdAt: new Date(ms) });
}

/** 取某个桶标签的计数（桶不存在就直接失败，免得把"标签算错"误报成"计数 0"） */
function pick(rows: Bucket[], label: string, field: keyof Bucket = 'newUsers') {
  const hit = rows.find((r) => r.date === label);
  assert.ok(hit, `趋势里没有桶 ${label}（实有 ${rows.slice(-3).map((r) => r.date).join('…')}）`);
  return hit[field] as number;
}

async function purge() {
  await UserModel.deleteMany({ openid: OPENID_PREFIX });
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await purge();
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
  await purge();
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

test('day：东八区今日 00:00:01 的记录归今天，不归昨天', async () => {
  const before = await trend('day');
  await seedUserAt(bjToday0() + 1000);
  const after = await trend('day');
  const today = bjDateStr(Date.now());
  const yesterday = bjDateStr(bjToday0() - DAY);
  assert.equal(pick(after, today) - pick(before, today), 1, '今天这个桶要 +1');
  assert.equal(pick(after, yesterday) - pick(before, yesterday), 0, '不该漏进昨天的桶');
});

test('day：东八区昨天 23:59:59 的记录归昨天，不归今天', async () => {
  const before = await trend('day');
  await seedUserAt(bjToday0() - 1000);
  const after = await trend('day');
  const today = bjDateStr(Date.now());
  const yesterday = bjDateStr(bjToday0() - DAY);
  assert.equal(pick(after, today) - pick(before, today), 0, '不该算进今天');
  assert.equal(pick(after, yesterday) - pick(before, yesterday), 1, '该落在昨天');
});

test('week：东八区本周一 00:00:01 归本周（末桶），不落到上一周', async () => {
  const before = await trend('week');
  // 东八区墙上时间的本周一 0 点 0 分 1 秒 —— 换成 UTC 看是上周日 16:00:01，正是串桶的地方
  const b = new Date(Date.now() + 8 * 3600000);
  const mon = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - ((b.getUTCDay() + 6) % 7) * DAY);
  await seedUserAt(bjMs(mon.getUTCFullYear(), mon.getUTCMonth() + 1, mon.getUTCDate(), 0, 0, 1));
  const after = await trend('week');
  const last = after[after.length - 1].date;
  const prev = after[after.length - 2].date;
  assert.equal(after[after.length - 1].newUsers - before[before.length - 1].newUsers, 1, `末桶 ${last} 应 +1`);
  assert.equal(after[after.length - 2].newUsers - before[before.length - 2].newUsers, 0, `不该掉进上一周 ${prev}`);
});

test('week：末桶标签必须是今天所在的真实 ISO 周（标签整体偏移一周也会被抓到）', async () => {
  const before = await trend('week');
  // 周中正午：东八区/UTC 两种日界下都落在本周，所以这条只可能因"标签算错"而失败
  await seedUserAt(bjToday0() + 12 * 3600000);
  const after = await trend('week');
  const moved = after
    .map((r, i) => ({ label: r.date, d: r.newUsers - before[i].newUsers }))
    .filter((x) => x.d !== 0);
  assert.equal(moved.length, 1, `只应有一个桶变化，实际 ${JSON.stringify(moved)}`);
  assert.equal(moved[0].label, after[after.length - 1].date, `本周记录掉进了 ${moved[0].label}`);
  assert.equal(new Set(after.map((r) => r.date)).size, after.length, '周桶标签不得重复');
});

test('month：东八区本月 1 号 00:00:01 归本月，不落到上个月', async () => {
  const { y, m } = bjNow();
  const label = `${y}-${String(m).padStart(2, '0')}`;
  const prevDate = new Date(Date.UTC(y, m - 2, 1));
  const prev = `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, '0')}`;
  const before = await trend('month');
  await seedUserAt(bjMs(y, m, 1, 0, 0, 1));
  const after = await trend('month');
  assert.equal(pick(after, label) - pick(before, label), 1, `${label} 桶应 +1`);
  assert.equal(pick(after, prev) - pick(before, prev), 0, `不该掉进 ${prev}`);
});

test('year：东八区本半年首刻归当前半年，不落到上一个半年', async () => {
  const { y, m } = bjNow();
  const inH2 = m > 6;
  const label = `${y}-${inH2 ? 'H2' : 'H1'}`;
  const prevLabel = inH2 ? `${y}-H1` : `${y - 1}-H2`;
  const startMs = inH2 ? bjMs(y, 7, 1, 0, 0, 1) : bjMs(y, 1, 1, 0, 0, 1);
  const before = await trend('year');
  await seedUserAt(startMs);
  const after = await trend('year');
  assert.equal(pick(after, label) - pick(before, label), 1, `${label} 桶应 +1`);
  assert.equal(pick(after, prevLabel) - pick(before, prevLabel), 0, `不该掉进 ${prevLabel}`);
});

test('year：东八区元旦 00:00:01 归本年 H1，不落到上一年（分组里的 %Y 也要带时区）', async () => {
  const { y } = bjNow();
  const label = `${y}-H1`;
  const prevLabel = `${y - 1}-H2`;
  const before = await trend('year');
  // 东八区元旦 0 点过 1 秒 = UTC 上一年 12-31 16:00:01，年份会整体差一年
  await seedUserAt(bjMs(y, 1, 1, 0, 0, 1));
  const after = await trend('year');
  assert.equal(pick(after, label) - pick(before, label), 1, `${label} 桶应 +1`);
  assert.equal(pick(after, prevLabel) - pick(before, prevLabel), 0, `不该掉进 ${prevLabel}`);
});

test('桶数与标签格式不变（概览页 trendLabel 按这个格式解析）', async () => {
  const cases: [string, number, RegExp][] = [
    ['day', 30, /^\d{4}-\d{2}-\d{2}$/],
    ['week', 25, /^\d{4}-W\d{2}$/],
    ['month', 12, /^\d{4}-\d{2}$/],
    ['year', 12, /^\d{4}-H[12]$/],
  ];
  for (const [type, count, re] of cases) {
    const rows = await trend(type);
    assert.equal(rows.length, count, `${type} 应有 ${count} 个桶`);
    assert.ok(rows.every((r) => re.test(r.date)), `${type} 桶标签格式变了：${rows.filter((r) => !re.test(r.date)).map((r) => r.date)}`);
  }
  // day 这条链必须连续铺到「东八区今天」，末桶就是今天（概览页今日那根柱子读的是它）
  const days = await trend('day');
  assert.equal(days[days.length - 1].date, bjDateStr(Date.now()), 'day 末桶应为东八区今天');
  assert.equal(days[days.length - 2].date, bjDateStr(Date.now() - DAY), 'day 倒数第二桶应为东八区昨天');
});

test('缺管理员凭证 → 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/sport-track/api/admin/trend?type=day' });
  assert.equal(res.statusCode, 401);
});
