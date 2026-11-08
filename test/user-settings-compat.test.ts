import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';

/**
 * 用户设置的新老版本兼容（2026-11-07）：
 * 小程序版本不齐——新版前端已下线「默认运动类型」（保存不带 defaultType），
 * 老版本仍在读写它。约定：
 *   - 老客户端带 defaultType 保存 → 照常落库
 *   - 新客户端不带 defaultType 保存 → 库里的旧值必须保留（不能被整体 $set 抹掉）
 *   - GET /users/me 两种客户端都能读到该字段
 * 其余 settings 字段新旧客户端共用同一套读写，不受影响。
 */

const API = '/sport-track/api';
let app: FastifyInstance;
let tokenOld = ''; // 模拟老版本客户端（保存时带 defaultType）
let tokenNew = ''; // 模拟新版客户端（保存时不带 defaultType）
let userId = '';

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  const users = await UserModel.find({ openid: /^usrset-/ }).select('_id');
  await UserModel.deleteMany({ _id: { $in: users.map((u) => u._id) } });

  const login = async (code: string) => {
    const res = await app.inject({ method: 'POST', url: `${API}/auth/login`, payload: { code: `openid:${code}` } });
    return res.json().data.accessToken as string;
  };
  // 同一个 openid 模拟「同一用户在两个版本间切换」
  tokenOld = await login('usrset-compat');
  tokenNew = await login('usrset-compat');
  const user = await UserModel.findOne({ openid: 'usrset-compat' });
  userId = String(user!._id);
});

after(async () => {
  const users = await UserModel.find({ openid: /^usrset-/ }).select('_id');
  await UserModel.deleteMany({ _id: { $in: users.map((u) => u._id) } });
  await app.close();
});

const putMe = (token: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `${API}/users/me`, headers: { authorization: `Bearer ${token}` }, payload });

const getMe = (token: string) =>
  app.inject({ method: 'GET', url: `${API}/users/me`, headers: { authorization: `Bearer ${token}` } });

test('UC1 老客户端：带 defaultType 保存 → 落库并可读回', async () => {
  const res = await putMe(tokenOld, { settings: { unit: 'metric', defaultType: 'cycling', highAccuracy: true } });
  assert.equal(res.statusCode, 200, res.body);
  const me = await (await getMe(tokenOld)).json().data;
  assert.equal(me.settings.defaultType, 'cycling');
});

test('UC2 新客户端：不带 defaultType 保存 → 库里的旧值保留，不被抹掉', async () => {
  const res = await putMe(tokenNew, { settings: { unit: 'metric', highAccuracy: false } });
  assert.equal(res.statusCode, 200, res.body);
  const me = await (await getMe(tokenNew)).json().data;
  assert.equal(me.settings.defaultType, 'cycling', '新版保存不得抹掉老版存的偏好');
  assert.equal(me.settings.highAccuracy, false, '本次提交的其他字段照常生效');
  assert.equal(me.settings.unit, 'metric');
});

test('UC3 两个版本交替使用：互不破坏对方的设置', async () => {
  // 老客户端改 defaultType + 开高精度
  await putMe(tokenOld, { settings: { defaultType: 'hiking', highAccuracy: true } });
  // 新客户端关高精度（不带 defaultType）
  await putMe(tokenNew, { settings: { highAccuracy: false } });
  const me = await (await getMe(tokenOld)).json().data;
  assert.equal(me.settings.defaultType, 'hiking', '老客户端写的偏好不能被新客户端保存冲掉');
  assert.equal(me.settings.highAccuracy, false, '新客户端写的开关要生效');
});

test('UC4 显式清空仍可行：带空串 defaultType 照常覆盖（预留产品回退位）', async () => {
  const res = await putMe(tokenOld, { settings: { defaultType: '' } });
  assert.equal(res.statusCode, 200, res.body);
  const me = await (await getMe(tokenOld)).json().data;
  assert.equal(me.settings.defaultType, '', '显式空串是合法值，不触发保留逻辑');
});
