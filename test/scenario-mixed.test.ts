import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { LoginLogModel } from '../src/models/login-log.model.js';
import { reprocessActivity } from '../src/services/activity.js';
import { haversineDistance } from '../src/utils/pace.js';

/**
 * 三个混合场景走「端上采点 → finish 落库 → 纠偏」全链路，验证最终口径：
 *
 * 场景一：步行 + 公交 + 暂停等车 + 地铁（地面段超速）+ 步行
 *   - finish：端上标记的地面超速步与隧道弦不计距离
 *   - 纠偏：公交段（≥6.5m/s 持续）被服务端判出剔除；地面段与隧道弦靠端上预标记剔除
 * 场景二：步行 + 骑行 + 步行（散步类型）
 *   - 16km/h 休闲骑行低于 6.5m/s 判据：纠偏不剔（速度上无法与快走区分，如实断言）
 *   - 29km/h 较快骑行：纠偏判出剔除
 * 场景三：散步类型实际坐车
 *   - 54km/h（端上全程预标记）：finish 即剔
 *   - 36km/h（低于端上限，未预标记）：纠偏持续判据剔
 */

const DEG = 1 / 111194.9;
const NOW = Date.now();

interface Leg {
  mps: number;
  sec: number;
  /** 端上实时标记（折算速度超类型上限的步） */
  vehicle?: boolean;
  /** 本段首点带 pauseGap（暂停恢复） */
  pauseGap?: boolean;
  /** 段前静默秒数（暂停不采点 / 隧道无定位） */
  gapSec?: number;
  /** 段首额外位移（米）：隧道重现点一步成弦用 */
  jumpM?: number;
  /** 仅段首一步标 vehicle（端上巨步弦规则：>120s 无定位后的重现点） */
  chord?: boolean;
}

/** 按腿构造点列：每步 3s，lng 固定、lat 匀速北移（与端上 tracker 的产出同构） */
function build(legs: Leg[]) {
  const pts: Array<Record<string, any>> = [];
  let lat = 30.5;
  let ts = NOW - 600000;
  let seq = 1;
  pts.push({ seq, lat, lng: 114.4, altitude: null, speed: null, accuracy: 10, timestamp: ts });
  for (const leg of legs) {
    if (leg.gapSec) ts += leg.gapSec * 1000;
    const steps = Math.round(leg.sec / 3);
    for (let i = 0; i < steps; i++) {
      seq += 1;
      ts += 3000;
      lat += leg.mps * 3 * DEG + (i === 0 && leg.jumpM ? leg.jumpM * DEG : 0);
      const p: Record<string, any> = {
        seq, lat, lng: 114.4, altitude: null, speed: leg.mps, accuracy: 10, timestamp: ts,
      };
      if (leg.vehicle) p.vehicle = true;
      if (leg.chord && i === 0) p.vehicle = true;
      if (leg.pauseGap && i === 0) p.pauseGap = true;
      pts.push(p);
    }
  }
  return pts;
}

/** 端上口径距离：vehicle 步不计入 */
function clientDistanceOf(pts: Array<Record<string, any>>): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].vehicle) continue;
    d += haversineDistance(pts[i - 1] as any, pts[i] as any);
  }
  return Math.round(d);
}

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
});

after(async () => {
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

/** 每个场景独立用户（创建限流/进行中唯一索引互不干扰） */
async function createUserAndActivity(code: string, pausedMs = 0, legs?: Leg[]) {
  const ids = (
    await UserModel.find({ openid: new RegExp(`^openid:${code}`) }).select('_id').lean()
  ).map((u) => u._id);
  if (ids.length) {
    await ActivityModel.deleteMany({ userId: { $in: ids } });
    await LoginLogModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  }
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code },
  });
  const { accessToken, user } = login.json().data;
  const created = await app.inject({
    method: 'POST',
    url: '/sport-track/api/activities',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { type: 'walking', startTime: NOW - 600000 },
  });
  const activityId = created.json().data.activityId as string;
  const pts = build(legs ?? []);
  return { accessToken, userId: user.id as string, activityId, pts, clientDistance: clientDistanceOf(pts) };
}

test('场景一：步行+公交+暂停等车+地铁+步行', async () => {
  // 公交 120s（留足余量：纠偏清洗可能吃掉过渡点，60s 整的腿会被洗到 57s 而漏判）
  const legs: Leg[] = [
    { mps: 1.4, sec: 30 }, // 步行 ~42m
    { mps: 9, sec: 120 }, // 公交 32km/h：端上不标，服务端持续判据兜
    { mps: 1.2, sec: 9, gapSec: 120, pauseGap: true }, // 暂停等车 120s 后走进站
    { mps: 16, sec: 24, vehicle: true }, // 地铁地面段 57.6km/h：端上标记
    { mps: 1.4, sec: 30, gapSec: 600, jumpM: 5000, chord: true }, // 隧道 600s 无定位，重现点弦 ~5km：端上巨步弦规则标记
  ];
  const { accessToken, userId, activityId, pts, clientDistance } = await createUserAndActivity(
    'scn-1',
    0,
    legs,
  );
  const finish = await app.inject({
    method: 'PUT',
    url: `/sport-track/api/activities/${activityId}/finish`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { trackPoints: pts, clientDistance, pausedMs: 120000 },
  });
  assert.equal(finish.statusCode, 200);
  const finished = finish.json().data;
  assert.equal(finished.status, 'finished');
  assert.equal(finished.activity.distance, clientDistance, 'finish 距离与端上口径一致（地面段与弦已剔）');
  assert.ok(clientDistance > 1100 && clientDistance < 1250, `端上距离 ${clientDistance}（步行+公交）`);

  const corrected = await reprocessActivity(activityId, userId);
  // 公交段被持续判据剔除、地面段与隧道弦靠端上预标记剔除 → 只剩步行
  const polyline = Math.round(
    pts.reduce((s, p, i) => (i === 0 ? 0 : s + haversineDistance(pts[i - 1] as any, p as any)), 0),
  );
  assert.ok(corrected.distance > 80 && corrected.distance < 250, `纠偏后只剩步行量级（${corrected.distance}）`);
  assert.ok(corrected.distance < polyline * 0.05, `全长 ${polyline} 里 ~6.5km 坐车/弦全部剔除`);
  assert.ok(corrected.vehicleMs >= 700_000, `vehicleMs=${corrected.vehicleMs}（公交 120s + 地面段 24s + 弦 603s）`);
  assert.ok(corrected.vehicleM > 6000, `vehicleM=${corrected.vehicleM}`);
});

