import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { WerunDayModel } from '../src/models/werun-day.model.js';
import { config } from '../src/config/index.js';

let app: FastifyInstance;
let tokenA = '';
const OPENID_A = 'werun_openid_a';
const OPENID_B = 'werun_openid_b';

/** mock 登录的 session_key（wechat.ts mock 模式固定值），base64 解出 16 字节 */
const MOCK_SESSION_KEY = 'MDEyMzQ1Njc4OWFiY2RlZg==';

/** 按微信同款算法加密一份开放数据（AES-128-CBC / PKCS#7），模拟客户端转发来的 encryptedData/iv */
function encryptWeRunPayload(payload: unknown, sessionKey = MOCK_SESSION_KEY) {
  const key = Buffer.from(sessionKey, 'base64');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { encryptedData: encrypted.toString('base64'), iv: iv.toString('base64') };
}

/** 造 stepInfoList：某天零点（北京时区）时间戳 */
function bjMidnight(daysAgo: number): number {
  const now = new Date(Date.now() - daysAgo * 24 * 3600 * 1000);
  return Math.floor(new Date(`${now.toISOString().slice(0, 10)}T00:00:00+08:00`).getTime() / 1000);
}

function sync(body: Record<string, unknown>, withToken = tokenA) {
  return app.inject({
    method: 'POST',
    url: '/sport-track/api/werun/sync',
    headers: withToken ? { authorization: `Bearer ${withToken}` } : {},
    payload: body,
  });
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  await WerunDayModel.deleteMany({});
  const users = await UserModel.find({ openid: { $in: [OPENID_A, OPENID_B] } }).select('_id');
  await UserModel.deleteMany({ _id: { $in: users.map((u) => u._id) } });

  // 两个用户（登录即建档）；mock 模式 code 'openid:xxx' 直接映射 openid
  await app.inject({ method: 'POST', url: '/sport-track/api/auth/login', payload: { code: `openid:${OPENID_A}` } });
  const loginB = await app.inject({ method: 'POST', url: '/sport-track/api/auth/login', payload: { code: `openid:${OPENID_B}` } });
  await app.inject({ method: 'POST', url: '/sport-track/api/auth/login', payload: { code: `openid:${OPENID_A}` } });
  tokenA = (
    await app.inject({ method: 'POST', url: '/sport-track/api/auth/login', payload: { code: `openid:${OPENID_A}` } })
  ).json().data.accessToken;
  assert.ok(tokenA, '用户 A 登录应成功');
  assert.ok(loginB.json().data.accessToken, '用户 B 登录应成功');

  // 测试里把 appid 钉住：水印匹配/不匹配两个用例都要走真实判定
  (config as { wxAppid: string }).wxAppid = 'wx_werun_test';
});

after(async () => {
  await WerunDayModel.deleteMany({});
  const users = await UserModel.find({ openid: { $in: [OPENID_A, OPENID_B] } }).select('_id');
  await UserModel.deleteMany({ _id: { $in: users.map((u) => u._id) } });
  await app.close();
});

test('WR1 正常同步：解密落库、按东八区映射日期、返回同步天数', async () => {
  const { encryptedData, iv } = encryptWeRunPayload({
    stepInfoList: [
      { timestamp: bjMidnight(0), step: 6000 },
      { timestamp: bjMidnight(1), step: 8000 },
    ],
    watermark: { appid: 'wx_werun_test', timestamp: Math.floor(Date.now() / 1000) - 60 },
  });
  const res = await sync({ code: `openid:${OPENID_A}`, encryptedData, iv });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().data.syncedDays, 2);

  const days = await WerunDayModel.find({}).lean();
  assert.equal(days.length, 2);
  const today = days.find((d) => d.step === 6000);
  assert.ok(today, '今天的步数应落库');
  assert.equal(
    today!.date,
    new Date((bjMidnight(0) + 8 * 3600) * 1000).toISOString().slice(0, 10),
    '日期应按东八区零点映射',
  );
});

test('WR2 幂等重同步：同一天覆盖旧值，不产生重复行', async () => {
  const { encryptedData, iv } = encryptWeRunPayload({
    stepInfoList: [{ timestamp: bjMidnight(0), step: 9999 }],
    watermark: { appid: 'wx_werun_test', timestamp: Math.floor(Date.now() / 1000) },
  });
  const res = await sync({ code: `openid:${OPENID_A}`, encryptedData, iv });
  assert.equal(res.statusCode, 200, res.body);

  const rows = await WerunDayModel.find({ step: 9999 }).lean();
  assert.equal(rows.length, 1, '同一天只能有一行');
  const total = await WerunDayModel.countDocuments();
  assert.ok(total <= 2, '总行数不应因重同步增长');
});

