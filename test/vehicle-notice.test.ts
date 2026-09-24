/**
 * 「约 X 公里疑似搭车，未计入」这句说明由**服务端拼好下发**（活动 DTO 的 vehicleNotice），
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
  const want = '约 1.00 公里疑似搭车，未计入';
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
  assert.equal((await noticeOf(long)).user, '约 43.21 公里疑似搭车，未计入');
  const short = await seedActivity('short', [false, true, true, false], 40_000, 500);
  assert.equal((await noticeOf(short)).user, '约 0.50 公里疑似搭车，未计入');
});

test('时长为 0 却不该出这句：有车速标记但没量，按脏数据处理', async () => {
  const zeroSec = await seedActivity('zero-sec', [false, true, true, false], 0, 800);
  assert.equal((await noticeOf(zeroSec)).user, '');
});
