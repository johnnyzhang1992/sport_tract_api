import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import FormData from 'form-data';

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  // 清理测试数据
  await UserModel.deleteMany({ openid: /^mock_openid_/ });
});

after(async () => {
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
  const res = await post('/api/auth/login', { code: 'test-code-abc' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.success, true);
  assert.ok(body.data.accessToken);
  assert.ok(body.data.refreshToken);
  assert.ok(body.data.user.id);
  // openid 不出接口（敏感字段）
  assert.equal(body.data.user.openid, undefined);
});

test('登录幂等：同一 code 返回同一用户', async () => {
  const r1 = await post('/api/auth/login', { code: 'same-code' });
  const r2 = await post('/api/auth/login', { code: 'same-code' });
  assert.equal(r1.json().data.user.id, r2.json().data.user.id);
});

test('登录缺少 code → 400', async () => {
  const res = await post('/api/auth/login', {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().success, false);
});

test('GET /users/me 无 token → 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/users/me' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().success, false);
});

test('GET /users/me 带 token 返回当前用户', async () => {
  const login = await post('/api/auth/login', { code: 'test-code-me' });
  const { accessToken } = login.json().data;

  const res = await app.inject({
    method: 'GET',
    url: '/api/users/me',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().success, true);
});

test('PUT /users/me 更新昵称与性别', async () => {
  const login = await post('/api/auth/login', { code: 'test-code-update' });
  const { accessToken } = login.json().data;

  const res = await app.inject({
    method: 'PUT',
    url: '/api/users/me',
    payload: { nickname: '跑者小王', gender: 1 },
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.nickname, '跑者小王');
  assert.equal(res.json().data.gender, 1);
});

test('PUT /users/me 空昵称 → 400', async () => {
  const login = await post('/api/auth/login', { code: 'test-code-bad-update' });
  const { accessToken } = login.json().data;

  const res = await app.inject({
    method: 'PUT',
    url: '/api/users/me',
    payload: { nickname: '   ' },
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(res.statusCode, 400);
});

test('refresh：合法 refreshToken 换新 accessToken', async () => {
  const login = await post('/api/auth/login', { code: 'test-code-refresh' });
  const { refreshToken } = login.json().data;

  const res = await post('/api/auth/refresh', { refreshToken });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().data.accessToken);
  assert.ok(res.json().data.refreshToken);
});

test('refresh：伪造 token → 401', async () => {
  const res = await post('/api/auth/refresh', { refreshToken: 'fake.token.value' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().data.code, 'INVALID_REFRESH_TOKEN');
});

test('OSS 凭证：未配置时返回 503 提示', async () => {
  const login = await post('/api/auth/login', { code: 'test-code-oss' });
  const { accessToken } = login.json().data;

  const res = await post('/api/oss/credential', {}, accessToken);
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
  const login = await post('/api/auth/login', { code: 'test-code-sec' });
  const { accessToken } = login.json().data;

  const form = new FormData();
  form.append('file', Buffer.from('fake-image-bytes'), {
    filename: 'a.jpg',
    contentType: 'image/jpeg',
  });

  const res = await app.inject({
    method: 'POST',
    url: '/api/users/check-image',
    payload: form,
    headers: { authorization: `Bearer ${accessToken}`, ...form.getHeaders() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.success, true);
  assert.ok(body.data.skipped === true || body.data.risky === true || body.data.risky === false);
});

test('图片合规检测：未传文件 → 400', async () => {
  const login = await post('/api/auth/login', { code: 'test-code-sec2' });
  const { accessToken } = login.json().data;

  const res = await app.inject({
    method: 'POST',
    url: '/api/users/check-image',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  // 无 multipart content-type：@fastify/multipart 返回 406；有请求体但无文件返回 400
  assert.ok([400, 406].includes(res.statusCode), `statusCode=${res.statusCode}`);
});

test('分享：非本人活动生成小程序码 → 404', async () => {
  // 用另一个登录用户请求（假 id 验证归属校验）
  const login = await post('/api/auth/login', { code: 'share-other-user' });
  const otherToken = login.json().data.accessToken;
  const res = await post('/api/share/mini-code', {
    activityId: '000000000000000000000000',
  }, otherToken);
  assert.equal(res.statusCode, 404);
});

test('分享：非法 activityId → 400', async () => {
  const login = await post('/api/auth/login', { code: 'share-bad-id' });
  const t = login.json().data.accessToken;
  const res = await post('/api/share/mini-code', { activityId: 'not-a-valid-id' }, t);
  assert.equal(res.statusCode, 400);
});

test('未匹配路由 → 404 统一格式', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/not-exist' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().success, false);
});

test('逆地理编码：未配置 key 时返回空地址（200）', async () => {
  const login = await post('/api/auth/login', { code: 'geo-test' });
  const t = login.json().data.accessToken;
  const res = await app.inject({
    method: 'GET',
    url: '/api/geo/reverse?lat=31.2304&lng=121.4737',
    headers: { authorization: `Bearer ${t}` },
  });
  assert.equal(res.statusCode, 200);
  // key 已配置时返回地址，未配置返回空；均 200 不报错
  assert.ok(typeof res.json().data.address === 'string');
});

test('逆地理编码：参数非法 → 400', async () => {
  const login = await post('/api/auth/login', { code: 'geo-bad' });
  const t = login.json().data.accessToken;
  const res = await app.inject({
    method: 'GET',
    url: '/api/geo/reverse?lat=999&lng=121',
    headers: { authorization: `Bearer ${t}` },
  });
  assert.equal(res.statusCode, 400);
});
