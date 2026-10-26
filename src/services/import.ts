/**
 * 运动数据导入（决策 M7）：解析 GPX / KML / TCX → 统一轨迹点 → 计算指标 → 创建 finished 活动
 * - GPX：trk/trkseg/trkpt（lat/lon 属性 + ele/time 子元素）—— Strava/华为/小米/两步路
 * - KML：Placemark/LineString/coordinates（"lon,lat,alt" 空格分隔，经度在前需调换）—— 两步路
 * - TCX：Activities/Activity/Lap/Track/Trackpoint/Position（LatitudeDegrees/LongitudeDegrees）—— Strava/佳明
 */
import { XMLParser } from 'fast-xml-parser';
import { ActivityModel } from '../models/activity.model.js';
import { compactTrackPoints } from '../utils/track-compact.js';
import { AppError } from '../utils/app-error.js';
import { calcStats, haversineDistance, type TrackPointLike } from '../utils/pace.js';
import { calcPerfScore } from '../utils/perf-score.js';
import { detectCrs } from '../utils/crs-detect.js';
import { classifyTrackKind } from '../utils/track-kind.js';
import { markStandstill } from '../utils/standstill.js';
import { markGapJumps } from '../utils/track-gap.js';
import { markVehicle } from '../utils/vehicle.js';
import { cleanAltitudeSpikes } from '../utils/altitude-clean.js';
import { calcDriftScore } from '../utils/drift-score.js';
import { wgs84ToGcj02, bd09ToGcj02 } from '../utils/coordinate.js';
import { markFootprintDirty } from './footprint.js';
import { resolveWeightKg } from './weight.js';
import { provincesOfPoints } from './region.js';
import { ACTIVITY_TYPES, MAX_TRACK_POINTS, MIN_EFFECTIVE_DISTANCE_M, MIN_EFFECTIVE_POINTS } from '../config/constants.js';

export interface ImportedPoint {
  lat: number;
  lng: number;
  altitude: number | null;
  timestamp: number;
}

/** 解析元信息（时间戳是否存在为原始信号——finalize 会给缺失时间补 1s 间隔，之后就无法区分了） */
export interface ParseMeta {
  hasTime?: boolean;
  creator?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false, // 保持字符串，避免数字被提前转换（坐标需精确）
});

const MAX_IMPORT_POINTS = 50_000;

