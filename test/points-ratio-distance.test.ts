/**
 * 倍率里程碑（200%/300%/400%/500% 完成目标）的**距离口径**（2026-11-20 产品裁定）
 *
 * 口径变更：
 *   旧 —— 三项（距离/时长/次数）里**最弱一项**的完成倍数。
 *          跑了 18km（目标 3km = 600%）但次数只完成 1/2 的用户，倍数 = 0.5，
 *          连 1 倍档都进不去，200% 徽章拿不到。用户认为「距离明明远超目标，被次数卡住没意义」。
 *   新 —— **只看距离**：progress.distanceM / targets.distanceM。
 *
 * 守的承诺：
 *   1. cur（卡面进度计数）与 earnDateText（解锁日）**必须同口径**
 *      —— 历史上两套口径导致过「徽章已解锁但没有获得日期」的自相矛盾卡面（2026-11-17 b4575da）
 *   2. 没设距离目标（distanceM=0）的期不计入任何倍率档
 *   3. overStreak（加量建议）**仍用三项最弱**，语义是「整体轻松超额」，不是同一件事
 *
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test test/points-ratio-distance.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', quiet: true });

import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ExercisePlanModel } from '../src/models/exercise-plan.model.js';
import { ExercisePlanPeriodModel } from '../src/models/exercise-plan-period.model.js';
import { getPlanSummary } from '../src/services/exercise-plan.js';
import { bjDateStr } from '../src/utils/bj-time.js';

const DAY = 86_400_000;
const OPENID_A = 'ratio-dist-a'; // 距离 600% / 次数 50% → 新口径应解锁 200/300/500
const OPENID_B = 'ratio-dist-b'; // 没设距离目标（只设时长）→ 不计入任何倍率档

let uidA = '';
let uidB = '';

const bj = (offsetDays: number) => bjDateStr(Date.now() - offsetDays * DAY);
const dayStart = (offsetDays: number) => Date.parse(`${bj(offsetDays)}T00:00:00+08:00`);

async function cleanup() {
  const users = await UserModel.find({ openid: { $in: [OPENID_A, OPENID_B] } }).select('_id').lean();
  const ids = users.map((u) => u._id);
  if (ids.length) {
    await ExercisePlanModel.deleteMany({ userId: { $in: ids } });
    await ExercisePlanPeriodModel.deleteMany({ userId: { $in: ids } });
    await UserModel.deleteMany({ _id: { $in: ids } });
  }
}

/** 造一期快照（targets 为当期目标，progress 为实际完成） */
function snap(
  userId: mongoose.Types.ObjectId,
  offsetDays: number,
  targets: { distanceM: number; durationMin: number; count: number },
  progress: { distanceM: number; durationSec: number; count: number },
) {
  return {
    userId,
    period: 'daily' as const,
    periodKey: bj(offsetDays),
    windowStart: dayStart(offsetDays),
    windowEnd: dayStart(offsetDays) + DAY,
    targets,
    progress,
    achieved: {
      distance: targets.distanceM > 0 && progress.distanceM >= targets.distanceM,
      duration: targets.durationMin > 0 && progress.durationSec >= targets.durationMin * 60,
      count: targets.count > 0 && progress.count >= targets.count,
    },
    // allAchieved 故意置 false（次数没达成）——倍率徽章不该看它
    allAchieved: false,
  };
}

before(async () => {
  // 直调 service，不需要 buildApp —— 但必须自己连库（buildApp 那条路会 connect）
  await mongoose.connect(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 5000 });
  await cleanup();
  const ua = await UserModel.create({ openid: OPENID_A, nickname: '距离派', uid: 91001 });
  const ub = await UserModel.create({ openid: OPENID_B, nickname: '只测时长', uid: 91002 });
  uidA = String(ua._id);
  uidB = String(ub._id);

  // A：目标 3km / 30min / 2次；实际 18km / 30min / 1次
  //    距离 600%（5 档）、时长 100%、次数 50% → 旧口径 min=0.5 什么都不进
  await ExercisePlanModel.create({
    userId: ua._id,
    period: 'daily',
    targets: { distanceM: 3000, durationMin: 30, count: 2 },
    activeFrom: dayStart(1),
  });
  await ExercisePlanPeriodModel.create(
    snap(ua._id, 1, { distanceM: 3000, durationMin: 30, count: 2 }, { distanceM: 18000, durationSec: 1800, count: 1 }),
  );

  // B：只设时长目标（距离 0），实际跑了很久 → 距离口径下无分母，不计入倍率档
  await ExercisePlanModel.create({
    userId: ub._id,
    period: 'daily',
    targets: { distanceM: 0, durationMin: 30, count: 0 },
    activeFrom: dayStart(1),
  });
  await ExercisePlanPeriodModel.create(
    snap(ub._id, 1, { distanceM: 0, durationMin: 30, count: 0 }, { distanceM: 50000, durationSec: 7200, count: 3 }),
  );
});

after(async () => {
  await cleanup();
  await mongoose.disconnect();
});

const trophy = (s: Awaited<ReturnType<typeof getPlanSummary>>, key: string) =>
  s.trophies.find((t) => t.key === key)!;

test('PRD1 距离 600% / 次数 50%：200%/300%/500% 徽章都解锁（旧口径一个都拿不到）', async () => {
  const s = await getPlanSummary(uidA);
  for (const key of ['x2', 'x3', 'x5']) {
    const t = trophy(s, key);
    assert.equal(t.unlocked, true, `${key} 应解锁（距离达标，不该被次数卡住）`);
    assert.ok(t.cur >= 1, `${key} 的 cur 应 ≥1，实际 ${t.cur}`);
  }
  // 600% 不到 400%？——600% ≥ 400% 和 500%，所以 x4 也解锁；这里校验「不超过」的边界用 500% 档
  assert.equal(trophy(s, 'x4').unlocked, true, '600% 也满足 400%（累计口径）');
});

test('PRD2 cur 与 earnDateText 同口径：解锁了就一定有获得日期（防「已解锁但无名次/无日期」）', async () => {
  const s = await getPlanSummary(uidA);
  for (const t of s.trophies) {
    if (!t.unlocked) continue;
    assert.ok(t.earnDateText, `${t.key} 已解锁但缺获得日期（cur/解锁日口径不一致）`);
    assert.match(t.earnDateText, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('PRD3 卡面：倍数章印百分比，进度行不再说「目标 N 次」，desc 说明是距离口径', async () => {
  const s = await getPlanSummary(uidA);
  const x2 = trophy(s, 'x2');
  assert.equal(x2.badgeText, '200%', '卡面印百分比');
  assert.match(x2.desc, /运动距离达到目标的 200%/, `desc 应说明按距离：${x2.desc}`);
  // 已解锁 → 进度行留空（不播报次数流水账）
  assert.equal(x2.detailText, '');
});

test('PRD4 没设距离目标（只设时长）的期不计入任何倍率档', async () => {
  const s = await getPlanSummary(uidB);
  for (const key of ['x2', 'x3', 'x4', 'x5']) {
    const t = trophy(s, key);
    assert.equal(t.unlocked, false, `${key} 不该解锁（没设距离目标，无分母）`);
    assert.equal(t.cur, 0, `${key} 的 cur 应为 0，实际 ${t.cur}`);
  }
});