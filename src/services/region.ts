/**
 * 离线省/市定位（决策：不依赖腾讯逆地理编码，用 DataV 边界 GeoJSON 判断坐标所属省/市）
 * - 数据：data/provinces.geojson（35 省）、data/cities.geojson（368 地级市/直辖市，含台湾）
 * - 算法：bbox 预筛 + 射线法（ray casting）点-in-polygon
 * - 坐标系：DataV 为 GCJ-02（火星坐标），与小程序 wx.getLocation 一致
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

interface GeoFeature {
  type: string;
  properties: {
    adcode: number;
    name: string;
    level?: string;
    parent?: { adcode: number };
  };
  geometry: {
    type: string;
    coordinates: number[][][][] | number[][][];
  };
}

interface RegionRecord {
  name: string;
  adcode: number;
  bbox: { minLng: number; maxLng: number; minLat: number; maxLat: number };
  /** 多边形外环（lat/lng 序列），射线法用 */
  polygons: number[][][]; // [ [ [lng, lat], ... ] ]
}

function loadJson(path: string): GeoFeature[] {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  return data.features ?? [];
}

function bboxOf(feature: GeoFeature): RegionRecord['bbox'] {
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  const coords = feature.geometry.coordinates;
  const walk = (rings: number[][][]) => {
    for (const ring of rings) {
      for (const pt of ring) {
        if (!pt || pt.length < 2) continue;
        const lng = pt[0];
        const lat = pt[1];
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  };
  if (feature.geometry.type === 'Polygon') {
    walk(coords as number[][][]);
  } else if (feature.geometry.type === 'MultiPolygon') {
    for (const poly of coords as number[][][][]) {
      walk(poly);
    }
  }
  return { minLng, maxLng, minLat, maxLat };
}

function outerRings(feature: GeoFeature): number[][][] {
  const rings: number[][][] = [];
  const coords = feature.geometry.coordinates;
  if (feature.geometry.type === 'Polygon') {
    const p = coords as number[][][];
    if (p[0]) rings.push(p[0]);
  } else if (feature.geometry.type === 'MultiPolygon') {
    for (const poly of coords as number[][][][]) {
      if (poly[0]) rings.push(poly[0]);
    }
  }
  return rings;
}

/** 射线法：点是否在多边形（外环）内 */
function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

const provinces = loadJson(join(dirname(fileURLToPath(import.meta.url)), '../../data/provinces.geojson'));
const cities = loadJson(join(dirname(fileURLToPath(import.meta.url)), '../../data/cities.geojson'));

const provinceRecords: RegionRecord[] = provinces.map((f) => ({
  name: f.properties.name,
  adcode: f.properties.adcode,
  bbox: bboxOf(f),
  polygons: outerRings(f),
}));

const cityRecords: RegionRecord[] = cities.map((f) => ({
  name: f.properties.name,
  adcode: f.properties.adcode,
  bbox: bboxOf(f),
  polygons: outerRings(f),
}));

/** 省 adcode → 省名 */
const adcodeToProvince = new Map<number, string>(
  provinces.map((f) => [f.properties.adcode, f.properties.name]),
);

/** 直辖市集合（level=province 的市） */
const municipalities = new Set(['北京市', '天津市', '上海市', '重庆市']);

const locateCache = new Map<string, { province: string; city: string }>();

function inRegion(lng: number, lat: number, rec: RegionRecord): boolean {
  const b = rec.bbox;
  if (lng < b.minLng || lng > b.maxLng || lat < b.minLat || lat > b.maxLat) return false;
  return rec.polygons.some((ring) => pointInRing(lng, lat, ring));
}

export interface RegionLocation {
  province: string;
  city: string;
}

/** 坐标 → 省/市（离线，粗粒度缓存 ~1km） */
export function locateRegion(lat: number, lng: number): RegionLocation | null {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const hit = locateCache.get(key);
  if (hit) return hit;

  // 先查市（更细），再查省
  for (const c of cityRecords) {
    if (inRegion(lng, lat, c)) {
      const provinceName = municipalities.has(c.name)
        ? c.name
        : adcodeToProvince.get(provinceAdcodeOfCity(c)) ?? '';
      const r = { province: provinceName || c.name, city: c.name };
      locateCache.set(key, r);
      return r;
    }
  }
  for (const p of provinceRecords) {
    if (inRegion(lng, lat, p)) {
      const r = { province: p.name, city: p.name };
      locateCache.set(key, r);
      return r;
    }
  }
  return null;
}

/** 市所属省 adcode（DataV 市 feature 未直接含 parent，需从省映射反查） */
const cityParentCache = new Map<number, number>();
function provinceAdcodeOfCity(rec: RegionRecord): number {
  if (cityParentCache.has(rec.adcode)) return cityParentCache.get(rec.adcode)!;
  // 从 cities geojson 原始 feature 找 parent.adcode
  const feat = cities.find((f) => f.properties.adcode === rec.adcode);
  const parent = feat?.properties?.parent?.adcode ?? 0;
  cityParentCache.set(rec.adcode, parent);
  return parent;
}

export function regionStats() {
  return { provinces: provinceRecords.length, cities: cityRecords.length };
}

/** 返回中国省界 GeoJSON（原始，前端 echarts registerMap 用） */
export function getChinaMap() {
  return chinaMapData;
}

const chinaMapData = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../data/provinces.geojson'), 'utf8'),
);

