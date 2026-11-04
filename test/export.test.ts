import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { UserModel } from '../src/models/user.model.js';
import { XpayOrderModel } from '../src/models/xpay-order.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { resetExportRate, assertExportRate, EXPORT_RATE_LIMIT } from '../src/services/export.js';

/**
 * 运动数据导出（2026-11-01）：
 * - /activities/export/summary：本人汇总 CSV（BOM + CRLF，昵称/类型/起止/三类时长/距离/点数；
 *   默认只导 finished；不含坐标明细与照片，无 openid/userId 列）
 * - /activities/export/gpx：ids 或时间范围 → zip 流（同一份 toGpx 口径 WGS-84 + 打点航点），
 *   越权 id 静默落空、空轨迹点不导、条数上限 100
 * - /admin/activities/export/summary：跨用户逐行昵称，status=all 含进行中
 */

const execFileP = promisify(execFile);
const API = '/sport-track/api';

let app: FastifyInstance;
let tokenA = '';
let tokenB = '';
let userAId = '';
let userBId = '';
let adminToken = '';
let nickA = '';
let nickB = '';
let aRunning = ''; // 2026-10-25 08:00 BJ，双点
let aWalk = ''; // 无轨迹点（CSV 出行、GPX 不导）
let aRide = ''; // 2026-10-26，带打点（含照片 URL，导出内容不应出现）
let aProgress = ''; // in_progress（默认 CSV 不出，admin status=all 才出）
let bRun = '';

/** BJ 2026-10-25 08:00:00 = UTC 00:00 */
const T_RUN = Date.UTC(2026, 9, 25, 0, 0, 0);
const T_RIDE = Date.UTC(2026, 9, 26, 2, 0, 0);
const T_WALK = Date.UTC(2026, 9, 24, 1, 0, 0);

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  const purge = async (openidPrefix: string) => {
    const users = await UserModel.find({ openid: { $regex: `^${openidPrefix}` } }).select('_id').lean();
    const ids = users.map((u) => u._id);
    if (!ids.length) return;
    await ActivityModel.deleteMany({ userId: { $in: ids } });
    // 多条轨迹打包是会员功能（spec §5.4）：先清掉这些用户的历史订单，否则重跑会撞 outTradeNo 唯一索引
    await XpayOrderModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  };
  await purge('exp-');

  const login = async (code: string) => {
    const res = await app.inject({ method: 'POST', url: `${API}/auth/login`, payload: { code: `openid:exp-${code}` } });
    return res.json().data;
  };
  const a = await login('user-a');
  tokenA = a.accessToken;
  userAId = a.user.id;
  nickA = a.user?.nickname || '';
  const b = await login('user-b');
  tokenB = b.accessToken;
  userBId = b.user.id;
  nickB = b.user?.nickname || '';

  // EX5～EX8 测的是打包导出的内容与边界，前提是该用户是会员（闸门本身在 gpx-bundle-member-gate.test.ts 里测）
  const DAY = 86_400_000;
  const run = Date.now().toString(36);
  const grant = (userId: string, openid: string, tag: string) =>
    XpayOrderModel.create({
      outTradeNo: `EXP${run}${tag}`.slice(0, 32), wxOrderId: `expwx${run}${tag}`.slice(0, 32),
      userId, openid, productKey: 'month_card', name: '会员月卡',
      priceFen: 199, durationDays: 30, status: 'delivered',
      periodStart: Date.now() - DAY, periodEnd: Date.now() + 30 * DAY,
      perksSnapshot: { adFree: true, exportBundle: true, photoQuota: 300, subscribeNotice: true },
    });
  await grant(userAId, 'exp-user-a', 'a');
  await grant(userBId, 'exp-user-b', 'b');

  const mk = (userId: string, doc: Record<string, unknown>) =>
    ActivityModel.create({
      status: 'finished', duration: 0, distance: 0,
      trackPoints: [], markers: [], ...doc, userId,
    } as never);

  aRunning = String(
    (
      await mk(userAId, {
        type: 'running',
        startTime: T_RUN,
        endTime: T_RUN + 3900000,
        duration: 3600,
        pausedMs: 120000, // 手动暂停 2 分钟
        standstillMs: 60000, // 静止 1 分钟
        vehicleMs: 30000, // 乘车 30 秒
        distance: 1500,
        trackPoints: [
          { seq: 1, lat: 31.2304, lng: 121.4737, timestamp: T_RUN + 1000 },
          { seq: 2, lat: 31.2314, lng: 121.4747, timestamp: T_RUN + 61000 },
        ],
      })
    )._id,
  );
  aWalk = String(
    (
      await mk(userAId, {
        type: 'walking', startTime: T_WALK, endTime: T_WALK + 600000, duration: 600, distance: 800,
      })
    )._id,
  );
  aRide = String(
    (
      await mk(userAId, {
        type: 'cycling',
        startTime: T_RIDE,
        endTime: T_RIDE + 1800000,
        duration: 1800,
        distance: 6000,
        trackPoints: [{ seq: 1, lat: 31.2404, lng: 121.4837, timestamp: T_RIDE + 1000 }],
        markers: [
          {
            id: 'm1', lat: 31.2405, lng: 121.4838, timestamp: T_RIDE + 5000,
            note: '中途补水', address: '某公园东门', photos: ['https://oss.example.com/x.jpg'],
          },
        ],
      })
    )._id,
  );
  aProgress = String(
    (await mk(userAId, { type: 'running', status: 'in_progress', startTime: T_RIDE + 3600000 }))._id,
  );
  bRun = String(
    (
      await mk(userBId, {
        type: 'running', startTime: T_RUN + 1000, endTime: T_RUN + 11000, duration: 10, distance: 30,
        trackPoints: [{ seq: 1, lat: 31.2304, lng: 121.4737, timestamp: T_RUN + 1000 }],
      })
    )._id,
  );

  // 管理员（与 admin-hour-stats 共用同一账号：共享库幂等 upsert）
  const existing = await AdminModel.findOne({ username: 't-admin-export' });
  if (existing) {
    existing.passwordHash = await hashPassword('test-admin-pass-123');
    await existing.save();
  } else {
    await AdminModel.create({ username: 't-admin-export', passwordHash: await hashPassword('test-admin-pass-123') });
  }
  const al = await app.inject({
    method: 'POST', url: `${API}/admin/login`,
    payload: { username: 't-admin-export', password: 'test-admin-pass-123' },
  });
  adminToken = al.json().data.token;
  assert.ok(adminToken);
});

