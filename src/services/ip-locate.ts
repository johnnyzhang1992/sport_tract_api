/**
 * IP 定位服务：ip2region-ts 离线库 + 腾讯 API 兜底
 * - 优先用 ip2region xdb 离线查询（毫秒级、无网络依赖）
 * - 离线库查不到时再调腾讯位置服务 WebService API
 */
import { config } from '../config/index.js';
import * as ip2regionTs from 'ip2region-ts';
const { newWithFileOnly, defaultDbFile } = ip2regionTs;

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

/**
 * 解析 ip2region 返回的 region 字符串
 * 格式示例："中国|0|湖北省|武汉市|电信"
 * 返回 { province: "湖北省", city: "武汉市" }
 */
function parseRegion(region: string): { province: string; city: string } {
  const parts = region.split('|');
  // parts[0]=国家, parts[1]=区域(0表示无), parts[2]=省, parts[3]=市, parts[4]=运营商
  const province = parts[2] || '';
  let city = parts[3] || '';
  // 直辖市：省和市相同，统一为 "北京市" 格式
  if (province && city && province === city) {
    city = province;
  }
  return { province, city };
}

let searcher: any | undefined;

function getSearcher(): any {
  if (!searcher) {
    searcher = newWithFileOnly(defaultDbFile);
  }
  return searcher;
}

export async function locateByIp(ip: string): Promise<IpLocation | null> {
  if (!ip || ip === '::1' || ip.startsWith('127.')) return null;

  const cached = cache.get(ip);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return { province: cached.province, city: cached.city };
  }

  // 1. 优先 ip2region 离线查询
  try {
    const searcher = await getSearcher();
    const result = await searcher.search(ip);
    if (result && result.region && result.region !== '0|0|0|0|0') {
      const loc = parseRegion(result.region);
      if (loc.province || loc.city) {
        cache.set(ip, { ...loc, ts: Date.now() });
        return loc;
      }
    }
  } catch {
    // 离线查询失败，继续走腾讯 API
  }

  // 2. 兜底：腾讯位置服务 WebService API
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
