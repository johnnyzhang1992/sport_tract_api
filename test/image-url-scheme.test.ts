/**
 * 图片/头像地址的协议闸门（防存储型脚本注入）
 *
 * 为什么要这条：zod 的 `z.string().url()` 底层就是 `new URL()`，而 `javascript:` / `data:`
 * 在它眼里都是"合法 URL"会一路放过。管理后台把足迹照片渲染成 `<a href={p}>`
 * （webAdmin `components/FootprintDetailDialog.tsx` 照片宫格），小程序用户提交一条
 * `javascript:` 地址，管理员点缩略图就是在后台源里执行脚本。
 *
 * 判"解析后的协议"而不是判字符串前缀：制表符、换行、前导空格、大小写这些混淆手段
 * 都会先被 URL 解析器归一，前缀黑名单必然漏。
 * 允许 http：微信头像域名（wx.qlogo.cn）给的就是 http 地址，一刀切 https 会打挂真实用户资料。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { FootprintRecordModel } from '../src/models/footprint-record.model.js';
import { CreateFootprintRecordSchema, UpdateMeSchema, CreateMarkerSchema } from '../src/utils/validators.js';

/** 会被 new URL() 判成非 http(s) 协议的注入载荷 */
const BAD = [
  'javascript:alert(document.cookie)',
  'JaVaScRiPt:alert(1)',
  'java\tscript:alert(1)',
  ' javascript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD4=',
  'vbscript:msgbox(1)',
];
/** 正常业务里真实存在的形态 */
const OK = ['https://example.com/a.jpg', 'http://wx.qlogo.cn/mmopen/abc/132'];

let app: FastifyInstance;
let token = '';

async function loginAs(code: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/sport-track/api/auth/login', payload: { code } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.accessToken as string;
}
const fpPayload = (photos: string[]) => ({
  visitDate: '2024-05-01',
  title: '协议闸门测试',
  location: { name: '西湖', address: '杭州市', latitude: 30.24, longitude: 120.15 },
  photos,
});
const markerPayload = (photoUrl: string) => ({
  id: 'm-scheme-1',
  lat: 30.24,
  lng: 120.15,
  timestamp: 1700000000000,
  type: 'photo',
  photoUrl,
});

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  token = await loginAs('scheme-user');
  await FootprintRecordModel.deleteMany({ title: /^协议闸门测试/ });
});

after(async () => {
  await FootprintRecordModel.deleteMany({ title: /^协议闸门测试/ });
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

test('三个图片入口的 schema 一律拒绝非 http(s) 协议', () => {
  for (const v of BAD) {
    const shown = JSON.stringify(v);
    assert.ok(!CreateFootprintRecordSchema.safeParse(fpPayload([v])).success, `足迹照片放过了 ${shown}`);
    assert.ok(!UpdateMeSchema.safeParse({ avatarUrl: v }).success, `头像放过了 ${shown}`);
    assert.ok(!CreateMarkerSchema.safeParse(markerPayload(v)).success, `打点照片放过了 ${shown}`);
  }
});

test('闸门不误伤：https 与本 bucket 之外的 http 图片地址照常接受', () => {
  for (const v of OK) {
    const shown = JSON.stringify(v);
    assert.ok(CreateFootprintRecordSchema.safeParse(fpPayload([v])).success, `拒绝了合法地址 ${shown}`);
    assert.ok(UpdateMeSchema.safeParse({ avatarUrl: v }).success, `拒绝了合法头像 ${shown}`);
    assert.ok(CreateMarkerSchema.safeParse(markerPayload(v)).success, `拒绝了合法打点照片 ${shown}`);
  }
});

test('打点的空照片位仍允许（未拍照就不传图）', () => {
  assert.ok(CreateMarkerSchema.safeParse(markerPayload('')).success, 'photoUrl:"" 应放行');
});

test('路由真的接了这条闸门：创建足迹带 javascript: 照片 → 400 且提示说清协议', async () => {
  const bad = await app.inject({
    method: 'POST',
    url: '/sport-track/api/footprint-records',
    headers: { authorization: `Bearer ${token}` },
    payload: fpPayload(['javascript:alert(document.cookie)']),
  });
  assert.equal(bad.statusCode, 400, bad.body);
  const msg = bad.json().message as string;
  assert.match(msg, /协议|http/, `提示要说明只接受 http/https，实际：${msg}`);
  assert.ok(!msg.includes('alert(document.cookie)'), '提示里不要反射原始载荷');

  const ok = await app.inject({
    method: 'POST',
    url: '/sport-track/api/footprint-records',
    headers: { authorization: `Bearer ${token}` },
    payload: fpPayload(['https://example.com/a.jpg']),
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const saved = await FootprintRecordModel.findOne({ title: '协议闸门测试' }).lean();
  assert.ok(saved, '合法地址应正常入库');
  assert.equal(saved!.photos.length, 1);
});

test('PUT /me 头像同样被拦，清空头像仍允许', async () => {
  const bad = await app.inject({
    method: 'PUT',
    url: '/sport-track/api/users/me',
    headers: { authorization: `Bearer ${token}` },
    payload: { avatarUrl: 'javascript:alert(1)' },
  });
  assert.equal(bad.statusCode, 400, bad.body);

  const cleared = await app.inject({
    method: 'PUT',
    url: '/sport-track/api/users/me',
    headers: { authorization: `Bearer ${token}` },
    payload: { avatarUrl: '' },
  });
  assert.equal(cleared.statusCode, 200, cleared.body);
});
