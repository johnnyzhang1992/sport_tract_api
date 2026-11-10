/**
 * 运动计划（三环目标）：PUT 保存/校验、GET 当期进度与三环、周期窗口（每天/每周）、用户隔离。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/exercise-plan.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { ExercisePlanModel } from '../src/models/exercise-plan.model.js';

let app: FastifyInstance;
const NOW = Date.now();
const PREFIX = 'openid:exercise-plan';
let tokenP = '';
let tokenQ = '';
let idP = '';

async function login(openid: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/sport-track/api/auth/login', payload: { code: `openid:${openid}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.accessToken;
}

/** 东八区今天某时刻（epoch ms） */
const bjTodayAt = (hour: number) => {
  const b = new Date(NOW + 8 * 3600_000);
  return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate(), hour - 8) + 60_000;
};

async function seedActivity(o: { type: string; start: number; distance: number; duration: number }) {
  await ActivityModel.create({
    userId: idP, type: o.type, status: 'finished',
    startTime: o.start, endTime: o.start + o.duration * 1000,
    duration: o.duration, distance: o.distance, trackPoints: [], markers: [],
  });
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const olds = await UserModel.find({ openid: { $in: [`${PREFIX}_p`, `${PREFIX}_q`] } }).select('_id').lean();
  if (olds.length) {
    const ids = olds.map((u) => u._id);
    await ActivityModel.deleteMany({ userId: { $in: ids } });
    await ExercisePlanModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  }
  tokenP = await login(`${PREFIX}_p`);
  tokenQ = await login(`${PREFIX}_q`);
  const me = await app.inject({
    method: 'GET', url: '/sport-track/api/users/me',
    headers: { authorization: `Bearer ${tokenP}` },
  });
  idP = me.json().data.id;
});

after(async () => {
  const olds = await UserModel.find({ openid: { $in: [`${PREFIX}_p`, `${PREFIX}_q`] } }).select('_id').lean();
  const ids = olds.map((u) => u._id);
  await ActivityModel.deleteMany({ userId: { $in: ids } });
  await ExercisePlanModel.deleteMany({ userId: { $in: ids } });
  await UserModel.deleteMany({ _id: { $in: ids } });
  await app.close();
});

const putPlan = (body: unknown, token = tokenP) =>
  app.inject({
    method: 'PUT', url: '/sport-track/api/plan',
    headers: { authorization: `Bearer ${token}` }, payload: body as never,
  });

const getCurrent = (token = tokenP) =>
  app.inject({ method: 'GET', url: '/sport-track/api/plan/current', headers: { authorization: `Bearer ${token}` } });

test('EP1 保存与校验：全零目标 400 / 非法周期 400 / 负数 400 / 超上限 400 / 未登录 401', async () => {
  const zero = await putPlan({ period: 'daily', targets: { distanceM: 0, durationMin: 0, count: 0 } });
  assert.equal(zero.statusCode, 400);
  assert.match(zero.body, /至少设置一项/);

  assert.equal((await putPlan({ period: 'monthly', targets: { distanceM: 1000, durationMin: 30, count: 1 } })).statusCode, 400);
  assert.equal((await putPlan({ period: 'daily', targets: { distanceM: -5, durationMin: 30, count: 1 } })).statusCode, 400);
  assert.equal((await putPlan({ period: 'daily', targets: { distanceM: 600_000, durationMin: 30, count: 1 } })).statusCode, 400, '距离超 500km');
  assert.equal((await putPlan({ period: 'daily', targets: { distanceM: 3000, durationMin: 30, count: 1 } })).statusCode, 200, '合法目标可保存');

  const guest = await app.inject({ method: 'PUT', url: '/sport-track/api/plan', payload: { period: 'daily', targets: { distanceM: 1, durationMin: 1, count: 1 } } });
  assert.equal(guest.statusCode, 401);
});

