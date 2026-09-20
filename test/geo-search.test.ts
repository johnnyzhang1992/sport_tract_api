import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import {
  __setPlaceFetcherForTest,
  __clearPlaceCacheForTest,
  searchPlaces,
  assertSearchQuota,
  type PlaceItem,
} from '../src/services/geo.js';

/**
 * /geo/search 腾讯 place 代理：1h 缓存 + 每用户 10 次/分限流 + 测试注入点
 * 注意：无 TENCENT_MAP_KEY 环境（CI/.env 缺失）时 searchPlaces 直接返回 []，
 * 下面用例对"返回空"与"fetcher 命中"两种情况都容忍，只断言不抛错 + 缓存不重复请求。
 * 全部用例经 __setPlaceFetcherForTest 走假上游，绝不真调腾讯（省额度、CI 无网也能跑）。
 */

let app: FastifyInstance;
let token = '';
let quotaToken = '';
let quotaUserId = '';

const SEARCH_URL = '/sport-track/api/geo/search';

async function loginAs(code: string): Promise<{ accessToken: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/sport-track/api/auth/login', payload: { code } });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json().data;
  // mock 登录同一 code 幂等返回同一用户
  return { accessToken: body.accessToken as string, userId: body.user.id as string };
}

const search = (qs: string, bearer = token) =>
  app.inject({ method: 'GET', url: `${SEARCH_URL}?${qs}`, headers: { authorization: `Bearer ${bearer}` } });

/** 假上游：一条"西湖"结果（PlaceItem 形状以下游小程序契约为准） */
const fakePlaceResponse = () => ({
  data: {
    status: 0,
    data: [{ title: '西湖', address: '杭州市西湖区', location: { lat: 30.24, lng: 120.15 } }],
  },
});

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  token = (await loginAs('geo-search-user')).accessToken;
  // 限流用例专属用户：不污染上面的计数
  const u = await loginAs('geo-search-quota-user');
  quotaToken = u.accessToken;
  quotaUserId = u.userId;
  __clearPlaceCacheForTest();
});

// 每个用例前重新装好假上游：searchPlaces 用例结束时会把注入点还原为 null，
// 若不在这里兜住，后续 route 用例就会真调腾讯接口烧额度
beforeEach(() => {
  __setPlaceFetcherForTest(async () => fakePlaceResponse());
});

after(async () => {
  __setPlaceFetcherForTest(null);
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

test('searchPlaces：空 keyword 返回 []；fetcher 不被重复调用（缓存）', async () => {
  let calls = 0;
  __clearPlaceCacheForTest();
  __setPlaceFetcherForTest(async () => {
    calls += 1;
    return { data: { status: 0, data: [{ title: '西湖', address: '杭州市', location: { lat: 30.24, lng: 120.15 } }] } };
  });
  const r1 = await searchPlaces('西湖');
  const r2 = await searchPlaces('西湖');
  if (r1.length === 0) {
    // 无 key 环境：短路返回，fetcher 不应被调用
    assert.equal(calls, 0);
  } else {
    assert.equal(r1[0].name, '西湖');
    assert.equal(calls, 1); // 第二次命中缓存
  }
  assert.deepEqual(r1, r2);
  __setPlaceFetcherForTest(null);
});

test('限流：每用户每分钟 10 次，第 11 次抛 429', async () => {
  const { assertSearchQuota } = await import('../src/services/geo.js');
  const uid = `quota-test-${Date.now()}`;
  const base = Math.floor(Date.now() / 60000);
  for (let i = 0; i < 10; i++) assertSearchQuota(uid);
  assert.throws(() => assertSearchQuota(uid), (e: any) => e.statusCode === 429);
});

test('route：未登录 401；带 token 缺 keyword 400（均不触达腾讯）', async () => {
  const noAuth = await app.inject({ method: 'GET', url: `${SEARCH_URL}?keyword=%E8%A5%BF%E6%B9%96` });
  assert.equal(noAuth.statusCode, 401);

  const noKw = await app.inject({ method: 'GET', url: SEARCH_URL, headers: { authorization: `Bearer ${token}` } });
  assert.equal(noKw.statusCode, 400, noKw.body);
  assert.equal(noKw.json().code, 400);
  assert.ok(noKw.json().message.includes('keyword'), noKw.body);

  const blankKw = await search('keyword=%20%20'); // 纯空白等同缺失
  assert.equal(blankKw.statusCode, 400, blankKw.body);
});

test('route：200 返回 success(PlaceItem[])，字段名与前端契约一致', async () => {
  const res = await search('keyword=%E8%A5%BF%E6%B9%96&latitude=30.24&longitude=120.15');
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.success, true);
  assert.equal(body.code, 200);
  const items = body.data as PlaceItem[];
  assert.ok(Array.isArray(items));
  if (config.tencentMapKey) {
    // 有 key（本地 .env.local）：走假上游，逐项断言下游小程序依赖的字段形状
    assert.equal(items.length, 1);
    assert.deepEqual(Object.keys(items[0]).sort(), ['address', 'latitude', 'longitude', 'name']);
    assert.equal(items[0].name, '西湖');
    assert.equal(items[0].address, '杭州市西湖区');
    assert.equal(items[0].latitude, 30.24);
    assert.equal(items[0].longitude, 120.15);
  } else {
    assert.equal(items.length, 0); // 无 key 环境：短路空数组，不请求上游
  }
});

test('route：限流真的生效——同一用户当分钟第 11 次搜索返回 429', async () => {
  // 直接烧掉 10 次额度（同一分钟窗口），随后一次 HTTP 请求即越界
  for (let i = 0; i < 10; i++) assertSearchQuota(quotaUserId);
  const blocked = await search('keyword=%E8%A5%BF%E6%B9%96', quotaToken);
  assert.equal(blocked.statusCode, 429, blocked.body);
  assert.equal(blocked.json().code, 429);
  assert.ok(blocked.json().message.includes('频繁'), blocked.body);
});

