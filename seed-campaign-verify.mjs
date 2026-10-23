/**
 * 一次性造数脚本（验证活动详情页新版式用）：
 * 一个进行中的公开活动 + 3 名成员 + 近 7 天的 finished 轨迹。
 * 三个指标（距离/次数/时长）各自能得出不同的名次，用来验「切指标服务端重排」。
 * 用完即可删（脚本本身不删数据，留着方便复跑）。
 */
import dotenv from 'dotenv';
import path from 'node:path';
import mongoose from 'mongoose';
import { UserModel } from './src/models/user.model.js';
import { CampaignModel } from './src/models/campaign.model.js';
import { CampaignMemberModel } from './src/models/campaign-member.model.js';
import { ActivityModel } from './src/models/activity.model.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
await mongoose.connect(process.env.MONGODB_URI);

const DAY_MS = 86400000;
/** 东八区当天 00:00 */
function bjDayStart(ms) {
  const d = new Date(ms + 8 * 3600000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 8 * 3600000;
}
const today0 = bjDayStart(Date.now());
const startAt = today0 - 6 * DAY_MS; // 6 天前开赛
const endAt = today0 + 4 * DAY_MS; // 4 天后收官

async function upsertUser(openid, nickname) {
  const u = await UserModel.findOne({ openid });
  if (u) {
    u.nickname = nickname;
    await u.save();
    return u;
  }
  return UserModel.create({ openid, nickname, weightKg: 62, heightCm: 170, profileCompleted: true });
}

const leader = await upsertUser('campverify_leader', '林小跑');
const rookie = await upsertUser('campverify_rookie', '陈徒步');
const me = await UserModel.findOne({ _id: '6a7ab349398adc2c86b4c1ba' });
if (!me) throw new Error('找不到 dev 用户 6a7ab349398adc2c86b4c1ba');

const campaign = await CampaignModel.create({
  creatorId: leader._id,
  title: '十月徒步挑战赛',
  description: '两周内累计里程最长者获胜，欢迎中途加入。',
  visibility: 'public',
  allowedTypes: ['hiking', 'running', 'cycling'],
  memberLimit: null,
  startAt,
  endAt,
  status: 'active',
});

const members = [
  { userId: leader._id, role: 'creator', joinedAt: startAt },
  { userId: me._id, role: 'member', joinedAt: startAt },
  { userId: rookie._id, role: 'member', joinedAt: startAt + DAY_MS },
];
await CampaignMemberModel.insertMany(
  members.map((m) => ({ ...m, campaignId: campaign._id, state: 'joined', leftAt: null })),
);

/** 造一条轨迹：沿一条直线走 n 步，步长按距离折算 */
function buildTrack({ user, type, dayOffset, distance, duration, hour, note, province, city }) {
  const startTime = bjDayStart(Date.now()) + dayOffset * DAY_MS + hour * 3600000;
  const steps = 24;
  const pts = [];
  const baseLat = 31.23 + (user._id.toString().charCodeAt(0) % 7) * 0.05;
  const baseLng = 121.47;
  const perStep = distance / steps; // 米
  for (let i = 0; i < steps; i++) {
    pts.push({
      seq: i,
      lat: baseLat + i * 0.00012,
      lng: baseLng + i * 0.00009,
      altitude: 20 + Math.round(Math.sin(i / 3) * 8),
      speed: 2.4,
      accuracy: 8,
      timestamp: startTime + Math.round((duration * 1000 * i) / steps),
    });
  }
  const km = distance / 1000;
  const avgPace = km > 0 ? duration / km : null;
  return {
    userId: user._id,
    type,
    status: 'finished',
    corrected: true,
    startTime,
    endTime: startTime + duration * 1000,
    duration,
    standstillMs: 0,
    vehicleMs: 0,
    vehicleM: 0,
    distance,
    avgPace,
    fastestKm: avgPace ? Math.round(avgPace * 0.94) : null,
    trackKind: 'recorded',
    pbMarks: [{ km: 1, sec: Math.round((avgPace || 0) * 1) }],
    calories: Math.round(duration * 0.16),
    elevationGain: 40 + Math.round(Math.random() * 60),
    minAltitude: 12,
    maxAltitude: 58,
    startAddress: `${city}·运动公园`,
    endAddress: `${city}·体育中心`,
    provinces: [province],
    startProvince: province,
    startCity: city,
    trackPoints: pts,
    markers: [],
    lastPointSeq: steps - 1,
    pausedMs: 0,
    note,
  };
}

const plan = [
  // 领先者：跑步为主，距离/时长都第一
  { user: leader, type: 'running', dayOffset: -6, distance: 8200, duration: 3120, hour: 7, note: '晨跑 8.2km', province: '上海市', city: '上海市' },
  { user: leader, type: 'hiking', dayOffset: -5, distance: 9600, duration: 4200, hour: 8, note: '佘山徒步', province: '上海市', city: '上海市' },
  { user: leader, type: 'running', dayOffset: -4, distance: 7400, duration: 2810, hour: 6, note: '间歇跑', province: '上海市', city: '上海市' },
  { user: leader, type: 'running', dayOffset: -3, distance: 8800, duration: 3350, hour: 7, note: '沿江跑', province: '上海市', city: '上海市' },
  { user: leader, type: 'hiking', dayOffset: -2, distance: 10200, duration: 4500, hour: 8, note: '天目山一日', province: '浙江省', city: '湖州市' },
  { user: leader, type: 'running', dayOffset: -1, distance: 6900, duration: 2600, hour: 18, note: '夜跑', province: '上海市', city: '上海市' },
  { user: leader, type: 'hiking', dayOffset: 0, distance: 8100, duration: 3600, hour: 9, note: '西山徒步', province: '北京市', city: '北京市' },
  // 我：中等，距离第二、次数第二、时长第二
  { user: me, type: 'hiking', dayOffset: -6, distance: 5200, duration: 2400, hour: 19, note: '下班走一圈', province: '北京市', city: '北京市' },
  { user: me, type: 'running', dayOffset: -5, distance: 4600, duration: 1750, hour: 20, note: '跑五公里', province: '北京市', city: '北京市' },
  { user: me, type: 'hiking', dayOffset: -4, distance: 5800, duration: 2600, hour: 19, note: '香山', province: '北京市', city: '北京市' },
  { user: me, type: 'cycling', dayOffset: -3, distance: 12000, duration: 1500, hour: 8, note: '通勤骑行', province: '北京市', city: '北京市' },
  { user: me, type: 'running', dayOffset: -2, distance: 6400, duration: 2430, hour: 6, note: '晨跑', province: '北京市', city: '北京市' },
  { user: me, type: 'hiking', dayOffset: -1, distance: 4300, duration: 1950, hour: 20, note: '夜走', province: '北京市', city: '北京市' },
  { user: me, type: 'running', dayOffset: 0, distance: 5500, duration: 2080, hour: 7, note: '晨跑 5.5', province: '北京市', city: '北京市' },
  // 新加入的队友：次数最多（8 次），距离/时长垫底 → 切「次数」指标时名次会变
  { user: rookie, type: 'hiking', dayOffset: -5, distance: 3200, duration: 1500, hour: 7, note: '入门走', province: '广东省', city: '深圳市' },
  { user: rookie, type: 'cycling', dayOffset: -5, distance: 4000, duration: 600, hour: 18, note: '骑行', province: '广东省', city: '深圳市' },
  { user: rookie, type: 'cycling', dayOffset: -4, distance: 8000, duration: 1100, hour: 8, note: '骑行', province: '广东省', city: '深圳市' },
  { user: rookie, type: 'cycling', dayOffset: -4, distance: 3500, duration: 500, hour: 18, note: '骑行', province: '广东省', city: '深圳市' },
  { user: rookie, type: 'hiking', dayOffset: -3, distance: 2400, duration: 1150, hour: 19, note: '夜走', province: '广东省', city: '深圳市' },
  { user: rookie, type: 'cycling', dayOffset: -2, distance: 4600, duration: 700, hour: 8, note: '骑行', province: '广东省', city: '深圳市' },
  { user: rookie, type: 'hiking', dayOffset: -2, distance: 1800, duration: 900, hour: 19, note: '散步', province: '广东省', city: '深圳市' },
  { user: rookie, type: 'hiking', dayOffset: -1, distance: 2800, duration: 1350, hour: 20, note: '散步', province: '广东省', city: '深圳市' },
];

await ActivityModel.insertMany(plan.map(buildTrack));

const sum = (u) => {
  const rows = plan.filter((p) => p.user._id.equals(u._id));
  return {
    name: u.nickname,
    count: rows.length,
    distance: rows.reduce((s, r) => s + r.distance, 0),
    duration: rows.reduce((s, r) => s + r.duration, 0),
  };
};
console.log('CAMPAIGN_ID', String(campaign._id));
console.log('title', campaign.title);
console.log('startAt', new Date(startAt).toISOString(), 'endAt', new Date(endAt).toISOString());
for (const u of [leader, me, rookie]) console.log(sum(u));
await mongoose.disconnect();
