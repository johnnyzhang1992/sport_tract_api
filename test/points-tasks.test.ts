import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { config } from '../src/config/index.js';
import {
  PointAccountModel, PointLotModel, PointRecordModel, PointTaskModel,
} from '../src/models/point.model.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { getTaskRows, claimTask, type TaskRow } from '../src/services/points-tasks.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 24, 2, 0, 0); // 2026-10-24 10:00 BJ

const created: Types.ObjectId[] = [];

/** 每个用例独立用户：任务行/明细/账户都按 userId 隔离，避免用例间互相影响 */
function newUser(): Types.ObjectId {
  const id = new Types.ObjectId();
  created.push(id);
  return id;
}

const wipe = (u: Types.ObjectId) => Promise.all([
  PointTaskModel.deleteMany({ userId: u }),
  PointRecordModel.deleteMany({ userId: u }),
  PointAccountModel.deleteMany({ userId: u }),
  PointLotModel.deleteMany({ userId: u }),
  ActivityModel.deleteMany({ userId: u }),
  UserModel.deleteMany({ _id: u }),
]);

const makeUser = (u: Types.ObjectId, patch: Record<string, unknown> = {}) => UserModel.create({
  _id: u,
  openid: `test-task-${u}`,
  nickname: '',
  avatarUrl: '',
  avatarPreset: '',
  ...patch,
});

const makeActivity = (u: Types.ObjectId, patch: Record<string, unknown> = {}) => ActivityModel.create({
  userId: u,
  type: 'walking',
  status: 'finished',
  startTime: NOW - 3600000,
  ...patch,
});

const row = (rows: TaskRow[], key: string): TaskRow => {
  const found = rows.find((r) => r.key === key);
  assert.ok(found, `缺少任务 ${key}`);
  return found;
};

before(async () => {
  // 单文件直跑不会经过 app 的 mongodb 插件，这里自行连接；不连时查询会一直 buffering
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  // 任务行唯一索引是异步建的，幂等断言（第二次领取撞 E11000）必须先等 init 完成
  await Promise.all([PointTaskModel.init(), PointRecordModel.init()]);
});

after(async () => {
  for (const u of created) await wipe(u);
  await mongoose.disconnect().catch(() => {});
});

test('PT1 完善资料：昵称+头像都齐才可领，领取幂等', async (t) => {
  const uid = newUser();
  t.after(() => wipe(uid));

  // 只有昵称、没有头像/预设头像 → 不可领
  await makeUser(uid, { nickname: '小明' });
  let rows = await getTaskRows(String(uid), NOW);
  assert.equal(row(rows, 'newbie_profile').status, 'locked');
  await assert.rejects(claimTask(String(uid), 'newbie_profile', NOW), /任务条件未完成/);

  // 补上预设头像 → 可领 +5
  await UserModel.updateOne({ _id: uid }, { $set: { avatarPreset: 'default-1' } });
  rows = await getTaskRows(String(uid), NOW);
  assert.equal(row(rows, 'newbie_profile').status, 'claimable');
  assert.equal(row(rows, 'newbie_profile').points, 5);

  const first = await claimTask(String(uid), 'newbie_profile', NOW);
  assert.deepEqual(first, { alreadyClaimed: false, credited: 5 });

  const again = await claimTask(String(uid), 'newbie_profile', NOW);
  assert.deepEqual(again, { alreadyClaimed: true, credited: 0 });

  // 重复领取不重复发分：任务行 1 条、明细 1 条、余额 5
  assert.equal(await PointTaskModel.countDocuments({ userId: uid, taskKey: 'newbie_profile' }), 1);
  assert.equal(await PointRecordModel.countDocuments({ userId: uid, type: 'task_newbie_profile' }), 1);
  assert.equal((await PointAccountModel.findOne({ userId: uid }).lean())?.balance, 5);

  rows = await getTaskRows(String(uid), NOW);
  assert.equal(row(rows, 'newbie_profile').status, 'claimed');
  assert.equal(row(rows, 'newbie_profile').actionText, '已领取');
});

