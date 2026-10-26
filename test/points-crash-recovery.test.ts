/**
 * 签到/补签崩溃恢复（审计 Finding 1 修复回归）。
 *
 * 崩溃夹缝：签到/补签的「占位行落库」与「发分」是两步写，进程崩在中间会留下
 * 一条 points=0 的行——旧行为里重试永远拿不到那笔分（签到）/卡永久损失（补签）。
 * 修复：重试时识别残留行并续跑，credit 同 idemKey 天然幂等不双发。
 *
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/points-crash-recovery.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { PointSigninModel, PointCardModel } from '../src/models/point.model.js';
import { previousDateKey } from '../src/utils/points-domain.js';
import { bjDateStr } from '../src/utils/bj-time.js';

let app: FastifyInstance;
let token = '';
let uid: Types.ObjectId;
const OPENID = `cr_openid_u1_${Date.now()}`; // 每次运行独立命名空间：ledger 的 idemKey 不跨运行残留
const OPENID_PREFIX = /^cr_openid/;
const NOW = Date.now();
const TODAY = bjDateStr(NOW);
const YDAY = previousDateKey(TODAY);

async function purge() {
  const users = await UserModel.find({ openid: OPENID_PREFIX }).select('_id').lean();
  const ids = users.map((u) => u._id);
  if (ids.length) {
    await PointSigninModel.deleteMany({ userId: { $in: ids } });
    await PointCardModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  }
}

/** 用例间封闭：清掉目标日期的签到行与全部卡 */
async function resetRows() {
  await PointSigninModel.deleteMany({ userId: uid, dateKey: { $in: [TODAY, YDAY] } });
  await PointCardModel.deleteMany({ userId: uid });
}

function insertStaleRow(dateKey: string, streakDay: number, source: 'sign' | 'makeup') {
  return PointSigninModel.create({
    userId: uid, dateKey, streakDay, points: 0, source, createdAt: NOW,
  });
}

function insertCard(status: 'unused' | 'used', usedForDate = '') {
  return PointCardModel.create({
    userId: uid, status, expiresAt: NOW + 30 * 86400_000, usedForDate, createdAt: NOW,
  });
}

const usedCardCount = (dateKey: string) =>
  PointCardModel.countDocuments({ userId: uid, status: 'used', usedForDate: dateKey });

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await purge();
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'openid:' + OPENID },
  });
  token = login.json().data.accessToken;
  const u = await UserModel.findOne({ openid: OPENID }).select('_id').lean();
  uid = u!._id as Types.ObjectId;
});

after(async () => {
  await purge();
  await app.close();
});

test('CR1 signIn 崩溃恢复：残留 points=0 的今日行 → 重试补发当天分', async () => {
  await resetRows();
  await insertStaleRow(TODAY, 1, 'sign');
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/points/sign-in',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const r = res.json().data;
  assert.equal(r.alreadySigned, true, '识别为已签（不重复占位）');
  assert.ok(r.credited >= 1, `当天分应补发，实际 credited=${r.credited}`);
  const row = await PointSigninModel.findOne({ userId: uid, dateKey: TODAY }).lean();
  assert.equal(row?.points, 1, '残留行分值应补写');
  assert.ok(r.balance >= 1, `余额应入账，实际 ${r.balance}`);
  // 再次重试不双发：idemKey 已消费（账本记得），恢复分支 credited=0
  const again = await app.inject({
    method: 'POST',
    url: '/sport-track/api/points/sign-in',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(again.json().data.credited, 0, '恢复后的重试不双发');
});

test('CR2 useMakeupCard 恢复：卡已扣 + 残留行 → 从发分步续跑，不再扣新卡', async () => {
  await resetRows();
  await insertStaleRow(YDAY, 1, 'makeup');
  await insertCard('used', YDAY);
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/points/signin/makeup',
    headers: { authorization: `Bearer ${token}` },
    payload: { dateKey: YDAY },
  });
  assert.equal(res.statusCode, 200, res.body);
  const r = res.json().data;
  assert.ok(r.credited >= 1, `补签分应补发，实际 credited=${r.credited}`);
  assert.ok(r.cardId, '返回消耗卡信息');
  assert.equal(await usedCardCount(YDAY), 1, '不得再扣第二张卡');
  const row = await PointSigninModel.findOne({ userId: uid, dateKey: YDAY }).lean();
  assert.equal(row?.points, 1, '残留行分值应补写');
});

test('CR3 useMakeupCard 恢复：残留行无卡 → 清残留走正常流程（扣一张卡）', async () => {
  await resetRows();
  await insertStaleRow(YDAY, 1, 'makeup'); // 上一次崩在扣卡之前
  await insertCard('unused');
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/points/signin/makeup',
    headers: { authorization: `Bearer ${token}` },
    payload: { dateKey: YDAY },
  });
  assert.equal(res.statusCode, 200, res.body);
  const r = res.json().data;
  assert.ok(r.credited >= 1, `补签分应入账，实际 credited=${r.credited}`);
  const cards = await PointCardModel.find({ userId: uid }).lean();
  assert.equal(cards.filter((c) => c.status === 'used').length, 1, '应恰好消耗一张卡');
  assert.equal(cards.filter((c) => c.status === 'unused').length, 0);
  const rows = await PointSigninModel.find({ userId: uid, dateKey: YDAY }).lean();
  assert.equal(rows.length, 1, '残留行应被清理、只留新补签行');
  assert.ok((rows[0]?.points ?? 0) >= 1);
});

test('CR4 完整完成的补签重试：仍 400，不重复扣卡（不因恢复逻辑放过重复补签）', async () => {
  // 沿用 CR3 的完成态：YDAY 已有 points≥1 的补签行、卡已扣
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/points/signin/makeup',
    headers: { authorization: `Bearer ${token}` },
    payload: { dateKey: YDAY },
  });
  assert.equal(res.statusCode, 400, '重复补签必须 400');
  assert.equal(await usedCardCount(YDAY), 1, '不得再扣卡');
});


