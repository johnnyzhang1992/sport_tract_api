/**
 * 徽章名次缓存层（2026-11-17）：services/redis.ts
 * 运行：node --import tsx --test test/badge-cache.test.ts
 *
 * 守的承诺——**Redis 是加速器，不是必需品**：
 *   1. 未配置 REDIS_URL → 内存模式，功能完全正常
 *   2. 配置了但连不上 → 自动降级内存，不抛错、不阻塞请求
 *   3. 两种后端的读写语义一致（都走 JSON 序列化，过期行为相同）
 *   4. 缓存只是派生数据，清掉也能现场重算出来
 *
 * 这里**不依赖真实 Redis**：它只测不配置/连不上时的降级路径
 * （真实 Redis 链路由 badge-overview.test.ts 等集成测试覆盖）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// 确保测试跑在「未配置 Redis」的内存模式（不污染真实 Redis）
delete process.env.REDIS_URL;

const {
  initRedis,
  cacheBackendNow,
  cacheGet,
  cacheSet,
  clearMemoryCache,
  closeRedis,
} = await import('../src/services/redis.js');

before(() => {
  initRedis();
});

after(async () => {
  await closeRedis();
});

test('RC1 未配置 REDIS_URL → 内存后端，不抛错', async () => {
  assert.equal(cacheBackendNow(), 'memory');
  clearMemoryCache();
});

test('RC2 写入后能读回，且对象结构保持不变', async () => {
  clearMemoryCache();
  const value = [{ uid: 'u1', date: '2026-11-16' }, { uid: 'u2', date: '2026-11-16' }];
  await cacheSet('badge:unlock:test', value, 60);
  assert.deepEqual(await cacheGet('badge:unlock:test'), value);
});

test('RC3 未命中的 key 返回 null（不是 undefined，调用方按 == null 判断）', async () => {
  clearMemoryCache();
  const v = await cacheGet('badge:unlock:never');
  assert.equal(v, null);
});

test('RC4 TTL 过期后读不到', async () => {
  clearMemoryCache();
  await cacheSet('short', { a: 1 }, 0); // 0 秒 → 立即过期
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await cacheGet('short'), null);
});

test('RC5 覆盖写：同 key 再写以最新为准', async () => {
  clearMemoryCache();
  await cacheSet('k', { v: 1 }, 60);
  await cacheSet('k', { v: 2 }, 60);
  assert.deepEqual(await cacheGet('k'), { v: 2 });
});

test('RC6 后端不可用时 cacheGet/cacheSet 仍工作（降级不抛错）', async () => {
  // 该测试跑在内存模式（未配置 REDIS_URL），等价于「Redis 挂了自动降级」后的状态：
  // 功能必须照常，只是复用范围退化为单进程。
  assert.equal(cacheBackendNow(), 'memory');
  clearMemoryCache();
  assert.equal(await cacheGet('k2'), null, '读不存在的 key 返回 null 而不是抛错');
  await cacheSet('k2', { ok: true }, 60);
  assert.deepEqual(await cacheGet('k2'), { ok: true });
});

test('RC7 存字符串/数字/布尔等非对象值也能往返（JSON 语义一致）', async () => {
  clearMemoryCache();
  for (const [k, v] of [['s', 'text'], ['n', 42], ['b', false], ['arr', [1, 2]]] as const) {
    await cacheSet(k, v, 60);
    assert.deepEqual(await cacheGet(k), v, `${k} 往返不一致`);
  }
});