import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
const kml = readFileSync('/Users/johnnyzhang/extra_sport/2025-10-03 13 36 42.kml', 'utf8');
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true, parseTagValue: false });
const root = parser.parse(kml);
const doc = root.kml?.Document ?? root.kml ?? {};
function collect(node, depth = 0) {
  const out = [];
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => out.push(...collect(n, depth))); return out; }
  if (node.Placemark) out.push(...(Array.isArray(node.Placemark) ? node.Placemark : [node.Placemark]));
  for (const k of Object.keys(node)) {
    if (k === 'Placemark') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((n) => out.push(...collect(n, depth)));
    else if (v && typeof v === 'object') out.push(...collect(v, depth));
  }
  return out;
}
const pms = collect(doc);
console.log('Placemark 数量:', pms.length);
pms.forEach((p, i) => {
  const keys = Object.keys(p);
  console.log(`#${i} keys=${keys.join(',')} lineString=${!!p.LineString} gxTrack=${!!p['gx:Track']}`);
  if (p.LineString) {
    const c = p.LineString.coordinates;
    console.log('  LineString keys:', Object.keys(p.LineString), 'coords 类型:', typeof c, '长度:', typeof c === 'string' ? c.length : '-');
  }
});
