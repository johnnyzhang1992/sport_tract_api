/**
 * IP 定位服务：通过腾讯位置服务 WebService API 将 IP 解析为省/市
 * - 使用项目中已有的 TENCENT_MAP_KEY（已授权 WebService）
 * - 接口：https://apis.map.qq.com/ws/location/v1/ip?key=<key>&ip=<ip>
 */
import { config } from '../config/index.js';

interface TencentIpResult {
  status: number;
  message: string;
  result?: {
    ip: string;
    location: { lat: number; lng: number };
    ad_info: {
      nation: string;
      province: string;
      city: string;
      district: string;
      adcode: number;
    };
  };
}

const cache = new Map<string, { province: string; city: string; ts: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

export interface IpLocation {
  province: string;
  city: string;
}

export async function locateByIp(ip: string): Promise<IpLocation | null> {
  if (!ip || ip === '::1' || ip.startsWith('127.')) return null;

  const cached = cache.get(ip);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return { province: cached.province, city: cached.city };
  }

  try {
    const key = config.tencentMapKey;
    if (!key) return null;

    const url = `https://apis.map.qq.com/ws/location/v1/ip?key=${key}&ip=${encodeURIComponent(ip)}`;
    const res = await fetch(url);
    const json: TencentIpResult = (await res.json()) as TencentIpResult;

    if (json.status !== 0 || !json.result?.ad_info) {
      console.log('[IP-Locate] Tencent API response for', ip, ':', JSON.stringify(json));
      return null;
    }

    const { province, city } = json.result.ad_info;
    const loc = { province: province || '', city: city || '' };
    cache.set(ip, { ...loc, ts: Date.now() });
    return loc;
  } catch {
    return null;
  }
}
