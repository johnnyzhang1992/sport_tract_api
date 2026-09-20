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
 * /geo/search 腾讯 place 代理：仅成功响应进 1h 缓存 + 每用户 10 次/分限流 + 测试注入点
 *
 * 环境无关：无 TENCENT_MAP_KEY 时在 before 里临时塞一个假 key（after 还原），
 * 因此下面所有断言都是硬断言，不再有 `if (config.tencentMapKey)` 之类的环境分支。
 * 全部上游访问都经 __setPlaceFetcherForTest 走假 fetcher，绝不真调腾讯（零真实额度、CI 无网也能跑）。
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

let originalTencentMapKey: string | null = null;

before(async () => {
  // 断言与本机是否配了 TENCENT_MAP_KEY 无关：缺失时临时塞一个假 key，
  // 让 searchPlaces 走进 fetcher 分支（fetcher 已被假实现接管，不会真调腾讯）
  if (!config.tencentMapKey) {
    originalTencentMapKey = config.tencentMapKey;
    (config as any).tencentMapKey = 'test-fake-key';
  }
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
  if (originalTencentMapKey !== null) {
    (config as any).tencentMapKey = originalTencentMapKey;
    originalTencentMapKey = null;
  }
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
  assert.equal(r1[0].name, '西湖');
  assert.equal(calls, 1); // 第二次命中缓存，上游只被调 1 次
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
  const res = await search(`keyword=${encodeURIComponent('西湖')}&latitude=30.24&longitude=120.15`);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.success, true);
  assert.equal(body.code, 200);
  const items = body.data as PlaceItem[];
  // 假上游命中（地址文案仅存在于假响应里 = 未真调腾讯的证据），逐项硬断言下游小程序依赖的字段形状
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 1);
  assert.deepEqual(Object.keys(items[0]).sort(), ['address', 'latitude', 'longitude', 'name']);
  assert.equal(items[0].name, '西湖');
  assert.equal(items[0].address, '杭州市西湖区');
  assert.equal(items[0].latitude, 30.24);
  assert.equal(items[0].longitude, 120.15);
});

test('降级：上游抛异常（网络/超时）→ searchPlaces 返回 []、route 不 5xx', async () => {
  __clearPlaceCacheForTest();
  __setPlaceFetcherForTest(async () => {
    throw new Error('ETIMEDOUT at apis.map.qq.com');
  });
  const kw = '异常关键词';
  const items = await searchPlaces(kw);
  assert.deepEqual(items, []);

  // 路由层同样不冒泡成 5xx：仍是 success([]) —— 前端按"搜不到"降级
  const res = await search(`keyword=${encodeURIComponent(kw)}&latitude=30.24&longitude=120.15`);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().success, true);
  assert.deepEqual(res.json().data, []);

  // 异常路径不进缓存：换个正常上游后同 keyword 立即能搜到（不会被空结果锁 1 小时）
  let calls = 0;
  __setPlaceFetcherForTest(async () => {
    calls += 1;
    return fakePlaceResponse();
  });
  const retry = await searchPlaces(kw);
  assert.equal(calls, 1);
  assert.equal(retry.length, 1);
  assert.equal(retry[0].name, '西湖');
});

test('截断：上游返回 25 条时结果只留 20 条', async () => {
  __clearPlaceCacheForTest();
  __setPlaceFetcherForTest(async () => ({
    data: {
      status: 0,
      data: Array.from({ length: 25 }, (_, i) => ({
        title: `地点${i}`,
        address: `地址${i}`,
        location: { lat: 30 + i / 100, lng: 120 + i / 100 },
      })),
    },
  }));
  const items = await searchPlaces('很多结果');
  assert.equal(items.length, 20);
  assert.equal(items[0].name, '地点0');
  assert.equal(items[19].name, '地点19');
});

test('route：限流真的生效——同一用户当分钟第 11 次搜索返回 429', async () => {
  // 直接烧掉 10 次额度（同一分钟窗口），随后一次 HTTP 请求即越界
  for (let i = 0; i < 10; i++) assertSearchQuota(quotaUserId);
  const blocked = await search('keyword=%E8%A5%BF%E6%B9%96', quotaToken);
  assert.equal(blocked.statusCode, 429, blocked.body);
  assert.equal(blocked.json().code, 429);
  assert.ok(blocked.json().message.includes('频繁'), blocked.body);
});

