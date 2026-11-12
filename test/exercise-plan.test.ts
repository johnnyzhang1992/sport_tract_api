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
import { bjDateStr, bjIsoWeekStart } from '../src/utils/bj-time.js';

let app: FastifyInstance;
const NOW = Date.now();
const PREFIX = 'openid:exercise-plan';
let tokenP = '';
let tokenQ = '';
let idP = '';
let idQ = '';

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

async function seedActivity(o: { type: string; start: number; distance: number; duration: number }, userId = idP) {
  await ActivityModel.create({
    userId, type: o.type, status: 'finished',
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
  const meQ = await app.inject({
    method: 'GET', url: '/sport-track/api/users/me',
    headers: { authorization: `Bearer ${tokenQ}` },
  });
  idQ = meQ.json().data.id;
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

  const docs = await ExercisePlanModel.countDocuments({ userId: idP });
  const mine = await ExercisePlanModel.findOne({ userId: idP }).lean();
  assert.equal(docs, 1, '同用户 upsert，不重复建档（共享库里有其他用户的计划，只数自己）');
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

test('EP6 改计划不追溯：改目标后进度不倒退，之后新增照常累加', async () => {
  await ActivityModel.deleteMany({ userId: idP });
  // 先建每天计划 10km，并跑一条 4km（相当于今天已完成 4km）
  await putPlan({ period: 'daily', targets: { distanceM: 10000, durationMin: 60, count: 2 } });
  const today = bjTodayAt(9);
  await seedActivity({ type: 'running', start: today, distance: 4000, duration: 1800 });

  const before = (await getCurrent()).json().data;
  assert.equal(before.progress.distanceM, 4000);
  const pctBefore = before.rings.find((r: { key: string }) => r.key === 'distance').pct;
  assert.ok(Math.abs(pctBefore - 0.4) < 1e-9, '4km/10km = 40%');

  // 中途把目标改成 5km（比当前已完成的大一点）：已完成的 4km 不能被新目标「追溯」改掉
  await putPlan({ period: 'daily', targets: { distanceM: 5000, durationMin: 60, count: 2 } });
  const after = (await getCurrent()).json().data;
  assert.equal(after.progress.distanceM, 4000, '改动前的 4km 仍然计入');
  assert.ok(
    Math.abs(after.rings.find((r: { key: string }) => r.key === 'distance').pct - 0.8) < 1e-9,
    '新目标 5km 下 4km = 80%（按新目标重算比例，但进度值不丢）',
  );

  // 改动之后新增的轨迹照常累加
  await seedActivity({ type: 'running', start: Date.now() - 60_000, distance: 3000, duration: 1200 });
  const later = (await getCurrent()).json().data;
  assert.equal(later.progress.distanceM, 7000, '基线 4km + 改动后 3km');
});

test('EP7 基线不跨周期：换天后按新窗口全量重算', async () => {
  await ActivityModel.deleteMany({ userId: idP });
  await putPlan({ period: 'daily', targets: { distanceM: 5000, durationMin: 60, count: 1 } });
  await seedActivity({ type: 'running', start: bjTodayAt(8), distance: 2000, duration: 900 });

  const now = (await getCurrent()).json().data;
  assert.equal(now.progress.distanceM, 2000);

  // 直接读库确认基线被写在本窗口起点上；模拟「到了第二天」→ 用明天的时刻查询，基线应失效
  const doc = await ExercisePlanModel.findOne({ userId: idP }).lean();
  assert.ok(doc && doc.baselineWindowStart > 0, '保存时写了基线窗口起点');
  const tomorrow = Date.now() + 86_400_000;
  const { getPlanWithProgress } = await import('../src/services/exercise-plan.js');
  const next = await getPlanWithProgress(idP, tomorrow);
  assert.equal(next.progress.distanceM, 0, '新的一天没有轨迹 → 进度 0（不沿用昨天的基线）');
});

test('EP8 下限语义：改动后即便轨迹被作废，进度也不会低于改动那一刻的成绩', async () => {
  await ActivityModel.deleteMany({ userId: idP });
  await putPlan({ period: 'daily', targets: { distanceM: 10000, durationMin: 60, count: 2 } });
  const a = await ActivityModel.create({
    userId: new (await import('mongoose')).default.Types.ObjectId(idP),
    type: 'running', status: 'finished',
    startTime: bjTodayAt(7), endTime: bjTodayAt(7) + 1800_000,
    duration: 1800, distance: 6000, trackPoints: [], markers: [],
  });
  // 改计划：此刻已 6km → 基线 6km
  await putPlan({ period: 'daily', targets: { distanceM: 8000, durationMin: 60, count: 2 } });
  assert.equal((await getCurrent()).json().data.progress.distanceM, 6000);

  // 把那条轨迹作废：真实合计变 0，但进度不倒退（基线兜底）
  await ActivityModel.updateOne({ _id: a._id }, { $set: { status: 'cancelled' } });
  assert.equal((await getCurrent()).json().data.progress.distanceM, 6000, '已完成的成绩不因后续作废而倒退');
});

test('EP9 当期达成旗标：periodKey 为东八区周期键；三项都达标才 allAchieved', async () => {
  await putPlan({ period: 'daily', targets: { distanceM: 1000, durationMin: 10, count: 2 } }, tokenQ);
  await seedActivity({ type: 'running', start: bjTodayAt(9), distance: 2000, duration: 1200 }, idQ);
  let d = (await getCurrent(tokenQ)).json().data;
  assert.equal(d.periodKey, bjDateStr(NOW), '日计划 periodKey=东八区今天');
  assert.equal(d.allAchieved, false, '次数未达标（1/2）');

  await seedActivity({ type: 'walking', start: bjTodayAt(11), distance: 100, duration: 60 }, idQ);
  d = (await getCurrent(tokenQ)).json().data;
  assert.equal(d.allAchieved, true, '三项都达标');

  // 周计划：periodKey=东八区本周一
  await ActivityModel.deleteMany({ userId: idQ });
  await putPlan({ period: 'weekly', targets: { distanceM: 1000, durationMin: 10, count: 1 } }, tokenQ);
  await seedActivity({ type: 'running', start: bjTodayAt(12), distance: 2000, duration: 1200 }, idQ);
  d = (await getCurrent(tokenQ)).json().data;
  assert.equal(d.periodKey, bjDateStr(bjIsoWeekStart(NOW)), '周计划 periodKey=本周一');
  assert.equal(d.allAchieved, true);
});
