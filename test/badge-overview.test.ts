/**
 * 「我的徽章」总览接口（2026-11-16）：GET /plan/badges
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test test/badge-overview.test.ts
 *
 * 守的承诺：
 *   - 计划页/我的徽章页**同源**：同一座徽章两处结论（解锁态/名次）必须一致
 *   - 分类齐全：plan=运动计划（15 座）、data=运动数据（96 座），合计 111
 *     （2026-11-17 去掉「新纪录」整组 8 座，数据类 104 → 96）
 *   - 分运动类型徽章按类型生成（5 类型 × 3 维度 × 3 档 = 45）
 *   - 无数据用户不炸（全灰但分类结构完整）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { streakDetailText, streakHistoryLines } from '../src/services/exercise-plan.js';
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

test('BO2 全量 111 座，分类数量正确（计划 15 / 数据 96）', async () => {
  const d = await overview();
  assert.equal(d.total, 111);
  assert.equal(d.trophies.length, 111);
  const plan = d.categories.find((c: any) => c.key === 'plan');
  const data = d.categories.find((c: any) => c.key === 'data');
  assert.equal(plan.total, 15, '计划类 = 里程碑7 + 合环4（去掉 2000 档）+ 完美周4');
  assert.equal(data.total, 96, '数据类 = 最坚持4 + 累计12 + 分类型80（新纪录已下线）');
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

test('BO10 不变式：已解锁徽章必须有 rank ≥ 1，且两句获得信息齐全（2026-11-17 拆两句）', async () => {
  const d = await overview();
  const unlocked = d.trophies.filter((t: any) => t.unlocked);
  assert.ok(unlocked.length > 0, '前置条件：该用户应有已解锁徽章');
  for (const t of unlocked) {
    assert.ok(t.rank >= 1, `${t.key} 已解锁但 rank=${t.rank}（会出现「已解锁却没有名次」的卡面）`);
    // 第一段：获得时间（只到年月）
    assert.match(t.earnedText, /^\d{4}年\d{1,2}月$/, `${t.key} earnedText 应是年月：${t.earnedText}`);
    // 第一句的后半段：名次
    assert.match(t.rankText, /^第 \d+ 位获得此徽章的迹路者$/, `${t.key} rankText 格式不对：${t.rankText}`);
    assert.ok(t.rankText.includes(`第 ${t.rank} 位`), `${t.key} rankText 里的名次应与 rank 一致`);
    // 第二句：总人数（单独一句）
    assert.match(t.totalText, /^\d+ 位迹路者获得$/, `${t.key} totalText 格式不对：${t.totalText}`);
    assert.ok(t.totalText.includes(String(t.rankTotal)), `${t.key} totalText 里的总数应与 rankTotal 一致`);
  }
});

test('BO11 earnedText 只到年月，不含具体日（隐私 + 用户要求）', async () => {
  const d = await overview();
  const t = d.trophies.find((x: any) => x.unlocked);
  assert.ok(t, '需要一个已解锁徽章');
  assert.ok(!/\d{4}年\d{1,2}月\d{1,2}日/.test(t.earnedText), '不应出现「日」');
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(t.earnedText), '不应出现 YYYY-MM-DD');
});

test('BO12 未解锁徽章：只有 totalText「N 位迹路者获得」，没有年月与名次句', async () => {
  const d = await overview();
  const locked = d.trophies.filter((t: any) => !t.unlocked);
  assert.ok(locked.length > 0, '前置条件：应有未解锁徽章');

  const withPeople = locked.filter((t: any) => t.rankTotal > 0);
  const nobody = locked.filter((t: any) => t.rankTotal === 0);

  for (const t of withPeople) {
    assert.equal(t.rank, 0, `${t.key} 未解锁不该有名次`);
    assert.equal(t.earnedText, '', `${t.key} 未解锁不该有获得时间`);
    assert.equal(t.rankText, '', `${t.key} 未解锁不该有名次句`);
    assert.match(t.totalText, /^\d+ 位迹路者获得$/, `${t.key} totalText 格式不对：${t.totalText}`);
    assert.ok(t.totalText.includes(String(t.rankTotal)), `${t.key} 数字应与 rankTotal 一致`);
  }
  // 全站确实没人获得 → 三句都空，前端退回描述
  for (const t of nobody) {
    assert.equal(t.earnedText, '', `${t.key} 不应有获得时间`);
    assert.equal(t.rankText, '', `${t.key} 不应有名次句`);
    assert.equal(t.totalText, '', `${t.key} 不应有总人数句`);
  }
});

test('BO13 未解锁徽章也有 rankTotal（全站已获得人数），供详情半屏展示', async () => {
  const d = await overview();
  // 榜里必然存在「别人拿到、我还没拿到」的徽章（测试用户只做了跑步/骑行）
  const climb = d.trophies.filter((t: any) => t.key.startsWith('climb-'));
  assert.ok(climb.length > 0, '应有爬山系列徽章');
  const lockedClimb = climb.filter((t: any) => !t.unlocked);
  assert.ok(lockedClimb.length > 0, '测试用户没爬山 → 爬山章应未解锁');
  for (const t of lockedClimb) {
    assert.equal(typeof t.rankTotal, 'number', `${t.key} rankTotal 必须是数字（不能是 undefined）`);
    assert.equal(t.rank, 0, `${t.key} 未解锁 rank 应为 0`);
  }
});

test('BO9 无数据用户：结构完整、全灰、不炸', async () => {
  const d = await overview(tokenEmpty);
  assert.equal(d.total, 111);
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

/* ── 分运动类型徽章的名次（2026-11-17 修复）──
   症状：80 座分类型徽章「已解锁但没有第 N 位迹路者文案」。
   原因：trophy-rank 的全站解锁日聚合只算了「用户 × 日」，漏了「用户 × 类型 × 日」，
        unlockDatesOf 收不到 typeDays → 分类型指标算不出解锁日 → 名次表里没有这些 key。 */
