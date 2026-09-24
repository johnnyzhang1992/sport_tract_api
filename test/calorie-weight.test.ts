/**
 * 卡路里的体重口径：calories = MET × 体重 × 小时，体重**一律取服务端的 user.weightKg**。
 *
 * 背景：calcStats 有 5 条会落卡路里的调用路径（finish / 24h 自动收尾 / 纠偏 / 改类型 / GPX 导入），
 * 之前只有 finish 传了体重、且传的是**客户端上报的** weightKg，其余 4 条都落到 calcStats 的 60kg 默认值。
 * 于是同一个用户「手录」和「导入」的两条记录卡路里口径差 1.5 倍，端上 tracker 实时显示的数值
 * 也对不上入库值。这里把 5 条路径钉在同一个体重上，并钉住「不认客户端传的体重」。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/calorie-weight.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { LoginLogModel } from '../src/models/login-log.model.js';
import { autoFinishStaleActivities } from '../src/services/activity.js';
import { ACTIVITY_TYPE_META, type ActivityType } from '../src/config/constants.js';

/** 档案体重：与 calcStats 的默认 60kg 差 1.5 倍，断言才分得清谁在用哪个 */
const WEIGHT = 90;
const TEST_NOW = Date.now();

let app: FastifyInstance;
let token = '';
let userId = '';

const kcal = (type: string, durationSec: number, kg: number) =>
  Math.round((ACTIVITY_TYPE_META[type as ActivityType]?.met ?? 3.5) * kg * (durationSec / 3600));

/** 入库的卡路里必须等于「档案体重 × 该类型 MET × 净时长」 */
function assertCaliber(act: { type: string; duration: number; calories: number }, where: string) {
  assert.ok(act.duration > 0, `${where}：净时长应 > 0，否则断言没意义`);
  const want = kcal(act.type, act.duration, WEIGHT);
  const byDefault = kcal(act.type, act.duration, 60);
  assert.notEqual(act.calories, byDefault, `${where}：卡路里落到了 60kg 默认值（${act.calories}）`);
  assert.equal(act.calories, want, `${where}：卡路里应等于 MET×${WEIGHT}kg×${act.duration}s = ${want}，实际 ${act.calories}`);
}

async function req(
  method: string,
  url: string,
  body?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: method as 'GET',
    url,
    payload: body,
    headers: { authorization: `Bearer ${token}` },
  });
}

/** 5 点、每点间隔 ~111m / 30s（3.7m/s）：不会被车速段判走，也不会被静止段判停 */
const track = (t0: number) =>
  Array.from({ length: 5 }, (_, i) => ({
    seq: i + 1,
    lat: 31.2304 + i * 0.001,
    lng: 121.4737,
    altitude: null,
    speed: null,
    timestamp: t0 + i * 30000,
  }));

async function createRunning(startTime: number) {
  const created = await req('POST', '/sport-track/api/activities', {
    type: 'running',
    startTime,
  });
  assert.equal(created.statusCode, 200, created.body);
  return created.json().data.activityId as string;
}

async function detail(id: string) {
  const res = await req('GET', `/sport-track/api/activities/${id}`);
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data;
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'cw-user-1' },
  });
  token = login.json().data.accessToken;
  userId = login.json().data.user.id;
  // 逐条新建有 1h 内 10 条的防刷闸，跑完不清就再也跑不动第二轮
  await ActivityModel.deleteMany({ userId });
  await LoginLogModel.deleteMany({ userId });
  await UserModel.updateOne({ _id: userId }, { $set: { weightKg: WEIGHT } });
});

after(async () => {
  await app.close();
});

test('CW1 finish：忽略客户端上报的 weightKg，按档案体重算卡路里', async () => {
  const id = await createRunning(TEST_NOW - 200000);
  const res = await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    trackPoints: track(TEST_NOW - 200000),
    startAddress: '起点',
    endAddress: '终点',
    pausedMs: 0,
    endTime: TEST_NOW - 80000,
    weightKg: 300, // 客户端乱传：不该影响入库
  });
  assert.equal(res.statusCode, 200, res.body);
  assertCaliber(res.json().data.activity, 'finish');
});

test('CW2 改运动类型：按新类型 MET 与档案体重重算卡路里', async () => {
  const id = await createRunning(TEST_NOW - 400000);
  await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    trackPoints: track(TEST_NOW - 400000),
    pausedMs: 0,
    endTime: TEST_NOW - 280000,
  });
  const res = await req('PUT', `/sport-track/api/activities/${id}/meta`, { type: 'walking' });
  assert.equal(res.statusCode, 200, res.body);
  const act = await detail(id);
  assert.equal(act.type, 'walking', '用例前提：类型确实改了');
  assertCaliber(act, '改类型');
});

test('CW3 纠偏（reprocess）：重算后仍按档案体重', async () => {
  const id = await createRunning(TEST_NOW - 600000);
  await req('PUT', `/sport-track/api/activities/${id}/finish`, {
    trackPoints: track(TEST_NOW - 600000),
    pausedMs: 0,
    endTime: TEST_NOW - 480000,
  });
  const res = await req('POST', `/sport-track/api/activities/${id}/reprocess`);
  assert.equal(res.statusCode, 200, res.body);
  assertCaliber(await detail(id), '纠偏');
});

test('CW4 24h 自动收尾：不再落到 60kg 默认值', async () => {
  const t0 = TEST_NOW - 800000;
  const id = await createRunning(t0);
  const uploaded = await req('POST', `/sport-track/api/activities/${id}/points`, {
    points: track(t0),
  });
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  // 伪装成 24h 没更新（杀进程退出），走惰性自动收尾
  const stale = new Date(Date.now() - 25 * 3600 * 1000);
  await ActivityModel.updateOne({ _id: id }, { $set: { updatedAt: stale } }, { timestamps: false });
  const handled = await autoFinishStaleActivities(userId);
  assert.ok(handled >= 1, '自动收尾应处理到这条活动');
  const act = await detail(id);
  assert.equal(act.status, 'finished', '用例前提：这条已被自动收尾');
  assertCaliber(act, '自动收尾');
});

test('CW5 GPX 导入：与手录同一体重口径', async () => {
  const LAT0 = 31.2304;
  const D = (m: number) => LAT0 + m / 111320;
  const rows: string[] = [];
  let ts = TEST_NOW - 1000000;
  for (let m = 0; m <= 200; m += 20) {
    rows.push(`    <trkpt lat="${D(m)}" lon="121.4737"><time>${new Date(ts).toISOString()}</time></trkpt>`);
    ts += 20000;
  }
  const gpx = `<?xml version="1.0"?>\n<gpx version="1.1" creator="test"><trk><trkseg>\n${rows.join('\n')}\n</trkseg></trk></gpx>`;
  const boundary = '----calorieweighttest';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cw.gpx"\r\nContent-Type: application/gpx+xml\r\n\r\n`,
    ),
    Buffer.from(gpx),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const imported = await app.inject({
    method: 'POST',
    url: '/sport-track/api/activities/import',
    payload,
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  assert.equal(imported.statusCode, 200, imported.body);
  const act = await detail(imported.json().data.id);
  assertCaliber(act, '导入');
});
