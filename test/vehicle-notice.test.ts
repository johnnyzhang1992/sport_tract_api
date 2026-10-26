/**
 * 「约 X 公里疑似定位漂移，未计入」这句说明由**服务端拼好下发**（活动 DTO 的 vehicleNotice），
 * 小程序详情页与 webAdmin 详情弹窗都只渲染这句话，谁都不再自己拼一遍——
 * 之前只有小程序拼了句（段数从点标记现数、时长位移取 vehicleMs/vehicleM），webAdmin 只画了灰线没说明。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/vehicle-notice.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';

const ADMIN_USER = 'admin_notice_test';
const ADMIN_PASS = 'test123456';
const NOW = Date.now();

let app: FastifyInstance;
let userToken = '';
let userId = '';
let adminToken = '';

/** 造一条轨迹：flags 指定哪些点是车速段（连续的算一段） */
function track(flags: boolean[]) {
  return flags.map((v, i) => ({
    seq: i + 1,
    lat: 31.2304 + i * 0.0002,
    lng: 121.4737,
    altitude: null,
    speed: null,
    timestamp: NOW - 3_600_000 + i * 2000,
    ...(v ? { vehicle: true } : {}),
  }));
}

async function seedActivity(name: string, flags: boolean[], vehicleMs: number, vehicleM: number) {
  const act = await ActivityModel.create({
    userId,
    type: 'running',
    status: 'finished',
    startTime: NOW - 3_600_000,
    endTime: NOW - 1_800_000,
    duration: 1800,
    distance: 5000,
    calories: 300,
    vehicleMs,
    vehicleM,
    trackPoints: track(flags),
    note: name,
  });
  return String(act._id);
}

