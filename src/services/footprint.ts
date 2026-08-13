/**
 * 足迹点亮统计（决策：省/市点亮地图）
 * 遍历用户 finished 轨迹，每条采样若干点逆地理编码得省/市，聚合去重统计。
 * 采样：首/尾 + 约每 25% 一点（覆盖跨市轨迹）；粗粒度坐标缓存（geo.ts 内）。
 */
import { ActivityModel } from '../models/activity.model.js';
import { UserModel } from '../models/user.model.js';
import { locateRegion } from './region.js';

export interface FootprintCity {
  name: string;
  province: string;
  count: number;
}

export interface FootprintProvince {
  name: string;
  count: number;
  cities: number;
}

export interface FootprintResult {
  provinceCount: number;
  cityCount: number;
  provinces: FootprintProvince[];
  cities: FootprintCity[];
}

export async function footprint(userId: string): Promise<FootprintResult> {
  // 缓存 + 懒重算：无缓存或 dirty 时全量计算
  const user = await UserModel.findById(userId).select({ footprintCache: 1, footprintDirty: 1 }).lean();
  if (user?.footprintCache && !user.footprintDirty) {
    return user.footprintCache as FootprintResult;
  }
  const result = await computeFootprint(userId);
  await UserModel.updateOne(
    { _id: userId },
    { $set: { footprintCache: result, footprintDirty: false } },
  );
  return result;
}

/** 标记足迹失效（finish/导入/删除后调用，下次读取时重算） */
export async function markFootprintDirty(userId: string): Promise<void> {
  await UserModel.updateOne({ _id: userId }, { $set: { footprintDirty: true } });
}

async function computeFootprint(userId: string): Promise<FootprintResult> {
  // 只取轨迹点（lat/lng），避免大字段
  const activities = await ActivityModel.find({ userId, status: 'finished' })
    .select({ trackPoints: 1 })
    .lean();

  const provinceCounts = new Map<string, Set<string>>(); // province -> 轨迹 id 集合
  const cityCounts = new Map<string, { province: string; set: Set<string> }>();

  for (const act of activities) {
    const pts = (act.trackPoints ?? []) as Array<{ lat: number; lng: number }>;
    if (pts.length < 2) continue;
    const id = String(act._id);

    // 采样：首、尾、25%、50%、75%
    const idxs = new Set<number>([0, pts.length - 1]);
    for (const r of [0.25, 0.5, 0.75]) {
      idxs.add(Math.floor(pts.length * r));
    }
    const seenCityThisAct = new Set<string>();
    const seenProvThisAct = new Set<string>();

    for (const i of idxs) {
      const p = pts[i];
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
      const d = locateRegion(p.lat, p.lng); // 离线省/市（不依赖腾讯 key）
      if (!d) continue;
      const prov = d.province || '未知';
      const city = d.city || d.province || '未知';

      if (!seenProvThisAct.has(prov)) {
        seenProvThisAct.add(prov);
        if (!provinceCounts.has(prov)) provinceCounts.set(prov, new Set());
        provinceCounts.get(prov)!.add(id);
      }
      if (!seenCityThisAct.has(city)) {
        seenCityThisAct.add(city);
        if (!cityCounts.has(city)) cityCounts.set(city, { province: prov, set: new Set() });
        cityCounts.get(city)!.set.add(id);
      }
    }
  }

  const provinces: FootprintProvince[] = Array.from(provinceCounts.entries())
    .map(([name, set]) => ({ name, count: set.size, cities: 0 }))
    .sort((a, b) => b.count - a.count);

  const cities: FootprintCity[] = Array.from(cityCounts.entries())
    .map(([name, v]) => ({ name, province: v.province, count: v.set.size }))
    .sort((a, b) => b.count - a.count);

  // 每个省的城数（去重城名）
  const cityProvMap = new Map<string, Set<string>>();
  for (const c of cities) {
    if (!cityProvMap.has(c.province)) cityProvMap.set(c.province, new Set());
    cityProvMap.get(c.province)!.add(c.name);
  }
  for (const p of provinces) {
    p.cities = cityProvMap.get(p.name)?.size ?? 0;
  }

  return {
    provinceCount: provinces.length,
    cityCount: cities.length,
    provinces,
    cities,
  };
}
