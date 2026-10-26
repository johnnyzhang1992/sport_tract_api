/**
 * 管理端「driftScore 批量回填」接口（POST /admin/activities/backfill-drift-score）
 *
 * 这是线上历史数据的唯一补齐入口（容器里没有 tsx、scripts/ 也不进镜像），
 * 与 scripts/backfill-drift-score.ts 共用 services/drift-score-backfill.ts 一份实现。
 * 行为契约：
 *   1) 需要 admin 鉴权；
 *   2) 默认干跑 —— 库里一字未动，但报告已算出 scanned/updated/分数分布；
 *   3) apply=true 才落库，落的是按点集+类型+距离/时长重算的分数（与 finish 同函数）；
 *   4) 只扫 driftScore=null 的 finished 轨迹（已有分数不重算，已有门禁语义不扰动）；
 *   5) limit 限量生效。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { calcDriftScore } from '../src/utils/drift-score.js';
import { DRIFT_SCORE_PB_GATE } from '../src/config/constants.js';

let app: FastifyInstance;
let adminToken = '';
let fixtureUserId = ''; // 测试用户：所有 apply/扫描断言都按它封闭（接口全库扫，共享库不能裸跑）

const ADMIN_USER = 'admin_dsb_test';
const ADMIN_PASS = 'test123456';
const OPENID_PREFIX = /^dsb_openid/;
const BASE = Date.parse('2026-08-01T00:00:00Z');
const M_PER_DEG = 180 / (Math.PI * 6371000);

/** 直线轨迹：steps 步 × stepM 米 × STEP_SEC 秒；hook 可注入 accBad/vehicle 标记 */
function buildPoints(steps: number, stepM: number, hook?: (i: number, p: Record<string, unknown>) => void) {
  const pts: Array<Record<string, unknown>> = [{ seq: 1, lat: 30, lng: 114, accuracy: 8, timestamp: BASE }];
  let lat = 30;
  for (let i = 1; i <= steps; i++) {
    lat += stepM * M_PER_DEG;
    const p: Record<string, unknown> = { seq: i + 1, lat, lng: 114, accuracy: 8, timestamp: BASE + i * 25_000 };
    hook?.(i, p);
    pts.push(p);
  }
  return pts;
}

async function purge() {
  const users = await UserModel.find({ openid: OPENID_PREFIX }).select('_id').lean();
  const ids = users.map((u) => u._id);
  if (ids.length) {
    await ActivityModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  }
  await AdminModel.deleteMany({ username: ADMIN_USER });
}

let cleanId = ''; // 干净轨迹
let badId = ''; // 高分轨迹（accBad 60%+）
let planId = ''; // planned 导入形态

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await purge();
  await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/login',
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  adminToken = login.json().data.token;

  const user = await UserModel.create({ openid: 'dsb_openid_u1', uid: 0, nickname: 'dsb' } as never);
  fixtureUserId = String(user._id);

  cleanId = String(
    (
      await ActivityModel.create({
        userId: user._id,
        type: 'walking',
        status: 'finished',
        startTime: BASE,
        endTime: BASE + 750_000,
        distance: 900,
        duration: 750,
        trackPoints: buildPoints(30, 30) as never, // 30m/25s = 1.2m/s 干净
      })
    )._id,
  );
  badId = String(
    (
      await ActivityModel.create({
        userId: user._id,
        type: 'walking',
        status: 'finished',
        startTime: BASE + 3600_000,
        endTime: BASE + 4600_000,
        distance: 8000,
        duration: 7200,
        trackPoints: buildPoints(80, 100, (i, p) => {
          if (i >= 30) p.accBad = true; // 63% accBad → ≥30 分
        }) as never,
      })
    )._id,
  );
  planId = String(
    (
      await ActivityModel.create({
        userId: user._id,
        type: 'walking',
        status: 'finished',
        startTime: BASE + 7200_000,
        endTime: BASE + 7800_000,
        distance: 500,
        duration: 600,
        trackKind: 'planned',
        trackPoints: buildPoints(10, 50) as never,
      })
    )._id,
  );
});

after(async () => {
  await purge();
  await app.close();
});

test('B1 未带 admin token：401', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/activities/backfill-drift-score',
    payload: { apply: true },
  });
  assert.equal(res.statusCode, 401);
});

test('B2 默认干跑：报告算出分布，库里一字未动', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/activities/backfill-drift-score',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { userId: fixtureUserId },
  });
  assert.equal(res.statusCode, 200, res.body);
  const r = res.json().data;
  assert.equal(r.apply, false);
  assert.equal(r.scanned, 3, '三条 null 轨迹都应扫到');
  assert.equal(r.updated, 0, '干跑不落库');
  const after = await ActivityModel.find({ _id: { $in: [cleanId, badId, planId] } })
    .select('driftScore')
    .lean();
  assert.ok(after.every((d) => d.driftScore == null), '干跑后 driftScore 应仍为 null');
  // 分布报告：bad 在门禁带，clean/planned 在低分区
  const gateBucket = r.buckets.find((b: { bucket: string }) => b.bucket.startsWith('30-39'));
  assert.equal(gateBucket?.count, 1, `门禁带应恰 1 条（bad），实际 ${JSON.stringify(r.buckets)}`);
});

test('B3 apply=true：分数落库且与 calcDriftScore 一致；planned 照常落分', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/activities/backfill-drift-score',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { apply: true, userId: fixtureUserId },
  });
  assert.equal(res.statusCode, 200, res.body);
  const r = res.json().data;
  assert.equal(r.apply, true);
  assert.equal(r.updated, 3);
  const [clean, bad, plan] = await Promise.all([
    ActivityModel.findById(cleanId).select('driftScore').lean(),
    ActivityModel.findById(badId).select('driftScore trackPoints type distance duration').lean(),
    ActivityModel.findById(planId).select('driftScore').lean(),
  ]);
  assert.ok(clean?.driftScore === 0);
  assert.equal(bad?.driftScore, calcDriftScore(bad!.trackPoints as never, bad!.type, { distance: bad!.distance, durationSec: bad!.duration }));
  assert.ok((bad?.driftScore ?? 0) >= DRIFT_SCORE_PB_GATE, 'bad 轨迹应 ≥ 门禁');
  assert.ok(typeof plan?.driftScore === 'number', 'planned 也应落分（门禁看数值不看 trackKind）');
});

test('B4 回填后再跑：无 null 可扫，scanned=0（幂等）', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/activities/backfill-drift-score',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { apply: true, userId: fixtureUserId },
  });
  const r = res.json().data;
  assert.equal(r.scanned, 0);
  assert.equal(r.updated, 0);
});

test('B5 limit 限量生效', async () => {
  // 造一条新的 null，limit=1 只扫到一条
  const user = await UserModel.findOne({ openid: 'dsb_openid_u1' }).select('_id').lean();
  await ActivityModel.create({
    userId: user!._id,
    type: 'walking',
    status: 'finished',
    startTime: BASE + 9000_000,
    endTime: BASE + 9600_000,
    distance: 500,
    duration: 600,
    trackPoints: buildPoints(10, 50) as never,
  });
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/activities/backfill-drift-score',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { apply: true, limit: 1, userId: fixtureUserId },
  });
  const r = res.json().data;
  assert.equal(r.scanned, 1);
  assert.equal(r.updated, 1);
});
