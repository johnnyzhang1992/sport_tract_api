import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';

/**
 * /overview 的「不可信连线」标记下发（pauseGap 暂停间隙 + gapJump 采样断档连线）
 * 为什么单独测：合集页地图上那些斜穿内场的直线，只有把标记一路带到前端才可能断开画；
 * 后端两处最容易丢标记的地方是「字段投影没 select」和「保形抽稀把标记点抽掉后没重打」。
 * 这里直接造库内的紧凑点（不走 finish 管线），只验 overview 这一层。
 */

let app: FastifyInstance;
let token = '';
let userId = '';

const NOW = Date.now();
const STEP_M = 2.2;
const M_PER_DEG = 111320;

/** 201 点直线，第 102 点（下标 101）是一次 89m 的断档落点：均匀抽稀/采样都可能丢它 */
function chordTrack() {
  let lat = 31.2304;
  const pts = [];
  for (let seq = 1; seq <= 201; seq++) {
    pts.push({ seq, lat, lng: 121.4737, timestamp: NOW - 420000 + seq * 2000, ...(seq === 102 ? { gapJump: true } : {}) });
    lat += (seq === 101 ? 89 : STEP_M) / M_PER_DEG;
  }
  return pts;
}
const JUMP_LAT = 31.2304 + (100 * STEP_M + 89) / M_PER_DEG;

async function loginMock(openid: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: openid },
  });
  assert.equal(res.statusCode, 200, `登录失败: ${res.body}`);
  const body = res.json().data;
  return { userId: body.user?.id ?? body.user?._id, token: body.accessToken };
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pre = await loginMock('mock_openid_overview_gap');
  await ActivityModel.deleteMany({ userId: pre.userId });
  await UserModel.deleteMany({ _id: pre.userId });
  const me = await loginMock('mock_openid_overview_gap');
  token = me.token;
  userId = me.userId;
  await ActivityModel.create({
    userId,
    type: 'running',
    status: 'finished',
    startTime: NOW - 420000,
    endTime: NOW,
    distance: 1100,
    duration: 408,
    calories: 80,
    trackPoints: chordTrack(),
  });
});

after(async () => {
  await ActivityModel.deleteMany({ userId }).catch(() => {});
  await UserModel.deleteMany({ _id: userId }).catch(() => {});
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

test('overview 地图点：gapJump 标记穿过保形抽稀后仍挂在断档落点上', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/overview?range=all',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const track = res.json().data.tracks[0];
  const marked = (track.points as Array<{ lat: number; gapJump?: boolean }>).filter(
    (p) => p.gapJump === true,
  );
  assert.equal(marked.length, 1, '地图点里应恰好有 1 个断档落点带标记');
  assert.ok(
    Math.abs(marked[0].lat - JUMP_LAT) < 1e-6,
    `标记应挂在断档落点上：期望 ${JUMP_LAT}，实得 ${marked[0].lat}`,
  );
});

test('overview 缩略图点：gapJump 不被均匀采样丢失', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/overview?range=all',
    headers: { authorization: `Bearer ${token}` },
  });
  const track = res.json().data.tracks[0];
  const pp = track.previewPoints as Array<{ lat: number; gapJump?: boolean; pauseGap?: boolean }>;
  const marked = pp.filter((p) => p.gapJump === true);
  assert.equal(marked.length, 1, '缩略图应补回断档落点');
  assert.ok(Math.abs(marked[0].lat - JUMP_LAT) < 1e-6, '缩略图断点坐标应来自落点原点');
  assert.equal(pp.filter((p) => p.pauseGap === true).length, 0, '不该有暂停标');
});
