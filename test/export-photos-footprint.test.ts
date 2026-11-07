import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { XpayOrderModel } from '../src/models/xpay-order.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { FootprintRecordModel } from '../src/models/footprint-record.model.js';
import { exportPhotosZip } from '../src/services/export.js';

const execFileP = promisify(execFile);
const API = '/sport-track/api';

let app: FastifyInstance;
let tokenA = '';
let userAId = '';
let photoServer: http.Server;
let photoBase = '';

const T_RUN = Date.UTC(2026, 9, 25, 0, 0, 0); // 2026-10-25 08:00 BJ

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  // 本地图片源：/ok.jpg 给 PNG 字节，/bad.jpg 404（模拟 OSS 对象已删）
  photoServer = http.createServer((req, res) => {
    if (req.url?.includes('bad.jpg')) {
      res.statusCode = 404;
      res.end('gone');
      return;
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]));
  });
  await new Promise<void>((resolve) => photoServer.listen(0, '127.0.0.1', resolve));
  photoBase = `http://127.0.0.1:${(photoServer.address() as { port: number }).port}`;

  const purge = async () => {
    const users = await UserModel.find({ openid: { $regex: /^expf-/ } }).select('_id').lean();
    const ids = users.map((u) => u._id);
    if (!ids.length) return;
    await ActivityModel.deleteMany({ userId: { $in: ids } });
    await FootprintRecordModel.deleteMany({ userId: { $in: ids } });
    await XpayOrderModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  };
  await purge();

  const login = async (code: string) => {
    const res = await app.inject({ method: 'POST', url: `${API}/auth/login`, payload: { code: `openid:expf-${code}` } });
    return res.json().data;
  };
  const a = await login('photo-a');
  tokenA = a.accessToken;
  userAId = a.user.id;

  // 照片打包是会员权益：给 A 发一张有效订单（与 export.test.ts 同款）
  const DAY = 86_400_000;
  const run = Date.now().toString(36);
  await XpayOrderModel.create({
    outTradeNo: `EXPF${run}a`.slice(0, 32),
    wxOrderId: `expfwx${run}a`.slice(0, 32),
    userId: userAId,
    openid: 'expf-photo-a',
    productKey: 'month_card',
    name: '会员月卡',
    priceFen: 199,
    durationDays: 30,
    status: 'delivered',
    periodStart: Date.now() - DAY,
    periodEnd: Date.now() + 30 * DAY,
    perksSnapshot: { adFree: true, exportBundle: true, photoQuota: 300, subscribeNotice: true },
  });

  // 轨迹：一条跑步带 3 张照片引用（photos 2 张 + photoUrl 旧字段与其中一张重复 → 去重后 2 张）
  await ActivityModel.create({
    userId: userAId,
    type: 'running',
    status: 'finished',
    startTime: T_RUN,
    endTime: T_RUN + 3600_000,
    duration: 3600,
    distance: 5000,
    trackPoints: [],
    markers: [
      {
        id: 'm1', lat: 31.23, lng: 121.47, timestamp: T_RUN + 1000, type: 'photo',
        note: '', photoUrl: `${photoBase}/ok.jpg`,
        photos: [`${photoBase}/ok.jpg?sign=abc`, `${photoBase}/bad.jpg`], address: '',
      },
    ],
  });
  // 足迹：两张照片（一张与轨迹同 URL 也无妨，目录不同各存一份）
  await FootprintRecordModel.create({
    userId: userAId,
    visitDate: '2026-10-25',
    title: '外滩漫步',
    people: ['阿黄'],
    description: '描述里有,逗号和"引号"',
    location: { name: '外滩', address: '中山东一路', province: '上海市', city: '上海市', adcode: 310000, latitude: 31.23, longitude: 121.47 },
    photos: [`${photoBase}/ok.jpg`, `${photoBase}/bad.jpg`],
    category: 'walk',
  });
});

after(async () => {
  await FootprintRecordModel.deleteMany({});
  const users = await UserModel.find({ openid: { $regex: /^expf-/ } }).select('_id').lean();
  const ids = users.map((u) => u._id);
  await ActivityModel.deleteMany({ userId: { $in: ids } });
  await FootprintRecordModel.deleteMany({ userId: { $in: ids } });
  await XpayOrderModel.deleteMany({ userId: { $in: ids } });
  await UserModel.deleteMany({ _id: { $in: ids } });
  photoServer.close();
  await app.close();
});

