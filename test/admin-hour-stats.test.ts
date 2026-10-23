import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { UserModel } from '../src/models/user.model.js';
import { LoginLogModel } from '../src/models/login-log.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { bjToday0 } from '../src/utils/bj-time.js';

/**
 * admin 小时分布统计接口测试：
 * - /admin/login-hour-stats：登录记录按东八区小时分桶（today / week / month）
 * - /admin/activity-hour-stats：已完成轨迹按开始时间东八区小时分桶（同档位）
 *
 * 测试库与其他用例共享，不能断言绝对值；统一用「造数前后同一桶的差值」断言，
 * 既验证时区分桶，也验证 7 天 / 30 天边界和轨迹状态过滤。
 */

const ADMIN_USER = 't-admin-hour-stats';
const ADMIN_PASS = 'test-admin-pass-123';
const DAY = 86400000;
const HOUR = 3600000;

type Bucket = { hour: number; count: number };
type Range = 'today' | 'week' | 'month';

let app: FastifyInstance;
let adminToken = '';
let userId = '';

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

  // 测试用户（mock 登录）：先按返回 id 清残留，避免旧数据累积
  const pre = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'mock_hour_stats_user' },
  });
  const preId = pre.json().data.user?.id;
  if (preId) {
    await LoginLogModel.deleteMany({ userId: preId });
    await ActivityModel.deleteMany({ userId: preId });
    await UserModel.deleteMany({ _id: preId });
  }
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'mock_hour_stats_user' },
  });
  userId = res.json().data.user.id;
  assert.ok(userId);
});

