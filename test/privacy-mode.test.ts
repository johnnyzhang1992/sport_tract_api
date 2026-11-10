/**
 * 隐私模式（2026-11-09）：设置开关 user.settings.privacyMode 开启后——
 * - 运动榜：他人视角下该用户行/本榜最佳匿名（昵称「隐私用户」、头像空、uid 0、数据归零、privacy 标记）；
 *   本人视角自己的行保持真实（Q2）；
 * - 微信步数榜：同款（步数归零 + privacy 标记；me 为查看者本人 → 真实）；
 * - 资料半屏 /stats/profile/:uid：目标为隐私用户且查看者非本人 → 仅返回 privacyMode:true（零值）；
 *   查看者=本人 → 真实资料；
 * - PUT /users/me settings.privacyMode 持久化。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/privacy-mode.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { WerunDayModel } from '../src/models/werun-day.model.js';

let app: FastifyInstance;
const PREFIX = 'openid:privacy-mode';
const OPENID_P = `${PREFIX}_p`; // 隐私用户
const OPENID_V = `${PREFIX}_v`; // 普通查看者
const NOW = Date.now();
const TODAY = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
let tokenP = '';
let tokenV = '';
let uidP = ''; // 公开 uid（数字）
let idP = '';
let idV = '';

async function login(openid: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/sport-track/api/auth/login', payload: { code: `openid:${openid}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.accessToken;
}

async function addSteps(openid: string, date: string, step: number) {
  const u = await UserModel.findOne({ openid });
  await WerunDayModel.updateOne(
    { userId: u!._id, date },
    { $set: { step, syncedAt: Date.now() } },
    { upsert: true },
  );
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  const olds = await UserModel.find({ openid: { $in: [OPENID_P, OPENID_V] } }).select('_id').lean();
  if (olds.length) {
    const ids = olds.map((u) => u._id);
    await ActivityModel.deleteMany({ userId: { $in: ids } });
    await WerunDayModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  }

  // P：隐私用户（跑步 10km + 今日 8000 步 + 开隐私）；V：普通查看者（跑步 3km + 今日 2000 步）
  tokenP = await login(OPENID_P);
  tokenV = await login(OPENID_V);
  const p = await UserModel.findOne({ openid: OPENID_P }).select('_id uid').lean();
  const v = await UserModel.findOne({ openid: OPENID_V }).select('_id uid').lean();
  idP = String(p!._id);
  idV = String(v!._id);
  uidP = Number(p!.uid) || 0;

  await ActivityModel.create({
    userId: p!._id, type: 'running', status: 'finished',
    startTime: NOW - 3600_000, endTime: NOW - 3600_000 + 3600_000,
    duration: 3600 * 50, distance: 500_000, trackPoints: [], markers: [], // 500km：稳进共享库 TOP10
  });
  await ActivityModel.create({
    userId: v!._id, type: 'running', status: 'finished',
    startTime: NOW - 3600_000, endTime: NOW - 3600_000 + 1800_000,
    duration: 1800 * 100, distance: 300_000, trackPoints: [], markers: [], // 300km：稳进共享库 TOP10
  });
  await addSteps(OPENID_P, TODAY, 8000);
  await addSteps(OPENID_V, TODAY, 2000);
  await UserModel.updateOne({ _id: p!._id }, { $set: { 'settings.privacyMode': true } });
});

after(async () => {
  const olds = await UserModel.find({ openid: { $in: [OPENID_P, OPENID_V] } }).select('_id').lean();
  const ids = olds.map((u) => u._id);
  await ActivityModel.deleteMany({ userId: { $in: ids } });
  await WerunDayModel.deleteMany({ userId: { $in: ids } });
  await UserModel.deleteMany({ _id: { $in: ids } });
  await app.close();
});

const get = (url: string, token?: string) =>
  app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });

test('PM1 运动榜：他人视角隐私行匿名（隐私用户/无数据/uid 0），本人视角真实', async () => {
  const asV = await get('/sport-track/api/stats/leaderboard?type=running&period=all', tokenV);
  assert.equal(asV.statusCode, 200, asV.body);
  const rowsV = asV.json().data.top;
  const pRow = rowsV.find((r: { name: string }) => r.name === '隐私用户');
  assert.ok(pRow, '他人视角应出现匿名行');
  assert.equal(pRow.privacy, true);
  assert.equal(pRow.uid, 0, 'uid 不下发（前端不可点开资料卡）');
  assert.equal(pRow.distanceKm, 500, '距离照常展示（口径修订：仅身份匿名）');
  assert.ok(pRow.count >= 1, '轨迹条数照常展示');
  assert.equal(pRow.memberActive, false);
  const vRow = rowsV.find((r: { privacy?: boolean }) => !r.privacy);
  assert.ok(vRow, '查看者自己的行真实');
  assert.equal(vRow.distanceKm, 300);

  // 本人视角：自己的行真实
  const asP = await get('/sport-track/api/stats/leaderboard?type=running&period=all', tokenP);
  const rowsP = asP.json().data.top;
  const mine = rowsP.find((r: { uid: number; name: string }) => r.name !== '隐私用户');
  assert.ok(mine, '本人视角自己的行不是匿名行');
  assert.equal(mine.distanceKm, 500);
});

test('PM2 运动榜 best：他人视角匿名（value 0 + privacy），本人视角真实', async () => {
  const asV = await get('/sport-track/api/stats/leaderboard?type=running&period=all', tokenV);
  const bestV = asV.json().data.best.filter((b: { privacy?: boolean }) => b.privacy);
  assert.ok(bestV.length > 0, '隐私用户的本榜最佳条目应匿名');
  for (const b of bestV) {
    assert.ok(b.value > 0, '纪录值照常展示（口径修订）');
    assert.equal(b.name, '隐私用户', '仅保持者身份匿名');
  }
  const asP = await get('/sport-track/api/stats/leaderboard?type=running&period=all', tokenP);
  const bestP = asP.json().data.best.filter((b: { name: string }) => b.name !== '隐私用户');
  assert.ok(bestP.length > 0);
  assert.ok(bestP.every((b: { privacy?: boolean }) => !b.privacy), '本人视角保持真实');
});

test('PM3 步数榜：他人视角隐私行匿名（步数归零），本人 me 真实', async () => {
  const asV = await get('/sport-track/api/werun/board?period=day', tokenV);
  assert.equal(asV.statusCode, 200, asV.body);
  const rowsV = asV.json().data.top;
  const pRow = rowsV.find((r: { privacy?: boolean }) => r.privacy);
  assert.ok(pRow, '他人视角应出现匿名行');
  assert.equal(pRow.name, '隐私用户');
  assert.equal(pRow.step, 8000, '步数照常展示（口径修订）');
  assert.equal(pRow.uid, 0);
  assert.equal(pRow.gender, 0);
  const vMe = asV.json().data.me;
  assert.ok(vMe, '查看者有步数应有 me 行');
  assert.equal(vMe.step, 2000, '查看者自己的行真实');

  // 本人视角：me 是自己 → 真实步数
  const asP = await get('/sport-track/api/werun/board?period=day', tokenP);
  assert.equal(asP.json().data.me.step, 8000);
});

test('PM4 资料半屏：他人查隐私用户 → privacyMode:true 零值；本人查 → 真实', async () => {
  assert.ok(uidP > 0);
  const asV = await get(`/sport-track/api/stats/profile/${uidP}`, tokenV);
  assert.equal(asV.statusCode, 200, asV.body);
  const dataV = asV.json().data;
  assert.equal(dataV.privacyMode, true, '隐私标记');
  assert.equal(dataV.nickname, '', '昵称不下发');
  assert.equal(dataV.joinDays, 0, '加入天数不下发');
  assert.equal(dataV.total, null, '累计数据不下发');
  assert.equal(dataV.footprint, null);

  // 本人查自己 → 真实（Q2）
  const asP = await get(`/sport-track/api/stats/profile/${uidP}`, tokenP);
  const dataP = asP.json().data;
  assert.equal(dataP.privacyMode, false, '本人查看不匿名');
  assert.ok(dataP.nickname, '昵称真实下发');
  assert.notEqual(dataP.joinDays, 0);
});

test('PM5 设置持久化：PUT /users/me settings.privacyMode → 读取一致', async () => {
  const put = await app.inject({
    method: 'PUT', url: '/sport-track/api/users/me',
    headers: { authorization: `Bearer ${tokenV}` },
    payload: { settings: { unit: 'metric', highAccuracy: true, showBodyData: true, showSportData: true, privacyMode: true, kmAnnounce: true, dailyStepSync: true } },
  });
  assert.equal(put.statusCode, 200, put.body);
  const got = await get('/sport-track/api/users/me', tokenV);
  assert.equal(got.json().data.settings.privacyMode, true);
  // 还原，避免影响其他用例
  await app.inject({
    method: 'PUT', url: '/sport-track/api/users/me',
    headers: { authorization: `Bearer ${tokenV}` },
    payload: { settings: { unit: 'metric', highAccuracy: true, showBodyData: true, showSportData: true, privacyMode: false, kmAnnounce: true, dailyStepSync: true } },
  });
});
