import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';

/**
 * 管理端运动榜行内指标（2026-10-26）：表里加「运动时长」「配速」两列。
 * 口径都是当前筛选范围（类型/省份/周期）内的合计，不是逐条平均：
 * - durationSec = Σ duration（运动时长，与活动榜/小程序同源字段）
 * - paceSecPerKm = Σ duration ÷ Σ distance，取整秒；Σ 距离为 0 时为 null（前端显示「—」）
 * 造数用专门的省份把本文件与其他用例隔离，避免共享库里的数据挤掉名次。
 */

const ADMIN_USER = 't-admin-lb-row-metrics';
const ADMIN_PASS = 'test-admin-pass-123';
const PROVINCE = '测试省LBR';
const OPENID_PREFIX = /^openid:lb-row-metrics/;

let app: FastifyInstance;
let adminToken = '';
const userIds: unknown[] = [];

interface Row {
  name: string;
  distanceKm: number;
  count: number;
  durationSec?: number;
  paceSecPerKm?: number | null;
}

async function fetchRows(type: string): Promise<Row[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/sport-track/api/admin/leaderboard?type=${type}&period=all&province=${encodeURIComponent(PROVINCE)}&limit=20`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.top as Row[];
}

async function createUser(openid: string, nickname: string): Promise<unknown> {
  const u = await UserModel.create({ openid, nickname, gender: 1 });
  userIds.push(u._id);
  return u._id;
}

async function createActivity(
  userId: unknown,
  type: string,
  distance: number,
  duration: number,
): Promise<void> {
  const startTime = Date.now() - 86400000;
  await ActivityModel.create({
    userId,
    type,
    status: 'finished',
    startTime,
    endTime: startTime + duration * 1000,
    duration,
    distance,
    provinces: [PROVINCE],
    startProvince: PROVINCE,
    startCity: '测试市LBR',
    trackPoints: [],
    markers: [],
  });
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  const existing = await AdminModel.findOne({ username: ADMIN_USER });
  if (existing) {
    existing.passwordHash = await hashPassword(ADMIN_PASS);
    await existing.save();
  } else {
    await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  }
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/login',
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  adminToken = login.json().data.token;
  assert.ok(adminToken);

  const stale = await UserModel.find({ openid: OPENID_PREFIX }).select('_id').lean();
  if (stale.length) {
    await ActivityModel.deleteMany({ userId: { $in: stale.map((u) => u._id) } });
    await UserModel.deleteMany({ _id: { $in: stale.map((u) => u._id) } });
  }

  // A：两条跑步，合计 4km / 1800s。逐条配速 300 与 500，算术平均 400 ——
  // 榜单要按合计距离加权得 450，用例才能区分「加权」与「平均各条配速」。
  const a = await createUser('openid:lb-row-metrics-a', '榜行A');
  await createActivity(a, 'running', 1000, 300);
  await createActivity(a, 'running', 3000, 1500);
  // A 的散步：用来验证时长/配速只算当前运动类型
  await createActivity(a, 'walking', 1000, 1200);
  // B：单条跑步，便于核对单人口径
  const b = await createUser('openid:lb-row-metrics-b', '榜行B');
  await createActivity(b, 'running', 500, 100);
  // C：距离与时长都为 0（作废前的空轨迹也可能落库），配速应无值
  const c = await createUser('openid:lb-row-metrics-c', '榜行C');
  await createActivity(c, 'running', 0, 0);
});

after(async () => {
  if (userIds.length) {
    await ActivityModel.deleteMany({ userId: { $in: userIds } });
    await UserModel.deleteMany({ _id: { $in: userIds } });
  }
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

test('LB-M1 榜单行带回运动时长合计与加权平均配速', async () => {
  const rows = await fetchRows('running');
  const a = rows.find((r) => r.name === '榜行A');
  assert.ok(a, `应有榜行A：${JSON.stringify(rows)}`);
  assert.equal(a.distanceKm, 4);
  assert.equal(a.durationSec, 1800, '两条跑步的运动时长合计 300+1500');
  assert.equal(
    a.paceSecPerKm,
    450,
    '按合计距离加权：1800s ÷ 4km = 450s/km；逐条配速算术平均是 400，必须能区分',
  );
});

test('LB-M2 时长与配速只统计当前运动类型 / 省份', async () => {
  const walking = await fetchRows('walking');
  const a = walking.find((r) => r.name === '榜行A');
  assert.ok(a, `散步榜应有榜行A：${JSON.stringify(walking)}`);
  assert.equal(a.durationSec, 1200, '不能把跑步的 1800s 也算进来');
  assert.equal(a.paceSecPerKm, 1200, '1000m / 1200s = 1200s/km');
});

test('LB-M3 距离为 0 时配速为 null（前端显示「—」），时长照常下发', async () => {
  const rows = await fetchRows('running');
  const c = rows.find((r) => r.name === '榜行C');
  assert.ok(c, `应有榜行C：${JSON.stringify(rows)}`);
  assert.equal(c.durationSec, 0);
  assert.equal(c.paceSecPerKm, null, '没有可信距离就不能给配速，别显示 0\'00"');
});

test('LB-M4 单条轨迹的行：时长与配速就是那条的数据', async () => {
  const rows = await fetchRows('running');
  const b = rows.find((r) => r.name === '榜行B');
  assert.ok(b, `应有榜行B：${JSON.stringify(rows)}`);
  assert.equal(b.durationSec, 100);
  assert.equal(b.paceSecPerKm, 200, '500m / 100s');
});