test('BO-R1 分运动类型徽章也要有名次（typeDays 必须参与全站解锁日计算）', async () => {
  const { __resetTrophyRankCache } = await import('../src/services/trophy-rank.js');
  const openid = 'bov-rank-type';
  const old = await UserModel.findOne({ openid }).select('_id').lean();
  if (old) {
    await ActivityModel.deleteMany({ userId: old._id });
    await UserModel.deleteMany({ _id: old._id });
  }
  const u = await UserModel.create({ openid, nickname: 'bov-rank-type' });
  // 5 次跑步 × 20km = 100km → 解锁 run-dist-100
  for (let i = 1; i <= 5; i++) {
    const start = Date.now() - i * DAY;
    await ActivityModel.create({
      userId: u._id, type: 'running', status: 'finished',
      startTime: start, endTime: start + 3600_000, duration: 3600, distance: 20_000,
      trackPoints: [], markers: [],
    });
  }
  const login = await app.inject({ method: 'POST', url: `${API}/auth/login`, payload: { code: `openid:${openid}` } });
  const tk = login.json().data.accessToken;

  __resetTrophyRankCache();
  const res = await app.inject({
    method: 'GET', url: `${API}/plan/summary`, headers: { authorization: `Bearer ${tk}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const t = res.json().data.trophies.find((x: { key: string }) => x.key === 'run-dist-100');
  assert.ok(t, '必须有 run-dist-100 这座徽章');
  assert.equal(t.unlocked, true, '100km 应解锁 run-dist-100');
  assert.ok(t.rank >= 1, `已解锁的分类型徽章必须有名次（实际 rank=${t.rank}）`);
  assert.ok(t.rankTotal >= 1, '名次分母不能为 0');

  await ActivityModel.deleteMany({ userId: u._id });
  await UserModel.deleteMany({ _id: u._id });
  __resetTrophyRankCache();
});

/* ── 性质测试：新增徽章/新增指标时最容易漏的是「接名次」──────────────
   历史教训（2026-11-17）：分运动类型 80 座徽章忘传 typeDays → 已解锁但 rank=0
   → 详情半屏少一行「第 N 位迹路者」，前端只是少渲染一行，谁也发现不了。
   这条不变式不关心具体哪座徽章，只要「已解锁却没有名次」就红。 */
test('BO-R2 不变式：任何已解锁的徽章都必须有名次（跨系列覆盖）', async () => {
  const { __resetTrophyRankCache } = await import('../src/services/trophy-rank.js');
  const openid = 'bov-rank-invariant';
  const old = await UserModel.findOne({ openid }).select('_id').lean();
  if (old) {
    await ActivityModel.deleteMany({ userId: old._id });
    await ExercisePlanPeriodModel.deleteMany({ userId: old._id });
    await UserModel.deleteMany({ _id: old._id });
  }
  const u = await UserModel.create({ openid, nickname: 'bov-invariant' });
  const uid = u._id;

  // 造 8 个连续自然日：每天一次跑步 20km / 2h，覆盖
  //   记录（破纪录）、坚持（连续天数）、累计里程/时长、分类型里程/时长
  const startOfToday = ((): number => {
    const b = new Date(Date.now() + 8 * 3600_000);
    return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - 8 * 3600_000;
  })();
  for (let i = 1; i <= 8; i++) {
    const start = startOfToday - i * DAY + 3600_000;
    await ActivityModel.create({
      userId: uid, type: 'running', status: 'finished',
      startTime: start, endTime: start + 7200_000, duration: 7200, distance: 20_000,
      trackPoints: [], markers: [],
    });
  }
  // 每天也落一条「三项全达成」的日快照 → 合上圆环 / 里程碑 / 完美周候选
  for (let i = 1; i <= 8; i++) {
    const key = new Date(startOfToday - i * DAY + 8 * 3600_000).toISOString().slice(0, 10);
    const ws = startOfToday - i * DAY;
    await ExercisePlanPeriodModel.create({
      userId: uid, period: 'daily', periodKey: key,
      windowStart: ws, windowEnd: ws + DAY,
      targets: { distanceM: 3000, durationMin: 30, count: 1 },
      progress: { distanceM: 20_000, durationSec: 7200, count: 1 },
      achieved: { distance: true, duration: true, count: true }, allAchieved: true,
    });
  }

  const login = await app.inject({ method: 'POST', url: `${API}/auth/login`, payload: { code: `openid:${openid}` } });
  const tk = login.json().data.accessToken;

  __resetTrophyRankCache();
  const res = await app.inject({
    method: 'GET', url: `${API}/plan/summary`, headers: { authorization: `Bearer ${tk}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const trophies = res.json().data.trophies as Array<{
    key: string; unlocked: boolean; rank: number; rankTotal: number; group: string;
  }>;

  const unlocked = trophies.filter((t) => t.unlocked);
  assert.ok(unlocked.length >= 6, `种子数据应解锁多座徽章（覆盖多系列），实际 ${unlocked.length}`);

  // 覆盖度自检：至少要跨 3 个分组，否则这条不变式其实没测到什么
  const groups = new Set(unlocked.map((t) => t.group));
  assert.ok(groups.size >= 3, `已解锁徽章应跨多个分组，实际 ${[...groups].join(',')}`);

  const missing = unlocked.filter((t) => !(t.rank > 0));
  assert.deepEqual(
    missing.map((t) => t.key),
    [],
    `已解锁但没有名次的徽章（说明该系列没接到名次计算）：${missing.map((t) => t.key).join(', ')}`,
  );
  for (const t of unlocked) {
    assert.ok(t.rankTotal >= 1, `${t.key} 的名次分母不能为 0`);
    assert.ok(t.rank <= t.rankTotal, `${t.key} 名次不得大于总人数`);
  }

  await ActivityModel.deleteMany({ userId: uid });
  await ExercisePlanPeriodModel.deleteMany({ userId: uid });
  await UserModel.deleteMany({ _id: uid });
  __resetTrophyRankCache();
});

test('BO14 已解锁的次数类徽章不再播报「已完成 N 次」；累计/纪录类保留当前值（2026-11-17）', async () => {
  const d = await overview();
  const lines = (t: any) => [t.detailText, ...(t.detailLines || [])].filter(Boolean);

  // 次数类（metric=typeCount）：已解锁 → 进度行应为空
  const earnedCount = d.trophies.filter((t: any) => t.unlocked && /type-count/.test(t.key));
  for (const t of earnedCount) {
    assert.deepEqual(lines(t), [], `${t.key} 已解锁不该再播报次数`);
  }

  // 里程碑（已完成 N 次 · 目标 M 次）：已解锁 → 为空
  const earnedFirst = d.trophies.find((t: any) => t.key === 'first' && t.unlocked);
  if (earnedFirst) assert.deepEqual(lines(earnedFirst), [], '里程碑已解锁不该再播报达成次数');

  // 累计类：已解锁 → 保留当前值（有独立意义）
  const earnedTotal = d.trophies.find((t: any) => t.key === 'total-dist-100' && t.unlocked);
  if (earnedTotal) {
    assert.ok(lines(earnedTotal).length > 0, '累计里程已解锁仍应展示累计值');
    assert.match(lines(earnedTotal)[0], /已累计/, '应展示「已累计 …」');
  }

  // 「新纪录」系列已于 2026-11-17 整组下线：不该再出现在任何返回里
  assert.equal(
    d.trophies.filter((t: any) => /^rec-dist|^rec-dur/.test(t.key)).length,
    0,
    '新纪录系列应已删除',
  );

  // 未解锁：进度行必须有内容（用户需要知道离目标多远）
  const locked = d.trophies.filter((t: any) => !t.unlocked).slice(0, 20);
  for (const t of locked) {
    assert.ok(lines(t).length > 0, `${t.key} 未解锁应展示进度（还差多少）`);
  }
});

test('BO15 「最坚持」文案：主行给「还要坚持几天」，历史最长单独一行（2026-11-18 定稿）', () => {
  /*
   * 表驱动（原先这条断言依赖「今天」的数据，两个分支只能概率性覆盖，且抓不到下面这种矛盾）：
   *   best=10 / current=2 时，卡面进度条按 best 算 10%，主行却按 current 说「再坚持 98 天」，
   *   两个数并列会被读成算错 —— 现在历史最长单独一行，明确给进度条归属。
   */
  const cases: Array<{
    best: number;
    current: number;
    tier: number;
    bestEndText: string;
    wantMain: string;
    wantLines: string[];
    why: string;
  }> = [
    {
      best: 3, current: 3, tier: 100, bestEndText: '2026-11-18',
      wantMain: '当前连续 3 天 · 再坚持 97 天解锁',
      wantLines: ['历史最长 3 天 · 就是当前这段'],
      why: '正在刷新纪录',
    },
    {
      best: 10, current: 2, tier: 100, bestEndText: '2026-11-07',
      wantMain: '当前连续 2 天 · 再坚持 98 天解锁',
      wantLines: ['历史最长 10 天 · 截至 2026-11-07'],
      why: '当前这段短于历史纪录（原本进度条 10% 与「再坚持 98 天」打架，靠这行给归属）',
    },
    {
      best: 10, current: 0, tier: 100, bestEndText: '2026-11-07',
      wantMain: '再坚持 100 天解锁',
      wantLines: ['历史最长 10 天 · 截至 2026-11-07'],
      why: '完全中断：主行只讲还要几天，历史最长单独一行',
    },
    {
      best: 120, current: 5, tier: 100, bestEndText: '2026-11-14',
      wantMain: '最长连续运动 120 天',
      wantLines: ['该纪录截至 2026-11-14'],
      why: '已解锁 + 中断',
    },
    {
      best: 120, current: 120, tier: 100, bestEndText: '2026-11-18',
      wantMain: '最长连续运动 120 天',
      wantLines: ['该纪录就是当前这段'],
      why: '已解锁 + 正在刷新',
    },
    {
      best: 0, current: 0, tier: 365, bestEndText: '',
      wantMain: '再坚持 365 天解锁',
      wantLines: [],
      why: '一次都没连续过：不硬造附加行',
    },
  ];

  for (const c of cases) {
    const main = streakDetailText({ best: c.best, current: c.current, tier: c.tier });
    assert.equal(main, c.wantMain, `[${c.why}] best=${c.best} current=${c.current} 主行不对`);
    const lines = streakHistoryLines({
      best: c.best,
      current: c.current,
      bestEndText: c.bestEndText,
      unlocked: c.best >= c.tier,
    });
    assert.deepEqual(lines, c.wantLines, `[${c.why}] best=${c.best} current=${c.current} 附加行不对`);
    // 通用不变量
    assert.ok(!/\{cur\}|\{remain\}|\{tier\}/.test(main), `[${c.why}] 主行残留占位符`);
    assert.ok(!lines.some((l) => /\d{4}-\d{2}-\d{2} 结束/.test(l)), `[${c.why}] 附加行仍是旧的「日期 结束」写法`);
  }
});

test('BO15b overview 里 streak 徽章不再出现占位符/歧义写法（数据无关的守门）', async () => {
  const d = await overview();
  const streaks = d.trophies.filter((t: any) => /^streak-/.test(t.key));
  assert.ok(streaks.length > 0, '应有 streak 系列');
  for (const t of streaks) {
    const all = [t.detailText, ...(t.detailLines || [])];
    for (const text of all) {
      assert.ok(!/\{cur\}|\{remain\}|\{tier\}|\{valueText\}/.test(text), `${t.key} 残留占位符：${text}`);
      assert.ok(!/\d{4}-\d{2}-\d{2} 结束/.test(text), `${t.key} 旧写法：${text}`);
    }
    // 未解锁必须有「还差 / 再坚持」这种差距提示
    if (!t.unlocked) assert.match(t.detailText, /再坚持 \d+ 天解锁/, `${t.key} 主行必须只讲「还要几天解锁」：${t.detailText}`);
    // 历史最长若出现在附加行，必须带主语（「历史最长」/「该纪录」）
    for (const line of t.detailLines || []) {
      assert.match(line, /^(历史最长|该纪录)/, `${t.key} 附加行缺主语：${line}`);
    }
  }
});

test('BO16 倍率型里程碑（200%完成目标）：卡面印百分比、进度不说「目标 N 次」（2026-11-18 修）', async () => {
  const d = await overview();
  for (const key of ['x2', 'x3', 'x4', 'x5']) {
    const t = d.trophies.find((x: any) => x.key === key);
    assert.ok(t, `缺 ${key}`);
    const pct = key.slice(1) * 100;
    // 卡面必须带 %，否则 200 会被读成「200 次」
    assert.equal(t.badgeText, `${pct}%`, `${key} 卡面应为百分比：${t.badgeText}`);
    // 进度文案不能把 tier(=百分比) 说成次数
    assert.ok(!/目标 \d{3} 次/.test(t.detailText || ''), `${key} 文案把百分比说成了次数：${t.detailText}`);
    // 不能与 desc 重复（desc 已说「单周期运动距离达到目标的 N% 即可获得」）
    assert.notEqual(t.detailText, t.desc, `${key} 进度文案与描述重复`);
  }

  // 次数型里程碑不受影响：卡面仍是次数
  const week = d.trophies.find((x: any) => x.key === 'week');
  assert.equal(week.badgeText, '7', '次数型仍印次数');
  if (!week.unlocked) assert.match(week.detailText, /已达成 \d+ 次 · 目标 7 次/, `次数型文案：${week.detailText}`);
});

test('BO17 年度报告返回徽章明细：列出区间内解锁的徽章，按日期倒序（2026-11-19）', async () => {
  const { planRangeReport } = await import('../src/services/exercise-plan.js');
  const u = await UserModel.findOne({ openid: 'trophy-preview' });
  assert.ok(u, '需要 trophy-preview 测试账号');
  const from = Date.parse('2026-01-01T00:00:00+08:00');
  const to = Date.parse('2026-12-31T23:59:59+08:00');
  const rep = await planRangeReport(String(u._id), from, to);

  assert.ok(Array.isArray(rep.badges.unlockedList), '应返回 unlockedList');
  // 数量必须与 unlockedInRange 一致（年报同时展示两者，不能对不上）
  assert.equal(rep.badges.unlockedList.length, rep.badges.unlockedInRange,
    `明细 ${rep.badges.unlockedList.length} 条 vs 计数 ${rep.badges.unlockedInRange}`);

  for (const b of rep.badges.unlockedList) {
    // 前端画章面需要的字段（activityIconId 是分类型徽章白色图标的来源；
    // group 供前端判断合环组走三层三环——2026-11-19 review 补锁）
    for (const f of ['key', 'shortLabel', 'shape', 'badgeText', 'earnDateText', 'groupTitle', 'group'] as const) {
      assert.ok((b as any)[f] !== undefined, `徽章明细缺 ${f}`);
    }
    if (/^type-/.test(b.key) || b.group === 'activity-type') {
      assert.ok(b.activityIconId, `分类型徽章 ${b.key} 必须带 activityIconId（白色图标来源）`);
    }
    assert.match(b.earnDateText, /^\d{4}-\d{2}-\d{2}$/, '日期格式');
    assert.ok(b.earnDateText >= '2026-01-01' && b.earnDateText <= '2026-12-31', '不应超出区间');
  }
  // 倒序
  const dates = rep.badges.unlockedList.map((b) => b.earnDateText);
  assert.deepEqual(dates, [...dates].sort().reverse(), '应按解锁日期倒序');
});