test('场景二a：步行+休闲骑行(16km/h)+步行——低于判据，纠偏不剔', async () => {
  const legs: Leg[] = [
    { mps: 1.4, sec: 30 },
    { mps: 4.5, sec: 45 }, // 16.2km/h
    { mps: 1.4, sec: 30 },
  ];
  const { accessToken, userId, activityId, pts, clientDistance } = await createUserAndActivity('scn-2a', 0, legs);
  const finish = await app.inject({
    method: 'PUT',
    url: `/sport-track/api/activities/${activityId}/finish`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { trackPoints: pts, clientDistance, pausedMs: 0 },
  });
  assert.equal(finish.json().data.status, 'finished');
  const corrected = await reprocessActivity(activityId, userId);
  assert.equal(corrected.vehicleMs, 0, '4.5m/s 低于 6.5m/s 判据，不剔');
  assert.ok(
    Math.abs(corrected.distance - clientDistance) < clientDistance * 0.05,
    `纠偏前后一致：${corrected.distance} vs ${clientDistance}`,
  );
});

test('场景二b：步行+较快骑行(29km/h)+步行——纠偏判出剔除', async () => {
  const legs: Leg[] = [
    { mps: 1.4, sec: 30 },
    { mps: 8, sec: 90 }, // 28.8km/h；>60s 留余量（清洗吃掉过渡点后仍过 60s 门槛）
    { mps: 1.4, sec: 30 },
  ];
  const { accessToken, userId, activityId, pts, clientDistance } = await createUserAndActivity('scn-2b', 0, legs);
  const finish = await app.inject({
    method: 'PUT',
    url: `/sport-track/api/activities/${activityId}/finish`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { trackPoints: pts, clientDistance, pausedMs: 0 },
  });
  assert.equal(finish.json().data.status, 'finished', '8m/s 中位数低于步行上限 12，不触发作废');
  const corrected = await reprocessActivity(activityId, userId);
  assert.ok(corrected.vehicleMs >= 57_000, `vehicleMs=${corrected.vehicleMs}`);
  assert.ok(corrected.distance < clientDistance * 0.2, `骑行段被剔：${corrected.distance} vs ${clientDistance}`);
});

test('场景三a：散步实际坐车 54km/h——端上全程标记，finish 即剔', async () => {
  const legs: Leg[] = [
    { mps: 1.4, sec: 15 },
    { mps: 15, sec: 90, vehicle: true }, // 54km/h 全程超速
    { mps: 1.4, sec: 15 },
  ];
  const { accessToken, userId, activityId, pts, clientDistance } = await createUserAndActivity('scn-3a', 0, legs);
  const finish = await app.inject({
    method: 'PUT',
    url: `/sport-track/api/activities/${activityId}/finish`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { trackPoints: pts, clientDistance, pausedMs: 0 },
  });
  assert.equal(finish.json().data.status, 'finished');
  assert.ok(clientDistance < 100, `finish 距离只剩步行（${clientDistance}m）`);
  const corrected = await reprocessActivity(activityId, userId);
  assert.ok(corrected.distance < 100, `纠偏后仍剔除坐车段（${corrected.distance}m）`);
  assert.ok(corrected.vehicleM > 1300, `vehicleM=${corrected.vehicleM}`);
});

test('场景三b：散步实际坐车 36km/h——低于端上限未标记，纠偏持续判据剔', async () => {
  const legs: Leg[] = [
    { mps: 1.4, sec: 15 },
    { mps: 10, sec: 120 }, // 36km/h，未超 43km/h，端上不标
    { mps: 1.4, sec: 15 },
  ];
  const { accessToken, userId, activityId, pts, clientDistance } = await createUserAndActivity('scn-3b', 0, legs);
  const finish = await app.inject({
    method: 'PUT',
    url: `/sport-track/api/activities/${activityId}/finish`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { trackPoints: pts, clientDistance, pausedMs: 0 },
  });
  assert.equal(finish.json().data.status, 'finished');
  assert.ok(clientDistance > 1200, `finish 距离含坐车（${clientDistance}m，端上看不出问题）`);
  const corrected = await reprocessActivity(activityId, userId);
  assert.ok(corrected.vehicleMs >= 117_000, `vehicleMs=${corrected.vehicleMs}`);
  assert.ok(corrected.distance < clientDistance * 0.15, `纠偏剔掉坐车段：${corrected.distance} vs ${clientDistance}`);
});
