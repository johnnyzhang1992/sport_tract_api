import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { LoginLogModel } from '../src/models/login-log.model.js';

/**
 * 运动榜游客可见（2026-10-26）：/leaderboard* 三个接口改可选鉴权——
 * 游客可看榜单主体，me 为 null；且榜单行不下发 userId/openid 等敏感字段（管理端 includeUserId 除外）。
 */

let app: FastifyInstance;
const NOW = Date.now();

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const ids = (await UserModel.find({ openid: /^openid:lb-guest/ }).select('_id').lean()).map((u) => u._id);
  if (ids.length) {
    await ActivityModel.deleteMany({ userId: { $in: ids } });
    await LoginLogModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  }
  const mk = await UserModel.create({ openid: 'openid:lb-guest-a', nickname: '榜客A', gender: 1 });
  await ActivityModel.create({
    userId: mk._id, type: 'running', status: 'finished',
    startTime: NOW - 86400000, endTime: NOW - 86400000 + 600000,
    duration: 600, distance: 2000, trackPoints: [], markers: [],
  });
});

after(async () => {
  const ids = (await UserModel.find({ openid: /^openid:lb-guest/ }).select('_id').lean()).map((u) => u._id);
  if (ids.length) {
    await ActivityModel.deleteMany({ userId: { $in: ids } });
    await LoginLogModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  }
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

const API = '/sport-track/api/stats';

test('LB-G1 游客可看榜单：/leaderboard 200 且含榜单行（top），me 为 null', async () => {
  const res = await app.inject({ method: 'GET', url: `${API}/leaderboard?type=running&period=all` });
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  assert.ok(Array.isArray(d.top), '榜单主体在 top 字段');
  assert.equal(d.me, null, '游客无"我的排名"');
});

test('LB-G2 游客可看 regions 与 type-counts', async () => {
  const r1 = await app.inject({ method: 'GET', url: `${API}/leaderboard-regions` });
  assert.equal(r1.statusCode, 200);
  const r2 = await app.inject({ method: 'GET', url: `${API}/leaderboard-type-counts?period=all` });
  assert.equal(r2.statusCode, 200);
  assert.ok(Array.isArray(r2.json().data.types));
});

test('LB-G3 榜单行不下发 userId/openid（用户端口径）', async () => {
  const res = await app.inject({ method: 'GET', url: `${API}/leaderboard?type=running&period=all` });
  const rows = res.json().data.top as Array<Record<string, unknown>>;
  assert.ok(rows.length > 0, '共享库应有上榜行');
  for (const r of rows) {
    assert.equal('userId' in r, false, `榜单行不得带 userId：${JSON.stringify(r).slice(0, 120)}`);
    assert.equal('openid' in r, false, '榜单行不得带 openid');
  }
  const best = res.json().data.best as Array<Record<string, unknown>>;
  for (const b of best ?? []) {
    assert.equal('userId' in b, false, '本榜最佳行不得带 userId');
    assert.equal('openid' in b, false, '本榜最佳行不得带 openid');
  }
});
