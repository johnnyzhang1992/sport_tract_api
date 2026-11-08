/**
 * 运营者趋势接口（2026-11-08）：GET /operator/stats/trend?range&granularity。
 * 口径：东八区；新增用户=users.createdAt、PV=登录日志数、UV=桶内去重 userId（周桶重新去重）、
 * 轨迹新增=activities.createdAt（同 summary「新增轨迹」）、轨迹完成=status finished 且 endTime（同「轨迹完成」）。窗口含今天；空桶补 0；周桶周一始。
 * 组合约束：week 仅 day；halfyear 仅 week；month 两者。非法 400 带实际值。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/operator-trend.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { UserModel } from '../src/models/user.model.js';
import { LoginLogModel } from '../src/models/login-log.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { bjToday0, bjDateStr, BJ_OFFSET_MS } from '../src/utils/bj-time.js';
import { operatorTrend } from '../src/services/operator-trend.js';

let app: FastifyInstance;
const RUN = Date.now().toString(36);
const OP = `otrend_op_${RUN}`;
const NORMAL = `otrend_norm_${RUN}`;
const NEWBIE = `otrend_new_${RUN}`;
const DAY = 86_400_000;
const NOW = Date.now();
const D0 = bjToday0(NOW);
let opToken = '';
let normToken = '';
let opId = '';
let normId = '';
let newbieId = '';

const mondayOf = (ms: number) => {
  const day = bjToday0(ms);
  const dow = new Date(day + BJ_OFFSET_MS).getUTCDay();
  return day - ((dow + 6) % 7) * DAY;
};

async function login(openid: string) {
  const res = await app.inject({ method: 'POST', url: `${config.apiPrefix}/auth/login`, payload: { code: `openid:${openid}` } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.accessToken as string;
}

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  app = await buildApp({ logger: false });
  await app.ready();
  opToken = await login(OP);
  normToken = await login(NORMAL);
  await login(NEWBIE);
  const ops = await UserModel.find({ openid: { $in: [OP, NORMAL, NEWBIE] } }).lean();
  opId = String(ops.find((u) => u.openid === OP)?._id);
  normId = String(ops.find((u) => u.openid === NORMAL)?._id);
  newbieId = String(ops.find((u) => u.openid === NEWBIE)?._id);
  await UserModel.updateOne({ _id: ops.find((u) => u.openid === OP)?._id }, { $set: { role: 'admin' } });
  // 三个测试账号的注册日移出所有窗口，newUsers 断言只认夹具
  // （mongoose timestamps 会护住 createdAt，updateOne $set 无效→走 raw collection）
  await UserModel.collection.updateMany(
    { openid: { $in: [OP, NORMAL, NEWBIE] } },
    { $set: { createdAt: new Date(D0 - 400 * DAY) } },
  );
});

beforeEach(async () => {
  await LoginLogModel.deleteMany({ userId: { $in: [opId, normId, newbieId] } });
  await ActivityModel.deleteMany({ userId: { $in: [opId, normId, newbieId] } });
});

after(async () => {
  await LoginLogModel.deleteMany({ userId: { $in: [opId, normId, newbieId] } });
  await ActivityModel.deleteMany({ userId: { $in: [opId, normId, newbieId] } });
  await UserModel.deleteMany({ openid: { $in: [OP, NORMAL, NEWBIE] } });
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const log = (userId: string, at: number) => LoginLogModel.create({ userId, createdAt: new Date(at) });

/** 共享 dev 库有真实数据：造数前后各拉一次，断言差值（不写死绝对值） */
async function delta(range: 'week' | 'month' | 'halfyear', gran: 'day' | 'week' | undefined, add: () => Promise<void>) {
  const before = await operatorTrend(range, gran, NOW);
  await add();
  const after = await operatorTrend(range, gran, NOW);
  const m = new Map(before.buckets.map((b) => [b.key, b]));
  const buckets = after.buckets.map((b) => {
    const p = m.get(b.key);
    return {
      key: b.key,
      label: b.label,
      uv: b.uv - (p?.uv ?? 0),
      pv: b.pv - (p?.pv ?? 0),
      newUsers: b.newUsers - (p?.newUsers ?? 0),
      tracksCreated: b.tracksCreated - (p?.tracksCreated ?? 0),
      tracksFinished: b.tracksFinished - (p?.tracksFinished ?? 0),
    };
  });
  return { granularity: after.granularity, buckets };
}