/** 解析文件内容 → 轨迹点（时间缺失时按 1s 间隔补全）；meta 带回 creator/是否含原始时间 */
export function parseTrackFile(filename: string, content: string, meta?: ParseMeta): ImportedPoint[] {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.gpx')) return parseGpx(content, meta);
  if (lower.endsWith('.kml')) return parseKml(content, meta);
  if (lower.endsWith('.tcx')) return parseTcx(content, meta);
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

/** GPX 解析：trk/trkseg/trkpt（creator 属性用于坐标系识别） */
export function parseGpx(xml: string, meta?: ParseMeta): ImportedPoint[] {
  const root = parser.parse(xml);
  const gpx = root?.gpx ?? {};
  if (meta && typeof gpx?.['@_creator'] === 'string') meta.creator = String(gpx['@_creator']).slice(0, 100);
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
        if (meta && Number.isFinite(time) && time > 0) meta.hasTime = true;
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
export function parseKml(xml: string, meta?: ParseMeta): ImportedPoint[] {
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
        if (meta && Number.isFinite(t) && t > 0) meta.hasTime = true;
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
export function parseTcx(xml: string, meta?: ParseMeta): ImportedPoint[] {
  const root = parser.parse(xml);
  const training = root?.TrainingCenterDatabase ?? {};
  const acts = asArray(training.Activities?.Activity);
  if (meta && typeof acts?.[0]?.Creator?.Name === 'string') meta.creator = String(acts[0].Creator.Name).slice(0, 100);
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
          if (meta && Number.isFinite(time) && time > 0) meta.hasTime = true;
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

/** 导入：解析 + 坐标系识别/转换 + 计算指标 + 创建 finished 活动 */
export async function importActivity(
  userId: string,
  filename: string,
  content: string,
  typeOverride?: string,
  source?: string,
): Promise<{
  id: string;
  type: string;
  distance: number;
  duration: number;
  pointCount: number;
  source: string;
  crs: string;
  crsConfidence: string;
  trackKind: string;
  trackKindReason: string;
}> {
  const meta: ParseMeta = {};
  let points = parseTrackFile(filename, content, meta);
  // 坐标系识别（TrailCraft 同思路）：国内 App 记录/导出的已是 GCJ-02，百度系为 BD-09，
  // 国际设备为 WGS-84；识别不出按 WGS-84（历史默认口径）
  const crsInfo = detectCrs({ creator: meta.creator, fileName: filename });
  points = points.map((p) => {
    if (crsInfo.crs === 'gcj02') return p;
    const c = crsInfo.crs === 'bd09' ? bd09ToGcj02(p.lat, p.lng) : wgs84ToGcj02(p.lat, p.lng);
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
  if (deduped.length < MIN_EFFECTIVE_POINTS) {
    throw new AppError(400, `解析后有效轨迹点不足（至少 ${MIN_EFFECTIVE_POINTS} 个）`);
  }
  points = deduped;

  const startTime = points[0].timestamp;
  const endTime = points[points.length - 1].timestamp;
  // 实跑/规划判别（三态）：规划路线（无时间信息）不参与配速/表现分统计
  let dist = 0;
  for (let i = 1; i < points.length; i++) dist += haversineDistance(points[i - 1], points[i]);
  const kindInfo = classifyTrackKind(points as TrackPointLike[], dist, { hasTime: meta.hasTime !== false });
  const isPlanned = kindInfo.kind === 'planned';
  // 非运动段（疑似乘车）先判：第三方文件里"开车去徒步、到山顶开录"这类混入段很常见，
  // 不剔的话导入的轨迹会带着车速段刷出个人最快配速（与 finish 同口径，见 utils/vehicle.ts）
  const veh = markVehicle(points, type);
  // 与 finish 共用静止剔除口径（见 utils/standstill.ts）：导入文件没有暂停语义，
  // 若不剔，同一条徒步「导进来 = 墙钟、App 里录 = 净时长」两条路径永远对不上。
  const { points: stillMarked, standstillMs } = markStandstill(veh.points);
  const wallSec = (endTime - startTime) / 1000;
  const durationSec = Math.max(1, Math.round(wallSec - standstillMs / 1000 - veh.vehicleMs / 1000));
  // 采样断档连线打标（与 finish 同口径，见 utils/track-gap.ts）：第三方文件粗采样很常见，
  // 只打标让渲染端断开连线，距离/时长一律不改（导入本来就只是把别人的点搬进来）
  const { points: markedPoints } = markGapJumps(stillMarked);
  // 先紧凑化再算指标：与 finish 同口径（落库值 = 基于落库点重算的值）
  const storedPoints = compactTrackPoints(markedPoints, startTime);
  const stats = calcStats(storedPoints, {
    type: type as never,
    durationSec,
    weightKg: await resolveWeightKg(userId),
  });
  // 表现分：仅实跑 + 类跑步类型；规划路线没有"跑得怎么样"可言
  const perf = kindInfo.kind === 'recorded' ? calcPerfScore(type, stats.distance, stats.elevationGain, durationSec) : null;

  // 无效轨迹守卫：导入文件重算距离过短（静止/漂移）→ 拒绝导入，与 finish 作废口径一致
  if (stats.distance < MIN_EFFECTIVE_DISTANCE_M) {
    throw new AppError(400, '轨迹距离过短（不足 10 米），未导入');
  }

  const trackPoints = storedPoints.map((p, i) => ({ ...p, seq: i + 1 }));
  // 落库省市（按省查询轨迹用）
  const regions = provincesOfPoints(trackPoints);

  const activity = await ActivityModel.create({
    userId,
    type,
    status: 'finished',
    startTime,
    endTime,
    duration: durationSec,
    standstillMs: Math.round(standstillMs),
    vehicleMs: Math.round(veh.vehicleMs),
    vehicleM: Math.round(veh.vehicleM),
    distance: stats.distance,
    avgPace: stats.avgPace,
    calories: stats.calories,
    elevationGain: stats.elevationGain,
    maxAltitude: stats.maxAltitude,
    perfScore: perf?.score ?? null,
    // 漂移置信度分（docs/19 §4）：导入轨迹也计分——稀疏采样会推高 gapRatio（实测 ~20 分，
    // 不会触发 30 分门禁），但真漂移的导入文件照样能被拦在榜外；planned 同样落分（门禁看数值不看 trackKind）
    driftScore: calcDriftScore(storedPoints, type),
    trackKind: kindInfo.kind,
    provinces: regions.provinces,
    startProvince: regions.startProvince,
    startCity: regions.startCity,
    trackPoints: compactTrackPoints(trackPoints.slice(0, MAX_TRACK_POINTS), startTime),
    markers: [],
    lastPointSeq: trackPoints.length,
    deviceInfo: { source: source || guessSource(filename), filename },
  });

  await markFootprintDirty(String(activity.userId)); // 足迹失效

  return {
    id: String(activity._id),
    type,
    distance: stats.distance,
    duration: durationSec,
    pointCount: trackPoints.length,
    source: source || guessSource(filename),
    crs: crsInfo.crs,
    crsConfidence: crsInfo.confidence,
    trackKind: kindInfo.kind,
    trackKindReason: kindInfo.reason,
  };
}
