/**
 * 报告页步数聚合 /werun/report：
 * - 全部时间取数据首尾；窗口 from/to 与 /overview 同口径 [from, to)；
 * - months 按月零填充，bestMonth 取月合计最大；只算本人。
 * 固定 2025-12 ~ 2026-03 的日期，避免依赖「今天」。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { WerunDayModel } from '../src/models/werun-day.model.js';

const API = '/sport-track/api';
const BJ = 8 * 3600_000;

let app: FastifyInstance;
let tokenA = '';
let userAId = '';
let userBId = '';

interface ReportData {
  startDate: string;
  endDate: string;
  overview: {
    totalStep: number; avgStep: number; bestDate: string; bestStep: number;
    syncedDays: number; days: number;
  };
  months: { month: string; step: number }[];
  bestMonth: { month: string; step: number } | null;
}

const bjStart = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) - BJ;

function get(path: string, token: string | null = tokenA) {
  return app.inject({
    method: 'GET',
    url: `${API}/werun${path}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function seed(userId: string, date: string, step: number) {
  await WerunDayModel.updateOne(
    { userId, date },
    { $set: { step, syncedAt: Date.now() } },
    { upsert: true },
  );
}

async function login(tag: string) {
  const res = await app.inject({
    method: 'POST',
    url: `${API}/auth/login`,
    payload: { code: `openid:wrrep-${tag}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data as { accessToken: string; user: { id: string } };
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  const users = await UserModel.find({ openid: /^wrrep-/ }).select('_id').lean();
  const ids = users.map((u) => u._id);
  if (ids.length) {
    await WerunDayModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  }

  const a = await login('a');
  tokenA = a.accessToken;
  userAId = a.user.id;
  const b = await login('b');
  userBId = b.user.id;

  await seed(userAId, '2025-12-30', 1000);
  await seed(userAId, '2026-01-05', 5000);
  await seed(userAId, '2026-01-20', 3000);
  await seed(userAId, '2026-02-10', 12000);
  await seed(userAId, '2026-03-01', 2000);
  await seed(userBId, '2026-02-10', 9999);
});

after(async () => {
  await WerunDayModel.deleteMany({ userId: { $in: [userAId, userBId] } });
  await UserModel.deleteMany({ _id: { $in: [userAId, userBId] } });
  await app.close();
});

test('WR-1 全部时间：首尾日期、概况、按月零填充、bestMonth', async () => {
  const res = await get('/report');
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data as ReportData;
  assert.equal(d.startDate, '2025-12-30');
  assert.equal(d.endDate, '2026-03-01');
  assert.deepEqual(d.overview, {
    totalStep: 23000,
    avgStep: 4600,
    bestDate: '2026-02-10',
    bestStep: 12000,
    syncedDays: 5,
    days: 62,
  });
  assert.deepEqual(d.months, [
    { month: '2025-12', step: 1000 },
    { month: '2026-01', step: 8000 },
    { month: '2026-02', step: 12000 },
    { month: '2026-03', step: 2000 },
  ]);
  assert.deepEqual(d.bestMonth, { month: '2026-02', step: 12000 });
});

test('WR-2 窗口 [from,to)：to 当天不纳入，月份骨架只到窗口内', async () => {
  const res = await get(`/report?from=${bjStart(2026, 1, 1)}&to=${bjStart(2026, 3, 1)}`);
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data as ReportData;
  assert.equal(d.startDate, '2026-01-01');
  assert.equal(d.endDate, '2026-02-28', 'to=3/1 是排他上界');
  assert.equal(d.overview.totalStep, 20000);
  assert.equal(d.overview.syncedDays, 3);
  assert.equal(d.overview.avgStep, 6667);
  assert.equal(d.overview.bestStep, 12000);
  assert.equal(d.overview.days, 59);
  assert.deepEqual(d.months.map((m) => [m.month, m.step]), [
    ['2026-01', 8000],
    ['2026-02', 12000],
  ]);
  assert.deepEqual(d.bestMonth, { month: '2026-02', step: 12000 });
});

test('WR-3 窗口无记录：概况全 0、月份零填充、bestMonth 为 null', async () => {
  const res = await get(`/report?from=${bjStart(2026, 4, 1)}&to=${bjStart(2026, 5, 1)}`);
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data as ReportData;
  assert.deepEqual(d.overview, {
    totalStep: 0, avgStep: 0, bestDate: '', bestStep: 0, syncedDays: 0, days: 30,
  });
  assert.deepEqual(d.months, [{ month: '2026-04', step: 0 }]);
  assert.equal(d.bestMonth, null);
});

test('WR-4 参数与鉴权：from/to 必须成对、to>from、非法数值 400；未登录 401', async () => {
  const onlyFrom = await get(`/report?from=${bjStart(2026, 1, 1)}`);
  assert.equal(onlyFrom.statusCode, 400);
  assert.match(onlyFrom.json().message, /时间范围无效/);

  const zero = await get(`/report?from=${bjStart(2026, 1, 1)}&to=${bjStart(2026, 1, 1)}`);
  assert.equal(zero.statusCode, 400);

  const bad = await get('/report?from=abc&to=def');
  assert.equal(bad.statusCode, 400);

  const noAuth = await get('/report', null);
  assert.equal(noAuth.statusCode, 401);
});

test('WR-5 只算本人：他人同一天的步数不混入', async () => {
  const res = await get(`/report?from=${bjStart(2026, 2, 1)}&to=${bjStart(2026, 3, 1)}`);
  const d = res.json().data as ReportData;
  assert.equal(d.overview.totalStep, 12000);
  assert.equal(d.overview.bestStep, 12000);
});
