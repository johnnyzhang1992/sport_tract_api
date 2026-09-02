import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { WeightLogModel } from '../src/models/weight-log.model.js';
import { LoginLogModel } from '../src/models/login-log.model.js';
import { nextUserUid } from '../src/services/uid.js';
import FormData from 'form-data';

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  // 清理测试数据（发号器不重置：dev 库存量用户已占号，重置会导致重复 uid）
  await clearMockLoginLogs();
  await UserModel.deleteMany({ openid: /^mock_openid_/ });
  await WeightLogModel.deleteMany({});
});

/** 删除 mock 用户产生的登录日志（避免污染 dev 库 UV/PV） */
async function clearMockLoginLogs() {
  const ids = (await UserModel.find({ openid: /^mock_openid_/ }).select('_id')).map((u) => u._id);
  if (ids.length) await LoginLogModel.deleteMany({ userId: { $in: ids } });
}

after(async () => {
  await clearMockLoginLogs();
  await UserModel.deleteMany({ openid: /^mock_openid_/ });
  await app.close();
});

async function post(
  url: string,
  body: Record<string, unknown> | undefined,
  token?: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url,
    payload: body,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

test('GET /health 返回 ok 且 MongoDB 已连接', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.mongodb, true);
});

test('登录：code 换 token，返回 accessToken/refreshToken/user', async () => {
  const res = await post('/sport-track/api/auth/login', { code: 'test-code-abc' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.success, true);
  assert.ok(body.data.accessToken);
  assert.ok(body.data.refreshToken);
  assert.ok(body.data.user.id);
  // 新用户自动分配 UID（正整数；起始值受 dev 库存量影响，断言相对）
  assert.ok(Number.isInteger(body.data.user.uid) && body.data.user.uid > 0);
  // openid 不出接口（敏感字段）
  assert.equal(body.data.user.openid, undefined);
});

test('登录幂等：同一 code 返回同一用户', async () => {
  const r1 = await post('/sport-track/api/auth/login', { code: 'same-code' });
  const r2 = await post('/sport-track/api/auth/login', { code: 'same-code' });
  assert.equal(r1.json().data.user.id, r2.json().data.user.id);
});

test('登录带 uid：新用户默认昵称 = 迹路者+uid', async () => {
  const res = await post('/sport-track/api/auth/login', { code: 'test-code-uid', uid: '001' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.user.nickname, '迹路者001');
});

test('登录带 uid 幂等：老用户不覆盖昵称', async () => {
  // 首次带 uid 创建
  await post('/sport-track/api/auth/login', { code: 'test-code-uid-2', uid: '007' });
  // 老用户再登录（不带 uid）昵称保持
  const r2 = await post('/sport-track/api/auth/login', { code: 'test-code-uid-2' });
  assert.equal(r2.json().data.user.nickname, '迹路者007');
  // 老用户换 uid 也不覆盖
  const r3 = await post('/sport-track/api/auth/login', { code: 'test-code-uid-2', uid: '999' });
  assert.equal(r3.json().data.user.nickname, '迹路者007');
});

test('无昵称老用户带 uid 登录 → 补默认昵称', async () => {
  // 直接构造空昵称老用户（新用户现在无 uid 也会自动分配，无法通过登录接口产生空昵称）
  const hashOf = (code: string) => [...code].reduce((a, c) => a + c.charCodeAt(0), 0) % 10000;
  const openidOf = (code: string) => `mock_openid_${String(hashOf(code)).padStart(4, '0')}`;
  await UserModel.create({ openid: openidOf('test-code-uid-3'), nickname: '' });
  const r2 = await post('/sport-track/api/auth/login', { code: 'test-code-uid-3', uid: '888' });
  assert.equal(r2.json().data.user.nickname, '迹路者888');
});

test('用户 UID 发号连续递增', async () => {
  const s1 = await nextUserUid();
  const s2 = await nextUserUid();
  assert.equal(s2, s1 + 1);
});

test('新用户自动分配 UID 且唯一，默认昵称 = 迹路者{UID}', async () => {
  const r1 = await post('/sport-track/api/auth/login', { code: 'test-code-auto-1' });
  const r2 = await post('/sport-track/api/auth/login', { code: 'test-code-auto-2' });
  const u1 = r1.json().data.user;
  const u2 = r2.json().data.user;
  assert.ok(u1.uid > 0 && u2.uid > 0, '应分配 UID');
  assert.notEqual(u1.uid, u2.uid, 'UID 不应重号');
  assert.equal(u1.nickname, `迹路者${u1.uid}`, '默认昵称应基于 UID');
  assert.equal(u2.nickname, `迹路者${u2.uid}`);
});

test('缺 UID 老用户登录自动补 UID（按创建时间，不动昵称）', async () => {
  const hashOf = (code: string) => [...code].reduce((a, c) => a + c.charCodeAt(0), 0) % 10000;
  const openidOf = (code: string) => `mock_openid_${String(hashOf(code)).padStart(4, '0')}`;
  // 模拟两个老用户：无 uid，一个有自定义昵称（最早创建），一个空昵称
  await UserModel.create({ openid: openidOf('test-code-old-a'), nickname: '小小梦工场', createdAt: new Date(Date.now() - 3600000) });
  await new Promise((r) => setTimeout(r, 5));
  await UserModel.create({ openid: openidOf('test-code-old-b'), nickname: '', createdAt: new Date(Date.now() - 1800000) });
  // 登录 B 触发批量补 UID（含 A）
  const rb = await post('/sport-track/api/auth/login', { code: 'test-code-old-b' });
  const b = rb.json().data.user;
  assert.ok(b.uid > 0, '老用户 B 应有 UID');
  const a = await UserModel.findOne({ openid: openidOf('test-code-old-a') });
  assert.ok(a && a.uid != null, '老用户 A 应有 UID');
  assert.equal(a.nickname, '小小梦工场', '自定义昵称不被覆盖');
  assert.ok(a.uid < b.uid, '先创建的用户 UID 更小');
  // B 空昵称 → 默认昵称 = 迹路者{B.uid}
  assert.equal(b.nickname, `迹路者${b.uid}`);
});

test('登录 uid 非法字符 → 400', async () => {
  const res = await post('/sport-track/api/auth/login', { code: 'test-code-uid-bad', uid: 'a b' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().success, false);
});

test('登录缺少 code → 400', async () => {
  const res = await post('/sport-track/api/auth/login', {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().success, false);
});

test('GET /users/me 无 token → 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/sport-track/api/users/me' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().success, false);
});

test('GET /users/me 带 token 返回当前用户', async () => {
  const login = await post('/sport-track/api/auth/login', { code: 'test-code-me' });
  const { accessToken } = login.json().data;

  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/users/me',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().success, true);
});

test('PUT /users/me 更新昵称与性别', async () => {
  const login = await post('/sport-track/api/auth/login', { code: 'test-code-update' });
  const { accessToken } = login.json().data;

  const res = await app.inject({
    method: 'PUT',
    url: '/sport-track/api/users/me',
    payload: { nickname: '跑者小王', gender: 1 },
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.nickname, '跑者小王');
  assert.equal(res.json().data.gender, 1);
});

test('PUT /users/me 空昵称 → 400', async () => {
  const login = await post('/sport-track/api/auth/login', { code: 'test-code-bad-update' });
  const { accessToken } = login.json().data;

  const res = await app.inject({
    method: 'PUT',
    url: '/sport-track/api/users/me',
    payload: { nickname: '   ' },
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(res.statusCode, 400);
});

test('refresh：合法 refreshToken 换新 accessToken', async () => {
  const login = await post('/sport-track/api/auth/login', { code: 'test-code-refresh' });
  const { refreshToken } = login.json().data;

  const res = await post('/sport-track/api/auth/refresh', { refreshToken });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().data.accessToken);
  assert.ok(res.json().data.refreshToken);
});

test('refresh：伪造 token → 401', async () => {
  const res = await post('/sport-track/api/auth/refresh', { refreshToken: 'fake.token.value' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().data.code, 'INVALID_REFRESH_TOKEN');
});

test('OSS 凭证：未配置时返回 503 提示', async () => {
  const login = await post('/sport-track/api/auth/login', { code: 'test-code-oss' });
  const { accessToken } = login.json().data;

  const res = await post('/sport-track/api/oss/credential', {}, accessToken);
  // 本地未配置 OSS 时返回 503；若配置了则返回签名凭证
  if (res.statusCode === 503) {
    assert.match(res.json().message, /OSS 未配置/);
  } else {
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().data.policy);
    assert.ok(res.json().data.signature);
    assert.ok(res.json().data.OSSAccessKeyId);
  }
});

test('图片合规检测：未配置微信接口时降级放行', async () => {
  const login = await post('/sport-track/api/auth/login', { code: 'test-code-sec' });
  const { accessToken } = login.json().data;

  const form = new FormData();
  form.append('file', Buffer.from('fake-image-bytes'), {
    filename: 'a.jpg',
    contentType: 'image/jpeg',
  });

  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/users/check-image',
    payload: form,
    headers: { authorization: `Bearer ${accessToken}`, ...form.getHeaders() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.success, true);
  assert.ok(body.data.skipped === true || body.data.risky === true || body.data.risky === false);
});

test('图片合规检测：未传文件 → 400', async () => {
  const login = await post('/sport-track/api/auth/login', { code: 'test-code-sec2' });
  const { accessToken } = login.json().data;

  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/users/check-image',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  // 无 multipart content-type：@fastify/multipart 返回 406；有请求体但无文件返回 400
  assert.ok([400, 406].includes(res.statusCode), `statusCode=${res.statusCode}`);
});

test('分享：非本人活动生成小程序码 → 404', async () => {
  // 用另一个登录用户请求（假 id 验证归属校验）
  const login = await post('/sport-track/api/auth/login', { code: 'share-other-user' });
  const otherToken = login.json().data.accessToken;
  const res = await post('/sport-track/api/share/mini-code', {
    activityId: '000000000000000000000000',
  }, otherToken);
  assert.equal(res.statusCode, 404);
});

test('分享：非法 activityId → 400', async () => {
  const login = await post('/sport-track/api/auth/login', { code: 'share-bad-id' });
  const t = login.json().data.accessToken;
  const res = await post('/sport-track/api/share/mini-code', { activityId: 'not-a-valid-id' }, t);
  assert.equal(res.statusCode, 400);
});

test('未匹配路由 → 404 统一格式', async () => {
  const res = await app.inject({ method: 'GET', url: '/sport-track/api/not-exist' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().success, false);
});

test('逆地理编码：未配置 key 时返回空地址（200）', async () => {
  const login = await post('/sport-track/api/auth/login', { code: 'geo-test' });
  const t = login.json().data.accessToken;
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/geo/reverse?lat=31.2304&lng=121.4737',
    headers: { authorization: `Bearer ${t}` },
  });
  assert.equal(res.statusCode, 200);
  // key 已配置时返回地址，未配置返回空；均 200 不报错
  assert.ok(typeof res.json().data.address === 'string');
});

test('逆地理编码：参数非法 → 400', async () => {
  const login = await post('/sport-track/api/auth/login', { code: 'geo-bad' });
  const t = login.json().data.accessToken;
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/geo/reverse?lat=999&lng=121',
    headers: { authorization: `Bearer ${t}` },
  });
  assert.equal(res.statusCode, 400);
});

test('保存体重变化 → 记录体重日志并可查询', async () => {
  const login = await post('/sport-track/api/auth/login', { code: 'weight-user' });
  const t = login.json().data.accessToken;
  // 保存体重 65
  await app.inject({
    method: 'PUT',
    url: '/sport-track/api/users/me',
    payload: { weightKg: 65 },
    headers: { authorization: `Bearer ${t}` },
  });
  // 再次保存相同体重 → 不重复记录
  await app.inject({
    method: 'PUT',
    url: '/sport-track/api/users/me',
    payload: { weightKg: 65 },
    headers: { authorization: `Bearer ${t}` },
  });
  // 改成 64 → 新增一条
  await app.inject({
    method: 'PUT',
    url: '/sport-track/api/users/me',
    payload: { weightKg: 64 },
    headers: { authorization: `Bearer ${t}` },
  });
  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/users/weight-logs',
    headers: { authorization: `Bearer ${t}` },
  });
  assert.equal(res.statusCode, 200);
  const items = res.json().data.items;
  assert.equal(items.length, 2, '相同体重不重复记录，应只有 2 条（65、64）');
  assert.equal(items[0].weightKg, 64, '最新体重在前');
});