const consecutive = (keys: string[], step: number) => {
  for (let i = 1; i < keys.length; i++) {
    assert.equal(Date.parse(keys[i] + 'T00:00:00+08:00') - Date.parse(keys[i - 1] + 'T00:00:00+08:00'), step, `桶键连续 ${keys[i - 1]}→${keys[i]}（空桶补零）`);
  }
};

test('OT-1 闸门与入参：401/403；非法 range/granularity/组合 400 带实际值', async () => {
  const base = `${config.apiPrefix}/operator/stats/trend`;
  assert.equal((await app.inject({ method: 'GET', url: base })).statusCode, 401);
  const norm = await app.inject({ method: 'GET', url: `${base}?range=week`, headers: auth(normToken) });
  assert.equal(norm.statusCode, 403);
  assert.match(norm.json().message, /仅运营者/);

  const badRange = await app.inject({ method: 'GET', url: `${base}?range=year`, headers: auth(opToken) });
  assert.equal(badRange.statusCode, 400);
  assert.match(badRange.json().message, /year/);
  assert.match(badRange.json().message, /week\/month\/halfyear/);

  const badGran = await app.inject({ method: 'GET', url: `${base}?range=month&granularity=hour`, headers: auth(opToken) });
  assert.equal(badGran.statusCode, 400);
  assert.match(badGran.json().message, /hour/);

  const weekWeek = await app.inject({ method: 'GET', url: `${base}?range=week&granularity=week`, headers: auth(opToken) });
  assert.equal(weekWeek.statusCode, 400);
  const halfDay = await app.inject({ method: 'GET', url: `${base}?range=halfyear&granularity=day`, headers: auth(opToken) });
  assert.equal(halfDay.statusCode, 400);
  assert.match(halfDay.json().message, /180/);
});

test('OT-2 week/day：7 桶补零；UV 去重 PV 计数；轨迹新增按创建、完成按结束时间归桶', async () => {
  const dayX = D0 - 2 * DAY;
  const d = await delta('week', 'day', async () => {
    await log(opId, dayX + 10 * 3600_000);
    await log(opId, dayX + 11 * 3600_000);
    await log(normId, dayX + 12 * 3600_000);
    await log(opId, D0 - DAY + 9 * 3600_000);
    await UserModel.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(newbieId) },
      { $set: { createdAt: new Date(dayX + 8 * 3600_000) } },
    );
    await ActivityModel.insertMany(
      [
        // 3 天前创建、今天完成：新增归创建日，完成归今天
        { userId: opId, type: 'running', status: 'finished', startTime: dayX - 3 * DAY, endTime: dayX + 9 * 3600_000, createdAt: new Date(dayX - 3 * DAY) },
        // 进行中：算新增、不算完成
        { userId: opId, type: 'walking', status: 'in_progress', startTime: dayX + 10 * 3600_000, createdAt: new Date(dayX + 10 * 3600_000) },
        // 今天创建、昨天完成：完成归昨天
        { userId: normId, type: 'hiking', status: 'finished', startTime: dayX + 8 * 3600_000, endTime: D0 - DAY + 9 * 3600_000, createdAt: new Date(dayX + 8 * 3600_000) },
      ],
      { timestamps: false },
    );
  });
  assert.equal(d.buckets.length, 7);
  assert.equal(d.buckets[6].key, bjDateStr(D0), '末桶=今天');
  consecutive(d.buckets.map((b) => b.key), DAY);
  const x = d.buckets.find((b) => b.key === bjDateStr(dayX));
  assert.deepEqual(
    { uv: x?.uv, pv: x?.pv, newUsers: x?.newUsers, tracksCreated: x?.tracksCreated, tracksFinished: x?.tracksFinished },
    { uv: 2, pv: 3, newUsers: 1, tracksCreated: 2, tracksFinished: 1 },
  );
  const y = d.buckets.find((b) => b.key === bjDateStr(D0 - DAY));
  assert.equal(y?.uv, 1);
  assert.equal(y?.pv, 1);
  assert.equal(y?.tracksCreated, 0, '昨天创建的那条已计入今天');
  assert.equal(y?.tracksFinished, 1, '昨天完成的进昨天桶');
  const z = d.buckets.find((b) => b.key === bjDateStr(dayX - 3 * DAY));
  assert.equal(z?.tracksCreated, 1, '3 天前创建的归创建日');
  assert.equal(z?.tracksFinished, 0);
  const hit = new Set([bjDateStr(dayX), bjDateStr(D0 - DAY), bjDateStr(dayX - 3 * DAY)]);
  for (const b of d.buckets) {
    if (!hit.has(b.key)) {
      assert.deepEqual([b.uv, b.pv, b.newUsers, b.tracksCreated, b.tracksFinished], [0, 0, 0, 0, 0], `夹具只落在三天 ${b.key}`);
    }
    assert.match(b.label, /^\d{1,2}\/\d{1,2}$/, '标签 M/D');
  }
  // 夹具注册日还原，避免影响后续用例
  await UserModel.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(newbieId) },
    { $set: { createdAt: new Date(D0 - 400 * DAY) } },
  );
});

