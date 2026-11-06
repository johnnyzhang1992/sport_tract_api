/**
 * 微信步数 CSV 导出：日期升序、星期口径、东八区自然日范围、只导本人、空数据 404。
 * 日期固定用 2026-10-25（周日）/10-26（周一）/11-01（周日），避免依赖「今天」。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { WerunDayModel } from '../src/models/werun-day.model.js';
import { exportWerunCsv } from '../src/services/werun-export.js';

const API = '/sport-track/api';
const DAY = 86_400_000;
const BJ = 8 * 3600_000;

let app: FastifyInstance;
let tokenA = '';
let tokenB = '';
let tokenC = '';
let userAId = '';
let userBId = '';
let userCId = '';

/** 东八区某日 0 点 / 当日 23:59:59.999 的 epoch ms */
const bjStart = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) - BJ;
const bjEnd = (y: number, m: number, d: number) => bjStart(y, m, d) + DAY - 1;

function get(path: string, token: string | null = tokenA) {
  return app.inject({
    method: 'GET',
    url: `${API}/werun${path}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function seed(userId: string, date: string, step: number) {
  await WerunDayModel.updateOne(
    { userId, date },
    { $set: { step, syncedAt: Date.now() } },
    { upsert: true },
  );
}

async function login(tag: string) {
  const res = await app.inject({
    method: 'POST',
    url: `${API}/auth/login`,
    payload: { code: `openid:wrexp-${tag}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data as { accessToken: string; user: { id: string } };
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  const purge = async () => {
    const users = await UserModel.find({ openid: /^wrexp-/ }).select('_id').lean();
    const ids = users.map((u) => u._id);
    if (ids.length) {
      await WerunDayModel.deleteMany({ userId: { $in: ids } });
      await UserModel.deleteMany({ _id: { $in: ids } });
    }
  };
  await purge();

  const a = await login('a');
  tokenA = a.accessToken;
  userAId = a.user.id;
  const b = await login('b');
  tokenB = b.accessToken;
  userBId = b.user.id;
  const c = await login('c');
  tokenC = c.accessToken;
  userCId = c.user.id;

  await seed(userAId, '2026-10-25', 1000);
  await seed(userAId, '2026-10-26', 2000);
  await seed(userAId, '2026-11-01', 3000);
  await seed(userBId, '2026-10-25', 9999);
});

after(async () => {
  await WerunDayModel.deleteMany({ userId: { $in: [userAId, userBId, userCId] } });
  await UserModel.deleteMany({ _id: { $in: [userAId, userBId, userCId] } });
  await app.close();
});

test('WE-1 CSV 文案与行：BOM+CRLF、日期升序、星期中文、只含本人', async () => {
  const res = await get('/export/csv');
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.headers['content-type'] as string, /text\/csv/);
  assert.ok(res.body.startsWith('\uFEFF'), 'UTF-8 BOM 开头');
  const lines = res.body.slice(1).trimEnd().split('\r\n');
  assert.equal(lines[0], '日期,星期,步数');
  assert.deepEqual(lines.slice(1), [
    '2026-10-25,周日,1000',
    '2026-10-26,周一,2000',
    '2026-11-01,周日,3000',
  ], '日期升序、星期按东八区日历');
  assert.ok(!res.body.includes('9999'), '不含他人步数');
  assert.ok(!res.body.includes(userAId) && !res.body.includes('wrexp-'), '不含用户标识');
});

test('WE-2 时间范围按东八区自然日、首尾都含；非法范围 400', async () => {
  const custom = await get(
    `/export/csv?from=${bjStart(2026, 10, 26)}&to=${bjEnd(2026, 10, 31)}`,
  );
  assert.equal(custom.statusCode, 200, custom.body);
  assert.deepEqual(custom.body.slice(1).trimEnd().split('\r\n').slice(1), ['2026-10-26,周一,2000']);

  const fromOnly = await get(`/export/csv?from=${bjStart(2026, 11, 1)}`);
  assert.equal(fromOnly.statusCode, 200);
  assert.deepEqual(fromOnly.body.slice(1).trimEnd().split('\r\n').slice(1), ['2026-11-01,周日,3000']);

  const toOnly = await get(`/export/csv?to=${bjEnd(2026, 10, 25)}`);
  assert.equal(toOnly.statusCode, 200);
  assert.deepEqual(toOnly.body.slice(1).trimEnd().split('\r\n').slice(1), ['2026-10-25,周日,1000']);

  const bad = await get('/export/csv?from=abc');
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().message, /时间范围无效/);

  const reversed = await get(`/export/csv?from=${bjEnd(2026, 11, 1)}&to=${bjStart(2026, 10, 26)}`);
  assert.equal(reversed.statusCode, 400);
  assert.match(reversed.json().message, /时间范围无效/);
});

test('WE-3 无记录 404；未登录 401', async () => {
  const empty = await get('/export/csv', tokenC);
  assert.equal(empty.statusCode, 404);
  assert.match(empty.json().message, /没有符合条件的步数记录/);

  const noAuth = await get('/export/csv', null);
  assert.equal(noAuth.statusCode, 401);
});

test('WE-4 单次上限：服务层超 cap 给可执行提示', async () => {
  await assert.rejects(
    () => exportWerunCsv({ userId: userAId, cap: 2 }),
    /共 3 天，超出单次导出上限 2 天，请缩小时间范围/,
  );
});

test('WE-5 to 是排他边界（次日 00:00）时不多带一天，与 /werun/report 同口径', async () => {
  // 本用例自建两天数据：10-01、10-02 各一天
  const u = await UserModel.create({ openid: `we5_${Date.now()}`, nickname: 'WE5', uid: 970000 + Math.floor(Math.random() * 9999) });
  const uid = String(u._id);
  await WerunDayModel.create([
    { userId: u._id, date: '2026-10-01', step: 1000, syncedAt: Date.now() },
    { userId: u._id, date: '2026-10-02', step: 2000, syncedAt: Date.now() },
    // 边界外的那一天必须有数据，否则「多带一天」的错误实现也会得到相同的两行（用例抓不到）
    { userId: u._id, date: '2026-10-03', step: 3000, syncedAt: Date.now() },
  ]);
  try {
    const from = Date.parse('2026-10-01T00:00:00+08:00');
    // 排他边界：10-03 的 00:00（窗口应为 10-01 ~ 10-02 两天）
    const toExclusive = Date.parse('2026-10-03T00:00:00+08:00');
    const csv = await exportWerunCsv({ userId: uid, from, to: toExclusive });
    const lines = csv.trim().split('\r\n').slice(1);
    assert.equal(lines.length, 2, `排他边界不该多带天数，实际 ${lines.length} 行：${lines.join(' | ')}`);
    assert.match(lines[1], /^2026-10-02/);
  } finally {
    await WerunDayModel.deleteMany({ userId: u._id });
    await UserModel.deleteOne({ _id: u._id });
  }
});
