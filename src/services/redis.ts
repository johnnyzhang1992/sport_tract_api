/**
 * Redis 客户端（2026-11-17）：**可选依赖，连不上就降级为内存**
 *
 * 为什么要这层：徽章名次缓存原来是进程内单例，多实例部署时各份互不同步，
 * 同一用户刷新两次可能拿到不同名次。放到 Redis 后全实例共享一份。
 *
 * 设计原则——**Redis 是加速器，不是必需品**：
 *   - 未配置 REDIS_URL → 直接用内存实现，进程内行为与原来完全一致
 *   - 配置了但连不上 → 打一条 warn，自动降级到内存，功能照常
 *   - **假死也要能自救**（2026-11-17 修复）：Redis 进程卡住时连接不会断，
 *     只靠 'ready' 事件根本不会触发降级/恢复。这里用两层保护：
 *       ① commandTimeout：单条命令超时即失败，请求不会被永久挂住
 *       ② 降级有冷却期，到期做一次「半开探测」自动切回 Redis
 * 用法（内存/Redis 同签名，调用方不关心底层）：
 *   await cacheGetMany(['badge:unlock:a', 'badge:unlock:b']);
 *   await cacheSetMany([{ key, value, ttlSec }]);
 */
import { Redis } from 'ioredis'; // ioredis v6 起 Redis 是具名导出
import { config } from '../config/index.js';

type CacheBackend = 'redis' | 'memory';

interface MemoryEntry {
  /** 到期时刻（epoch ms） */
  exp: number;
  /** JSON 文本（与 Redis 存的一致，读写都走序列化，保证两种实现行为对齐） */
  raw: string;
}

/** 单条命令超时：Redis 假死（连接在、命令不回）时快速失败，绝不挂住业务请求 */
const COMMAND_TIMEOUT_MS = 800;
const CONNECT_TIMEOUT_MS = 1500;
/** 降级冷却：到期后做一次半开探测，成功就自动切回 Redis */
const DEGRADE_COOLDOWN_MS = 10_000;

const memory = new Map<string, MemoryEntry>();
let client: InstanceType<typeof Redis> | null = null;
let backend: CacheBackend = 'memory';
/** 降级到期时刻：now >= retryAt 时允许一次探测（避免一次抖动就永久降级） */
let retryAt = 0;
/** 连续失败只告警一次，避免日志被重连刷屏 */
let warnedDown = false;

/** 当前是否该走 Redis：降级冷却到期后做半开探测 */
function useRedis(): boolean {
  if (!client) return false;
  if (backend === 'redis') return true;
  if (Date.now() < retryAt) return false;
  backend = 'redis'; // 半开：放这一条命令过去试
  return true;
}

/** 标记降级并进入冷却期 */
function degrade(reason: string): void {
  if (!warnedDown) {
    warnedDown = true;
    console.warn(`[redis] 不可用，缓存降级为内存（${DEGRADE_COOLDOWN_MS / 1000}s 后自动重试）：`, reason);
  }
  backend = 'memory';
  retryAt = Date.now() + DEGRADE_COOLDOWN_MS;
}

/**
 * 初始化（进程启动时调用一次，幂等）。
 * 未配置 REDIS_URL 时什么都不做 → 内存模式。
 */
export function initRedis(): void {
  if (client) return;
  const url = config.redisUrl;
  if (!url) return; // 未配置：内存模式（本地开发默认走这里）

  client = new Redis(url, {
    commandTimeout: COMMAND_TIMEOUT_MS, // ← 关键：假死时不会永久阻塞
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false, // 断线时命令立即失败 → 走降级，而不是排队卡住请求
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 500, 10_000), // 重连退避，最长 10s
  });

  client.on('ready', () => {
    backend = 'redis';
    retryAt = 0;
    if (warnedDown) console.info('[redis] 已恢复，缓存切回 Redis');
    warnedDown = false;
  });
  client.on('error', (e: Error) => {
    degrade(e.message);
  });
  client.on('end', () => {
    degrade('连接已断开');
  });
}