test('PF1 足迹 CSV：表头/字段顺序/转义/描述全文/坐标', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `${API}/footprint-records/export/csv`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers['content-type']), /text\/csv/);
  const text = res.payload;
  assert.ok(text.startsWith('\uFEFF足迹ID,到访日期,标题,分类,地点,详细地址,省份,城市,同行人,描述,图片数,经度,纬度'), text.slice(0, 80));
  const row = text.split('\r\n')[1];
  assert.ok(row.includes('外滩漫步'), '标题在列');
  assert.ok(row.includes('漫步'), '分类中文标签');
  assert.ok(row.includes('"描述里有,逗号和""引号"""'), '含逗号/引号的描述按 CSV 规则转义');
  assert.ok(row.includes(',121.47,31.23'), '经纬度在列');
  assert.ok(row.includes('阿黄'), '同行人在列');
});

test('PF2 足迹 CSV：visitDate 自然日区间过滤 + 空结果 404', async () => {
  const from = Date.UTC(2026, 9, 1);
  // UTC 12:00 → 东八区 20:00 仍是 10-24；足迹是 10-25，应落空（to 用 UTC 23:59 会跨到 10-25）
  const to = Date.UTC(2026, 9, 24, 12, 0, 0);
  const res = await app.inject({
    method: 'GET',
    url: `${API}/footprint-records/export/csv?from=${from}&to=${to}`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(res.statusCode, 404);
  assert.match(res.json().message, /没有符合条件的足迹/);
});

test('PF3 照片打包：会员可导、双源目录、去重、坏图跳过并写进说明', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `${API}/activities/export/photos`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['content-type'], 'application/zip');
  assert.ok(res.rawPayload.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])), 'zip 魔数');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photos-zip-'));
  const zipPath = path.join(dir, 'out.zip');
  fs.writeFileSync(zipPath, res.rawPayload);
  await execFileP('unzip', ['-o', zipPath, '-d', dir]);
  const walk = (d: string, prefix = ''): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
    );
  const entries = walk(dir).filter((f) => f !== 'out.zip');
  const trackEntry = entries.find((f) => f.startsWith('轨迹/') && f.endsWith('photo-1.jpg'));
  const fpEntry = entries.find((f) => f.startsWith('足迹/2026-10-25_') && f.endsWith('photo-1.jpg'));
  assert.ok(trackEntry, `轨迹照片应入包：${entries.join(',')}`);
  assert.ok(fpEntry, `足迹照片应入包：${entries.join(',')}`);
  // 打包内容是图片字节（本地源给的 JPEG 魔数）
  const img = fs.readFileSync(path.join(dir, trackEntry!));
  assert.deepEqual([...img.subarray(0, 2)], [0xff, 0xd8], '应是下载的原图字节');

  const readme = fs.readFileSync(path.join(dir, '导出说明.txt'), 'utf8');
  assert.match(readme, /照片总数：4 张/, '轨迹 2 张（去重后）+ 足迹 2 张');
  assert.match(readme, /成功打包 2 张/);
  assert.match(readme, /photo-2\.jpg/, '失败清单要点名文件（两张坏图都是各自目录的 photo-2）');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PF4 非会员 403；范围内无照片 404', async () => {
  // 无会员用户
  const b = await app.inject({ method: 'POST', url: `${API}/auth/login`, payload: { code: 'openid:expf-photo-b' } });
  const tokenB = b.json().data.accessToken;
  const denied = await app.inject({
    method: 'GET',
    url: `${API}/activities/export/photos`,
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.equal(denied.statusCode, 403);
  assert.match(denied.json().message, /会员/);

  const empty = await app.inject({
    method: 'GET',
    url: `${API}/activities/export/photos?from=${Date.UTC(2030, 0, 1)}&to=${Date.UTC(2030, 0, 2)}`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(empty.statusCode, 404);
  assert.match(empty.json().message, /没有可导出的照片/);
});

test('PF5 服务层上限：cap=2 时 3 张直接 400（不等下载才发现）', async () => {
  const uid = userAId;
  // 再建一条带 1 张照片的轨迹：总计 4+1=5？不——直接用现有 4 张，cap 2 就超
  await assert.rejects(
    exportPhotosZip({ userId: uid, cap: 2 }),
    (e: { statusCode: number; message: string }) => e.statusCode === 400 && /超出单次打包上限/.test(e.message),
  );
});