/** 同一个 id 在两个读接口上必须给出同一句话（都出自 toActivityDto） */
async function noticeOf(id: string) {
  const mine = await app.inject({
    method: 'GET',
    url: `/sport-track/api/activities/${id}`,
    headers: { authorization: `Bearer ${userToken}` },
  });
  assert.equal(mine.statusCode, 200, mine.body);
  const admin = await app.inject({
    method: 'GET',
    url: `/sport-track/api/admin/activities/${id}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(admin.statusCode, 200, admin.body);
  return { user: mine.json().data.vehicleNotice, admin: admin.json().data.vehicleNotice };
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  await AdminModel.deleteOne({ username: ADMIN_USER });
  await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  adminToken = (
    await app.inject({
      method: 'POST',
      url: '/sport-track/api/admin/login',
      payload: { username: ADMIN_USER, password: ADMIN_PASS },
    })
  ).json().data.token;

  const users = await UserModel.find({ openid: /^vn_openid/ }).select('_id');
  await ActivityModel.deleteMany({ userId: { $in: users.map((u) => u._id) } });
  await UserModel.deleteMany({ openid: /^vn_openid/ });
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'vn-user' },
  });
  userToken = login.json().data.accessToken;
  userId = login.json().data.user.id;
});

after(async () => {
  await ActivityModel.deleteMany({ userId });
  await UserModel.deleteMany({ openid: /^vn_openid/ });
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await app.close();
});

test('两段车速段：句子里带位移，两个读接口同一句', async () => {
  // 车速点被普通点隔开 → 两段；100s / 1000m
  const id = await seedActivity(
    'two-spans',
    [false, true, true, false, false, true, true, false],
    100_000,
    1000,
  );
  const want = '约 1.00 公里疑似定位漂移，未计入';
  const got = await noticeOf(id);
  assert.equal(got.user, want, `用户端文案不对：${JSON.stringify(got.user)}`);
  assert.equal(got.admin, want, `管理端文案应与用户端一字不差：${JSON.stringify(got.admin)}`);
});

test('没有车速段：下发空串，客户端据此不渲染这行', async () => {
  const id = await seedActivity('no-vehicle', [false, false, false], 0, 0);
  const got = await noticeOf(id);
  assert.equal(got.user, '');
  assert.equal(got.admin, '');
});

test('位移一律按公里保留两位小数（长短两句都读得通）', async () => {
  const long = await seedActivity('long', [false, true, true, false], 3_700_000, 43_210);
  assert.equal((await noticeOf(long)).user, '约 43.21 公里疑似定位漂移，未计入');
  const short = await seedActivity('short', [false, true, true, false], 40_000, 500);
  assert.equal((await noticeOf(short)).user, '约 0.50 公里疑似定位漂移，未计入');
});

test('时长为 0 却不该出这句：有车速标记但没量，按脏数据处理', async () => {
  const zeroSec = await seedActivity('zero-sec', [false, true, true, false], 0, 800);
  assert.equal((await noticeOf(zeroSec)).user, '');
});

// ── 文案按「直线度」分类（2026-10-26 用户拍板）：被运载基本是直线，漂移基本不是直线 ──

/** 沿纬线匀速推进的轨迹：stepM 米/步，stepSec 秒/步，flags 指定 vehicle 标记 */
function straightTrack(steps: number, stepM: number, stepSec: number, marked: boolean[], startLat = 31.2304) {
  const mPerDeg = 111194.9;
  return Array.from({ length: steps + 1 }, (_, i) => ({
    seq: i + 1,
    lat: startLat + (i * stepM) / mPerDeg,
    lng: 121.4737,
    altitude: null,
    speed: null,
    accuracy: 5,
    timestamp: NOW - 3_600_000 + i * stepSec * 1000,
    ...(marked[i] ? { vehicle: true } : {}),
  }));
}

test('分类：直线持续高速段（≥200m/≥30s/直线度≈1）→ 疑似搭车', async () => {
  // 60 步 × 16m × 2s = 960m / 120s，全部标记 → 直线度 1.0
  const pts = straightTrack(60, 16, 2, Array.from({ length: 61 }, (_, i) => i >= 1));
  const act = await ActivityModel.create({
    userId,
    type: 'running',
    status: 'finished',
    startTime: NOW - 3_600_000,
    endTime: NOW - 1_800_000,
    duration: 1800,
    distance: 5000,
    vehicleMs: 120_000,
    vehicleM: 960,
    trackPoints: pts,
    note: 'straight-car',
  });
  const got = await noticeOf(String(act._id));
  assert.equal(got.user, '约 0.96 公里疑似搭车，未计入', `实际：${got.user}`);
});

test('分类：来回跳的碎段（直线度低/位移小）→ 疑似定位漂移', async () => {
  // ±80m 方向交替、每 3s 一点，全标记：直线度 0 → 漂移
  const pts = Array.from({ length: 61 }, (_, i) => ({
    seq: i + 1,
    lat: 31.2304 + ((i % 2 === 0 ? 80 : -80) / 111194.9),
    lng: 121.4737,
    altitude: null,
    speed: null,
    accuracy: 40,
    timestamp: NOW - 3_600_000 + i * 3000,
    ...(i >= 1 ? { vehicle: true } : {}),
  }));
  const act = await ActivityModel.create({
    userId,
    type: 'walking',
    status: 'finished',
    startTime: NOW - 3_600_000,
    endTime: NOW - 1_800_000,
    duration: 1800,
    distance: 3000,
    vehicleMs: 180_000,
    vehicleM: 4800,
    trackPoints: pts,
    note: 'zigzag-drift',
  });
  const got = await noticeOf(String(act._id));
  assert.equal(got.user, '约 4.80 公里疑似定位漂移，未计入', `实际：${got.user}`);
});

test('分类：两类都有 → 一句话里分别报（距离按存储总量比例拆分）', async () => {
  // 前 30 步直线（8m/s × 2s = 16m/步，480m/60s，标记）+ 中间 30 步普通 + 后 30 步原地来回跳（标记）
  const mPerDeg = 111194.9;
  const pts: Array<Record<string, unknown>> = [];
  let lat = 31.2304;
  let ts = NOW - 3_600_000;
  const push = (extra: Record<string, unknown>) => {
    pts.push({ seq: pts.length + 1, lat, lng: 121.4737, altitude: null, speed: null, accuracy: 5, timestamp: ts, ...extra });
    ts += 2000;
  };
  push({}); // 起点
  for (let i = 0; i < 30; i++) {
    lat += 16 / mPerDeg;
    push({ vehicle: true }); // 直线搭车段：480m / 60s
  }
  for (let i = 0; i < 30; i++) {
    lat += 1.4 * 2 / mPerDeg; // 正常步行段
    push({});
  }
  const driftBase = lat;
  for (let i = 0; i < 30; i++) {
    lat = driftBase + ((i % 2 === 0 ? 80 : -80) / mPerDeg); // 原地来回跳（漂移）
    push({ vehicle: true });
  }
  const act = await ActivityModel.create({
    userId,
    type: 'walking',
    status: 'finished',
    startTime: NOW - 3_600_000,
    endTime: NOW - 1_800_000,
    duration: 1800,
    distance: 2000,
    vehicleMs: 120_000,
    vehicleM: 960,
    trackPoints: pts,
    note: 'mixed',
  });
  const got = await noticeOf(String(act._id));
  assert.match(got.user, /^约 0\.\d\d 公里疑似搭车、\d+\.\d\d 公里疑似定位漂移，未计入$/, `实际：${got.user}`);
  // 两类距离之和 = 存储的 vehicleM（按比例分摊不改总量）
  const nums = got.user.match(/\d+\.\d\d/g)!.map(Number);
  assert.ok(Math.abs(nums.reduce((a: number, b: number) => a + b, 0) - 0.96) < 0.02, `两类之和应≈0.96km，实际 ${nums}`);
});
