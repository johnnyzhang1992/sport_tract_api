import axios from 'axios';
import { config } from '../config/index.js';

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
