/**
 * 运动数据导入（决策 M7）：解析 GPX / KML / TCX → 统一轨迹点 → 计算指标 → 创建 finished 活动
 * - GPX：trk/trkseg/trkpt（lat/lon 属性 + ele/time 子元素）—— Strava/华为/小米/两步路
 * - KML：Placemark/LineString/coordinates（"lon,lat,alt" 空格分隔，经度在前需调换）—— 两步路
 * - TCX：Activities/Activity/Lap/Track/Trackpoint/Position（LatitudeDegrees/LongitudeDegrees）—— Strava/佳明
 */
import { XMLParser } from 'fast-xml-parser';
import { ActivityModel } from '../models/activity.model.js';
import { AppError } from '../utils/app-error.js';
import { calcStats, haversineDistance, type TrackPointLike } from '../utils/pace.js';
import { cleanAltitudeSpikes } from '../utils/altitude-clean.js';
import { wgs84ToGcj02 } from '../utils/coordinate.js';
import { ACTIVITY_TYPES, MAX_TRACK_POINTS } from '../config/constants.js';

export interface ImportedPoint {
  lat: number;
  lng: number;
  altitude: number | null;
  timestamp: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false, // 保持字符串，避免数字被提前转换（坐标需精确）
});

const MAX_IMPORT_POINTS = 50_000;

/** 解析文件内容 → 轨迹点（时间缺失时按 1s 间隔补全） */
export function parseTrackFile(filename: string, content: string): ImportedPoint[] {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.gpx')) return parseGpx(content);
  if (lower.endsWith('.kml')) return parseKml(content);
  if (lower.endsWith('.tcx')) return parseTcx(content);
  throw new AppError(400, `不支持的文件格式：${filename}（支持 .gpx/.kml/.tcx）`);
}

