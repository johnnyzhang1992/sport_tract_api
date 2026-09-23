/**
 * 坐标系转换（决策 M7）：WGS-84 → GCJ-02（火星坐标）
 * 第三方导入文件（两步路/Strava/佳明等）为 WGS-84，微信地图使用 GCJ-02，
 * 中国境内直接使用会偏移数百米，导入时需转换。境外坐标不动。
 */

/** 中国境内范围（GCJ-02 偏移仅对中国生效） */
function inChina(lng: number, lat: number): boolean {
  return lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320.0 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

/**
 * WGS-84 → GCJ-02（火星坐标）
 * 中国境内平移数百米级纠偏；境外返回原值
 */
export function wgs84ToGcj02(lat: number, lng: number): { lat: number; lng: number } {  if (!inChina(lng, lat)) return { lat, lng };

  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

/**
 * GCJ-02 → WGS-84（导出 GPX/对外分享用）
 *
 * 标准协议（GPX / GeoJSON / 地图服务）都是 WGS-84，而 App 内部与微信地图是 GCJ-02。
 * 导出时若原样写出，外部工具打开会偏数百米，而且「导出→再导入」会被二次偏移
 * （`importActivity` 按 WGS-84 再转一次，实测 588.7m）。这里做逆变换，让往返闭合。
 * 没有解析解，用不动点迭代逼近：3 次即收敛到厘米级。境外原样返回。
 */
export function gcj02ToWgs84(lat: number, lng: number): { lat: number; lng: number } {
  if (!inChina(lng, lat)) return { lat, lng };

  let wgsLat = lat;
  let wgsLng = lng;
  for (let i = 0; i < 3; i++) {
    const gcj = wgs84ToGcj02(wgsLat, wgsLng);
    wgsLat += lat - gcj.lat;
    wgsLng += lng - gcj.lng;
  }
  return { lat: wgsLat, lng: wgsLng };
}
