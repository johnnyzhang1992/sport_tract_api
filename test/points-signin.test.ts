import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { config } from '../src/config/index.js';
import { PointSigninModel, PointCardModel, PointRecordModel, PointAccountModel, PointLotModel } from '../src/models/point.model.js';
import { signIn, useMakeupCard, getSigninState } from '../src/services/points-signin.js';

const userId = String(new Types.ObjectId());
const uid = new Types.ObjectId(userId);
const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 24, 2, 0, 0); // 2026-10-24 10:00 BJ

const wipe = (u: Types.ObjectId) => Promise.all([
  PointSigninModel.deleteMany({ userId: u }),
  PointCardModel.deleteMany({ userId: u }),
  PointRecordModel.deleteMany({ userId: u }),
  PointAccountModel.deleteMany({ userId: u }),
  PointLotModel.deleteMany({ userId: u }),
]);

const seed = (dateKey: string, streakDay: number) => PointSigninModel.create({ userId: uid, dateKey, streakDay, points: Math.min(streakDay, 7), source: 'sign', createdAt: NOW });

before(async () => {
  // 单文件直跑不会经过 app 的 mongodb 插件，这里自行连接；不连时查询会一直 buffering
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  // 签到唯一索引是异步建的，测试要覆盖并发/重复路径，必须先等 init 完成
  await Promise.all([PointSigninModel.init(), PointRecordModel.init()]);
});

after(async () => {
  await Promise.all([
    PointSigninModel.deleteMany({ userId: uid }),
    PointCardModel.deleteMany({ userId: uid }),
    PointRecordModel.deleteMany({ userId: uid }),
    PointAccountModel.deleteMany({ userId: uid }),
    PointLotModel.deleteMany({ userId: uid }),
  ]);
  await mongoose.disconnect().catch(() => {});
});

test('PS1 连签第 7 天 +7；第 8 天仍 +7', async () => {
  for (let i = 1; i <= 6; i++) await seed(`2026-10-${String(17 + i).padStart(2, '0')}`, i);
  const r7 = await signIn(userId, NOW);
  assert.equal(r7.streakDay, 7);
  assert.equal(r7.credited, 7);
  assert.equal(r7.nextReward, 7); // 今天已签，nextReward 是明天（第 8 天）的 7 分
  const r8 = await signIn(userId, NOW + DAY);
  assert.equal(r8.streakDay, 8);
  assert.equal(r8.credited, 7);
});

test('PS2 断签后从第 1 天重算', async () => {
  const uid2 = new Types.ObjectId();
  await PointSigninModel.create({ userId: uid2, dateKey: '2026-10-20', streakDay: 5, points: 5, source: 'sign', createdAt: NOW });
  const r = await signIn(String(uid2), NOW);
  assert.equal(r.streakDay, 1);
  assert.equal(r.credited, 1);
  await wipe(uid2);
});

test('PS3 同一天重复签到幂等', async () => {
  // 用独立用户：PS1 已经把主用户 10-25 签过了，这里要观察首次签到才能断言 alreadySigned=false
  const uid3 = new Types.ObjectId();
  const first = await signIn(String(uid3), NOW + DAY);
  const again = await signIn(String(uid3), NOW + DAY);
  assert.equal(again.alreadySigned, true);
  assert.equal(again.credited, 0);
  assert.equal(first.alreadySigned, false);
  await wipe(uid3);
});

test('PS4 补签：昨天第 3 天，补 +3，今天签到第 4 天 +4', async () => {
  const uid4 = new Types.ObjectId();
  await PointSigninModel.create({ userId: uid4, dateKey: '2026-10-22', streakDay: 2, points: 2, source: 'sign', createdAt: NOW });
  const card = await PointCardModel.create({ userId: uid4, expiresAt: NOW + 86400000, createdAt: NOW });
  const r = await useMakeupCard(String(uid4), String(card._id), NOW);
  assert.equal(r.credited, 3);
  assert.equal(r.streakDay, 3);
  assert.equal(r.nextReward, 4); // 补完昨天，今天还能签第 4 天
  assert.equal(r.canMakeUp, false);
  assert.equal((await signIn(String(uid4), NOW)).credited, 4);
  await wipe(uid4);
});

test('PS5 前天未签不能补昨天', async () => {
  const uid5 = new Types.ObjectId();
  const card = await PointCardModel.create({ userId: uid5, expiresAt: NOW + 86400000, createdAt: NOW });
  await assert.rejects(useMakeupCard(String(uid5), String(card._id), NOW), /前天/);
  await PointCardModel.deleteMany({ userId: uid5 });
});

test('PS6 今天已签到时补签被拒，卡不消耗', async () => {
  const uid6 = new Types.ObjectId();
  for (const [dateKey, streakDay] of [['2026-10-22', 2], ['2026-10-23', 3], ['2026-10-24', 4]] as const) {
    await PointSigninModel.create({ userId: uid6, dateKey, streakDay, points: streakDay, source: 'sign', createdAt: NOW });
  }
  const card = await PointCardModel.create({ userId: uid6, expiresAt: NOW + 86400000, createdAt: NOW });
  await assert.rejects(useMakeupCard(String(uid6), String(card._id), NOW), /今天已签到/);
  const after = await PointCardModel.findById(card._id).lean();
  assert.equal(after?.status, 'unused');
  await wipe(uid6);
});