/** 数字解析防御：字符串 → 有限数字，非法返回 null */
function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 坐标合法性：纬度 ±90、经度 ±180 */
function validLatLng(lat: number | null, lng: number | null): lat is number {
  return lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/** 通用：过滤非法点 + 时间排序/补全 */
function finalize(points: ImportedPoint[]): ImportedPoint[] {
  const pts = points.filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180,
  );
  if (pts.length < 2) {
    throw new AppError(400, '文件解析失败：有效轨迹点不足 2 个');
  }
  if (pts.length > MAX_IMPORT_POINTS) {
    throw new AppError(400, `轨迹点过多（>${MAX_IMPORT_POINTS}），请导出时缩小范围`);
  }
  // 时间：缺失按 1s 间隔补全；乱序按时间排序
  let t0 = 0;
  const out: ImportedPoint[] = [];
  for (const p of pts) {
    if (typeof p.timestamp === 'number' && p.timestamp > 0) {
      t0 = p.timestamp;
    } else {
      p.timestamp = t0;
      t0 += 1000;
    }
    out.push(p);
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  // 海拔尖刺清洗（复用 finish 清洗逻辑）
  return cleanAltitudeSpikes(out);
}

/** GPX 解析：trk/trkseg/trkpt */
export function parseGpx(xml: string): ImportedPoint[] {
  const root = parser.parse(xml);
  const gpx = root?.gpx ?? {};
  const trks = asArray(gpx.trk);
  const points: ImportedPoint[] = [];
  for (const trk of trks) {
    const segs = asArray(trk?.trkseg);
    for (const seg of segs) {
      for (const pt of asArray(seg?.trkpt)) {
        const lat = toNum(pt?.['@_lat']);
        const lng = toNum(pt?.['@_lon']);
        if (!validLatLng(lat, lng)) continue;
        const alt = toNum(pt?.ele);
        const time = pt?.time ? new Date(String(pt.time)).getTime() : 0;
        points.push({
          lat: lat as number,
          lng: lng as number,
          altitude: alt != null ? Math.round(alt * 10) / 10 : null,
          timestamp: Number.isFinite(time) && time > 0 ? time : 0,
        });
      }
    }
  }
  return finalize(points);
}

/** KML 解析：递归收集所有 Placemark（两步路轨迹在 Folder 内） */
export function parseKml(xml: string): ImportedPoint[] {
  const root = parser.parse(xml);
  const doc = root?.kml?.Document ?? root?.kml ?? {};
  const placemarks = collectPlacemarks(doc);
  const points: ImportedPoint[] = [];
  for (const pm of placemarks) {
    // 优先 gx:Track（两步路格式，含时间）；fallback LineString coordinates
    const gx = pm?.['gx:Track'];
    if (gx) {
      const whens = asArray(gx.when);
      const coords = asArray(gx['gx:coord']);
      for (let i = 0; i < coords.length; i++) {
        const parts = String(coords[i]).trim().split(/\s+/);
        if (parts.length < 2) continue;
        const lng = toNum(parts[0]);
        const lat = toNum(parts[1]);
        if (!validLatLng(lat, lng)) continue;
        const alt = toNum(parts[2]);
        const when = whens[i];
        const t = when ? new Date(String(when)).getTime() : 0;
        points.push({
          lat: lat as number,
          lng: lng as number,
          altitude: alt != null ? Math.round(alt * 10) / 10 : null,
          timestamp: Number.isFinite(t) && t > 0 ? t : 0,
        });
      }
      continue;
    }
    const coords = pm?.LineString?.coordinates ?? pm?.MultiGeometry?.LineString?.coordinates;
    if (typeof coords !== 'string') continue;
    for (const chunk of coords.trim().split(/\s+/)) {
      if (!chunk || !chunk.includes(',')) continue;
      const [lngS, latS, altS] = chunk.split(',').map((s) => s.trim());
      const lng = toNum(lngS);
      const lat = toNum(latS);
      if (!validLatLng(lat, lng)) continue;
      const alt = toNum(altS);
      points.push({
        lat: lat as number,
        lng: lng as number,
        altitude: alt != null ? Math.round(alt * 10) / 10 : null,
        timestamp: 0, // KML coordinates 无时间，finalize 补全
      });
    }
  }
  return finalize(points);
}

/** 递归收集节点下所有 Placemark（Folder 可多层嵌套） */
function collectPlacemarks(node: unknown): any[] {
  const out: any[] = [];
  if (Array.isArray(node)) {
    node.forEach((n) => out.push(...collectPlacemarks(n)));
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const obj = node as Record<string, unknown>;
  if (obj.Placemark) out.push(...asArray(obj.Placemark));
  for (const key of Object.keys(obj)) {
    if (key === 'Placemark') continue;
    const v = obj[key];
    if (Array.isArray(v)) {
      v.forEach((n) => out.push(...collectPlacemarks(n)));
    } else if (v && typeof v === 'object') {
      out.push(...collectPlacemarks(v));
    }
  }
  return out;
}

/** TCX 解析：Activities/Activity/Lap/Track/Trackpoint */
export function parseTcx(xml: string): ImportedPoint[] {
  const root = parser.parse(xml);
  const training = root?.TrainingCenterDatabase ?? {};
  const acts = asArray(training.Activities?.Activity);
  const points: ImportedPoint[] = [];
  for (const act of acts) {
    const laps = asArray(act.Lap);
    for (const lap of laps) {
      const tracks = asArray(lap.Track);
      for (const track of tracks) {
        for (const tp of asArray(track.Trackpoint)) {
          const lat = toNum(tp?.Position?.LatitudeDegrees);
          const lng = toNum(tp?.Position?.LongitudeDegrees);
          if (!validLatLng(lat, lng)) continue;
          const alt = toNum(tp?.AltitudeMeters);
          const time = tp?.Time ? new Date(String(tp.Time)).getTime() : 0;
          points.push({
            lat: lat as number,
            lng: lng as number,
            altitude: alt != null ? Math.round(alt * 10) / 10 : null,
            timestamp: Number.isFinite(time) && time > 0 ? time : 0,
          });
        }
      }
    }
  }
  return finalize(points);
}

/** XML 节点可能是对象或数组，统一转数组 */
function asArray(v: unknown): any[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** 从文件名推断数据来源（用户可在前端修正/自定义） */
export function guessSource(filename: string): string {
  const lower = filename.toLowerCase();
  if (/2bulu|两步路/i.test(lower) || /\.kml$/i.test(lower)) return '两步路';
  if (/strava/i.test(lower)) return 'Strava';
  if (/garmin|connect|佳明/i.test(lower) || /\.tcx$/i.test(lower)) return '佳明';
  if (/huawei|华为/i.test(lower)) return '华为运动健康';
  if (/xiaomi|mifitness|zepp|小米/i.test(lower)) return '小米运动';
  if (/keep/i.test(lower)) return 'Keep';
  return '其他';
}

/** 从文件名推断运动类型（GPX/KML 通常无类型字段） */
export function guessType(filename: string, points: ImportedPoint[]): string {
  const lower = filename.toLowerCase();
  if (/骑|cycle|bike|ride/i.test(lower)) return 'cycling';
  if (/走|walk|hike|徒步|登山|mountain/i.test(lower)) return 'hiking';
  if (/游|swim/i.test(lower)) return 'swimming';
  // 速度推断：平均速度 > 4m/s 视为骑行，> 2m/s 视为跑步
  if (points.length >= 2) {
    let dist = 0;
    for (let i = 1; i < points.length; i++) {
      dist += haversineDistance(points[i - 1], points[i]);
    }
    const spanSec = (points[points.length - 1].timestamp - points[0].timestamp) / 1000;
    const avgMps = spanSec > 0 ? dist / spanSec : 0;
    if (avgMps > 5) return 'cycling';
    if (avgMps > 2.2) return 'running';
  }
  return 'running';
}

/** 导入：解析 + 计算指标 + 创建 finished 活动 */
export async function importActivity(
  userId: string,
  filename: string,
  content: string,
  typeOverride?: string,
  source?: string,
): Promise<{ id: string; type: string; distance: number; duration: number; pointCount: number }> {
  let points = parseTrackFile(filename, content);
  // 坐标系转换（决策 M7）：第三方文件为 WGS-84，微信地图为 GCJ-02，中国境内偏移数百米
  // 转换后再做类型推断/去重/入库
  points = points.map((p) => {
    const c = wgs84ToGcj02(p.lat, p.lng);
    return { ...p, lat: c.lat, lng: c.lng };
  });
  let type = typeOverride || guessType(filename, points);
  if (!ACTIVITY_TYPES.includes(type as (typeof ACTIVITY_TYPES)[number])) {
    type = 'running';
  }

  // 去重：距离 < 1m 的相邻重复点合并（部分导出文件有大量重复点）
  const deduped: ImportedPoint[] = [];
  for (const p of points) {
    const last = deduped[deduped.length - 1];
    if (last && haversineDistance(last, p) < 1) continue;
    deduped.push(p);
  }
  if (deduped.length < 2) {
    throw new AppError(400, '解析后有效轨迹点不足');
  }
  points = deduped;

  const startTime = points[0].timestamp;
  const endTime = points[points.length - 1].timestamp;
  const durationSec = Math.max(1, Math.round((endTime - startTime) / 1000));
  const stats = calcStats(points, { type: type as never, durationSec });

  const trackPoints = points.map((p, i) => ({
    seq: i + 1,
    lat: p.lat,
    lng: p.lng,
    altitude: p.altitude,
    speed: null,
    timestamp: p.timestamp,
  }));

  const activity = await ActivityModel.create({
    userId,
    type,
    status: 'finished',
    startTime,
    endTime,
    duration: durationSec,
    distance: stats.distance,
    avgPace: stats.avgPace,
    calories: stats.calories,
    elevationGain: stats.elevationGain,
    maxAltitude: stats.maxAltitude,
    trackPoints: trackPoints.slice(0, MAX_TRACK_POINTS),
    markers: [],
    lastPointSeq: trackPoints.length,
    deviceInfo: { source: source || guessSource(filename), filename },
  });

  return {
    id: String(activity._id),
    type,
    distance: stats.distance,
    duration: durationSec,
    pointCount: trackPoints.length,
  };
}
