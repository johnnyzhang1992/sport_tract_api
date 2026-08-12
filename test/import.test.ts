import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGpx, parseKml, parseTcx, guessType, parseTrackFile } from '../src/services/import.js';

const GPX_SAMPLE = `<?xml version="1.0"?>
<gpx version="1.1" creator="test">
  <trk><name>晨跑</name><trkseg>
    <trkpt lat="31.2301" lon="121.4731"><ele>10.5</ele><time>2026-08-12T00:00:00Z</time></trkpt>
    <trkpt lat="31.2302" lon="121.4732"><ele>10.8</ele><time>2026-08-12T00:00:05Z</time></trkpt>
    <trkpt lat="31.2303" lon="121.4733"><ele>11.0</ele><time>2026-08-12T00:00:10Z</time></trkpt>
  </trkseg></trk>
</gpx>`;

const KML_SAMPLE = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document><Placemark><name>轨迹</name><LineString>
    <coordinates>121.4731,31.2301,10.5 121.4732,31.2302,10.8 121.4733,31.2303,11.0</coordinates>
  </LineString></Placemark></Document>
</kml>`;

const TCX_SAMPLE = `<?xml version="1.0"?>
<TrainingCenterDatabase>
  <Activities><Activity Sport="Running"><Lap><Track>
    <Trackpoint>
      <Time>2026-08-12T00:00:00Z</Time>
      <Position><LatitudeDegrees>31.2301</LatitudeDegrees><LongitudeDegrees>121.4731</LongitudeDegrees></Position>
      <AltitudeMeters>10.5</AltitudeMeters>
    </Trackpoint>
    <Trackpoint>
      <Time>2026-08-12T00:00:05Z</Time>
      <Position><LatitudeDegrees>31.2302</LatitudeDegrees><LongitudeDegrees>121.4732</LongitudeDegrees></Position>
    </Trackpoint>
  </Track></Lap></Activity></Activities>
</TrainingCenterDatabase>`;

test('GPX 解析：lat/lon/ele/time 正确', () => {
  const pts = parseGpx(GPX_SAMPLE);
  assert.equal(pts.length, 3);
  assert.equal(pts[0].lat, 31.2301);
  assert.equal(pts[0].lng, 121.4731);
  assert.equal(pts[0].altitude, 10.5);
  assert.equal(pts[0].timestamp, Date.parse('2026-08-12T00:00:00Z'));
  // 时间升序
  assert.ok(pts[2].timestamp > pts[1].timestamp);
});

test('KML 解析：coordinates 经度在前调换', () => {
  const pts = parseKml(KML_SAMPLE);
  assert.equal(pts.length, 3);
  // KML "lon,lat" → lat/lng 正确调换
  assert.equal(pts[0].lat, 31.2301);
  assert.equal(pts[0].lng, 121.4731);
  assert.equal(pts[0].altitude, 10.5);
});

const KML_GXTRACK = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document><Folder><Placemark>
    <gx:Track>
      <when>2026-08-12T00:00:00Z</when><gx:coord>121.4731 31.2301 10.5</gx:coord>
      <when>2026-08-12T00:00:05Z</when><gx:coord>121.4732 31.2302 10.8</gx:coord>
      <when>2026-08-12T00:00:10Z</when><gx:coord>121.4733 31.2303 11.0</gx:coord>
    </gx:Track>
  </Placemark></Folder></Document>
</kml>`;

test('KML gx:Track 解析（两步路格式）：when 时间 + coord 经纬度', () => {
  const pts = parseKml(KML_GXTRACK);
  assert.equal(pts.length, 3);
  assert.equal(pts[0].lat, 31.2301);
  assert.equal(pts[0].lng, 121.4731);
  assert.equal(pts[0].altitude, 10.5);
  assert.equal(pts[0].timestamp, Date.parse('2026-08-12T00:00:00Z'));
  assert.equal(pts[2].timestamp - pts[1].timestamp, 5000);
});

test('TCX 解析：Position/Altitude 正确', () => {
  const pts = parseTcx(TCX_SAMPLE);
  assert.equal(pts.length, 2);
  assert.equal(pts[0].lat, 31.2301);
  assert.equal(pts[0].altitude, 10.5);
  // 第二个点无海拔 → null
  assert.equal(pts[1].altitude, null);
});

test('无时间戳文件：按 1s 间隔补全时间', () => {
  const pts = parseKml(KML_SAMPLE);
  assert.equal(pts[0].timestamp, 0); // 相对时间从 0 开始
  assert.equal(pts[1].timestamp - pts[0].timestamp, 1000);
  assert.equal(pts[2].timestamp - pts[1].timestamp, 1000);
});

test('非法坐标被过滤；有效点不足报错', () => {
  const bad = `<?xml version="1.0"?>
  <gpx><trk><trkseg>
    <trkpt lat="999" lon="121.47"/>
    <trkpt lat="31.2" lon="abc"/>
  </trkseg></trk></gpx>`;
  assert.throws(() => parseGpx(bad), /有效轨迹点不足/);
});

test('文件扩展名路由：不支持格式报错', () => {
  assert.throws(() => parseTrackFile('a.fit', 'data'), /不支持的文件格式/);
});

test('类型推断：文件名关键词 / 速度', () => {
  assert.equal(guessType('周末骑行.gpx', []), 'cycling');
  assert.equal(guessType('hike_route.kml', []), 'hiking');
  assert.equal(guessType('track.gpx', []), 'running');
  // 高速 → 骑行
  const fast = [
    { lat: 31.23, lng: 121.47, altitude: null, timestamp: 0 },
    { lat: 31.235, lng: 121.475, altitude: null, timestamp: 60000 },
  ];
  assert.equal(guessType('track.gpx', fast), 'cycling');
});