test('EP2 保存成功 + 覆盖更新：同用户只有一份计划', async () => {
  const ok = await putPlan({ period: 'daily', targets: { distanceM: 5000, durationMin: 30, count: 1 } });
  assert.equal(ok.statusCode, 200, ok.body);
  const again = await putPlan({ period: 'weekly', targets: { distanceM: 20000, durationMin: 120, count: 3 } });
  assert.equal(again.statusCode, 200);

  const docs = await ExercisePlanModel.find({}).countDocuments();
  const mine = await ExercisePlanModel.findOne({ userId: idP }).lean();
  assert.equal(docs, 1, '同用户 upsert，不重复建档');
  assert.equal(mine?.period, 'weekly');
  assert.equal(mine?.targets.distanceM, 20000);
});

test('EP3 每日计划：只计今天窗口的轨迹；超额封顶 pct=1', async () => {
  await putPlan({ period: 'daily', targets: { distanceM: 4000, durationMin: 30, count: 1 } });
  // 今天两条：3km/30min + 2km/20min → 合计 5km/50min/2 次（距离与次数超额）
  await seedActivity({ type: 'running', start: bjTodayAt(8), distance: 3000, duration: 1800 });
  await seedActivity({ type: 'walking', start: bjTodayAt(10), distance: 2000, duration: 1200 });
  // 昨天的不计
  await seedActivity({ type: 'running', start: bjTodayAt(8) - 86_400_000, distance: 9999, duration: 9999 });

  const res = await getCurrent();
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  assert.equal(d.plan.period, 'daily');
  assert.equal(d.progress.distanceM, 5000);
  assert.equal(d.progress.durationSec, 3000);
  assert.equal(d.progress.count, 2);

  const byKey = Object.fromEntries(d.rings.map((r: { key: string }) => [r.key, r]));
  assert.equal(byKey.distance.pct, 1, '距离超额封顶 1');
  assert.equal(byKey.distance.value, 5000, '实际值不封顶（5km > 4km 目标）');
  assert.equal(byKey.duration.target, 1800, '时长目标换算成秒（30 分钟）');
  assert.ok(byKey.duration.pct > 1 || byKey.duration.pct === 1);
  assert.equal(byKey.count.pct, 1);
});

test('EP4 每周计划：窗口＝本周一 00:00 起；上周轨迹不计', async () => {
  await ActivityModel.deleteMany({ userId: idP }); // 清掉 EP3 的种子，隔离断言
  await putPlan({ period: 'weekly', targets: { distanceM: 20000, durationMin: 120, count: 3 } });
  // 本周一 00:30 的轨迹（一定在本周窗口内）；上周日的不计
  const monday = new Date(Date.now() + 8 * 3600_000);
  const dow = monday.getUTCDay();
  const mondayUtc = Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate()) - ((dow + 6) % 7) * 86_400_000 - 8 * 3600_000;
  await seedActivity({ type: 'cycling', start: mondayUtc + 1800_000, distance: 8000, duration: 2400 });
  await seedActivity({ type: 'running', start: mondayUtc - 3600_000, distance: 9999, duration: 3600 });

  const res = await getCurrent();
  const d = res.json().data;
  assert.equal(d.plan.period, 'weekly');
  assert.equal(d.progress.distanceM, 8000, '本周一的一条计入，上周日的不计');
  assert.equal(d.progress.count, 1);

  const byKey = Object.fromEntries(d.rings.map((r: { key: string }) => [r.key, r]));
  assert.equal(byKey.distance.pct, 0.4, '8km / 20km = 40%');
});

test('EP5 用户隔离 + 无计划：B 不可见/不影响 A；B 无计划返回 null', async () => {
  const resQ = await getCurrent(tokenQ);
  const d = resQ.json().data;
  assert.equal(d.plan, null, 'B 没建过计划');
  assert.deepEqual(d.rings, [], '无计划无环');
  assert.equal(d.progress.distanceM, 0, 'B 的进度不受 A 的轨迹影响');

  const mine = await getCurrent(tokenP);
  assert.equal(mine.json().data.plan.period, 'weekly', 'A 的计划仍在');
});
