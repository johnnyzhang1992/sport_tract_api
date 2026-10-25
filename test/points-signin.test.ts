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

test('PS2 断签后从第 1 天重算', async (t) => {
  const uid2 = new Types.ObjectId();
  t.after(() => wipe(uid2));
  await PointSigninModel.create({ userId: uid2, dateKey: '2026-10-20', streakDay: 5, points: 5, source: 'sign', createdAt: NOW });
  const r = await signIn(String(uid2), NOW);
  assert.equal(r.streakDay, 1);
  assert.equal(r.credited, 1);
});

test('PS3 同一天重复签到幂等', async (t) => {
  // 用独立用户：PS1 已经把主用户 10-25 签过了，这里要观察首次签到才能断言 alreadySigned=false
  const uid3 = new Types.ObjectId();
  t.after(() => wipe(uid3));
  const first = await signIn(String(uid3), NOW + DAY);
  const again = await signIn(String(uid3), NOW + DAY);
  assert.equal(again.alreadySigned, true);
  assert.equal(again.credited, 0);
  assert.equal(first.alreadySigned, false);
});

test('PS4 补签：昨天第 3 天，补 +3，今天签到第 4 天 +4', async (t) => {
  const uid4 = new Types.ObjectId();
  t.after(() => wipe(uid4));
  await PointSigninModel.create({ userId: uid4, dateKey: '2026-10-22', streakDay: 2, points: 2, source: 'sign', createdAt: NOW });
  const card = await PointCardModel.create({ userId: uid4, expiresAt: NOW + 86400000, createdAt: NOW });
  const r = await useMakeupCard(String(uid4), String(card._id), NOW);
  assert.equal(r.credited, 3);
  assert.equal(r.streakDay, 3);
  assert.equal(r.nextReward, 4); // 补完昨天，今天还能签第 4 天
  assert.equal(r.canMakeUp, false);
  assert.equal((await signIn(String(uid4), NOW)).credited, 4);
});

test('PS5 前天未签不能补昨天', async (t) => {
  const uid5 = new Types.ObjectId();
  t.after(() => wipe(uid5));
  const card = await PointCardModel.create({ userId: uid5, expiresAt: NOW + 86400000, createdAt: NOW });
  await assert.rejects(useMakeupCard(String(uid5), String(card._id), NOW), /前天/);
});

test('PS6 今天已签到时补签被拒，卡不消耗', async (t) => {
  const uid6 = new Types.ObjectId();
  t.after(() => wipe(uid6));
  for (const [dateKey, streakDay] of [['2026-10-22', 2], ['2026-10-23', 3], ['2026-10-24', 4]] as const) {
    await PointSigninModel.create({ userId: uid6, dateKey, streakDay, points: streakDay, source: 'sign', createdAt: NOW });
  }
  const card = await PointCardModel.create({ userId: uid6, expiresAt: NOW + 86400000, createdAt: NOW });
  await assert.rejects(useMakeupCard(String(uid6), String(card._id), NOW), /今天已签到/);
  const cardAfter = await PointCardModel.findById(card._id).lean();
  assert.equal(cardAfter?.status, 'unused');
});

test('PS7 昨天已签到时补签被拒，卡不消耗', async (t) => {
  const uid7 = new Types.ObjectId();
  t.after(() => wipe(uid7));
  for (const [dateKey, streakDay] of [['2026-10-22', 2], ['2026-10-23', 3]] as const) {
    await PointSigninModel.create({ userId: uid7, dateKey, streakDay, points: streakDay, source: 'sign', createdAt: NOW });
  }
  const card = await PointCardModel.create({ userId: uid7, expiresAt: NOW + 86400000, createdAt: NOW });
  await assert.rejects(useMakeupCard(String(uid7), String(card._id), NOW), /昨天已签到/);
  assert.equal((await PointCardModel.findById(card._id).lean())?.status, 'unused');
  assert.equal(await PointSigninModel.countDocuments({ userId: uid7 }), 2);
  assert.equal(await PointRecordModel.countDocuments({ userId: uid7 }), 0);
});

test('PS8 补签卡已过期：拒绝且不留 0 分补签行', async (t) => {
  const uid8 = new Types.ObjectId();
  t.after(() => wipe(uid8));
  await PointSigninModel.create({ userId: uid8, dateKey: '2026-10-22', streakDay: 2, points: 2, source: 'sign', createdAt: NOW });
  const card = await PointCardModel.create({ userId: uid8, expiresAt: NOW - 1, createdAt: NOW });
  await assert.rejects(useMakeupCard(String(uid8), String(card._id), NOW), /不可用或已过期/);
  assert.equal(await PointSigninModel.countDocuments({ userId: uid8, dateKey: '2026-10-23' }), 0); // 占位行已撤回
  assert.equal(await PointRecordModel.countDocuments({ userId: uid8 }), 0);
  assert.equal((await PointCardModel.findById(card._id).lean())?.status, 'unused');
});

