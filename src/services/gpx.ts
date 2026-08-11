import { AppError } from '../utils/app-error.js';

/**
 * Activity → GPX 1.1 XML（决策 D6：导出留存，可导入其他运动 App）
 * - trkpt：轨迹点（含海拔/时间）
 * - wpt：打点（markers 作为航点）
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
      const ele = p.altitude != null ? `<ele>${p.altitude}</ele>` : '';
      const time = p.timestamp ? `<time>${new Date(p.timestamp).toISOString()}</time>` : '';
      return `      <trkpt lat="${p.lat}" lon="${p.lng}">${ele}${time}</trkpt>`;
    })
    .join('\n');

  const wpts = markers
    .map((m) => {
      const name = m.note ? `<name>${escape(m.note)}</name>` : '';
      const desc = m.address ? `<desc>${escape(m.address)}</desc>` : '';
      const time = m.timestamp ? `<time>${new Date(m.timestamp).toISOString()}</time>` : '';
      return `  <wpt lat="${m.lat}" lon="${m.lng}">${name}${desc}${time}</wpt>`;
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
