/**
 * 种子脚本：为测试用户生成多时间段的多形状轨迹（M6 轨迹合集演示）
 * 用法：WX_MOCK_LOGIN=true node --import tsx /tmp/seed-overview.ts
 */
import mongoose from 'mongoose';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';

const MONGO =
  'mongodb://root:REDACTED@127.0.0.1:27017/sport-track-dev?authSource=admin';

/** 圆形轨迹点 */
function ring(lat0, lng0, radiusKm, n, phase = 0) {
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.cos((lat0 * Math.PI) / 180));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI + phase;
    pts.push({ lat: lat0 + Math.sin(a) * dLat, lng: lng0 + Math.cos(a) * dLng });
  }
  return pts;
}

/** 折返直线轨迹 */
function zigzag(lat0, lng0, lenKm, n, phase = 0) {
  const dLat = lenKm / 111.32;
  const dLng = lenKm / (111.32 * Math.cos((lat0 * Math.PI) / 180));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * dLat * (i % 2 === 0 ? 1 : -1) * 0.3 + 0.15;
    const tt = (i / n) * dLng;
    pts.push({ lat: lat0 + t + phase * 0.001, lng: lng0 + tt });
  }
  return pts;
}

/** 生成一条活动 */
function makeActivity(userId, type, startTs, pts, speedMps) {
  let distance = 0;
  const toRad = (d) => (d * Math.PI) / 180;
  const trackPoints = pts.map((p, i) => {
    if (i > 0) {
      const a = pts[i - 1];
      const dLat = toRad(p.lat - a.lat);
      const dLng = toRad(p.lng - a.lng);
      const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(p.lat)) * Math.sin(dLng / 2) ** 2;
      distance += 2 * 6371000 * Math.asin(Math.sqrt(s));
    }
    const ts = startTs + i * 3000;
    return {
      seq: i + 1,
      lat: p.lat,
      lng: p.lng,
      altitude: Math.round((10 + Math.sin(i / 5) * 2) * 10) / 10,
      speed: speedMps,
      timestamp: ts,
    };
  });
  return {
    userId,
    type,
    status: 'finished',
    startTime: startTs,
    endTime: startTs + trackPoints.length * 3000,
    distance: Math.round(distance),
    duration: trackPoints.length * 3000,
    avgPace: Math.round((trackPoints.length * 3) / (distance / 1000) * 100) / 100,
    elevationGain: 12,
    maxAltitude: 14,
    calories: Math.round(distance / 1000 * 60),
    label: '',
    markerCount: 0,
    trackPoints,
    markers: [],
  };
}

async function main() {
  await mongoose.connect(MONGO);
  const user = await UserModel.findOne({ openid: 'o3hvt0MK7bfPk2705B6H9Zngw1eI' }).lean();
  if (!user) {
    console.error('测试用户不存在');
    process.exit(1);
  }
  console.log('测试用户:', user._id.toString());

  // 只删除之前种子数据（避免误删真实记录）：按 label 标记（原生 collection，label 不在 schema 内）
  await mongoose.connection.db.collection('activities').deleteMany({ userId: user._id, label: 'SEED' });

  const now = Date.now();
  const DAY = 86400000;
  const types = ['running', 'hiking', 'cycling', 'walking'];
  const seeds = [];

  // 今天 1 条环形
  seeds.push(makeActivity(user._id, 'running', now - 2 * 3600000, ring(31.232, 121.468, 0.5, 60, 0), 3.2));

  // 近一周（3~6 天前）：5 条，同一片区不同环（高频热区）
  for (let i = 0; i < 5; i++) {
    const daysAgo = 3 + i;
    const c = 31.231 + i * 0.0012;
    const l = 121.467 + (i % 2) * 0.0015;
    seeds.push(
      makeActivity(
        user._id,
        types[i % types.length],
        now - daysAgo * DAY - 3600000 * i,
        ring(c, l, 0.45 + (i % 3) * 0.08, 50, i * 0.7),
        2.8 + i * 0.2,
      ),
    );
  }

  // 近一月（8~25 天前）：8 条（环 + 折返混搭）
  for (let i = 0; i < 8; i++) {
    const daysAgo = 8 + i * 2.2;
    const pts =
      i % 3 === 0
        ? zigzag(31.228 + i * 0.001, 121.47, 1.2, 40, i)
        : ring(31.229 + i * 0.0011, 121.472 + (i % 2) * 0.001, 0.4 + (i % 3) * 0.1, 45, i * 0.9);
    seeds.push(
      makeActivity(user._id, types[i % types.length], now - Math.floor(daysAgo) * DAY, pts, 2.5 + (i % 4) * 0.3),
    );
  }

  // 近一年（30~100 天前）：10 条（散点分布）
  for (let i = 0; i < 10; i++) {
    const daysAgo = 30 + i * 7;
    const c = 31.226 + (i % 4) * 0.0018;
    const l = 121.468 + (i % 3) * 0.002;
    const pts =
      i % 2 === 0
        ? ring(c, l, 0.35 + (i % 3) * 0.12, 40, i * 1.3)
        : zigzag(c, l, 0.9 + (i % 3) * 0.4, 35, i);
    seeds.push(
      makeActivity(user._id, types[i % types.length], now - daysAgo * DAY, pts, 2.2 + (i % 3) * 0.4),
    );
  }

  const docs = seeds.map((s) => ({ ...s, label: 'SEED', createdAt: new Date(), updatedAt: new Date() }));
  await mongoose.connection.db.collection('activities').insertMany(docs);
  console.log(`✅ 插入 ${docs.length} 条模拟活动（周 ${7} / 月 ${8} / 年 ${10} 分布）`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('种子脚本失败:', e);
  process.exit(1);
});