test('OT-3 东八区日边界：BJ 23 点与次日 BJ 1 点分属两桶', async () => {
  const dayStart = D0 - 3 * DAY;
  const d = await delta('week', 'day', async () => {
    await log(opId, dayStart + 23 * 3600_000); // BJ 当日 23:00
    await log(opId, dayStart + 25 * 3600_000); // BJ 次日 01:00
  });
  assert.equal(d.buckets.find((b) => b.key === bjDateStr(dayStart))?.pv, 1);
  assert.equal(d.buckets.find((b) => b.key === bjDateStr(dayStart + DAY))?.pv, 1);
});

test('OT-4 month/week：周桶周一始；UV 周内重新去重（≠逐日 UV 相加）', async () => {
  const mon = mondayOf(D0);
  const d = await delta('month', 'week', async () => {
    await log(opId, mon + DAY + 10 * 3600_000); // 周二
    await log(opId, mon + 2 * DAY + 10 * 3600_000); // 周三
    await log(normId, mon - DAY + 10 * 3600_000); // 上一周周日
  });
  assert.equal(d.granularity, 'week');
  assert.equal(d.buckets[0].key, bjDateStr(mondayOf(D0 - 29 * DAY)), '首桶=窗口首日所在周的周一');
  consecutive(d.buckets.map((b) => b.key), 7 * DAY);
  const cur = d.buckets.find((b) => b.key === bjDateStr(mon));
  assert.equal(cur?.uv, 1, '同一人周二+周三登录，周 UV=1');
  assert.equal(cur?.pv, 2);
  const prev = d.buckets.find((b) => b.key === bjDateStr(mon - 7 * DAY));
  assert.equal(prev?.uv, 1, '周日登录归上一周（周一始）');
  assert.equal(prev?.pv, 1);
});

test('OT-5 halfyear/week：窗口=近 6 个自然月；窗口外不计；全桶补零', async () => {
  const bj = new Date(D0 + BJ_OFFSET_MS);
  const monthStart = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth() - 5, 1) - BJ_OFFSET_MS;
  const d = await delta('halfyear', undefined, async () => {
    await log(opId, monthStart + 3 * DAY);
    await log(opId, monthStart - 2 * DAY); // 窗口外
  });
  assert.equal(d.granularity, 'week', '半年默认周粒度');
  assert.equal(d.buckets[0].key, bjDateStr(mondayOf(monthStart)));
  assert.equal(d.buckets[d.buckets.length - 1].key, bjDateStr(mondayOf(D0)));
  consecutive(d.buckets.map((b) => b.key), 7 * DAY);
  assert.equal(d.buckets.reduce((s, b) => s + b.pv, 0), 1, '窗口外登录不计');
});

test('OT-6 路由形状：默认粒度 week→day/halfyear→week；buckets 升序', async () => {
  const base = `${config.apiPrefix}/operator/stats/trend`;
  const w = await app.inject({ method: 'GET', url: `${base}?range=week`, headers: auth(opToken) });
  assert.equal(w.statusCode, 200, w.body);
  assert.equal(w.json().data.granularity, 'day');
  assert.equal(w.json().data.buckets.length, 7);
  const h = await app.inject({ method: 'GET', url: `${base}?range=halfyear`, headers: auth(opToken) });
  assert.equal(h.statusCode, 200, h.body);
  assert.equal(h.json().data.granularity, 'week');
  const keys = h.json().data.buckets.map((b: { key: string }) => b.key);
  assert.deepEqual(keys, [...keys].sort(), '桶升序');
});