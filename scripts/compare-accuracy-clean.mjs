/**
 * 真实数据前后对比（方案 12 验证）：dev 库全部 finished 轨迹
 * 旧管线（无 accuracy 因子）vs 新管线（差精度加严剔除）逐条对比
 * 输出：距离变化、剔除点数、accuracy 分布；只读不改库
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { ActivityModel } from '../src/models/activity.model.js';
import { cleanAltitudeSpikes } from '../src/utils/altitude-clean.js';
import { cleanTrajectory } from '../src/utils/trajectory-clean.js';
import { smoothTrackSmart } from '../src/utils/smooth.js';
import { calcStats, haversineDistance } from '../src/utils/pace.js';

const M = 111320;
// 旧版 cleanTrajectory（复刻：去掉 3.5 规则）——直接用开关参数实现同效果
// 这里用简单办法：旧管线把 accuracy 剥掉即可（无字段 → 3.5 不触发）
const stripAcc = (pts) => pts.map((p) => {
  const { accuracy: _a, ...rest } = p;
  return rest;
});

async function main() {
  await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://localhost:27017/sport-track-dev');
  const activities = await ActivityModel.find({ status: 'finished' })
    .select({ trackPoints: 1, type: 1, distance: 1, duration: 1 })
    .lean();
  console.log(`finished 轨迹总数: ${activities.length}\n`);

  let changed = 0;
  const rows = [];
  const accHistogram = new Map();

  for (const act of activities) {
    const raw = (act.trackPoints ?? []).map((p) => ({
      lat: p.lat,
      lng: p.lng,
      altitude: p.altitude,
      accuracy: p.accuracy ?? null,
      pauseGap: p.pauseGap,
      timestamp: p.timestamp,
      seq: p.seq,
    }));
    if (raw.length < 10) continue;

    // accuracy 分布（全库点级）
    for (const p of raw) {
      if (p.accuracy == null) { accHistogram.set('null', (accHistogram.get('null') ?? 0) + 1); continue; }
      const bucket = p.accuracy < 10 ? '<10' : p.accuracy < 25 ? '10-25' : p.accuracy < 50 ? '25-50' : p.accuracy < 100 ? '50-100' : '>=100';
      accHistogram.set(bucket, (accHistogram.get(bucket) ?? 0) + 1);
    }

    // 旧管线（无 accuracy）
    const oldCleaned = cleanTrajectory(stripAcc(cleanAltitudeSpikes(raw)), {}, act.type);
    // 新管线（带 accuracy）
    const newCleaned = cleanTrajectory(cleanAltitudeSpikes(raw), {}, act.type);

    const statsOf = (pts) => {
      const smoothed = smoothTrackSmart(pts, 5, haversineDistance);
      return calcStats(smoothed, { type: act.type, durationSec: act.duration ?? 0 });
    };
    const oldStats = statsOf(oldCleaned);
    const newStats = statsOf(newCleaned);

    const dOld = oldStats.distance;
    const dNew = newStats.distance;
    const diffM = dNew - dOld;
    if (Math.abs(diffM) > 1 || oldCleaned.length !== newCleaned.length) {
      changed += 1;
      rows.push({
        id: String(act._id).slice(-6),
        type: act.type,
        pts: raw.length,
        dropOld: raw.length - oldCleaned.length,
        dropNew: raw.length - newCleaned.length,
        distKmOld: (dOld / 1000).toFixed(3),
        distKmNew: (dNew / 1000).toFixed(3),
        diffM: diffM.toFixed(1),
      });
    }
  }

  console.log('accuracy 点级分布:');
  const total = [...accHistogram.values()].reduce((s, v) => s + v, 0);
  for (const [k, v] of [...accHistogram.entries()].sort()) {
    console.log(`  ${k.padEnd(7)} ${String(v).padStart(6)}  (${((v / total) * 100).toFixed(1)}%)`);
  }
  console.log(`\n受影响轨迹: ${changed} 条 / 样本 ${rows.length.length || rows.length}`);
  if (rows.length) {
    console.table(rows);
  } else {
    console.log('所有轨迹新旧管线结果一致（当前库内无差精度漂移点命中新规则）');
  }
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
