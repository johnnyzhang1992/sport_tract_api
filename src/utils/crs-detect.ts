/**
 * 导入文件坐标系识别（TrailCraft core/crs/detect.ts 同思路）：
 * 按 GPX creator / 文件名匹配「国内坐标 App」vs「国际设备」——
 *   - 两步路/六只脚/行者/奥维/Keep 等国内 App 记录/导出的就是 GCJ-02 坐标
 *   - 百度系导出 BD-09
 *   - Garmin/Coros/Strava 等国际设备导出 WGS-84
 * 识别失败（unknown）按 WGS-84 处理（历史默认口径），由响应里的 crs 字段告知前端展示。
 *
 * Latin 词用字母边界 `(?<![a-zA-Z])...(?![a-zA-Z])` 而非 \b：\b 把数字/下划线当
 * 词字符，会漏匹配 "foooooot_12345.kml" 这类真实文件名；同时防止 "apple" 作为
 * 子串误匹配进 "Snapple Fitness" 这种 App 名。
 */
export type Crs = 'wgs84' | 'gcj02' | 'bd09';

export interface DetectCrsInput {
  creator?: string;
  fileName?: string;
}

export interface DetectCrsResult {
  crs: Crs;
  confidence: 'high' | 'unknown';
  reason: string;
}

const WGS84_PAT = /(?<![a-zA-Z])(?:coros|garmin|suunto|strava|polar|wahoo|amazfit|huami|apple|gpx.?studio|caltopo|komoot)(?![a-zA-Z])/i;
const GCJ02_PAT = /两步路|六只脚|行者|奥维|高德|(?<![a-zA-Z])(?:foooooot|lvye|imxingzhe|xingzhe|ovital|amap|keep)(?![a-zA-Z])/i;
const BD09_PAT = /百度|(?<![a-zA-Z])baidu(?![a-zA-Z])/i;

export function detectCrs(input: DetectCrsInput): DetectCrsResult {
  const sig = `${input.creator ?? ''} ${input.fileName ?? ''}`;
  if (BD09_PAT.test(sig)) return { crs: 'bd09', confidence: 'high', reason: 'creator/文件名匹配百度系' };
  if (GCJ02_PAT.test(sig)) return { crs: 'gcj02', confidence: 'high', reason: 'creator/文件名匹配国内 App' };
  if (WGS84_PAT.test(sig)) return { crs: 'wgs84', confidence: 'high', reason: 'creator/文件名匹配国际设备' };
  return { crs: 'wgs84', confidence: 'unknown', reason: '无识别信号，按 WGS-84 处理' };
}
