import mongoose from 'mongoose';
import { getOverview } from '../src/services/overview.js';
const MONGO = 'mongodb://root:REDACTED@127.0.0.1:27017/sport-track-dev?authSource=admin';
await mongoose.connect(MONGO);
const res = await getOverview('6a7ab349398adc2c86b4c1ba', 'week');
res.tracks.forEach((t, i) => {
  const bad = (t.points || []).filter((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180);
  console.log(`#${i} type=${t.type} pts=${t.points.length} bad=${bad.length} first=(${t.points[0]?.lat}, ${t.points[0]?.lng}) last=(${t.points[t.points.length-1]?.lat}, ${t.points[t.points.length-1]?.lng})`);
});
await mongoose.disconnect();
