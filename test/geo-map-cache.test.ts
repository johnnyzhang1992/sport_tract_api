/**
 * 省界地图接口的缓存响应头。
 *
 * 背景：体验评分把 /geo/china-map 判为「请求未做缓存」——这份 GeoJSON 内容静态、体积大，
 * 每次进地图页整包重拉纯属浪费。接口侧给出 Cache-Control 让客户端/中间层可以复用。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
});

const get = (url: string) => app.inject({ method: 'GET', url: `/sport-track/api${url}` });

test('GM1 china-map 带 Cache-Control，可被客户端缓存', async () => {
  const res = await get('/geo/china-map');
  assert.equal(res.statusCode, 200, res.body);
  const cc = res.headers['cache-control'];
  assert.ok(cc, '应下发 Cache-Control');
  assert.match(String(cc), /public/);
  assert.match(String(cc), /max-age=86400/);
});

test('GM2 province-map 同样下发缓存头', async () => {
  const res = await get('/geo/province-map?adcode=330000');
  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers['cache-control'] || ''), /max-age=86400/);
});