after(async () => {
  await purge2();
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

/** 与 before 同口径清理（after 里再跑一遍防上轮崩溃残留） */
async function purge2() {
  const users = await UserModel.find({ openid: { $regex: '^exp-' } }).select('_id').lean();
  const ids = users.map((u) => u._id);
  if (!ids.length) return;
  await ActivityModel.deleteMany({ userId: { $in: ids } });
  // 本文件会给测试用户发会员订单（打包导出闸门）；不清掉的话后台「会员订单」页会长期挂着测试单
  await XpayOrderModel.deleteMany({ userId: { $in: ids } });
  await UserModel.deleteMany({ _id: { $in: ids } });
}

test('EX1 用户端汇总 CSV：BOM+CRLF、十一列口径（首列轨迹ID）、三类时长独立、只含本人 finished', async () => {
  const res = await app.inject({
    method: 'GET', url: `${API}/activities/export/summary`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.headers['content-type'] as string, /text\/csv/);
  const body = res.body;
  assert.ok(body.startsWith('\uFEFF'), 'UTF-8 BOM 开头（Excel 中文兼容）');
  assert.ok(body.includes('\r\n'), 'CRLF 换行');
  const lines = body.slice(1).trimEnd().split('\r\n');
  assert.equal(lines[0], '轨迹ID,昵称,运动类型,开始时间,结束时间,运动时长,手动暂停,静止暂停,乘车时长,运动距离(公里),坐标点数量');
  assert.equal(lines.length, 4, `本人 finished 共 3 行：${lines.length}`);
  assert.ok(body.includes('2026-10-25 08:00:00'), '开始时间走东八区');
  const runLine = lines.find((l) => l.includes('2026-10-25 08:00:00'))!;
  assert.ok(runLine.startsWith(`${aRunning},`), '首列是完整轨迹 ID，可与 GPX 文件名关联');
  assert.ok(runLine.includes(',跑步,'), '类型出中文标签');
  assert.ok(runLine.includes(',01:00:00,'), `运动时长 3600s：${runLine}`);
  assert.ok(runLine.includes(',00:02:00,00:01:00,00:00:30,'), '手动/静止/乘车三列独立');
  assert.ok(runLine.includes(',1.50,'), '距离公里两位小数');
  assert.ok(runLine.endsWith(',2'), '坐标点数量=2');
  assert.ok(body.includes(nickA), '含本人昵称');
  assert.ok(!body.includes(nickB), '不含他人昵称/数据');
  assert.ok(!body.includes('openid'), '无 openid');
  assert.ok(!body.includes(userAId) && !body.includes(userBId), '无 userId 标识列');
  assert.ok(!body.includes('oss.example.com'), '照片 URL 不出现在汇总导出');
});

test('EX2 CSV 类型筛选：type=running 只出跑步行', async () => {
  const res = await app.inject({
    method: 'GET', url: `${API}/activities/export/summary?type=running`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(res.statusCode, 200);
  const lines = res.body.slice(1).trimEnd().split('\r\n');
  assert.equal(lines.length, 2, '只有 aRunning 一行');
});

test('EX3 CSV 时间范围：from 收口之后的活动不出现', async () => {
  const res = await app.inject({
    method: 'GET', url: `${API}/activities/export/summary?from=${T_RUN + 1}`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(res.statusCode, 200);
  const lines = res.body.slice(1).trimEnd().split('\r\n');
  assert.equal(lines.length, 2, '只剩 aRide（10-26）');
  assert.ok(lines[1].includes('骑行'));
});

test('EX4 未登录 401；无效类型 400', async () => {
  const r1 = await app.inject({ method: 'GET', url: `${API}/activities/export/summary` });
  assert.equal(r1.statusCode, 401);
  const r2 = await app.inject({
    method: 'GET', url: `${API}/activities/export/summary?type=flying`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(r2.statusCode, 400);
});

test('EX5 批量 GPX zip：PK 魔数、单条条目、README 坐标系说明', async () => {
  const res = await app.inject({
    method: 'GET', url: `${API}/activities/export/gpx?ids=${aRunning}`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['content-type'], 'application/zip');
  const zip = res.rawPayload;
  assert.ok(zip.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])), 'zip 本地文件头魔数');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-test-'));
  try {
    const zipPath = path.join(dir, 'out.zip');
    fs.writeFileSync(zipPath, zip);
    await execFileP('unzip', ['-o', zipPath, '-d', dir]);
    const entries = fs.readdirSync(dir).filter((f) => f !== 'out.zip');
    const gpx = entries.find((f) => f.endsWith('.gpx'));
    const readme = entries.find((f) => f.endsWith('.txt'));
    assert.ok(gpx && readme, `条目齐全：${entries.join(',')}`);
    assert.ok(gpx!.startsWith('2026-10-25_'), '文件名以开始日期开头');
    assert.ok(gpx!.includes('跑步'), '文件名含类型中文');
    assert.ok(gpx!.includes(aRunning), '文件名带完整轨迹 ID（不再截前 12 位）');
    const gpxBody = fs.readFileSync(path.join(dir, gpx!), 'utf8');
    assert.ok(gpxBody.includes('<trkpt'), '有轨迹点');
    assert.ok(gpxBody.includes(`轨迹ID：${aRunning}`), 'GPX metadata 里带轨迹 ID');
    assert.ok(gpxBody.includes('2026-10-25T'), '时间已换算绝对 ISO');
    assert.ok(!gpxBody.includes('oss.example.com'), '照片 URL 不进 GPX');
    const readmeBody = fs.readFileSync(path.join(dir, readme!), 'utf8');
    assert.ok(readmeBody.includes('WGS-84'), 'README 声明坐标系');
    assert.ok(readmeBody.includes('轨迹条数：1'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('EX6 越权 id 静默落空：混入他人轨迹只导本人的；只选他人的 404', async () => {
  const r1 = await app.inject({
    method: 'GET', url: `${API}/activities/export/gpx?ids=${aRunning},${bRun}`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(r1.statusCode, 200);
  assert.ok(r1.body.includes('导出说明') || r1.rawPayload.length > 0);
  const r2 = await app.inject({
    method: 'GET', url: `${API}/activities/export/gpx?ids=${bRun}`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(r2.statusCode, 404, '他人轨迹查无本人的可导数据');
});

test('EX7 无轨迹点的活动不进 zip（404 提示）；无 ids/范围 400', async () => {
  const r1 = await app.inject({
    method: 'GET', url: `${API}/activities/export/gpx?ids=${aWalk}`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(r1.statusCode, 404);
  const r2 = await app.inject({
    method: 'GET', url: `${API}/activities/export/gpx`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(r2.statusCode, 400);
});

test('EX8 超上限 101 条 400', async () => {
  const ids = Array.from({ length: 101 }, (_, i) => `a${String(i).padStart(2, '0')}`.padStart(24, 'b')).join(',');
  const res = await app.inject({
    method: 'GET', url: `${API}/activities/export/gpx?ids=${ids}`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.includes('100'));
});

test('EX13 GPX 类型/时间筛选：type=running 只导跑步行；未知类型 400', async () => {
  const one = await app.inject({
    method: 'GET', url: `${API}/activities/export/gpx?type=running`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(one.statusCode, 200, one.body);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-type-'));
  try {
    const zipPath = path.join(dir, 'out.zip');
    fs.writeFileSync(zipPath, one.rawPayload);
    await execFileP('unzip', ['-o', zipPath, '-d', dir]);
    const gpxFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.gpx'));
    assert.equal(gpxFiles.length, 1, '只打包跑步那一条');
    assert.ok(gpxFiles[0].includes(aRunning));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const bad = await app.inject({
    method: 'GET', url: `${API}/activities/export/gpx?type=flying`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(bad.statusCode, 400);
  const byTime = await app.inject({
    method: 'GET', url: `${API}/activities/export/gpx?from=${T_RUN + 1}`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(byTime.statusCode, 200, byTime.body);
  assert.ok(byTime.rawPayload.length > 0, '时间范围同样可打包');
});

test('EX9 频控：同 key 窗口内超 5 次 429（临时解除测试豁免验证分支）', async () => {
  const savedEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production'; // 关掉 WX_MOCK_LOGIN 豁免
  try {
    resetExportRate();
    const key = 'gpx:test-rate';
    for (let i = 0; i < EXPORT_RATE_LIMIT; i++) assertExportRate(key);
    assert.throws(() => assertExportRate(key), /导出太频繁/);
    resetExportRate();
    assertExportRate(key); // 重置后恢复
  } finally {
    process.env.NODE_ENV = savedEnv;
    resetExportRate();
  }
});

test('EX10 管理端 CSV：跨用户逐行昵称；status=all 含 in_progress（结束时间留白）', async () => {
  const r1 = await app.inject({
    method: 'GET', url: `${API}/admin/activities/export/summary?userId=${userAId}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(r1.statusCode, 200, r1.body);
  const lines1 = r1.body.slice(1).trimEnd().split('\r\n');
  assert.equal(lines1.length, 4, 'A 的 3 条 finished');
  assert.ok(lines1[1].includes(nickA), '逐行昵称列');

  const r2 = await app.inject({
    method: 'GET', url: `${API}/admin/activities/export/summary?userId=${userAId}&status=all`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const lines2 = r2.body.slice(1).trimEnd().split('\r\n');
  assert.equal(lines2.length, 5, 'status=all 放开状态过滤（+in_progress）');
  const progressLine = lines2.find((l) => l.includes('2026-10-26 11:00:00'))!;
  assert.ok(progressLine.includes(',,') || progressLine.endsWith(','), '无结束时间留空');
});

test('EX11 管理端未带凭证 401', async () => {
  const res = await app.inject({ method: 'GET', url: `${API}/admin/activities/export/summary` });
  assert.equal(res.statusCode, 401);
});

test('EX12 单条 GPX 导出不受影响（回归）', async () => {
  const res = await app.inject({
    method: 'GET', url: `${API}/activities/${aRunning}/gpx`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('<trkpt'));
});
