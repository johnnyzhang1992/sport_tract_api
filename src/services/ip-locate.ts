/**
 * IP 定位服务：ip2region-ts 离线库 + 三级在线兜底
 * - 优先 ip2region xdb 离线查询（毫秒级、无网络依赖）
 * - 移动基站等动态号段离线库只有运营商没有省市（"中国|0|0|0|移动"），需在线兜底：
 *   1) 太平洋 whois（国内直连、中文省市、免 key，GBK 编码）
 *   2) ip-api.com（中文、免 key，境外 IP 也可解析；免费版仅 http、45 次/分钟）
 *   3) 腾讯位置服务 WebService API（key 为域名授权，服务端调用需带授权域 Referer，且每日额度有限）
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

/** 自治区/直辖市简称 → 全称（不同数据源命名粒度不一致，统一为 ip2region 风格全称） */
const PROVINCE_ALIAS: Record<string, string> = {
  北京: '北京市',
  上海: '上海市',
  天津: '天津市',
  重庆: '重庆市',
  广西: '广西壮族自治区',
  内蒙古: '内蒙古自治区',
  宁夏: '宁夏回族自治区',
  新疆: '新疆维吾尔自治区',
  西藏: '西藏自治区',
};

/** 以“省”结尾的省份简称（部分数据源返回“广东”这类不带后缀的名称） */
const PROVINCE_SHORT = new Set([
  '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽', '福建', '江西', '山东',
  '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '陕西', '甘肃', '青海', '台湾',
]);

function normalizeProvince(p: string): string {
  if (!p) return '';
  if (PROVINCE_ALIAS[p]) return PROVINCE_ALIAS[p];
  if (PROVINCE_SHORT.has(p)) return `${p}省`;
  return p;
}

/**
 * IP 定位无效/内网占位值：ip2region、whois 兜底可能返回 "0"、"内网IP" 等，
 * 这些不是真实省市，写入登录日志会让管理端省份分布出现“0”这类脏数据。
 */
export const INVALID_REGION_VALUES = ['', '0', '内网IP', '未知', '局域网', '本机地址', '保留地址'];
const invalidRegionSet = new Set(INVALID_REGION_VALUES);

/** 是否为有效省/市值（过滤 "0"、"内网IP"、空串等占位值） */
export function isValidRegionValue(v: string | null | undefined): boolean {
  return !!v && !invalidRegionSet.has(v);
}

/** 清洗定位结果：无效值一律置空（调用方再按 province/city 是否为空决定是否落库） */
function sanitizeRegion(loc: IpLocation): IpLocation {
  return {
    province: isValidRegionValue(loc.province) ? loc.province : '',
    city: isValidRegionValue(loc.city) ? loc.city : '',
  };
}

/**
 * 解析 ip2region 返回的 region 字符串
 * 格式示例："中国|0|湖北省|武汉市|电信"
 * 返回 { province: "湖北省", city: "武汉市" }
 */
function parseRegion(region: string): { province: string; city: string } {
  const parts = region.split('|');
  // parts[0]=国家, parts[1]=区域(0表示无), parts[2]=省, parts[3]=市, parts[4]=运营商
  const province = parts[2] && parts[2] !== '0' ? parts[2] : '';
  let city = parts[3] && parts[3] !== '0' ? parts[3] : '';
  // 直辖市：省和市相同，统一为 "北京市" 格式
  if (province && city && province === city) {
    city = province;
  }
  return { province: normalizeProvince(province), city };
}

let searcher: any | undefined;

function getSearcher(): any {
  if (!searcher) {
    searcher = newWithFileOnly(defaultDbFile);
  }
  return searcher;
}

/** GBK 解码（懒初始化：ICU 不完整的环境下返回 null，跳过该数据源） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let gbkDecoder: any | null | undefined;
function decodeGbk(buf: ArrayBuffer): string | null {
  if (gbkDecoder === undefined) {
    try {
      gbkDecoder = new TextDecoder('gbk');
    } catch {
      gbkDecoder = null;
    }
  }
  return gbkDecoder ? gbkDecoder.decode(buf) : null;
}

/** 兜底 1：太平洋 whois（中文省市、国内直连；境外 IP 返回 err="noprovince"） */
async function locateByPconline(ip: string): Promise<IpLocation | null> {
  const res = await fetch(
    `https://whois.pconline.com.cn/ipJson.jsp?ip=${encodeURIComponent(ip)}&json=true`,
    { signal: AbortSignal.timeout(2500) },
  );
  const text = decodeGbk(await res.arrayBuffer());
  if (!text) return null;
  // 响应首尾可能有空行，取第一个 { 到最后一个 } 之间的 JSON
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  const json: any = JSON.parse(text.slice(s, e + 1));
  if (json.err || !json.pro) return null;
  return { province: normalizeProvince(json.pro), city: json.city || '' };
}

/** 兜底 2：ip-api.com（免费版 http + 45 次/分钟，中文返回；仅 IP 归属粗粒度，够省市展示用） */
async function locateByIpApi(ip: string): Promise<IpLocation | null> {
  const res = await fetch(
    `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=status,regionName,city`,
    { signal: AbortSignal.timeout(2500) },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json();
  if (json.status !== 'success' || !json.regionName) return null;
  return { province: normalizeProvince(json.regionName), city: json.city || '' };
}

/** 兜底 3：腾讯位置服务（额度有限，放最后；域名授权 key 必须带 Referer，否则 status 110） */
async function locateByTencent(ip: string): Promise<IpLocation | null> {
  const key = config.tencentMapKey;
  if (!key) return null;
  const url = `https://apis.map.qq.com/ws/location/v1/ip?key=${key}&ip=${encodeURIComponent(ip)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(3000),
    headers: { Referer: config.tencentMapReferer },
  });
  const json = (await res.json()) as TencentIpResult;
  if (json.status !== 0 || !json.result?.ad_info) {
    console.log('[IP-Locate] Tencent API response for', ip, ':', JSON.stringify(json));
    return null;
  }
  const { province, city } = json.result.ad_info;
  return { province: normalizeProvince(province || ''), city: city || '' };
}

export async function locateByIp(ip: string): Promise<IpLocation | null> {
  if (!ip || ip === '::1' || ip.startsWith('127.')) return null;

  const cached = cache.get(ip);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return sanitizeRegion({ province: cached.province, city: cached.city });
  }

  // 1. 优先 ip2region 离线查询
  try {
    const searcher = await getSearcher();
    const result = await searcher.search(ip);
    if (result && result.region && result.region !== '0|0|0|0|0') {
      const loc = sanitizeRegion(parseRegion(result.region));
      if (loc.province || loc.city) {
        cache.set(ip, { ...loc, ts: Date.now() });
        return loc;
      }
    }
  } catch {
    // 离线查询失败，继续在线兜底
  }

  // 2~4. 在线兜底链：任一解析到省市即用
  for (const provider of [locateByPconline, locateByIpApi, locateByTencent]) {
    try {
      const loc = await provider(ip);
      if (loc) {
        const clean = sanitizeRegion(loc);
        if (clean.province || clean.city) {
          cache.set(ip, { ...clean, ts: Date.now() });
          return clean;
        }
      }
    } catch {
      // 该数据源失败（超时/限流/结构变化），继续下一个
    }
  }
  return null;
}
