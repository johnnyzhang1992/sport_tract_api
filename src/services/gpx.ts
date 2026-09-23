import { AppError } from '../utils/app-error.js';
import { gcj02ToWgs84 } from '../utils/coordinate.js';

/**
 * Activity → GPX 1.1 XML（决策 D6：导出留存，可导入其他运动 App）
 * - trkpt：轨迹点（含海拔/时间）
 * - wpt：打点（markers 作为航点）
 * - 坐标：库内/微信地图是 GCJ-02，**GPX 标准协议是 WGS-84** —— 导出必须反算，
 *   否则外部工具（Strava/Google Earth/两步路）读到的位置偏数百米，
 *   而且再导入回本 App 会被二次偏移（import 按 WGS-84 再转一次）。
 */
export function toGpx(doc: Record<string, any>): string {
  const escape = (s: unknown) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const points = (doc.trackPoints ?? []) as Array<{
    lat: number;
    lng: number;
    altitude?: number | null;
    timestamp?: number;
  }>;
  const markers = (doc.markers ?? []) as Array<{
    lat: number;
    lng: number;
    timestamp?: number;
    note?: string;
    address?: string;
  }>;

  const trkpts = points
    .map((p) => {
      const c = gcj02ToWgs84(p.lat, p.lng);
      const ele = p.altitude != null ? `<ele>${p.altitude}</ele>` : '';
      const time = p.timestamp ? `<time>${new Date(p.timestamp).toISOString()}</time>` : '';
      return `      <trkpt lat="${c.lat}" lon="${c.lng}">${ele}${time}</trkpt>`;
    })
    .join('\n');

  const wpts = markers
    .map((m) => {
      const c = gcj02ToWgs84(m.lat, m.lng);
      const name = m.note ? `<name>${escape(m.note)}</name>` : '';
      const desc = m.address ? `<desc>${escape(m.address)}</desc>` : '';
      const time = m.timestamp ? `<time>${new Date(m.timestamp).toISOString()}</time>` : '';
      return `  <wpt lat="${c.lat}" lon="${c.lng}">${name}${desc}${time}</wpt>`;
    })
    .join('\n');

  const startTime = doc.startTime ? new Date(doc.startTime).toISOString() : '';
  const name = `${doc.type ?? 'activity'} ${startTime}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="sport-track" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${escape(name)}</name>
    <time>${startTime}</time>
  </metadata>
${wpts}
  <trk>
    <name>${escape(name)}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

export function assertActivityForGpx(doc: Record<string, any>): void {
  if ((doc.trackPoints ?? []).length === 0) {
    throw new AppError(400, '活动没有轨迹点，无法导出 GPX');
  }
}
