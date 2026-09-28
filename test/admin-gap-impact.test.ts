/**
 * 管理端「断档虚高影响评估」接口（POST /admin/activities/gap-impact）
 *
 * 为什么要它：gapJump 的视觉断线带第三条横向闸门，"沿跑道把弯切了"那类不标；
 * 但那类恰恰是里程虚高的来源（位置被报到前面，那段地面人当时没到过）。
 * 折算属于改指标口径，动之前必须先看到影响面 —— 而线上不跑脚本，所以做成管理端只读接口。
 *
 * 这里验的契约：
 *   1) **只读**：跑完库里一字未动（这条是 dry-run 的全部承诺）；
 *   2. 折算口径只看前两条判据（间隔拉长 + 位移超限），沿跑道的长步也要算进来；
 *   3) 每条给出 弦长/应有/虚高/虚高占比 与折算后的距离、平均配速；
 *   4) 汇总与分桶能对上号；明细按虚高占比倒序、可封顶。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { haversineDistance } from '../src/utils/pace.js';

let app: FastifyInstance;
let adminToken = '';

const ADMIN_USER = 'admin_gap_test';
const ADMIN_PASS = 'test123456';
const OPENID_PREFIX = /^gap_openid/;
const BASE = Date.parse('2026-08-01T00:00:00Z');
/** 正常步：5m / 2s = 2.5 m/s（中位步速就是它） */
const NORMAL = 5;
/** 断档步：80m / 10s —— 间隔 5 倍、位移 32 倍，前两条判据都过；横向 0m 所以视觉不标 */
const DRIFT_M = 80;
const DRIFT_SEC = 10;
/** 断档步按中位步速本该走 2.5×10 = 25m，虚高 55m */
const DRIFT_OVER = 55;

/** 沿纬线铺点：steps 里每项是「这一步若干米」，间隔默认 2s，drift 位用 10s */
function buildPoints(steps: Array<{ m: number; sec?: number }>) {
  const lat = 39.9042;
  const mPerDeg = 111320 * Math.cos((lat * Math.PI) / 180);
  let lng = 116.4074;
  let t = BASE;
  const pts = [{ seq: 1, lat, lng, speed: 0, accuracy: 8, timestamp: t }];
  steps.forEach((s, i) => {
    lng += s.m / mPerDeg;
    t += (s.sec ?? 2) * 1000;
    pts.push({ seq: i + 2, lat, lng, speed: s.m / (s.sec ?? 2), accuracy: 8, timestamp: t });
  });
  return pts;
}

async function seedActivity(name: string, steps: Array<{ m: number; sec?: number }>) {
  const pts = buildPoints(steps);
  const wallSec = ((pts[pts.length - 1].timestamp - BASE) / 1000) | 0;
  const rawDist = pts.slice(1).reduce((s, p, i) => s + haversineDistance(pts[i], p), 0);
  const user = await UserModel.create({ openid: `gap_openid-${name}`, nickname: `断档评估-${name}` });
  const act = await ActivityModel.create({
    userId: user._id,
    type: 'running',
    status: 'finished',
    startTime: BASE,
    endTime: pts[pts.length - 1].timestamp,
    pausedMs: 0,
    duration: wallSec,
    standstillMs: 0,
    vehicleMs: 0,
    vehicleM: 0,
    distance: Math.round(rawDist),
    avgPace: Math.round(wallSec / (rawDist / 1000)),
    calories: 80,
    elevationGain: 5,
    trackPoints: pts,
    markers: [],
  });
  return { id: String(act._id), distance: Math.round(rawDist), duration: wallSec };
}

const cruise = (n: number) => Array.from({ length: n }, () => ({ m: NORMAL }));
const drift = { m: DRIFT_M, sec: DRIFT_SEC };

const ids: string[] = [];
let clean: { id: string; distance: number } | null = null;
let one: { id: string; distance: number } | null = null;
let two: { id: string; distance: number } | null = null;

function call(payload: Record<string, unknown>, withToken = true) {
  return app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/activities/gap-impact',
    headers: withToken ? { authorization: `Bearer ${adminToken}` } : {},
    payload,
  });
}

/** 整条文档（含 updatedAt）：只读承诺要连"值没变但被写过"也抓得住 */
async function snapshot(id: string) {
  const a = await ActivityModel.findById(id)
    .select('updatedAt status type duration distance avgPace fastestKm calories standstillMs vehicleMs vehicleM trackPoints')
    .lean();
  return JSON.stringify(a);
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  const users = await UserModel.find({ openid: OPENID_PREFIX }).select('_id');
  await ActivityModel.deleteMany({ userId: { $in: users.map((u) => u._id) } });
  await UserModel.deleteMany({ openid: OPENID_PREFIX });
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/login',
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  adminToken = login.json().data.token;
  assert.ok(adminToken, '管理员登录应成功');

  clean = await seedActivity('clean', cruise(80));
  one = await seedActivity('one-drift', [...cruise(40), drift, ...cruise(40)]);
  two = await seedActivity('two-drift', [...cruise(20), drift, ...cruise(20), drift, ...cruise(20)]);
  ids.push(clean.id, one.id, two.id);
});

