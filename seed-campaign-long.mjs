/**
 * 一次性造数脚本（验证「活动跨度很长」时趋势图的桶粒度与 X 轴排字）：
 * 一个跨约一年的进行中活动 + 3 名成员 + 12 个月各一条轨迹。
 *
 * 落点：dayCount ≈ 371 → 服务端切「按周」桶 → 53 个桶。
 * 这正是 X 轴标签抽稀要治的场景（旧口径 53 桶会画 18 个标签、且末两格只差 3 格必压字）。
 *
 * 脚本自带清理（按标题删活动与成员行、按 note 前缀删轨迹），可反复重跑。
 * 用法：cd sport_track_api && npx tsx seed-campaign-long.mjs
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
function bjDayStart(ms) {
  const d = new Date(ms + 8 * 3600000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 8 * 3600000;
}
const today0 = bjDayStart(Date.now());
const startAt = today0 - 370 * DAY_MS; // 一年前开赛
const endAt = today0 + 10 * DAY_MS;

const TITLE = '跨年拉练测试队';
const NOTE_PREFIX = 'longtrend ';

// 先清掉上一次跑出来的（只按自己的标题与 note 前缀匹配）
const stale = await CampaignModel.find({ title: TITLE }).select('_id').lean();
const staleIds = stale.map((c) => c._id);
await CampaignMemberModel.deleteMany({ campaignId: { $in: staleIds } });
await CampaignModel.deleteMany({ _id: { $in: staleIds } });
const staleTracks = await ActivityModel.deleteMany({ note: { $regex: `^${NOTE_PREFIX}` } });
console.log('清理：活动', staleIds.length, '个 / 轨迹', staleTracks.deletedCount, '条');

const leader = await UserModel.findOne({ nickname: '林小跑' });
const me = await UserModel.findOne({ _id: '6a7ab349398adc2c86b4c1ba' });
const rookie = await UserModel.findOne({ nickname: '陈徒步' });
if (!leader || !me || !rookie) throw new Error('找不到上一版造数脚本建的三个 dev 用户');
const users = [leader, me, rookie];

const campaign = await CampaignModel.create({
  creatorId: leader._id,
  title: TITLE,
  description: '跨一年，用来验趋势图的周桶与 X 轴排字。',
  visibility: 'public',
  allowedTypes: ['hiking'], // 只留一类，按人档就是三条线，专注看横轴
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

/** 每月一条：三人轮流、距离递增，累计线整年都有台阶 */
function buildTrack(user, dayOffset, distance, hour) {
  const startTime = today0 + dayOffset * DAY_MS + hour * 3600000;
  const steps = 24;
  const pts = [];
  const baseLat = 31.23 + (user._id.toString().charCodeAt(0) % 7) * 0.05;
  for (let i = 0; i < steps; i++) {
    pts.push({
      seq: i,
      lat: baseLat + i * 0.00012,
      lng: 121.47 + i * 0.00009,
      altitude: 20 + Math.round(Math.sin(i / 3) * 8),
      speed: 2.4,
      accuracy: 8,
      timestamp: startTime + Math.round((10800 * 1000 * i) / steps),
    });
  }
  const duration = Math.round((distance / 1000) * 700); // 徒步 11:40/km
  const avgPace = Math.round(duration / (distance / 1000));
  return {
    userId: user._id,
    type: 'hiking',
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
    fastestKm: Math.round(avgPace * 0.94),
    trackKind: 'recorded',
    pbMarks: [{ km: 1, sec: avgPace }],
    calories: Math.round(duration * 0.16),
    elevationGain: 60,
    minAltitude: 12,
    maxAltitude: 72,
    startAddress: '拉练起点',
    endAddress: '拉练终点',
    provinces: ['浙江省'],
    startProvince: '浙江省',
    startCity: '杭州市',
    trackPoints: pts,
    markers: [],
    lastPointSeq: steps - 1,
    pausedMs: 0,
    note: `${NOTE_PREFIX}${dayOffset}`,
  };
}

const plan = [];
for (let m = 0; m < 12; m++) {
  const dayOffset = -370 + m * 31; // 每月一格，铺满整年
  users.forEach((u, ui) => {
    plan.push(buildTrack(u, dayOffset + ui, 6000 + m * 400 + ui * 900, 8));
  });
}
await ActivityModel.insertMany(plan);

console.log('CAMPAIGN_ID', String(campaign._id));
console.log('members', users.length, 'activities', plan.length, '跨度天', Math.round((endAt - startAt) / DAY_MS));
console.log('预计桶数：dayCount ≈', Math.round((today0 - startAt) / DAY_MS) + 1, '→ 按周 ≈',
  Math.ceil((Math.round((today0 - startAt) / DAY_MS) + 1) / 7), '个标签位');
await mongoose.disconnect();
