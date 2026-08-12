import { readFileSync } from 'node:fs';
import { parseGpx, parseKml, guessType } from '../src/services/import.js';

const base = '/Users/johnnyzhang/extra_sport/';
const gpx = readFileSync(base + '2025-10-03 13 36 42.gpx', 'utf8');
const kml = readFileSync(base + '2025-10-03 13 36 42.kml', 'utf8');

const gpxPts = parseGpx(gpx);
console.log('GPX: 点', gpxPts.length, '首', gpxPts[0], '尾', gpxPts[gpxPts.length-1]);

const kmlPts = parseKml(kml);
console.log('KML: 点', kmlPts.length, '首', kmlPts[0], '尾', kmlPts[kmlPts.length-1]);

console.log('GPX 类型推断:', guessType('2025-10-03 13 36 42.gpx', gpxPts));
console.log('KML 类型推断:', guessType('2025-10-03 13 36 42.kml', kmlPts));
