/**
 * 管理端「车速段回填」接口（POST /admin/activities/backfill-vehicle）
 *
 * 这条接口是线上历史数据的唯一修正入口（容器里没有 tsx、scripts/ 也不进镜像），
 * 所以它必须和 CLI 脚本共用一份实现：判据、四道闸门、报告字段一处定义。
 * 这里验的是接口这侧的行为契约：
 *   1) 默认干跑 —— 库里一字未动，但报告已经把该改的都算出来了；
 *   2) apply 才落库，且落的是新口径（时长/距离/配速/点标记）；
 *   3) calories 一律不动（历史体重没落库，回算会把卡路里口径带偏）；
 *   4) fastestKm 只降不升 —— 回填不该顺手把人刷到更好的名次上。
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

const ADMIN_USER = 'admin_vbf_test';
const ADMIN_PASS = 'test123456';
const OPENID_PREFIX = /^vbf_openid/;
/** 采样间隔（秒）：10s 一步，第三方 GPX 也常是这个量级 */
const STEP_SEC = 10;
const BASE = Date.parse('2026-08-01T00:00:00Z');

/** 沿纬线按「每步若干米」铺点：距离由 haversineDistance 反算，测试里不手写坐标差 */
function buildPoints(steps: number[], stepSec = STEP_SEC) {
  const lat = 39.9042;
  const mPerDeg = 111320 * Math.cos((lat * Math.PI) / 180);
  let lng = 116.4074;
  const pts = [{ seq: 1, lat, lng, speed: 0, accuracy: 8, timestamp: BASE }];
  steps.forEach((m, i) => {
    lng += m / mPerDeg;
    pts.push({
      seq: i + 2,
      lat,
      lng,
      speed: m / stepSec,
      accuracy: 8,
      timestamp: BASE + (i + 1) * stepSec * 1000,
    });
  });
  return pts;
}

function rawMeters(pts: { lat: number; lng: number }[]) {
  return pts.slice(1).reduce((s, p, i) => s + haversineDistance(pts[i], p), 0);
}

/** 造一条 finished 活动：duration 与墙钟严格对齐，否则脚本的时长闸门会先把它挡掉 */
async function seedActivity(
  name: string,
  steps: number[],
  extra: Record<string, unknown> = {},
  stepSec = STEP_SEC,
) {
  const pts = buildPoints(steps, stepSec);
  const wallSec = ((pts[pts.length - 1].timestamp - BASE) / 1000) | 0;
  const user = await UserModel.create({ openid: `vbf_openid-${name}`, nickname: `回填测试-${name}` });
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
    distance: Math.round(rawMeters(pts)),
    avgPace: Math.round(wallSec / (rawMeters(pts) / 1000)),
    calories: 500,
    elevationGain: 12,
    trackPoints: pts,
    ...extra,
  });
  return { id: String(act._id), wallSec, rawDist: Math.round(rawMeters(pts)) };
}

function call(payload: Record<string, unknown>, withToken = true) {
  return app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/activities/backfill-vehicle',
    headers: withToken ? { authorization: `Bearer ${adminToken}` } : {},
    payload,
  });
}

async function snapshot(id: string) {
  const a = await ActivityModel.findById(id).select('-_id type status duration distance avgPace fastestKm calories standstillMs vehicleMs vehicleM trackPoints').lean();
  return JSON.stringify(a);
}

/** 只属于本次用例的活动：按 openid 前缀找到本测试用户，避免被别人的数据干扰 */
const ids = new Set<string>();

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

  // A：跑步途中夹 6 步 100m/10s（10 m/s 持续 60s）→ 应判为车速段
  ids.add((await seedActivity('vehicle', [30, 30, 30, 30, 30, 30, 30, 100, 100, 100, 100, 100, 100, 30, 30, 30, 30, 30, 30, 30])).id);
  // B：全程 ~3 m/s（100m/33s）的干净轨迹，但库里 fastestKm 存了个明显更差的值 → 重算更快，不许写
  ids.add(
    (await seedActivity('clean', Array.from({ length: 21 }, () => 100), { fastestKm: 999 }, 33)).id,
  );
});

