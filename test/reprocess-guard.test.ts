/**
 * 重跑纠偏（reprocess）的两道前置校验：id 合法性 + 活动状态
 *
 * 函数注释写的是"对已完成活动重跑"，但实现里既没 gate id 也没看 status：
 * - 非法 id 直接进 findById → CastError → 500（全仓其他入口都走 assertObjectIdLike 返回 404）；
 * - 更糟的是对 in_progress 的活动执行：它 $set 整个 trackPoints 并把 lastPointSeq 重算，
 *   等于把用户正在录的那条覆盖掉，之后客户端再传点会被当成"已存在的 seq"整批丢掉。
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { UserModel } from '../src/models/user.model.js';

const ADMIN_USER = 'test_reprocess_guard';
const ADMIN_PASS = 'rp_pass_123';
const OPENID = 'test-reprocess-guard';

let app: FastifyInstance;
let adminToken = '';
let userToken = '';
let userId = '';

const adminPost = (path: string) =>
  app.inject({ method: 'POST', url: `/sport-track/api/admin${path}`, headers: { authorization: `Bearer ${adminToken}` } });

async function newActivityWithPoints(n = 12) {
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/activities',
    headers: { authorization: `Bearer ${userToken}` },
    payload: { type: 'running', startTime: Date.now() },
  });
  assert.equal(res.statusCode, 200, res.body);
  const id = res.json().data.activityId as string;
  const points = Array.from({ length: n }, (_, k) => ({
    seq: k + 1,
    lat: 31.23 + k * 0.0002,
    lng: 121.47 + k * 0.0002,
    timestamp: Date.now() - (n - k) * 1000,
  }));
  const up = await app.inject({
    method: 'POST',
    url: `/sport-track/api/activities/${id}/points`,
    headers: { authorization: `Bearer ${userToken}` },
    payload: { points },
  });
  assert.equal(up.statusCode, 200, up.body);
  return id;
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
  const login = await app.inject({ method: 'POST', url: '/sport-track/api/admin/login', payload: { username: ADMIN_USER, password: ADMIN_PASS } });
  adminToken = login.json().data.token;
  const ulogin = await app.inject({ method: 'POST', url: '/sport-track/api/auth/login', payload: { code: OPENID } });
  userToken = ulogin.json().data.accessToken;
  userId = ulogin.json().data.user.id;
});

async function cleanup() {
  await ActivityModel.deleteMany({ userId });
  await UserModel.deleteMany({ openid: OPENID });
}

beforeEach(cleanup);
after(async () => {
  await cleanup();
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

test('非法 id 走 404，不是 500', async () => {
  for (const bad of ['abc', 'not-an-id', '12345']) {
    const res = await adminPost(`/activities/${bad}/reprocess`);
    assert.equal(res.statusCode, 404, `id=${bad} 应 404，实际 ${res.statusCode}：${res.body.slice(0, 140)}`);
    assert.ok(!res.body.includes('CastError') && !res.body.includes('E11000'), `响应泄露内部信息：${res.body.slice(0, 160)}`);
  }
});

test('进行中的活动不许重跑纠偏，且轨迹点一个都不被改写', async () => {
  const id = await newActivityWithPoints();
  const beforeDoc = await ActivityModel.findById(id)
    .select('trackPoints lastPointSeq updatedAt')
    .lean();
  assert.equal(beforeDoc!.trackPoints.length, 12);

  const res = await adminPost(`/activities/${id}/reprocess`);
  assert.equal(res.statusCode, 409, res.body);
  const body = res.json();
  assert.equal(body.data?.code, 'ACTIVITY_NOT_FINISHED', `409 要带明确 code：${res.body}`);
  assert.match(body.message, /进行中|in_progress/, `提示要说清当前状态：${body.message}`);

  const after = await ActivityModel.findById(id)
    .select('trackPoints lastPointSeq distance updatedAt')
    .lean();
  assert.equal(after!.trackPoints.length, 12, '被拒之后点数不该变');
  assert.deepStrictEqual(after!.trackPoints, beforeDoc!.trackPoints, '原始点必须逐字段一致');
  assert.equal(after!.lastPointSeq, beforeDoc!.lastPointSeq, 'lastPointSeq 不能被重算');
  // 模型里 corrected 默认就是 true（未完成活动创建时已为 true），拿它证明"没跑过管线"没有判别力；
  // updatedAt 只有在真的执行过 $set 时才前移，能证明整条更新链路一步都没走
  assert.equal(String(after!.updatedAt), String(beforeDoc!.updatedAt), '文档不能被写入过');

  // 录制还能继续：闸门没把活动搞坏
  const more = await app.inject({
    method: 'POST',
    url: `/sport-track/api/activities/${id}/points`,
    headers: { authorization: `Bearer ${userToken}` },
    payload: { points: [{ seq: 13, lat: 31.234, lng: 121.474, timestamp: Date.now() }] },
  });
  assert.equal(more.statusCode, 200, more.body);
  assert.equal((await ActivityModel.findById(id).select('trackPoints').lean())!.trackPoints.length, 13);
});

test('已完成的活动仍能正常重跑（闸门不误伤）', async () => {
  const id = await newActivityWithPoints();
  await ActivityModel.updateOne({ _id: id }, { $set: { status: 'finished', endTime: new Date() } });
  const res = await adminPost(`/activities/${id}/reprocess`);
  assert.equal(res.statusCode, 200, res.body);
  const after = await ActivityModel.findById(id).select('corrected trackPoints').lean();
  assert.equal(after!.corrected, true, '重跑应落纠偏标记');
  assert.ok(after!.trackPoints.length >= 1);
});