/** 当前后端（测试/诊断用） */
export function cacheBackendNow(): CacheBackend {
  return backend;
}

/** 关闭连接（进程退出/测试收尾用） */
export async function closeRedis(): Promise<void> {
  if (!client) return;
  const c = client;
  client = null;
  backend = 'memory';
  retryAt = 0;
  try {
    await c.quit();
  } catch {
    c.disconnect();
  }
}

/** 从内存层读一条 */
function memoryGet<T>(key: string): T | null {
  const hit = memory.get(key);
  if (!hit) return null;
  if (hit.exp <= Date.now()) {
    memory.delete(key);
    return null;
  }
  try {
    return JSON.parse(hit.raw) as T;
  } catch {
    return null;
  }
}

/** 写内存层（带兜底清理，避免长期运行只增不减） */
function memorySet(key: string, raw: string, ttlSec: number): void {
  memory.set(key, { exp: Date.now() + ttlSec * 1000, raw });
  if (memory.size > 500) {
    const now = Date.now();
    for (const [k, v] of memory.entries()) if (v.exp <= now) memory.delete(k);
  }
}

/** 解析一批 JSON，坏数据按 null 处理（不让一条脏数据毁掉整批） */
function parseAll<T>(raws: Array<string | null | undefined>): Array<T | null> {
  return raws.map((raw) => {
    if (raw == null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  });
}

/**
 * 批量读缓存（**一次往返**）。命中返回解析后的值，未命中/过期/后端故障返回 null。
 * 批量是硬要求：按 key 逐个 GET 在徽章数量上百时就是上百次往返，比直查 Mongo 还慢。
 */
export async function cacheGetMany<T>(keys: string[]): Promise<Array<T | null>> {
  if (!keys.length) return [];
  if (useRedis() && client) {
    try {
      const raws = await client.mget(...keys);
      return parseAll<T>(raws);
    } catch (e) {
      degrade((e as Error).message);
    }
  }
  return keys.map((k) => memoryGet<T>(k));
}

/** 单条读（内部转批量，语义与批量一致） */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const [v] = await cacheGetMany<T>([key]);
  return v;
}

/**
 * 批量写缓存（一次往返，pipeline）。Redis 失败时写内存，保证至少本进程可复用。
 */
export async function cacheSetMany(entries: Array<{ key: string; value: unknown; ttlSec: number }>): Promise<void> {
  if (!entries.length) return;
  const raws = entries.map((e) => JSON.stringify(e.value));
  if (useRedis() && client) {
    try {
      const pipe = client.pipeline();
      entries.forEach((e, i) => pipe.set(e.key, raws[i], 'EX', e.ttlSec));
      const res = await pipe.exec();
      // pipeline 逐条返回 [err, ok]，有错误也要降级（否则部分 key 静默丢失）
      const failed = res?.find((r) => r && r[0]);
      if (failed) throw failed[0] as Error;
      return;
    } catch (e) {
      degrade((e as Error).message);
    }
  }
  entries.forEach((e, i) => memorySet(e.key, raws[i], e.ttlSec));
}

/** 单条写 */
export async function cacheSet(key: string, value: unknown, ttlSec: number): Promise<void> {
  await cacheSetMany([{ key, value, ttlSec }]);
}

/** 清空内存层（测试用；Redis 层用 clearRedisKeys 单独清） */
export function clearMemoryCache(): void {
  memory.clear();
}

/** 删除已存在的 Redis key（测试/运维用）；未连 Redis 时无操作 */
export async function clearRedisKeys(prefix: string): Promise<void> {
  if (!client) return;
  try {
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      if (keys.length) await client.del(...keys);
    } while (cursor !== '0');
  } catch {
    // 忽略：清理失败不影响功能
  }
}