test('PT2 首次运动 +10、首次导入 +5 只在有对应活动时可领', async (t) => {
  const uid = newUser();
  t.after(() => wipe(uid));
  await makeUser(uid);

  // 普通完成的活动（无 deviceInfo.filename）：首次运动可领，首次导入不可领
  await makeActivity(uid, { startTime: NOW - 3600000 });
  let rows = await getTaskRows(String(uid), NOW);
  assert.equal(row(rows, 'newbie_first_activity').status, 'claimable');
  assert.equal(row(rows, 'newbie_first_activity').points, 10);
  assert.equal(row(rows, 'newbie_first_import').status, 'locked');
  await assert.rejects(claimTask(String(uid), 'newbie_first_import', NOW), /任务条件未完成/);

  const first = await claimTask(String(uid), 'newbie_first_activity', NOW);
  assert.deepEqual(first, { alreadyClaimed: false, credited: 10 });

  // 导入轨迹（deviceInfo.filename 非空）→ 首次导入可领 +5
  await makeActivity(uid, { startTime: NOW - 2 * 3600000, deviceInfo: { filename: 'x.gpx' } });
  rows = await getTaskRows(String(uid), NOW);
  assert.equal(row(rows, 'newbie_first_import').status, 'claimable');
  assert.equal(row(rows, 'newbie_first_import').points, 5);

  const imported = await claimTask(String(uid), 'newbie_first_import', NOW);
  assert.deepEqual(imported, { alreadyClaimed: false, credited: 5 });
  assert.equal((await PointAccountModel.findOne({ userId: uid }).lean())?.balance, 15);
});

test('PT3 每日运动 +1：当天 finished 轨迹才可领，次日不可领', async (t) => {
  const uid = newUser();
  t.after(() => wipe(uid));
  await makeUser(uid);

  // 今天一条 + 昨天一条 finished
  await makeActivity(uid, { startTime: NOW - 3600000 }); // 2026-10-24
  await makeActivity(uid, { startTime: NOW - DAY }); // 2026-10-23

  let rows = await getTaskRows(String(uid), NOW);
  assert.equal(row(rows, 'daily_activity').status, 'claimable');
  assert.equal(row(rows, 'daily_activity').points, 1);

  const claimed = await claimTask(String(uid), 'daily_activity', NOW);
  assert.deepEqual(claimed, { alreadyClaimed: false, credited: 1 });

  rows = await getTaskRows(String(uid), NOW);
  assert.equal(row(rows, 'daily_activity').status, 'claimed');

  // 次日（10-25）只有 10-23/10-24 的轨迹，今天没有 finished → 不可领
  const tomorrow = NOW + DAY;
  rows = await getTaskRows(String(uid), tomorrow);
  assert.equal(row(rows, 'daily_activity').status, 'locked');
  assert.equal(row(rows, 'daily_activity').actionText, '去运动');
  await assert.rejects(claimTask(String(uid), 'daily_activity', tomorrow), /任务条件未完成/);

  // 跨天后旧任务行不会被当成今天已领（periodKey 不同）
  assert.equal(await PointTaskModel.countDocuments({ userId: uid, taskKey: 'daily_activity' }), 1);
});

test('PT4 视频任务每日一次：领取后再次返回已领取', async (t) => {
  const uid = newUser();
  t.after(() => wipe(uid));
  await makeUser(uid);

  const first = await claimTask(String(uid), 'daily_video', NOW);
  assert.deepEqual(first, { alreadyClaimed: false, credited: 5 });

  const again = await claimTask(String(uid), 'daily_video', NOW);
  assert.deepEqual(again, { alreadyClaimed: true, credited: 0 });

  assert.equal(await PointTaskModel.countDocuments({ userId: uid, taskKey: 'daily_video' }), 1);
  assert.equal((await PointAccountModel.findOne({ userId: uid }).lean())?.balance, 5);

  const rows = await getTaskRows(String(uid), NOW);
  assert.equal(row(rows, 'daily_video').status, 'claimed');

  // 次日重置为可领（每日一次）
  const tomorrowRows = await getTaskRows(String(uid), NOW + DAY);
  assert.equal(row(tomorrowRows, 'daily_video').status, 'claimable');
});