after(async () => {
  const users = await UserModel.find({ openid: OPENID_PREFIX }).select('_id');
  await ActivityModel.deleteMany({ userId: { $in: users.map((u) => u._id) } });
  await UserModel.deleteMany({ openid: OPENID_PREFIX });
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

test('gap-impact 是只读评估：报告出了，库里一字未动', async () => {
  const beforeSnaps = await Promise.all(ids.map((id) => snapshot(id)));
  const res = await call({ ids });
  assert.equal(res.statusCode, 200, res.body);
  const afterSnaps = await Promise.all(ids.map((id) => snapshot(id)));
  assert.deepEqual(afterSnaps, beforeSnaps, 'dry-run 不许写库');
});

test('gap-impact 折算口径只看前两条判据：沿跑道的断档步算得进来，视觉标记却不标它', async () => {
  const res = await call({ ids });
  const d = res.json().data;
  assert.equal(d.scanned, 3);
  assert.equal(d.withGaps, 2, '干净那条不该有虚高');
  assert.equal(d.gaps, 3, '一处 + 两处 = 3 处断档');
  assert.ok(Math.abs(d.overM - 3 * DRIFT_OVER) < 3, `虚高合计 ${d.overM}`);
  assert.ok(Math.abs(d.chordM - 3 * DRIFT_M) < 3, `弦合计 ${d.chordM}`);
  assert.ok(Math.abs(d.plausibleM - 3 * (DRIFT_M - DRIFT_OVER)) < 3, `应有合计 ${d.plausibleM}`);
  // 库里没有 gapJump 标记也不影响评估（评估不读那个字段）
  const rowIds = d.rows.map((r: { id: string }) => r.id);
  assert.ok(!rowIds.includes(clean!.id), '干净的不该进明细');
});

test('gap-impact 明细：按虚高占比倒序，给出折算后的距离与配速', async () => {
  const res = await call({ ids });
  const d = res.json().data;
  assert.equal(d.rows.length, 2);
  const [first, second] = d.rows;
  assert.equal(first.id, two!.id, '两处断档的占比更高，排前面');
  assert.equal(second.id, one!.id);

  assert.equal(second.gaps, 1);
  assert.equal(second.distance, one!.distance);
  assert.ok(Math.abs(second.overM - DRIFT_OVER) < 1, `虚高 ${second.overM}`);
  assert.ok(Math.abs(second.distanceAfter - (one!.distance - DRIFT_OVER)) < 1, `折算后 ${second.distanceAfter}`);
  const pct = (DRIFT_OVER / one!.distance) * 100;
  assert.ok(Math.abs(second.overPct - pct) < 0.3, `占比 ${second.overPct} 期望 ${pct.toFixed(1)}`);
  // 距离变短、时长不动 → 平均配速必然变慢，这是折算最直观代价
  assert.ok(second.avgPaceAfter > second.avgPace, `${second.avgPace} → ${second.avgPaceAfter}`);
  assert.ok(Math.abs(first.avgPaceAfter - first.duration / (first.distanceAfter / 1000)) < 1);
});

test('gap-impact 汇总与分桶对得上号，明细可封顶', async () => {
  const res = await call({ ids });
  const d = res.json().data;
  assert.equal(d.distanceNow, clean!.distance + one!.distance + two!.distance);
  assert.ok(Math.abs(d.distanceAfter - (d.distanceNow - d.overM)) < 3);
  const bucketSum = d.overPctBuckets.reduce((a: number, b: { count: number }) => a + b.count, 0);
  assert.equal(bucketSum, d.withGaps, '分桶总数必须等于受影响条数');
  assert.deepEqual(
    d.overPctBuckets.map((b: { label: string }) => b.label),
    ['≤1%', '1–3%', '3–5%', '5–10%', '>10%'],
  );

  const capped = await call({ ids: [one!.id, two!.id], listCap: 1 });
  const cd = capped.json().data;
  assert.equal(cd.rows.length, 1);
  assert.equal(cd.rowsCount, 2, '封顶后仍要报出总条数');
});

test('gap-impact 不许伪造数字：虚高超过整条距离的行标为不可折算，不给出折算结果', async () => {
  // 点极少、一步顶满整条的烂轨迹：按中位步速折算会算出"负距离"，
  // 把它夹到 1m 就是凭空造数（配速会变成 540000 秒/公里这种鬼东西）
  const junk = await seedActivity('junk', [
    { m: 5 },
    { m: 5 },
    { m: 5 },
    { m: 5 },
    { m: 1200, sec: 60 }, // 一步 1200m/60s：位移门槛 = 2.5×60×2.5 = 375m，远超 → 判成断档
    { m: 5 },
    { m: 5 },
    { m: 5 },
  ]);
  const res = await call({ ids: [junk.id] });
  const d = res.json().data;
  assert.equal(d.withGaps, 1);
  assert.equal(d.unreliableCount, 1, '虚高 ≥ 整条距离的，要单独点出来');
  const row = d.rows[0];
  assert.equal(row.id, junk.id);
  assert.equal(row.unreliable, true);
  assert.equal(row.distanceAfter, null, '不可折算就不该给折算后距离');
  assert.equal(row.avgPaceAfter, null, '更不该给出 540000 秒/公里这种数');
  // 汇总里这条按"不动"计，虚高也不进总量（否则总里程会被扣成负数）
  assert.equal(d.distanceAfter, d.distanceNow);
  assert.equal(d.overM, 0);
  assert.equal(d.maxOverPct, 0);
  assert.equal(
    d.overPctBuckets.reduce((a: number, b: { count: number }) => a + b.count, 0),
    0,
    '不可折算的不进分桶，分桶只统计真要折算的那些',
  );
  await ActivityModel.deleteOne({ _id: junk.id });
  await UserModel.deleteOne({ openid: 'gap_openid-junk' });
});

test('gap-impact 要管理员身份；不传 ids 就是全库扫', async () => {
  const anon = await call({ ids }, false);
  assert.equal(anon.statusCode, 401);
  const all = await call({});
  assert.equal(all.statusCode, 200, all.body);
  assert.ok(all.json().data.scanned >= 3, '不给 ids 时扫全库 finished');
});
