/**
 * GET /admin/stats —— 数据概览页「今日/本周/本月」那组计数
 *
 * 这个接口数的是全站记录，dev 库里始终有别人的数据，所以断言一律走**差分**：
 * 先取基线，插入已知记录，只看增量。
 *
 * 要钉住的两件事：
 *   1) 每档除了「新增轨迹（全状态）」还要给「其中已完成」——概览页第三段要显示 已完成/总；
 *   2) 「今日」的边界是东八区 0 点，不是服务器本地时区的 0 点（部署到 UTC 容器就会整体错位 8 小时，
 *      这条用例外加 TZ=UTC / TZ=Pacific/Kiritimati 跑必须给同样的结果）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';

const ADMIN_USER = 'admin_stats_test';
const ADMIN_PASS = 'test123456';
const OPENID_PREFIX = /^stats_openid/;

/** 东八区今日 0 点（epoch ms）：测试要的是「接口以它为界」这个事实，故与服务器时区无关 */
const bjToday0 = () => {
  const bj = new Date(Date.now() + 8 * 3600000);
  return Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - 8 * 3600000;
};

interface Cell {
  newUsers: number;
  newActivities: number;
  finishedActivities: number;
  newFootprints: number;
  uv: number;
  pv: number;
}
type Stats = Record<string, Cell>;

let app: FastifyInstance;
let adminToken = '';
let userId = '';

async function stats(): Promise<Stats> {
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/admin/stats',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 200);
  return res.json().data as Stats;
}

/** 造一条活动：createdAt 钉死在 ms，status 可控（这个接口只按 createdAt + status 计数） */
async function seedActivity(status: 'finished' | 'cancelled', ms: number) {
  const act = await ActivityModel.create({
    userId,
    type: 'running',
    status,
    startTime: ms,
    endTime: ms + 60_000,
    pausedMs: 0,
    duration: 60,
    distance: 200,
    createdAt: new Date(ms),
  });
  return String(act._id);
}

async function purge() {
  const users = await UserModel.find({ openid: OPENID_PREFIX }).select('_id');
  await ActivityModel.deleteMany({ userId: { $in: users.map((u) => u._id) } });
  await UserModel.deleteMany({ openid: OPENID_PREFIX });
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await purge();
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/login',
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  adminToken = login.json().data.token;
  assert.ok(adminToken, '管理员登录应成功');
  const user = await UserModel.create({ openid: 'stats_openid-owner', nickname: '统计测试用户' });
  userId = String(user._id);
});

after(async () => {
  await purge();
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

test('每档都带 finishedActivities：新增轨迹里已完成的子集', async () => {
  const base = await stats();
  // 全部落在东八区「今日」内（0 点后 1 秒起），三条一起构成 2 完成 + 1 作废
  const t0 = bjToday0() + 1000;
  await seedActivity('finished', t0);
  await seedActivity('finished', t0 + 1000);
  await seedActivity('cancelled', t0 + 2000);

  const d = await stats();
  assert.equal(d.today.newActivities - base.today.newActivities, 3, '三条都算「新增轨迹」');
  assert.equal(
    d.today.finishedActivities - base.today.finishedActivities,
    2,
    '「已完成」子集只数 status=finished，作废那条不该进来',
  );
  for (const k of ['today', 'week', 'month']) {
    assert.ok(
      d[k].finishedActivities <= d[k].newActivities,
      `${k} 档：已完成(${d[k].finishedActivities})不该大于新增总数(${d[k].newActivities})`,
    );
  }
});

test('「今日」以东八区 0 点为界：昨天 23:59:59 的记录不算今日、仍算近 7 天', async () => {
  const base = await stats();
  await seedActivity('finished', bjToday0() - 1000);

  const d = await stats();
  assert.equal(
    d.today.newActivities - base.today.newActivities,
    0,
    '东八区 0 点前的记录不该进今日（按服务器时区算就会：UTC 容器上它属于「昨天」，+14 区里它又变成「今天」）',
  );
  assert.equal(d.today.finishedActivities - base.today.finishedActivities, 0, '已完成子集同界');
  assert.equal(d.week.newActivities - base.week.newActivities, 1, '它是滚动 7 天内该计的记录');
});

test('结构契约：三档同构，pv/uv 一起给（概览页把它们并成一行）', async () => {
  const d = await stats();
  for (const k of ['today', 'week', 'month']) {
    assert.ok(d[k], `缺 ${k} 档`);
    for (const f of ['newUsers', 'newActivities', 'finishedActivities', 'newFootprints', 'uv', 'pv'] as const) {
      assert.equal(typeof d[k][f], 'number', `${k}.${f} 应是数字，实为 ${typeof d[k][f]}`);
    }
    assert.ok(d[k].uv <= d[k].pv, `${k} 档：UV(去重登录用户)不该大于 PV(登录次数)`);
  }
  assert.ok(d.today.newActivities <= d.week.newActivities, '今日 ≤ 近 7 天');
  assert.ok(d.week.newActivities <= d.month.newActivities, '近 7 天 ≤ 近 30 天');
});

test('缺管理员凭证 → 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/sport-track/api/admin/stats' });
  assert.equal(res.statusCode, 401);
});
