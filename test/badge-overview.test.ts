/**
 * 「我的徽章」总览接口（2026-11-16）：GET /plan/badges
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test test/badge-overview.test.ts
 *
 * 守的承诺：
 *   - 计划页/我的徽章页**同源**：同一座徽章两处结论（解锁态/名次）必须一致
 *   - 分类齐全：plan=运动计划（15 座）、data=运动数据（104 座），合计 119
 *   - 分运动类型徽章按类型生成（5 类型 × 3 维度 × 3 档 = 45）
 *   - 无数据用户不炸（全灰但分类结构完整）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { ExercisePlanPeriodModel } from '../src/models/exercise-plan-period.model.js';

const API = '/sport-track/api';
const DAY = 86_400_000;
let app: FastifyInstance;
let token = '';
let tokenEmpty = '';

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const users = await UserModel.find({ openid: /^bov-/ }).select('_id');
  const ids = users.map((u) => u._id);
  await ActivityModel.deleteMany({ userId: { $in: ids } });
  await ExercisePlanPeriodModel.deleteMany({ userId: { $in: ids } });
  await UserModel.deleteMany({ _id: { $in: ids } });

  const login = await app.inject({ method: 'POST', url: `${API}/auth/login`, payload: { code: 'openid:bov-a' } });
  token = login.json().data.accessToken;
  const empty = await app.inject({ method: 'POST', url: `${API}/auth/login`, payload: { code: 'openid:bov-empty' } });
  tokenEmpty = empty.json().data.accessToken;

  const user = await UserModel.findOne({ openid: 'bov-a' });
  const base = Date.now() - 40 * DAY;
  // 跑步 40 次（每次 10km / 1h）+ 骑行 30 次（每次 60km / 2h）→ 分类型徽章可解锁
  const acts = [] as Record<string, unknown>[];
  for (let i = 0; i < 40; i++) {
    acts.push({
      userId: user!._id, type: 'running', status: 'finished',
      startTime: base + i * DAY, endTime: base + i * DAY + 3600_000,
      duration: 3600, distance: 10_000, trackPoints: [], markers: [],
    });
  }
  for (let i = 0; i < 30; i++) {
    acts.push({
      userId: user!._id, type: 'cycling', status: 'finished',
      startTime: base + i * DAY + 7200_000, endTime: base + i * DAY + 7200_000 + 7200_000,
      duration: 7200, distance: 60_000, trackPoints: [], markers: [],
    });
  }
  await ActivityModel.insertMany(acts);
});

after(async () => {
  const users = await UserModel.find({ openid: /^bov-/ }).select('_id');
  const ids = users.map((u) => u._id);
  await ActivityModel.deleteMany({ userId: { $in: ids } });
  await ExercisePlanPeriodModel.deleteMany({ userId: { $in: ids } });
  await UserModel.deleteMany({ _id: { $in: ids } });
  await app.close();
});

async function overview(t = token) {
  const res = await app.inject({ method: 'GET', url: `${API}/plan/badges`, headers: { authorization: `Bearer ${t}` } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data;
}

test('BO1 需登录', async () => {
  const res = await app.inject({ method: 'GET', url: `${API}/plan/badges` });
  assert.equal(res.statusCode, 401);
});

test('BO2 全量 119 座，分类数量正确（计划 15 / 数据 104）', async () => {
  const d = await overview();
  assert.equal(d.total, 119);
  assert.equal(d.trophies.length, 119);
  const plan = d.categories.find((c: any) => c.key === 'plan');
  const data = d.categories.find((c: any) => c.key === 'data');
  assert.equal(plan.total, 15, '计划类 = 里程碑7 + 合环4（去掉 2000 档）+ 完美周4');
  assert.equal(data.total, 104, '数据类 = 新纪录8 + 最坚持4 + 累计12 + 分类型80');
  assert.equal(plan.total + data.total, d.total);
});

test('BO3 每个徽章都有 category，且与分组分类一致', async () => {
  const d = await overview();
  for (const t of d.trophies) {
    assert.ok(t.category === 'plan' || t.category === 'data', `${t.key} category 非法`);
  }
  const planGroups = new Set(['plan', 'rings', 'week']);
  for (const t of d.trophies) {
    assert.equal(t.category, planGroups.has(t.group) ? 'plan' : 'data', `${t.key} 分类与分组不符`);
  }
});

test('BO4 分组统计与实际徽章数对得上', async () => {
  const d = await overview();
  const sumTotal = d.groups.reduce((a: number, g: any) => a + g.total, 0);
  const sumEarned = d.groups.reduce((a: number, g: any) => a + g.earned, 0);
  assert.equal(sumTotal, d.total, '分组总数应等于总徽章数');
  assert.equal(sumEarned, d.earned, '分组已获得数应等于总已获得数');
});

test('BO5 分运动类型：5 类型 × (距离6+时长4+次数6) = 80 座，key 带类型前缀', async () => {
  const d = await overview();
  const typed = d.trophies.filter((t: any) => t.activityLabel);
  assert.equal(typed.length, 80);
  for (const prefix of ['walk', 'run', 'hike', 'ride', 'climb']) {
    const n = typed.filter((t: any) => t.key.startsWith(`${prefix}-`)).length;
    assert.equal(n, 16, `${prefix} 应有 16 座（距离6 + 时长4 + 次数6）`);
  }
  for (const t of typed) assert.ok(t.shortLabel && t.groupTitle === '分运动类型', `${t.key} 展示字段缺失`);
});

test('BO6 计划页与我的徽章页同源：同一座徽章解锁态一致', async () => {
  const ov = await overview();
  const sum = await app.inject({ method: 'GET', url: `${API}/plan/summary`, headers: { authorization: `Bearer ${token}` } });
  const byKey = new Map(sum.json().data.trophies.map((t: any) => [t.key, t]));
  for (const t of ov.trophies) {
    const s: any = byKey.get(t.key);
    assert.ok(s, `${t.key} 在 summary 里缺失`);
    assert.equal(t.unlocked, s.unlocked, `${t.key} 两处解锁态不一致`);
    assert.equal(t.rank, s.rank, `${t.key} 两处名次不一致`);
  }
});

test('BO7 跑步/骑行分类型徽章按类型正确解锁（不串类型）', async () => {
  const d = await overview();
  const get = (k: string) => d.trophies.find((t: any) => t.key === k);
  // 档位 2026-11-16 调整为 100/500/1000/2000/5000/10000（50 档已去掉）
  // 跑步：40 次 × 10km = 400km → 100 解锁，500/1000 未解锁
  assert.equal(get('run-dist-100').unlocked, true, '跑步 400km 应解锁 100km');
  assert.equal(get('run-dist-500').unlocked, false, '跑步 400km 不应解锁 500km');
  assert.equal(get('run-dist-1000').unlocked, false, '跑步 400km 不应解锁 1000km');
  // 骑行：30 次 × 60km = 1800km → 100/500/1000 解锁，2000 未解锁
  assert.equal(get('ride-dist-100').unlocked, true, '骑行 1800km 应解锁 100km');
  assert.equal(get('ride-dist-1000').unlocked, true, '骑行 1800km 应解锁 1000km');
  assert.equal(get('ride-dist-2000').unlocked, false, '骑行 1800km 不应解锁 2000km');
  // 50 档已移除，不应再下发
  assert.equal(get('run-dist-50'), undefined, 'run-dist-50 应已移除');
  // 没动过的类型一律不解锁（不串类型）
  assert.equal(get('climb-dist-100').unlocked, false, '没爬山不应解锁爬山徽章');
  assert.equal(get('walk-dist-100').unlocked, false, '没散步不应解锁散步徽章');
});

test('BO8 分类型累计值正确（跑步/骑行各自的概览）', async () => {
  const d = await overview();
  const run = d.activityTypes.find((x: any) => x.type === 'running');
  const ride = d.activityTypes.find((x: any) => x.type === 'cycling');
  assert.ok(run && ride, '应有两个类型的概览');
  assert.equal(run.count, 40);
  assert.equal(run.distanceM, 400_000);
  assert.equal(ride.count, 30);
  assert.equal(ride.distanceM, 1_800_000);
  assert.equal(run.label, '跑步');
  assert.equal(ride.label, '骑行');
});

test('BO9 无数据用户：结构完整、全灰、不炸', async () => {
  const d = await overview(tokenEmpty);
  assert.equal(d.total, 119);
  assert.equal(d.earned, 0);
  assert.deepEqual(d.activityTypes, []);
  assert.equal(d.categories.length, 2);
  for (const t of d.trophies) assert.equal(t.unlocked, false);
});
/* ───────────── 轻量计数接口（2026-11-16）：「我的」页角标不再跑完整 summary ───────────── */

test('BO-C1 /plan/badges/count：需登录；返回 earned/total 且与 /plan/badges 一致', async () => {
  const guest = await app.inject({ method: 'GET', url: `${API}/plan/badges/count` });
  assert.equal(guest.statusCode, 401, '未登录 401');

  const res = await app.inject({
    method: 'GET', url: `${API}/plan/badges/count`, headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const count = res.json().data;
  assert.equal(typeof count.earned, 'number');
  assert.equal(typeof count.total, 'number');

  const full = await app.inject({
    method: 'GET', url: `${API}/plan/badges`, headers: { authorization: `Bearer ${token}` },
  });
  const overview = full.json().data;
  assert.equal(count.earned, overview.earned, '与总览的 earned 必须一致（同源计算）');
  assert.equal(count.total, overview.total, '总数一致');
});

test('BO-C2 无数据用户：earned=0、total 照常（全灰但结构完整）', async () => {
  const res = await app.inject({
    method: 'GET', url: `${API}/plan/badges/count`, headers: { authorization: `Bearer ${tokenEmpty}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const c = res.json().data;
  assert.equal(c.earned, 0);
  assert.ok(c.total > 0, `总数应为全部徽章，实际 ${c.total}`);
});