test('WR3 身份不匹配：A 的 token 配 B 的 code 直接 400（防拿别人 code 解自己的数据、反之亦然）', async () => {
  const { encryptedData, iv } = encryptWeRunPayload({
    stepInfoList: [{ timestamp: bjMidnight(0), step: 1 }],
    watermark: { appid: 'wx_werun_test', timestamp: Math.floor(Date.now() / 1000) },
  });
  const res = await sync({ code: `openid:${OPENID_B}`, encryptedData, iv });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /不匹配/);
});

test('WR4 解密失败：key 对不上返回 409（客户端约定重登重试），不落任何数据', async () => {
  const { encryptedData, iv } = encryptWeRunPayload(
    { stepInfoList: [{ timestamp: bjMidnight(0), step: 5 }], watermark: { appid: 'wx_werun_test', timestamp: Math.floor(Date.now() / 1000) } },
    'MTIzNDU2Nzg5MGFiY2RlZg==', // 另一把合法的 16 字节 key（'1234567890abcdef' 的 base64），解密必然失败
  );
  const res = await sync({ code: `openid:${OPENID_A}`, encryptedData, iv });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().message, /解密失败/);
  const count = await WerunDayModel.countDocuments({ step: 5 });
  assert.equal(count, 0, '解密失败的请求不能落任何行');
});

test('WR5 水印：appid 不匹配 400；过期（>7 天）400；缺水印 400', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const cases = [
    { watermark: { appid: 'wx_other', timestamp: nowSec }, msg: /不匹配/ },
    { watermark: { appid: 'wx_werun_test', timestamp: nowSec - 8 * 24 * 3600 }, msg: /过期/ },
    { watermark: null, msg: /水印/ },
  ];
  for (const c of cases) {
    const payload: Record<string, unknown> = {
      stepInfoList: [{ timestamp: bjMidnight(0), step: 7 }],
    };
    if (c.watermark) payload.watermark = c.watermark;
    const { encryptedData, iv } = encryptWeRunPayload(payload);
    const res = await sync({ code: `openid:${OPENID_A}`, encryptedData, iv });
    assert.equal(res.statusCode, 400, `case ${JSON.stringify(c.watermark)}: ${res.body}`);
    assert.match(res.json().message, c.msg);
  }
  const count = await WerunDayModel.countDocuments({ step: 7 });
  assert.equal(count, 0, '被拒的数据一行都不应落库');
});

test('WR6 脏数据清洗：离谱步数与 40 天窗口外的项被丢，其余照常入库', async () => {
  const { encryptedData, iv } = encryptWeRunPayload({
    stepInfoList: [
      { timestamp: bjMidnight(0), step: 999999 }, // 超单日上限 → 丢
      { timestamp: bjMidnight(1), step: -3 }, // 负数 → 丢
      { timestamp: bjMidnight(50), step: 100 }, // 40 天窗口外 → 丢
      { timestamp: bjMidnight(2), step: 321 }, // 合法 → 留
    ],
    watermark: { appid: 'wx_werun_test', timestamp: Math.floor(Date.now() / 1000) },
  });
  const res = await sync({ code: `openid:${OPENID_A}`, encryptedData, iv });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().data.syncedDays, 1, '只有一条合法项');
  const row = await WerunDayModel.findOne({ step: 321 }).lean();
  assert.ok(row, '合法项应落库');
});

test('WR7 未携带 token 401；参数缺字段 400', async () => {
  const noAuth = await sync({ code: `openid:${OPENID_A}`, encryptedData: 'x', iv: 'y' }, '');
  assert.equal(noAuth.statusCode, 401);

  const { encryptedData, iv } = encryptWeRunPayload({
    stepInfoList: [],
    watermark: { appid: 'wx_werun_test', timestamp: Math.floor(Date.now() / 1000) },
  });
  const missing = await sync({ code: `openid:${OPENID_A}`, encryptedData });
  assert.equal(missing.statusCode, 400);
  assert.ok(iv.length > 0); // 占位：iv 变量已生成，未走缺失分支
});
