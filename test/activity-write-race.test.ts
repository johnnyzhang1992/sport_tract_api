/**
 * 打点写入的并发正确性（决策 D13 的"幂等去重"要真的成立）
 *
 * appendPoints 原本是"先 findOne 判状态和 lastPointSeq，再 findByIdAndUpdate 裸 $push"：
 * 两个请求同时进来时，各自看到的都是旧的 lastPointSeq，于是同一批 seq 被 $push 两次
 * ——轨迹点重复入库，距离/配速全部虚高。addMarker 的 $pull + $push 是两条独立写，
 * 同一个 marker id 并发提交会留下两份。
 *
 * 这里钉三条不变量：重复上传不产生重复点、并发上传不相交的批次一个都不丢、
 * 同 id 打点并发只留一份。
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { UserModel } from '../src/models/user.model.js';

const OPENID = 'test-race-writer';
let app: FastifyInstance;
let token = '';
let userId = '';

const post = (url: string, payload?: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/sport-track/api/activities${url}`, headers: { authorization: `Bearer ${token}` }, payload });

/** 生成 seq 从 from 起的 n 个点（每点向东挪 5m，时间戳递增 1s） */
const pts = (from: number, n: number) =>
  Array.from({ length: n }, (_, k) => ({
    seq: from + k,
    lat: 31.23,
    lng: 121.47 + (from + k) * 0.00005,
    timestamp: 1700000000000 + (from + k) * 1000,
  }));

async function newActivity() {
  const res = await post('', { type: 'running', startTime: Date.now() });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.activityId as string;
}
async function load(id: string) {
  const a = await ActivityModel.findById(id).select('trackPoints markers lastPointSeq status').lean();
  return a!;
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/sport-track/api/auth/login', payload: { code: OPENID } });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().data.accessToken;
  userId = login.json().data.user.id;
  await cleanup();
});

// 一个用户同时只允许一条进行中活动（服务端硬闸门），所以每条用例开新活动前先放弃旧的
beforeEach(async () => {
  const open = await ActivityModel.findOne({ userId, status: 'in_progress' }).select('_id').lean();
  if (open) {
    const res = await app.inject({
      method: 'PUT',
      url: `/sport-track/api/activities/${open._id}/cancel`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200, res.body);
  }
});

async function cleanup() {
  const users = await UserModel.find({ openid: OPENID }).select('_id');
  await ActivityModel.deleteMany({ userId: { $in: users.map((u) => u._id) } });
  await UserModel.deleteMany({ openid: OPENID });
}

after(async () => {
  await cleanup();
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

test('并发重复上传同一批点：不产生重复 seq', async () => {
  const id = await newActivity();
  const results = await Promise.all([post(`/${id}/points`, { points: pts(1, 10) }), post(`/${id}/points`, { points: pts(1, 10) })]);
  for (const r of results) assert.equal(r.statusCode, 200, r.body);

  const a = await load(id);
  const seqs = a.trackPoints.map((p: any) => p.seq);
  assert.equal(new Set(seqs).size, seqs.length, `出现重复 seq：${JSON.stringify(seqs.sort())}`);
  assert.equal(seqs.length, 10, `应只留 10 个点，实际 ${seqs.length}`);
});

test('并发上传不相交的两批点：一个都不能丢', async () => {
  const id = await newActivity();
  const results = await Promise.all([post(`/${id}/points`, { points: pts(1, 10) }), post(`/${id}/points`, { points: pts(11, 10) })]);
  for (const r of results) assert.equal(r.statusCode, 200, r.body);

  const a = await load(id);
  const seqs = a.trackPoints.map((p: any) => p.seq).sort((x: number, y: number) => x - y);
  assert.equal(seqs.length, 20, `丢了点，只剩 ${JSON.stringify(seqs)}`);
  assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(a.lastPointSeq, 20);
});

test('并发提交同一个 marker id：只留一份', async () => {
  const id = await newActivity();
  const marker = { id: 'm-1', lat: 31.23, lng: 121.47, timestamp: 1700000000000, type: 'checkpoint', label: '并发', note: '', photoUrl: '', address: '' };
  const results = await Promise.all([post(`/${id}/markers`, marker), post(`/${id}/markers`, marker)]);
  for (const r of results) assert.equal(r.statusCode, 200, r.body);

  const a = await load(id);
  assert.equal(a.markers.length, 1, `同 id 打点重复了：${a.markers.length} 份`);
});