test('PS9 补签卡已用过：拒绝且不改动原卡的 usedForDate', async (t) => {
  const uid9 = new Types.ObjectId();
  t.after(() => wipe(uid9));
  await PointSigninModel.create({ userId: uid9, dateKey: '2026-10-22', streakDay: 2, points: 2, source: 'sign', createdAt: NOW });
  const card = await PointCardModel.create({
    userId: uid9, status: 'used', usedForDate: '2026-10-20', expiresAt: NOW + 86400000, createdAt: NOW,
  });
  await assert.rejects(useMakeupCard(String(uid9), String(card._id), NOW), /不可用或已过期/);
  const cardAfter = await PointCardModel.findById(card._id).lean();
  assert.equal(cardAfter?.status, 'used');
  assert.equal(cardAfter?.usedForDate, '2026-10-20');
  assert.equal(await PointSigninModel.countDocuments({ userId: uid9, dateKey: '2026-10-23' }), 0);
});

test('PS10 并发交错：今天的行抢在补签落库前出现 → 补签拒绝、卡不消耗、补签行已撤回', async (t) => {
  const uid10 = new Types.ObjectId();
  t.after(() => wipe(uid10));
  const u10 = String(uid10);
  await PointSigninModel.create({ userId: uid10, dateKey: '2026-10-22', streakDay: 2, points: 2, source: 'sign', createdAt: NOW });
  const card = await PointCardModel.create({ userId: uid10, expiresAt: NOW + 86400000, createdAt: NOW });

  type CreateFn = (...args: unknown[]) => Promise<unknown>;
  const realCreate = PointSigninModel.create.bind(PointSigninModel) as CreateFn;
  // 精确模拟交错：补签占位行落库的这一刻，并发 signIn 已经写入了今天的签到行
  // （它读 yesterday 时补签行还不存在，所以 streakDay=1）
  t.mock.method(PointSigninModel as unknown as { create: CreateFn }, 'create', async (...args: unknown[]) => {
    const doc = args[0] as { source?: string; userId?: unknown } | undefined;
    if (doc?.source === 'makeup' && String(doc.userId) === u10) {
      await realCreate({ userId: uid10, dateKey: '2026-10-24', streakDay: 1, points: 1, source: 'sign', createdAt: NOW });
    }
    return realCreate(...args);
  });

  await assert.rejects(useMakeupCard(u10, String(card._id), NOW), /今天已签到/);

  // 补签行已撤回：只剩前天 + 今天的行，明天不会被补签行污染成「昨天已签到」
  const dateKeys = (await PointSigninModel.find({ userId: uid10 }).lean()).map((r) => r.dateKey).sort();
  assert.deepEqual(dateKeys, ['2026-10-22', '2026-10-24']);
  assert.equal((await PointCardModel.findById(card._id).lean())?.status, 'unused'); // 卡未消耗
  assert.equal(await PointRecordModel.countDocuments({ userId: uid10 }), 0); // 未发分
});

test('PS11 补签发分为 0（当日已满）→ 400、卡退回未使用、不留 0 分补签行', async (t) => {
  const uid11 = new Types.ObjectId();
  t.after(() => wipe(uid11));
  await PointSigninModel.create({ userId: uid11, dateKey: '2026-10-22', streakDay: 2, points: 2, source: 'sign', createdAt: NOW });
  // 昨天（2026-10-23）已入账 100 分（每日上限），补签只能拿到 0 分
  await PointRecordModel.create({
    userId: uid11, type: 'task', title: '占满当日上限', delta: 100, balanceAfter: 100,
    bizDate: '2026-10-23', idemKey: `${uid11}:seed:cap`, createdAt: NOW,
  });
  const card = await PointCardModel.create({ userId: uid11, expiresAt: NOW + 86400000, createdAt: NOW });

  await assert.rejects(useMakeupCard(String(uid11), String(card._id), NOW), /补签卡未消耗/);

  const cardAfter = await PointCardModel.findById(card._id).lean();
  assert.equal(cardAfter?.status, 'unused'); // 0 分不该白烧卡
  assert.equal(cardAfter?.usedForDate, '');
  assert.equal(await PointSigninModel.countDocuments({ userId: uid11, dateKey: '2026-10-23' }), 0); // 无 0 分补签行
  assert.equal(await PointRecordModel.countDocuments({ userId: uid11, idemKey: `${uid11}:makeup:2026-10-23` }), 0);
});
