/**
 * 唯一索引冲突要翻成 409，不能裸奔成 500
 *
 * "同一用户同时只允许一条进行中活动"靠两层：应用层 findOne + 数据库 partial unique index
 * （unique_in_progress_per_user）。findOne 有并发窗口，真正兜底的是索引——但索引抛的是
 * MongoServerError code=11000，错误处理里没有这一支，于是并发创建时输的那个请求直接 500，
 * dev 下还会把集合名、索引名、对方 userId 的 ObjectId 原样吐进响应体。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { UserModel } from '../src/models/user.model.js';

const OPENID = 'test-dup-key';
let app: FastifyInstance;
let token = '';
let userId = '';

const create = (type: string) =>
  app.inject({ method: 'POST', url: '/sport-track/api/activities', headers: { authorization: `Bearer ${token}` }, payload: { type, startTime: Date.now() } });

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/sport-track/api/auth/login', payload: { code: OPENID } });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().data.accessToken;
  userId = login.json().data.user.id;
});

async function cleanup() {
  await ActivityModel.deleteMany({ userId });
  await UserModel.deleteMany({ openid: OPENID });
}

after(async () => {
  await cleanup();
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

test('并发创建：输的一方拿 409 而不是 500，且库里只留一条进行中', async () => {
  // 连跑 3 轮：并发路径不能只在某一次调度下成立
  for (let round = 1; round <= 3; round++) {
    await ActivityModel.deleteMany({ userId });
    const rs = await Promise.all([create('running'), create('walking')]);
    for (const r of rs) {
      assert.ok(r.statusCode < 500, `第 ${round} 轮出现 ${r.statusCode}（唯一索引冲突漏到通用 500 分支）：${r.body.slice(0, 140)}`);
    }
    const loser = rs.find((r) => r.statusCode === 409);
    assert.ok(loser, `第 ${round} 轮应恰好有一个请求被拒（两个都 200 说明互斥失效）：${rs.map((r) => r.statusCode).join('/')}`);
    const body = loser.json();
    assert.equal(body.data?.code, 'ACTIVITY_IN_PROGRESS', `409 要复用应用层那个 code，客户端才认：${loser.body}`);
    assert.match(body.message, /进行中的运动/);
    assert.equal(
      await ActivityModel.countDocuments({ userId, status: 'in_progress' }),
      1,
      `第 ${round} 轮进行中活动数应为 1`,
    );
  }
});

test('冲突响应不泄露内部信息', async () => {
  await ActivityModel.deleteMany({ userId });
  const rs = await Promise.all([create('running'), create('cycling')]);
  const loser = rs.find((r) => r.statusCode >= 400);
  assert.ok(loser, '这一轮没触发冲突，测不到泄露（并发调度变了就要重看用例）');
  const body = loser!.body;
  for (const leak of ['E11000', 'duplicate key', 'sport-track-dev', 'unique_in_progress_per_user', 'ObjectId']) {
    assert.ok(!body.includes(leak), `响应里出现了内部信息 ${leak}：${body.slice(0, 200)}`);
  }
});
