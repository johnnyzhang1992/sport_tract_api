/**
 * 管理端活动列表 startTimeFrom / startTimeTo 开始时间区间过滤（活动详情弹窗用）。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/admin-activities-time-filter.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';

let app: FastifyInstance;
let adminToken = '';
let userId = '';
const NS = 'openid:tf-';
const BASE = Date.now() - 10 * 86400_000;
const ids: Record<string, string> = {}; // key A/B → 活动 id

async function purge() {
  const users = await UserModel.find({ openid: /^tf-/ }).select('_id').lean();
  const ids = users.map((u) => u._id);
  if (ids.length) {
    await ActivityModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  }
  await AdminModel.deleteMany({ username: 'tf-admin' });
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await purge();
  await AdminModel.create({ username: 'tf-admin', passwordHash: await hashPassword('tf-pass-123') });
  const adminLogin = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/login',
    payload: { username: 'tf-admin', password: 'tf-pass-123' },
  });
  adminToken = adminLogin.json().data.token;

  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'openid:tf-user' },
  });
  const u = await UserModel.findOne({ openid: 'tf-user' }).select('_id').lean();
  userId = String(u!._id);

  // 两条轨迹：A 在 base 日，B 在 base+5 天
  for (const [k, offsetDays] of [['A', 0], ['B', 5]] as const) {
    const start = BASE + offsetDays * 86400_000;
    const pts = Array.from({ length: 5 }, (_, i) => ({
      seq: i + 1,
      lat: 30 + (i * 100) / 111194.9,
      lng: 114,
      timestamp: start + i * 60_000,
    }));
    const doc = await ActivityModel.create({
      userId: u!._id,
      type: 'walking',
      status: 'finished',
      startTime: start,
      endTime: start + 300_000,
      distance: 400,
      trackPoints: pts,
    });
    ids[k] = String(doc._id);
  }
  void login;
});

after(async () => {
  await purge();
  await app.close();
});

test('TF1 startTimeFrom：只返回区间起点之后的轨迹', async () => {
  const from = BASE + 3 * 86400_000;
  const res = await app.inject({
    method: 'GET',
    url: `/sport-track/api/admin/activities?userId=${userId}&startTimeFrom=${from}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const items = res.json().data.items as Array<{ id: string }>;
  assert.equal(items.length, 1, `应只有 B 一条，实际 ${items.length}`);
  assert.equal(items[0].id, ids.B, '返回的应是 B');
});

test('TF2 startTimeFrom+To：两端夹住的才返回', async () => {
  const from = BASE - 86400_000;
  const to = BASE + 86_399_000; // A 的窗口内
  const res = await app.inject({
    method: 'GET',
    url: `/sport-track/api/admin/activities?userId=${userId}&startTimeFrom=${from}&startTimeTo=${to}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const items = res.json().data.items as Array<{ id: string }>;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, ids.A, '只应返回 A');
});

test('TF3 userId + 区间组合：互不影响', async () => {
  const from = BASE + 3 * 86400_000;
  const res = await app.inject({
    method: 'GET',
    url: `/sport-track/api/admin/activities?userId=${userId}&startTimeFrom=${from}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const items = res.json().data.items as Array<{ id: string; userId: string }>;
  assert.ok(items.every((i) => String(i.userId) === userId));
});
