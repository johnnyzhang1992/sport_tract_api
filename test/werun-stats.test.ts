/**
 * 微信步数个人统计：概况 / 趋势分桶 / 每日明细分页。
 * 数据落在 WerunDay(userId,date)；日期口径一律东八区。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { WerunDayModel } from '../src/models/werun-day.model.js';

const OPENID = 'wrstat_a';
let app: FastifyInstance;
let token = '';
let userId = '';

const DAY = 86_400_000;

interface TrendBucket { step: number }
interface StatsData {
  range: number;
  bucket: string;
  overview: { totalStep: number; avgStep: number; bestDate: string; bestStep: number; syncedDays: number };
  trend: TrendBucket[];
  prevOverview?: { totalStep: number; avgStep: number; bestDate: string; bestStep: number; syncedDays: number; startDate: string; endDate: string };
}
interface DayItem { date: string; step: number }
interface DaysData { total: number; items: DayItem[]; hasMore: boolean; startDate: string; endDate: string }

/** 东八区今天 − n 天，YYYY-MM-DD */
function bjDateAgo(n: number): string {
  return new Date(Date.now() - n * DAY + 8 * 3600_000).toISOString().slice(0, 10);
}

function get(path: string, withToken: string | null = token) {
  return app.inject({
    method: 'GET',
    url: `/sport-track/api/werun${path}`,
    headers: withToken ? { authorization: `Bearer ${withToken}` } : {},
  });
}

async function seed(date: string, step: number) {
  await WerunDayModel.updateOne(
    { userId, date },
    { $set: { step, syncedAt: Date.now() } },
    { upsert: true },
  );
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  // 只清本用例的用户，避免动全库（其它测试共享 dev 库）
  const old = await UserModel.findOne({ openid: OPENID }).select('_id').lean();
  if (old) {
    await WerunDayModel.deleteMany({ userId: old._id });
    await UserModel.deleteOne({ _id: old._id });
  }
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: `openid:${OPENID}` },
  });
  token = login.json().data.accessToken;
  userId = String((await UserModel.findOne({ openid: OPENID }).lean())!._id);

  await seed(bjDateAgo(0), 1000);
  await seed(bjDateAgo(1), 2000);
  await seed(bjDateAgo(6), 3000);
  await seed(bjDateAgo(10), 4000); // 7 天外、30 天内
  await seed(bjDateAgo(40), 5000); // 30 天外、半年内
  await seed(bjDateAgo(200), 6000); // 半年外、一年内
  await seed(bjDateAgo(400), 7000); // 全范围外
});

after(async () => {
  await WerunDayModel.deleteMany({ userId });
  await UserModel.deleteOne({ _id: userId });
  await app.close();
});

test('WS-1 7 日概况：合计/日均/最高单日/同步天数，趋势按日补 0', async () => {
  const res = await get('/stats?range=7');
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data as StatsData;
  assert.equal(d.range, 7);
  assert.equal(d.bucket, 'day');
  assert.equal(d.overview.totalStep, 6000);
  assert.equal(d.overview.syncedDays, 3);
  assert.equal(d.overview.avgStep, 2000);
  assert.equal(d.overview.bestStep, 3000);
  assert.equal(d.overview.bestDate, bjDateAgo(6));
  assert.equal(d.trend.length, 7, '最近 7 日每天一根柱');
  assert.deepEqual(d.trend.map((x) => x.step), [3000, 0, 0, 0, 0, 2000, 1000]);
  assert.equal(d.trend.reduce((s, x) => s + x.step, 0), 6000, '趋势合计＝概况合计');
});

test('WS-2 30/180/365 天：窗口与分桶维度随时间调整', async () => {
  const thirty = (await get('/stats?range=30')).json().data as StatsData;
  assert.equal(thirty.bucket, 'day');
  assert.equal(thirty.trend.length, 30);
  assert.equal(thirty.overview.totalStep, 10000);
  assert.equal(thirty.overview.syncedDays, 4);

  const half = (await get('/stats?range=180')).json().data as StatsData;
  assert.equal(half.bucket, 'week');
  assert.ok(half.trend.length >= 26, `半年应至少 26 个周桶，实际 ${half.trend.length}`);
  assert.equal(half.overview.totalStep, 15000);
  assert.equal(half.trend.reduce((s, x) => s + x.step, 0), 15000);

  const year = (await get('/stats?range=365')).json().data as StatsData;
  assert.equal(year.bucket, 'month');
  assert.ok(year.trend.length >= 12, `一年应至少 12 个月桶，实际 ${year.trend.length}`);
  assert.equal(year.overview.totalStep, 21000);
  assert.equal(year.trend.reduce((s, x) => s + x.step, 0), 21000);
  assert.equal(year.overview.bestStep, 6000);
});

