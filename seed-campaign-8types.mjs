/**
 * 一次性造数脚本（验证「按类型」趋势在极端情况下的版面）：
 * 一个**不限运动类型**的公开活动 + 10 名成员 + 近 7 天 finished 轨迹，8 个运动类型全部有数据。
 *
 * 刻意做成最坏情况：
 * - 8 类各有不同的总里程 → 8 条线终点互不相同，能看出服务端按累计降序排；
 * - 昵称里有 3 个超过 5 字 → 顺带验「按人」图例的截断；
 * - 10 名成员 → 「按人」档是前三 + 我共 4 枚图例。
 *
 * 脚本自带清理：按标题删掉本脚本建过的活动与成员行、按 note 删掉本脚本造的轨迹，
 * 所以可以反复重跑而不会越堆越多。用法：cd sport_track_api && npx tsx seed-campaign-8types.mjs
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
const startAt = today0 - 6 * DAY_MS; // 6 天前开赛 → 7 个日桶（≤31 天，桶粒度仍是「按日」）
const endAt = today0 + 4 * DAY_MS;

const TITLE = '八项全能测试队';
const ALL_TYPE_KEYS = [
  'hiking',
  'running',
  'cycling',
  'swimming',
  'rowing',
  'walking',
  'mountaineering',
  'skiing',
];
const SEED_NOTES = ALL_TYPE_KEYS.map((t) => `${t} 造数`);

/**
 * 先清掉本脚本上一次跑出来的东西（只按自己的标题与 note 匹配，不碰别的活动/轨迹）。
 * 上一版把 duration 算错了（拿米数除类型总公里数，造出 60 小时一条活动），必须能重跑覆盖。
 */
const staleCampaigns = await CampaignModel.find({ title: TITLE }).select('_id').lean();
const staleIds = staleCampaigns.map((c) => c._id);
await CampaignMemberModel.deleteMany({ campaignId: { $in: staleIds } });
await CampaignModel.deleteMany({ _id: { $in: staleIds } });
const staleTracks = await ActivityModel.deleteMany({ note: { $in: SEED_NOTES } });
console.log(
  '清理：活动',
  staleIds.length,
  '个 / 轨迹',
  staleTracks.deletedCount,
  '条',
);

async function upsertUser(openid, nickname) {
  const u = await UserModel.findOne({ openid });
  if (u) {
    u.nickname = nickname;
    await u.save();
    return u;
  }
  return UserModel.create({ openid, nickname, weightKg: 62, heightCm: 170, profileCompleted: true });
}

// 前三个沿用上一版脚本的人，保证「我」（模拟器登录态）仍在队里
const leader = await upsertUser('campverify_leader', '林小跑');
const rookie = await upsertUser('campverify_rookie', '陈徒步');
const me = await UserModel.findOne({ _id: '6a7ab349398adc2c86b4c1ba' });
if (!me) throw new Error('找不到 dev 用户 6a7ab349398adc2c86b4c1ba');

// 后 7 位是新队友，其中 3 个昵称超过 5 字（用来验图例截断）
const extraNames = [
  '小小梦工场爱运动',
  '周末爬山小队长',
  '阿迹的健身日记',
  '老王',
  '阿珍',
  '大熊',
  '小美',
];
const extras = [];
for (let i = 0; i < extraNames.length; i++) {
  extras.push(await upsertUser(`camp8_${i}`, extraNames[i]));
}
const users = [leader, me, rookie, ...extras];

const campaign = await CampaignModel.create({
  creatorId: leader._id,
  title: TITLE,
  description: '不限运动类型，用来验「按类型」趋势八条线的版面。',
  visibility: 'public',
  allowedTypes: [], // 不限 → 八类全部计入
  memberLimit: null,
  startAt,
  endAt,
  status: 'active',
});

await CampaignMemberModel.insertMany(
  users.map((u, i) => ({
    campaignId: campaign._id,
    userId: u._id,
    role: i === 0 ? 'creator' : 'member',
    state: 'joined',
    leftAt: null,
    joinedAt: startAt,
  })),
);

/** 每类的总里程（km）互不相同 → 八条线的终点高低、排序都能一眼看出 */
const TYPES = [
  { type: 'hiking', km: 58, pace: 700 },
  { type: 'running', km: 46, pace: 360 },
  { type: 'cycling', km: 34, pace: 120 },
  { type: 'swimming', km: 22, pace: 200 },
  { type: 'rowing', km: 16, pace: 240 },
  { type: 'walking', km: 12, pace: 900 },
  { type: 'mountaineering', km: 8, pace: 800 },
  { type: 'skiing', km: 5, pace: 300 },
];

/** 造一条轨迹：沿一条直线走 n 步，步长按距离折算（同 seed-campaign-verify.mjs） */
function buildTrack({ user, type, dayOffset, distance, duration, hour, city, province }) {
  const startTime = today0 + dayOffset * DAY_MS + hour * 3600000;
  const steps = 24;
  const pts = [];
  const baseLat = 31.23 + (user._id.toString().charCodeAt(0) % 7) * 0.05;
  const baseLng = 121.47;
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
  const avgPace = km > 0 ? Math.round(duration / km) : null;
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
    pbMarks: [{ km: 1, sec: avgPace || 0 }],
    calories: Math.round(duration * 0.16),
    elevationGain: 40 + (steps % 60),
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
    note: `${type} 造数`,
  };
}

const CITIES = [
  ['上海市', '上海市'],
  ['北京市', '北京市'],
  ['广东省', '深圳市'],
  ['浙江省', '杭州市'],
];

const plan = [];
TYPES.forEach((t, ti) => {
  const totalM = t.km * 1000;
  const n = 3 + (ti % 3); // 每类 3~5 人参与，摊成多条线才有累计坡度
  const per = Math.round(totalM / n / 100) * 100;
  for (let k = 0; k < n; k++) {
    const [province, city] = CITIES[(ti + k) % CITIES.length];
    plan.push({
      user: users[(ti * 3 + k * 2) % users.length],
      type: t.type,
      dayOffset: -6 + ((ti + k * 2) % 7),
      distance: per,
      // pace 是「秒 / 公里」，所以要乘**这一条的公里数**（上一版误乘了该类型的总公里数，造出 60 小时一条活动）
      duration: Math.round((per / 1000) * t.pace),
      hour: 6 + ((ti + k) % 12),
      province,
      city,
    });
  }
});

await ActivityModel.insertMany(plan.map(buildTrack));

const byType = {};
for (const p of plan) byType[p.type] = (byType[p.type] || 0) + p.distance;
console.log('CAMPAIGN_ID', String(campaign._id));
console.log('members', users.length, 'activities', plan.length);
for (const t of TYPES) {
  console.log(`${t.type.padEnd(15)} ${(byType[t.type] / 1000).toFixed(2)} km`);
}
console.log(
  '合计',
  (plan.reduce((s, p) => s + p.distance, 0) / 1000).toFixed(2),
  'km',
  '| 次数',
  plan.length,
);
await mongoose.disconnect();
