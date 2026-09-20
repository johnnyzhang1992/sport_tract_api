import axios from 'axios';
import { config } from '../config/index.js';
import { AppError } from '../utils/app-error.js';

/**
 * 腾讯位置服务 WebService 逆地理编码（决策：从后端调用，避免前端暴露 key）
 * 文档：https://lbs.qq.com/service/webService/webServiceGuide/overview
 * - key 需在控制台勾选启用 WebService API（否则 status 199）
 * - 失败/未配置时返回空字符串（前端降级不显示地址）
 */
export async function reverseGeocode(lat: number, lng: number): Promise<string> {
  const d = await reverseGeocodeDetail(lat, lng);
  return d?.address ?? '';
}

export interface GeoDetail {
  address: string;
  province: string;
  city: string;
}

const detailCache = new Map<string, GeoDetail>();

/**
 * 逆地理编码详情（地址 + 省/市，用于足迹点亮统计）
 * 粗粒度坐标缓存（约 1km 网格），降低调用量
 */
export async function reverseGeocodeDetail(lat: number, lng: number): Promise<GeoDetail | null> {
  if (!config.tencentMapKey) return null;

  const cacheKey = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const hit = detailCache.get(cacheKey);
  if (hit) return hit;

  try {
    const { data } = await axios.get('https://apis.map.qq.com/ws/geocoder/v1/', {
      params: { location: `${lat},${lng}`, key: config.tencentMapKey },
      timeout: 5000,
    });
    if (data.status !== 0 || !data.result) return null;
    const ad = data.result.ad_info ?? {};
    const detail: GeoDetail = {
      address: String(data.result.address ?? ''),
      province: String(ad.province ?? ''),
      city: String(ad.city ?? ''),
    };
    detailCache.set(cacheKey, detail);
    return detail;
  } catch (err) {
    console.warn('[geo] 逆地理编码失败:', (err as Error).message);
    return null;
  }
}

// ==================== 地点关键词搜索（腾讯 place/v1/search） ====================

export interface PlaceItem {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
}

type PlaceResponse = { data: { status: number; data?: Array<{ title?: string; address?: string; location?: { lat: number; lng: number } }> } };
type PlaceFetcher = () => Promise<PlaceResponse>;

const PLACE_TTL_MS = 3600000; // 关键词缓存 1 小时：省额度
const PLACE_CACHE_MAX = 500;
const placeCache = new Map<string, { at: number; items: PlaceItem[] }>();

/** 测试注入点：替换上游请求（传 null 还原） */
let placeFetcherOverride: PlaceFetcher | null = null;
export function __setPlaceFetcherForTest(f: PlaceFetcher | null) {
  placeFetcherOverride = f;
}
export function __clearPlaceCacheForTest() {
  placeCache.clear();
}

export async function searchPlaces(keyword: string, latitude?: number, longitude?: number): Promise<PlaceItem[]> {
  const kw = keyword.trim();
  if (!kw || !config.tencentMapKey) return [];
  const cacheKey = `${kw.toLowerCase()}|${latitude != null && longitude != null ? `${latitude.toFixed(2)},${longitude.toFixed(2)}` : ''}`;
  const hit = placeCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PLACE_TTL_MS) return hit.items;

  const fetcher: PlaceFetcher =
    placeFetcherOverride ??
    (async () =>
      axios.get('https://apis.map.qq.com/ws/place/v1/search', {
        params: {
          keyword: kw,
          page_size: 20,
          ...(latitude != null && longitude != null ? { location: `${latitude},${longitude}` } : {}),
          key: config.tencentMapKey,
        },
        headers: config.tencentMapReferer ? { Referer: config.tencentMapReferer } : {},
        timeout: 5000,
      }) as Promise<PlaceResponse>);

  try {
    const res = await fetcher();
    const list = res.data?.status === 0 ? res.data.data ?? [] : [];
    const items: PlaceItem[] = list
      .filter((p) => p.title && p.location)
      .slice(0, 20)
      .map((p) => ({
        name: String(p.title ?? ''),
        address: String(p.address ?? ''),
        latitude: Number(p.location!.lat),
        longitude: Number(p.location!.lng),
      }));
    if (placeCache.size >= PLACE_CACHE_MAX) placeCache.delete(placeCache.keys().next().value as string);
    placeCache.set(cacheKey, { at: Date.now(), items });
    return items;
  } catch (err) {
    console.warn('[geo] place 搜索失败:', (err as Error).message);
    return [];
  }
}

// ==================== 每用户搜索限流（10 次/分钟） ====================

const SEARCH_LIMIT = 10;
const searchRate = new Map<string, { minute: number; count: number }>();

/** 当前分钟窗口内计数，超过 SEARCH_LIMIT 抛 429（now 可注入便于时间相关测试） */
export function assertSearchQuota(userId: string, now: number = Date.now()): void {
  const minute = Math.floor(now / 60000);
  const rec = searchRate.get(userId);
  if (!rec || rec.minute !== minute) {
    searchRate.set(userId, { minute, count: 1 });
    return;
  }
  rec.count += 1;
  if (rec.count > SEARCH_LIMIT) {
    throw new AppError(429, '搜索过于频繁，请稍后再试');
  }
}