test('WS-3 每日明细：倒序 + 分页，只列有同步记录的天', async () => {
  const p1 = (await get('/days?range=7&page=1&pageSize=2')).json().data as DaysData;
  assert.equal(p1.total, 3);
  assert.deepEqual(p1.items.map((x) => [x.date, x.step]), [
    [bjDateAgo(0), 1000],
    [bjDateAgo(1), 2000],
  ]);
  assert.equal(p1.hasMore, true);

  const p2 = (await get('/days?range=7&page=2&pageSize=2')).json().data as DaysData;
  assert.deepEqual(p2.items.map((x) => [x.date, x.step]), [[bjDateAgo(6), 3000]]);
  assert.equal(p2.hasMore, false);

  const wide = (await get('/days?range=365&page=1&pageSize=100')).json().data as DaysData;
  assert.equal(wide.total, 6, '400 天前那条不在一年窗口');
  assert.deepEqual(wide.items.map((x) => x.step), [1000, 2000, 3000, 4000, 5000, 6000]);
});

test('WS-5 compare=1：下发紧邻的前一个同长度窗口，供趋势变化卡对比', async (t) => {
  const d1 = bjDateAgo(35);
  const d2 = bjDateAgo(45);
  await seed(d1, 8000);
  await seed(d2, 9000);
  t.after(async () => {
    await WerunDayModel.deleteMany({ userId, date: { $in: [d1, d2] } });
  });

  const withPrev = (await get('/stats?range=30&compare=1')).json().data as StatsData;
  assert.equal(withPrev.prevOverview?.totalStep, 22000, '前 30 天：-40 的 5000 + -35 的 8000 + -45 的 9000');
  assert.equal(withPrev.prevOverview?.syncedDays, 3);
  assert.equal(withPrev.prevOverview?.bestStep, 9000);
  assert.equal(withPrev.prevOverview?.startDate, bjDateAgo(59));
  assert.equal(withPrev.prevOverview?.endDate, bjDateAgo(30));

  const plain = (await get('/stats?range=30')).json().data as StatsData;
  assert.equal(plain.prevOverview, undefined, '不传 compare 不多算一个窗口');
});

test('WS-6 明细 range=all：不限窗口、倒序分页，包含一年外记录', async () => {
  const all = (await get('/days?range=all&page=1&pageSize=100')).json().data as DaysData;
  assert.equal(all.total, 7, '7 条同步记录全部纳入，含 400 天前');
  assert.deepEqual(all.items.map((x) => x.step), [1000, 2000, 3000, 4000, 5000, 6000, 7000]);
  assert.equal(all.startDate, bjDateAgo(400), '首尾按数据实际范围');
  assert.equal(all.endDate, bjDateAgo(0));

  const p1 = (await get('/days?range=all&page=1&pageSize=2')).json().data as DaysData;
  assert.deepEqual(p1.items.map((x) => x.step), [1000, 2000]);
  assert.equal(p1.hasMore, true);
  // 起止日期描述的是**整个数据集**，不随 pageSize/页码变
  assert.equal(p1.startDate, all.startDate, '换 pageSize 也不能改 startDate');
  assert.equal(p1.endDate, all.endDate, '换 pageSize 也不能改 endDate');
  const p4 = (await get('/days?range=all&page=4&pageSize=2')).json().data as DaysData;
  assert.deepEqual(p4.items.map((x) => x.step), [7000]);
  assert.equal(p4.hasMore, false);
});

test('WS-4 参数与鉴权：非法 range 400，未登录 401', async () => {
  const bad = await get('/stats?range=14');
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().message, /7|30|180|365/);

  const noAuth = await get('/stats?range=7', null);
  assert.equal(noAuth.statusCode, 401);
  assert.match(noAuth.json().message, /登录/);
});

test('WS-7 深翻页闸门：skip 超上限直接 400（range=all 的 total 会随年限增长）', async () => {
  // 页 251 × 每页 20 = skip 5000 → 恰好等于上限，放行
  const edge = await get('/days?range=all&page=251&pageSize=20');
  assert.equal(edge.statusCode, 200, edge.body);
  // 再多一页就拒：不让服务端替调用方空转几十万行
  const deep = await get('/days?range=all&page=252&pageSize=20');
  assert.equal(deep.statusCode, 400);
  assert.match(deep.json().message, /翻页过深/);
  assert.match(deep.json().message, /5000/);
});