after(async () => {
  const users = await UserModel.find({ openid: OPENID_PREFIX }).select('_id');
  await ActivityModel.deleteMany({ userId: { $in: users.map((u) => u._id) } });
  await UserModel.deleteMany({ openid: OPENID_PREFIX });
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await app.close();
});

test('干跑：报告算出车速段，但库里一字未动', async () => {
  const vehicleId = [...ids][0];
  const beforeJson = await snapshot(vehicleId);
  const res = await call({ id: vehicleId });
  assert.equal(res.statusCode, 200);
  const d = res.json().data;
  assert.ok(d.db, '报告要回连的是哪个库');
  assert.equal(d.apply, false);
  assert.equal(d.scanned, 1);
  assert.equal(d.hitCount, 1, '这条应被判出车速段');
  assert.ok(d.hits[0].includes(vehicleId));
  assert.equal(await snapshot(vehicleId), beforeJson, '干跑不能写库');
});

test('apply：按新口径落库（时长/距离/配速/点标记），calories 不动', async () => {
  const vehicleId = [...ids][0];
  const res = await call({ id: vehicleId, apply: true });
  assert.equal(res.statusCode, 200);
  const d = res.json().data;
  assert.equal(d.apply, true);
  assert.equal(d.changed, 1);

  const a = await ActivityModel.findById(vehicleId)
    .select('duration distance avgPace vehicleMs vehicleM calories trackPoints')
    .lean();
  const marked = (a!.trackPoints as any[]).filter((p) => p.vehicle === true);
  assert.equal(marked.length, 6, '6 步 100m/10s 该被标成车速段');
  assert.equal(a!.vehicleMs, 60000, '60s 车程');
  assert.ok(Math.abs(a!.vehicleM - 600) <= 6, `车速段位移应≈600m，实为 ${a!.vehicleM}`);
  assert.equal(a!.duration, 140, '墙钟 200s 扣掉 60s 车程');
  assert.ok(Math.abs(a!.distance - 420) <= 6, `距离应只剩走动的 420m，实为 ${a!.distance}`);
  assert.ok(
    Math.abs(a!.avgPace! - a!.duration / (a!.distance / 1000)) <= 1,
    '平均配速要与新的时长/距离自洽',
  );
  assert.equal(a!.calories, 500, '卡路里不参与回填');
});

test('apply 可重跑：第二次不再产生改动（标记与汇总已对齐）', async () => {
  const vehicleId = [...ids][0];
  const beforeJson = await snapshot(vehicleId);
  const res = await call({ id: vehicleId, apply: true });
  assert.equal(res.json().data.changed, 0);
  assert.equal(await snapshot(vehicleId), beforeJson, '复跑不该抖出假差异');
});

test('fastestKm 只降不升：重算更快时不写值、只列进 fastSkipped', async () => {
  const cleanId = [...ids][1];
  const res = await call({ id: cleanId, apply: true });
  assert.equal(res.statusCode, 200);
  const d = res.json().data;
  assert.equal(d.hitCount, 0, '全程 3 m/s 不该判出车速段');
  assert.ok(
    d.fastSkipped.some((s: string) => s.includes(cleanId)),
    `重算值更快应进 fastSkipped，实际：${JSON.stringify(d.fastSkipped)}`,
  );
  const a = await ActivityModel.findById(cleanId).select('fastestKm duration vehicleMs').lean();
  assert.equal(a!.fastestKm, 999, '更快的重算值不写库');
  assert.equal(a!.vehicleMs, 0);
  assert.equal(a!.duration, 693, '干净轨迹的时长不该被回填动过');
});

test('缺管理员凭证 → 401', async () => {
  const res = await call({ id: [...ids][0] }, false);
  assert.equal(res.statusCode, 401);
});