after(async () => {
  if (userId) {
    await LoginLogModel.deleteMany({ userId }).catch(() => {});
    await ActivityModel.deleteMany({ userId }).catch(() => {});
    await UserModel.deleteMany({ _id: userId }).catch(() => {});
  }
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

async function adminReq(url: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${adminToken}` } });
}

/** 三档一次取齐，便于做前后差值 */
async function snapshot(path: string): Promise<Record<Range, Bucket[]>> {
  const out = {} as Record<Range, Bucket[]>;
  for (const range of ['today', 'week', 'month'] as Range[]) {
    const res = await adminReq(`${path}?range=${range}`);
    assert.equal(res.statusCode, 200, `${path} range=${range} 应 200`);
    const d = res.json().data;
    assert.equal(d.range, range);
    out[range] = d.data;
  }
  return out;
}

/** 同一档位逐小时差值 */
function delta(before: Bucket[], after: Bucket[]): number[] {
  return after.map((b, i) => b.count - before[i].count);
}

function assertShape(data: Bucket[]) {
  assert.equal(data.length, 24, '应为 0–23 共 24 个小时桶');
  data.forEach((b, i) => {
    assert.equal(b.hour, i, `第 ${i} 个桶 hour 应为 ${i}`);
    assert.equal(typeof b.count, 'number');
  });
}

test('login-hour-stats：24 桶形状 + 非法 range 兜底 today', async () => {
  const res = await adminReq('/sport-track/api/admin/login-hour-stats');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.range, 'today', '缺省应为 today');
  assertShape(res.json().data.data);

  const bad = await adminReq('/sport-track/api/admin/login-hour-stats?range=nope');
  assert.equal(bad.json().data.range, 'today', '非法 range 应兜底 today');

  const noAuth = await app.inject({ method: 'GET', url: '/sport-track/api/admin/login-hour-stats' });
  assert.equal(noAuth.statusCode, 401, '无管理员凭证应 401');
});

test('login-hour-stats：东八区小时分桶 + today/week/month 边界', async () => {
  const path = '/sport-track/api/admin/login-hour-stats';
  const today0 = bjToday0();
  const before = await snapshot(path);

  // 东八区 00:05（UTC 是前一天 16:05）：不按 +08:00 分桶会落到 16 时
  const docs = [
    { at: today0 + 5 * 60000 }, // 今天 0 时
    { at: today0 + 9 * HOUR }, // 今天 9 时 ×2
    { at: today0 + 9 * HOUR + 60000 },
    { at: today0 - 1 }, // 昨天 23:59:59.999 → 计入 week/month，不计 today
    { at: today0 - 6 * DAY + 3 * HOUR }, // 6 天前 3 时 → week 含今天共 7 个自然日，应计入
    { at: today0 - 7 * DAY + 4 * HOUR }, // 7 天前 4 时 → 不计 week，计 month
    { at: today0 - 29 * DAY + 5 * HOUR }, // 29 天前 5 时 → month 含今天共 30 个自然日，应计入
    { at: today0 - 30 * DAY + 6 * HOUR }, // 30 天前 6 时 → 不计 month
  ];
  await LoginLogModel.insertMany(docs.map((d) => ({ userId, createdAt: new Date(d.at) })));

  const after = await snapshot(path);
  const dToday = delta(before.today, after.today);
  const dWeek = delta(before.week, after.week);
  const dMonth = delta(before.month, after.month);

  // today：只有今天 0 时 ×1、9 时 ×2
  assert.equal(dToday[0], 1, 'today 0 时应 +1（时区分桶）');
  assert.equal(dToday[9], 2, 'today 9 时应 +2');
  assert.equal(dToday[23], 0, '昨天 23 时不应计入 today');
  assert.equal(dToday.reduce((s, v) => s + v, 0), 3, 'today 合计应 +3');

  // week：再加 昨天 23 时、6 天前 3 时；7 天前不算
  assert.equal(dWeek[0], 1);
  assert.equal(dWeek[9], 2);
  assert.equal(dWeek[23], 1, '昨天 23 时应计入 week');
  assert.equal(dWeek[3], 1, '6 天前应计入 week（含今天共 7 天）');
  assert.equal(dWeek[4], 0, '7 天前不应计入 week');
  assert.equal(dWeek.reduce((s, v) => s + v, 0), 5, 'week 合计应 +5');

  // month：再加 7 天前 4 时、29 天前 5 时；30 天前不算
  assert.equal(dMonth[4], 1, '7 天前应计入 month');
  assert.equal(dMonth[5], 1, '29 天前应计入 month（含今天共 30 天）');
  assert.equal(dMonth[6], 0, '30 天前不应计入 month');
  assert.equal(dMonth.reduce((s, v) => s + v, 0), 7, 'month 合计应 +7');
});

test('activity-hour-stats：按开始时间东八区分桶 + 只计已完成', async () => {
  const path = '/sport-track/api/admin/activity-hour-stats';
  const today0 = bjToday0();
  const before = await snapshot(path);

  const base = { userId, type: 'walking', duration: 60, distance: 1000, trackPoints: [], markers: [] };
  const mk = (startTime: number, status: 'finished' | 'in_progress' | 'cancelled' = 'finished') => ({
    ...base,
    status,
    startTime,
    endTime: status === 'in_progress' ? null : startTime + 60000,
  });
  await ActivityModel.insertMany([
    mk(today0 + 10 * 60000), // 今天 0 时（时区分桶）
    mk(today0 + 6 * HOUR), // 今天 6 时 ×2
    mk(today0 + 6 * HOUR + 60000),
    mk(today0 + 6 * HOUR + 120000, 'in_progress'), // 同小时进行中：不计（同用户只允许一条进行中）
    mk(today0 + 6 * HOUR + 180000, 'cancelled'), // 同小时已作废：不计
    mk(today0 - 1), // 昨天 23 时 → week/month 计，today 不计
    mk(today0 - 7 * DAY + 4 * HOUR), // 7 天前 → 只计 month
  ]);

  const after = await snapshot(path);
  const dToday = delta(before.today, after.today);
  const dWeek = delta(before.week, after.week);
  const dMonth = delta(before.month, after.month);

  assert.equal(dToday[0], 1, 'today 0 时应 +1（时区分桶）');
  assert.equal(dToday[6], 2, 'today 6 时应 +2，进行中/已作废不计');
  assert.equal(dToday[23], 0, '昨天 23 时不应计入 today');
  assert.equal(dToday.reduce((s, v) => s + v, 0), 3, 'today 合计应 +3');

  assert.equal(dWeek[23], 1, '昨天 23 时应计入 week');
  assert.equal(dWeek[4], 0, '7 天前不应计入 week');
  assert.equal(dWeek.reduce((s, v) => s + v, 0), 4, 'week 合计应 +4');

  assert.equal(dMonth[4], 1, '7 天前应计入 month');
  assert.equal(dMonth.reduce((s, v) => s + v, 0), 5, 'month 合计应 +5');
});
