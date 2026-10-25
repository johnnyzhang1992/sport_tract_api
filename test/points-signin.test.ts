import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { config } from '../src/config/index.js';
import { PointSigninModel, PointCardModel, PointRecordModel, PointAccountModel, PointLotModel } from '../src/models/point.model.js';
import { signIn, useMakeupCard, getSigninState } from '../src/services/points-signin.js';
import { creditStreakTopUp } from '../src/services/points-streak.js';
import { creditPoints } from '../src/services/points-ledger.js';

const userId = String(new Types.ObjectId());
const uid = new Types.ObjectId(userId);
const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 25, 2, 0, 0); // 2026-10-25 10:00 东八区（与 points-streak.test.ts 同一冻结时钟）

const wipe = (u: Types.ObjectId) => Promise.all([
  PointSigninModel.deleteMany({ userId: u }),
  PointCardModel.deleteMany({ userId: u }),
  PointRecordModel.deleteMany({ userId: u }),
  PointAccountModel.deleteMany({ userId: u }),
  PointLotModel.deleteMany({ userId: u }),
]);

const seed = (dateKey: string, streakDay: number) => PointSigninModel.create({ userId: uid, dateKey, streakDay, points: Math.min(streakDay, 7), source: 'sign', createdAt: NOW });

/** 造一行签到记录，points 显式给（区分「库存 streakDay」与当日实发 points，模拟截断/崩溃夹缝） */
const row = (u: Types.ObjectId, dateKey: string, streakDay: number, points: number) =>
  PointSigninModel.create({ userId: u, dateKey, streakDay, points, source: 'sign', createdAt: NOW });

/**
 * 造一张可用补签卡（默认给主用户），返回 id。
 * 改版后**客户端不传卡 id**（spec §5.2）：这些 id 只用来断言「服务端挑了哪张卡、卡有没有被退回来」。
 */
const giveCard = (u: Types.ObjectId = uid, expiresAt = NOW + 30 * 86400000) => PointCardModel.create({
  userId: u, itemKey: 'makeup_card', status: 'unused',
  expiresAt, usedForDate: '', createdAt: NOW,
}).then((c) => String(c._id));

/** 账本不变式（每次写结束都得成立）：Σ 流水 delta === 账户余额 === Σ 未过期批次 remaining */
const assertLedgerHolds = async (u: Types.ObjectId, expected: number, label: string) => {
  const recs = await PointRecordModel.find({ userId: u }).lean();
  assert.equal(recs.reduce((s, r) => s + r.delta, 0), expected, `${label}：Σ流水=期望`);
  assert.equal((await PointAccountModel.findOne({ userId: u }).lean())?.balance, expected, `${label}：余额=期望`);
  const lotSum = (await PointLotModel.find({ userId: u, expireAt: { $gt: NOW } }).lean())
    .reduce((s, l) => s + l.remaining, 0);
  assert.equal(lotSum, expected, `${label}：Σ批次剩余=期望`);
};

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
  for (let i = 1; i <= 6; i++) await seed(`2026-10-${String(18 + i).padStart(2, '0')}`, i);
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
  await PointSigninModel.create({ userId: uid2, dateKey: '2026-10-21', streakDay: 5, points: 5, source: 'sign', createdAt: NOW });
  const r = await signIn(String(uid2), NOW);
  assert.equal(r.streakDay, 1);
  assert.equal(r.credited, 1);
});

test('PS3 同一天重复签到幂等', async (t) => {
  // 用独立用户：PS1 已经把主用户 10-26 签过了，这里要观察首次签到才能断言 alreadySigned=false
  const uid3 = new Types.ObjectId();
  t.after(() => wipe(uid3));
  const first = await signIn(String(uid3), NOW + DAY);
  const again = await signIn(String(uid3), NOW + DAY);
  assert.equal(again.alreadySigned, true);
  assert.equal(again.credited, 0);
  assert.equal(first.alreadySigned, false);
});

test('PS4 补签：昨天第 2 天补 +2，今天再签是第 3 天 +3', async () => {
  await wipe(uid);
  await seed('2026-10-23', 1);
  const cardId = await giveCard();
  const r = await useMakeupCard(userId, '2026-10-24', NOW);
  assert.equal(r.credited, 2);
  assert.equal(r.toppedUp, 0);
  assert.equal(r.balance, 2);
  assert.equal((await PointSigninModel.findOne({ userId: uid, dateKey: '2026-10-24' }).lean())?.points, 2, '行记的是实发分（§3）');
  assert.equal((await PointCardModel.findById(cardId).lean())?.usedForDate, '2026-10-24', '卡记在补的那一天上');
  const s = await signIn(userId, NOW);
  assert.equal(s.streakDay, 3);
  assert.equal(s.credited, 3);
});

test('PS4b 补窗口最左的 19：19=1 分，20..23 各补 1 分差额', async () => {
  await wipe(uid);
  for (const [i, k] of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'].entries()) {
    await seed(k, i + 1);
  }
  await giveCard();
  const r = await useMakeupCard(userId, '2026-10-19', NOW);
  assert.equal(r.credited, 1, '19 自己排第 1');
  assert.equal(r.toppedUp, 4, '20..23 各 +1');
  assert.equal(r.balance, 5);
  // 两条流水同刻落库（createdAt 都是 NOW），按 {userId, createdAt:-1} 索引取时同刻顺序不保证
  // → 补 _id 兜底（ObjectId 单调，等于写入顺序）。
  const recs = await PointRecordModel.find({ userId: uid }).sort({ createdAt: 1, _id: 1 }).lean();
  assert.deepEqual(recs.map((x) => [x.type, x.delta, x.bizDate]), [
    ['makeup_reward', 1, '2026-10-19'],
    ['makeup_topup', 4, '2026-10-25'],
  ]);
  assert.equal((await PointSigninModel.findOne({ userId: uid, dateKey: '2026-10-23' }).lean())?.streakDay, 5);
  const s = await getSigninState(userId, NOW);
  assert.equal(s.cells.find((c) => c.dateKey === '2026-10-25')!.reward, 1, '24 还空着 → 今天签是新链第 1 天');
  // brief 这里写的 6 是**补 19 之前**的数（MW1：20..23 是 1..4 → 24=5、今天=6）。
  // 补完 19 后链条左移一天（19..23 = 1..5，行上的库存 streakDay 已被校正改过），再补 24 就是 6、今天是 7。
  assert.equal(s.cells.find((c) => c.dateKey === '2026-10-24')!.todayRewardAfter, 7, '补上 24 才把今天顶到 7 分');
});

test('PS4c 一次补两天要两张卡，逐格消耗；先补右边也能靠校正拿到应得分', async () => {
  await wipe(uid);
  await seed('2026-10-20', 1); await seed('2026-10-21', 2); await seed('2026-10-22', 3); // 23、24 都漏，同属一个长度 2 的未签段
  const first = await giveCard();
  const one = await useMakeupCard(userId, '2026-10-24', NOW);
  assert.equal(one.credited, 1, '23 还没补 → 24 左边是断口，自己起新段第 1 天');
  assert.equal(one.toppedUp, 0);
  assert.equal((await PointCardModel.findById(first).lean())?.usedForDate, '2026-10-24');
  await assert.rejects(() => useMakeupCard(userId, '2026-10-23', NOW), /没有可用的补签卡/);
  assert.equal(await PointSigninModel.countDocuments({ userId: uid, dateKey: '2026-10-23' }), 0, '无卡那次连占位行都没留（判定在扣卡之前）');
  await giveCard();
  const two = await useMakeupCard(userId, '2026-10-23', NOW);
  assert.equal(two.credited, 4, '23 接在 22（第 3 天）之后 → 第 4 天');
  assert.equal(two.toppedUp, 4, '24 从第 1 天被顶到第 5 天，欠 4 分差额');
  assert.equal((await PointSigninModel.findOne({ userId: uid, dateKey: '2026-10-24' }).lean())?.streakDay, 5);
  assert.equal((await PointAccountModel.findOne({ userId: uid }).lean())?.balance, 9, '1+4+4');
  // 差额流水挂在**补签日**上（trigger 用今天就会和 signIn 的同天键相撞，Ruling 2026-10-25）；
  // 先补 24 那次没有欠分 → 不写空流水，所以库里只有补 23 这一条。
  assert.deepEqual(
    (await PointRecordModel.find({ userId: uid, type: 'makeup_topup' }).sort({ createdAt: 1, _id: 1 }).lean())
      .map((x) => x.idemKey),
    [`${userId}:makeup_topup:2026-10-23`],
  );
  await assertLedgerHolds(uid, 9, 'PS4c 逐格补两天');
});

test('PS4d 顺序无关：先补 19 再补 24，与先补 24 再补 19 得到同一套分值', async () => {
  await wipe(uid);
  for (const [i, k] of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'].entries()) {
    await seed(k, i + 1);
  }
  await giveCard(); await giveCard();
  const a = await useMakeupCard(userId, '2026-10-19', NOW);
  const b = await useMakeupCard(userId, '2026-10-24', NOW);
  assert.equal(a.credited + a.toppedUp + b.credited + b.toppedUp, 1 + 4 + 6 + 0);
  const rows = await PointSigninModel.find({ userId: uid }).sort({ dateKey: 1 }).lean();
  assert.deepEqual(rows.map((r) => [r.dateKey.slice(8), r.streakDay]),
    [['19', 1], ['20', 2], ['21', 3], ['22', 4], ['23', 5], ['24', 6]]);
  assert.equal((await getSigninState(userId, NOW)).cells.find((c) => c.dateKey === '2026-10-25')!.reward, 7);
  // 反序重跑：结果必须一致
  await wipe(uid);
  for (const [i, k] of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'].entries()) {
    await seed(k, i + 1);
  }
  await giveCard(); await giveCard();
  await useMakeupCard(userId, '2026-10-24', NOW);
  await useMakeupCard(userId, '2026-10-19', NOW);
  const rows2 = await PointSigninModel.find({ userId: uid }).sort({ dateKey: 1 }).lean();
  assert.deepEqual(rows2.map((r) => [r.dateKey.slice(8), r.streakDay]),
    [['19', 1], ['20', 2], ['21', 3], ['22', 4], ['23', 5], ['24', 6]]);
  assert.equal((await PointAccountModel.findOne({ userId: uid }).lean())?.balance,
    (await PointRecordModel.aggregate<{ t: number }>().match({ userId: uid }).group({ _id: null, t: { $sum: '$delta' } }))[0].t,
    '两种顺序下余额都等于 Σ流水');
});

test('PS4e 当天额度只剩 1 分时：响应与流水都带回实发值，行也写实发（§5.2/§3）', async () => {
  await wipe(uid);
  await seed('2026-10-23', 2); // 24 排第 3 天 → 名义 3 分
  // 24 那天已经入账 99 分（走账本，保证余额/批次是真的）→ 补签只剩 1 分额度
  await creditPoints(userId, {
    type: 'task', title: '当日已入账 99', points: 99, bizDate: '2026-10-24', idemKey: `${userId}:seed:99`,
  }, NOW);
  await giveCard();
  const r = await useMakeupCard(userId, '2026-10-24', NOW);
  assert.equal(r.credited, 1, '被 DAILY_CAP 截断成 1，不是名义 3');
  assert.equal(r.toppedUp, 0, '链条本来就正，没有欠分');
  assert.equal((await PointSigninModel.findOne({ userId: uid, dateKey: '2026-10-24' }).lean())?.points, 1, '行写「该日实际入账分」');
  assert.equal((await PointRecordModel.findOne({ userId: uid, type: 'makeup_reward' }).lean())?.delta, 1);
  await assertLedgerHolds(uid, 100, 'PS4e 截断补签');
});

test('PS4f 位置排到第 8 天时补签当天分封顶 7：用 rewardForStreakDay，不是裸 streakDay', async () => {
  await wipe(uid);
  await seed('2026-10-23', 7); // 已连签 7 天 → 24 是第 8 天
  await giveCard();
  const r = await useMakeupCard(userId, '2026-10-24', NOW);
  assert.equal(r.credited, 7, '第 8 天照样 7 分');
  assert.equal((await PointSigninModel.findOne({ userId: uid, dateKey: '2026-10-24' }).lean())?.streakDay, 8, 'streakDay 记绝对天数，不封顶');
});

test('PS5 断签 3 天（22/23/24 都漏）不可补，卡不消耗', async () => {
  await wipe(uid);
  await seed('2026-10-21', 1);
  const id = await giveCard();
  await assert.rejects(() => useMakeupCard(userId, '2026-10-24', NOW), /断签超过 2 天/);
  assert.equal((await PointCardModel.findById(id).lean())?.status, 'unused');
  assert.equal((await PointCardModel.findById(id).lean())?.usedForDate, '', '拒绝发生在占行与扣卡之前，卡上不留痕');
  assert.equal(await PointSigninModel.countDocuments({ userId: uid, dateKey: '2026-10-24' }), 0, '不可补的日子不该被占位行占上');
});

test('PS5b 补今天/补窗口外日期/补非法串/补已签日 → 各自文案的 400，且卡不消耗', async () => {
  await wipe(uid);
  await seed('2026-10-23', 1);
  const id = await giveCard();
  // §5.3 的错误表逐条对上：出窗/是今天/格式非法 → 「该日期不能补签」；已签 → 「该日已签到，无需补签」
  const cases: [string, RegExp][] = [
    ['2026-10-25', /该日期不能补签/],
    ['2026-10-18', /该日期不能补签/],
    ['2026-10-1x', /该日期不能补签/],
    ['2026-10-23', /该日已签到，无需补签/],
  ];
  for (const [bad, re] of cases) {
    await assert.rejects(() => useMakeupCard(userId, bad, NOW), re, `${bad} 应报「${re}」`);
  }
  assert.equal((await PointCardModel.findById(id).lean())?.status, 'unused');
  assert.equal((await PointCardModel.findById(id).lean())?.usedForDate, '');
  assert.equal(await PointSigninModel.countDocuments({ userId: uid }), 1, '四次拒绝都不新增签到行（只有 seed 的 23）');
  assert.equal(await PointRecordModel.countDocuments({ userId: uid }), 0, '四次拒绝都不发分');
});

test('PS6 今天已签也能补昨天，补完把今天那份差额补上', async () => {
  await wipe(uid);
  await seed('2026-10-22', 1); await seed('2026-10-23', 2); // 造一段自洽的连签
  const signed = await signIn(userId, NOW); // 昨天(24)没签 → 今天从第 1 天起，+1
  assert.equal(signed.credited, 1);
  const cardId = await giveCard();
  const r = await useMakeupCard(userId, '2026-10-24', NOW);
  assert.equal(r.credited, 3, '24 接在 23 之后 → 第 3 天');
  assert.equal(r.toppedUp, 3, '今天从第 1 天被顶到第 4 天，补 3 分');
  assert.equal((await PointSigninModel.findOne({ userId: uid, dateKey: '2026-10-25' }).lean())?.streakDay, 4);
  assert.equal((await PointAccountModel.findOne({ userId: uid }).lean())?.balance, 7, '1+3+3');
  assert.equal((await PointCardModel.findById(cardId).lean())?.usedForDate, '2026-10-24');
  assert.equal(r.alreadySigned, true, '今天本就签过：口径 3 不再因此拒绝补签');
});

test('PS6b 同一天连补两格：差额各挂各的 trigger，两条 makeup_topup 互不相吞', async () => {
  await wipe(uid);
  for (const [i, k] of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'].entries()) {
    await seed(k, i + 1);
  }
  const signed = await signIn(userId, NOW); // 24 空着 → 今天新链第 1 天，没欠分可补
  assert.equal(signed.credited, 1);
  await giveCard(); await giveCard();

  const one = await useMakeupCard(userId, '2026-10-19', NOW);
  assert.equal(one.credited, 1);
  assert.equal(one.toppedUp, 4, '20..23 各 +1');
  const two = await useMakeupCard(userId, '2026-10-24', NOW);
  assert.equal(two.credited, 6, '19 补上后 24 排在第 6 天');
  assert.equal(two.toppedUp, 6, '今天从第 1 天顶到第 7 天');

  // trigger 若图省事用今天，这两次补签会抢同一个 {userId}:makeup_topup:{今天} 键、后一份被吞成 0
  assert.deepEqual(
    (await PointRecordModel.find({ userId: uid, type: 'makeup_topup' }).sort({ createdAt: 1, _id: 1 }).lean())
      .map((x) => [x.idemKey, x.delta, x.bizDate]),
    [
      [`${userId}:makeup_topup:2026-10-19`, 4, '2026-10-25'],
      [`${userId}:makeup_topup:2026-10-24`, 6, '2026-10-25'],
    ],
    '差额记今天的额度（§2 口径 2），键却按补签日区分',
  );
  assert.equal((await getSigninState(userId, NOW)).cells.find((c) => c.dateKey === '2026-10-25')!.reward, 7);
  await assertLedgerHolds(uid, 1 + 1 + 4 + 6 + 6, 'PS6b 连补两格');
});

test('PS7 昨天已签到时补签被拒，卡不消耗、流水不写', async () => {
  await wipe(uid);
  await seed('2026-10-23', 2); await seed('2026-10-24', 3);
  const id = await giveCard();
  await assert.rejects(() => useMakeupCard(userId, '2026-10-24', NOW), /该日已签到，无需补签/);
  const cardAfter = await PointCardModel.findById(id).lean();
  assert.equal(cardAfter?.status, 'unused');
  assert.equal(cardAfter?.usedForDate, '');
  assert.equal(await PointSigninModel.countDocuments({ userId: uid }), 2);
  assert.equal(await PointRecordModel.countDocuments({ userId: uid }), 0);
});

test('PS8 只有过期卡：拒绝且不留 0 分补签行（卡不消耗）、根本不去扣卡', async (t) => {
  await wipe(uid);
  await seed('2026-10-23', 2);
  const card = await PointCardModel.create({
    userId: uid, itemKey: 'makeup_card', status: 'unused', expiresAt: NOW - 1, usedForDate: '', createdAt: NOW,
  });
  const id = String(card._id);
  // cards 闸门在扣卡之前：无卡时根本不该发出那一枪（把这枪换成报错也照样看不见）
  type UpdateFn = (...args: unknown[]) => unknown;
  t.mock.method(PointCardModel as unknown as { findOneAndUpdate: UpdateFn }, 'findOneAndUpdate',
    () => ({ lean: () => Promise.reject(new Error('无可用卡时不该走到扣卡这一步')) }));

  await assert.rejects(() => useMakeupCard(userId, '2026-10-24', NOW), /没有可用的补签卡/);
  assert.equal(await PointSigninModel.countDocuments({ userId: uid, dateKey: '2026-10-24' }), 0, '卡数为 0 时连占位行都不建');
  assert.equal(await PointRecordModel.countDocuments({ userId: uid }), 0);
  assert.equal((await PointCardModel.findById(id).lean())?.status, 'unused');
});

test('PS8b 服务端自己挑卡：两张可用卡用掉最早过期那张，客户端不传卡 id', async (t) => {
  const u8b = new Types.ObjectId();
  const id8b = String(u8b);
  t.after(() => wipe(u8b));
  await row(u8b, '2026-10-23', 2, 2);
  const late = await giveCard(u8b, NOW + 20 * 86400000);
  const early = await giveCard(u8b, NOW + 5 * 86400000);
  const r = await useMakeupCard(id8b, '2026-10-24', NOW);
  assert.equal(r.cardId, early, '最早过期的那张被挑走');
  assert.equal((await PointCardModel.findById(early).lean())?.usedForDate, '2026-10-24');
  assert.equal((await PointCardModel.findById(late).lean())?.status, 'unused', '另一张不动');
});

test('PS9 卡已用过（无其它可用卡）：拒绝、原卡的 usedForDate 不改动、不留占位行', async () => {
  await wipe(uid);
  await seed('2026-10-23', 2);
  const card = await PointCardModel.create({
    userId: uid, itemKey: 'makeup_card', status: 'used', usedForDate: '2026-10-20', expiresAt: NOW + 86400000, createdAt: NOW,
  });
  await assert.rejects(() => useMakeupCard(userId, '2026-10-24', NOW), /没有可用的补签卡/);
  const cardAfter = await PointCardModel.findById(card._id).lean();
  assert.equal(cardAfter?.status, 'used');
  assert.equal(cardAfter?.usedForDate, '2026-10-20');
  assert.equal(await PointSigninModel.countDocuments({ userId: uid, dateKey: '2026-10-24' }), 0);
});

test('PS10 同一天双击两张卡并发补签：只成一次，卡只烧一张，钱只发一次', async () => {
  await wipe(uid);
  await seed('2026-10-23', 2);
  await giveCard(); await giveCard();
  const [a, b] = await Promise.allSettled([
    useMakeupCard(userId, '2026-10-24', NOW),
    useMakeupCard(userId, '2026-10-24', NOW),
  ]);
  const ok = [a, b].filter((x) => x.status === 'fulfilled');
  const bad = [a, b].filter((x) => x.status === 'rejected');
  assert.equal(ok.length, 1, '只有一个请求补成功');
  assert.equal(bad.length, 1, '另一个必须失败');
  assert.match(String((bad[0] as PromiseRejectedResult).reason), /该日已签到，无需补签|没有可用的补签卡/);
  assert.equal((ok[0] as PromiseFulfilledResult<{ credited: number; toppedUp: number }>).value.credited, 3);
  assert.equal(await PointSigninModel.countDocuments({ userId: uid, dateKey: '2026-10-24' }), 1, '24 只有一行');
  assert.equal(await PointRecordModel.countDocuments({ userId: uid, type: 'makeup_reward' }), 1, '当天分只发一次');
  assert.equal(await PointCardModel.countDocuments({ userId: uid, status: 'used' }), 1, '一张卡就够，另一张留着');
  await assertLedgerHolds(uid, 3, 'PS10 并发双击');
});

test('PS10b 占行之后卡被另一路抢走：撤回该行、不写流水、卡不动', async (t) => {
  await wipe(uid);
  await seed('2026-10-23', 2);
  const cardId = await giveCard();
  type UpdateFn = (...args: unknown[]) => unknown;
  // 交错：count 说有卡，真正扣卡时那张已被并发请求用掉 → findOneAndUpdate 拿不到卡
  t.mock.method(PointCardModel as unknown as { findOneAndUpdate: UpdateFn }, 'findOneAndUpdate',
    () => ({ lean: () => Promise.resolve(null) }));

  await assert.rejects(() => useMakeupCard(userId, '2026-10-24', NOW), /没有可用的补签卡/);
  t.mock.restoreAll();

  assert.equal(await PointSigninModel.countDocuments({ userId: uid, dateKey: '2026-10-24' }), 0, '占位行已撤回');
  assert.equal(await PointRecordModel.countDocuments({ userId: uid }), 0, '没扣到卡就一分钱都不发');
  const cardAfter = await PointCardModel.findById(cardId).lean();
  assert.equal(cardAfter?.status, 'unused', '不是本次挑中的卡，不能被改');
  assert.equal(cardAfter?.usedForDate, '');
});

test('PS10c 扣卡这一枪本身报错（网络/校验）：撤回占位行、原样冒泡、不发分不烧卡', async (t) => {
  await wipe(uid);
  await seed('2026-10-23', 2);
  const cardId = await giveCard();
  type UpdateFn = (...args: unknown[]) => unknown;
  t.mock.method(PointCardModel as unknown as { findOneAndUpdate: UpdateFn }, 'findOneAndUpdate',
    () => ({ lean: () => Promise.reject(new Error('模拟：扣卡请求失败')) }));

  await assert.rejects(() => useMakeupCard(userId, '2026-10-24', NOW), /模拟：扣卡请求失败/);
  assert.equal(await PointSigninModel.countDocuments({ userId: uid, dateKey: '2026-10-24' }), 0, '报错也要撤掉刚占的行，别留 0 分补签行');
  assert.equal(await PointRecordModel.countDocuments({ userId: uid }), 0, '没扣到卡就一分钱都不发');
  assert.equal((await PointCardModel.findById(cardId).lean())?.status, 'unused');
});

test('PS12b 并发交错：另一路签到先把今天建成第 1 天，补签 24 后由校正重排并补差', async (t) => {
  const u12b = new Types.ObjectId();
  const id12b = String(u12b);
  t.after(() => wipe(u12b));
  await row(u12b, '2026-10-22', 1, 1);
  await row(u12b, '2026-10-23', 2, 2);
  const cardId = await giveCard(u12b);
  // 今天的行抢在补签落库前出现（它读昨天时 24 还没行，所以 streakDay=1、当天只拿了 1 分）
  await row(u12b, '2026-10-25', 1, 1);
  await creditPoints(id12b, {
    type: 'signin', title: '连续签到第 1 天', points: 1, bizDate: '2026-10-25',
    refType: 'signin', refId: '2026-10-25', idemKey: `${id12b}:signin:2026-10-25`,
  }, NOW);

  // 旧实现在这里报「今天已签到，补签需在今日签到前完成」；口径 3 之后照样能补，欠的那份由收尾校正补上
  const r = await useMakeupCard(id12b, '2026-10-24', NOW);
  assert.equal(r.credited, 3, '24 接在 23（第 2 天）之后 → 第 3 天');
  assert.equal(r.toppedUp, 3, '今天从第 1 天顶到第 4 天');
  assert.equal((await PointSigninModel.findOne({ userId: u12b, dateKey: '2026-10-25' }).lean())?.streakDay, 4);
  assert.equal((await PointCardModel.findById(cardId).lean())?.usedForDate, '2026-10-24');
  const recs = await PointRecordModel.find({ userId: u12b }).sort({ createdAt: 1, _id: 1 }).lean();
  assert.deepEqual(recs.map((x) => x.type), ['signin', 'makeup_reward', 'makeup_topup'], '交错不留空流水');
  await assertLedgerHolds(u12b, 7, 'PS12b 交错补签');
});

// 计划里这两条原本断言 canMakeUp/makeupDate 的下发；那两个字段已删（Task 3），Task 3 顺手把它们改成了
// cells 断言。这里保留断言内容、改成 PS22/PS23 编号，让给回滚路径的 PS11/PS12 用（读路径用例）。
test('PS22 可补格与卡数量解耦：无卡也下发 makeup 格，供前端引导兑换', async (t) => {
  const uid12 = new Types.ObjectId();
  const u12 = String(uid12);
  t.after(() => wipe(uid12));
  // 昨天漏签、前天签过 → 存在可补空档，但一张卡都没有
  await PointSigninModel.create({ userId: uid12, dateKey: '2026-10-23', streakDay: 2, points: 2, source: 'sign', createdAt: NOW });

  const noCard = await getSigninState(u12, NOW);
  assert.deepEqual(noCard.cells.filter((c) => c.state === 'makeup').map((c) => c.dateKey), ['2026-10-24'], '无卡也要下发可补格，前端才能引导兑换');
  assert.equal(noCard.cards, 0);

  await PointCardModel.create({ userId: uid12, expiresAt: NOW + 86400000, createdAt: NOW });
  const withCard = await getSigninState(u12, NOW);
  // 改版口径（spec §5.1）：可补与否只看 state === 'makeup'，与卡数无关；能不能直接补由 cards 决定
  assert.deepEqual(withCard.cells.filter((c) => c.state === 'makeup').map((c) => c.dateKey), ['2026-10-24']);
  assert.equal(withCard.cards, 1);
});

test('PS23 cells 改版：今天已签仍可补昨天（口径 3）；连漏 3 天的昨天不可补', async (t) => {
  const uid13 = new Types.ObjectId();
  const uid14 = new Types.ObjectId();
  t.after(() => Promise.all([wipe(uid13), wipe(uid14)]));

  // 今天已签：旧口径会关掉补签入口，新口径（口径 3）历史漏签日照常可补
  await PointSigninModel.create({ userId: uid13, dateKey: '2026-10-23', streakDay: 2, points: 2, source: 'sign', createdAt: NOW });
  await PointSigninModel.create({ userId: uid13, dateKey: '2026-10-25', streakDay: 3, points: 3, source: 'sign', createdAt: NOW });
  const signedToday = await getSigninState(String(uid13), NOW);
  assert.equal(signedToday.todaySigned, true);
  assert.deepEqual(signedToday.cells.filter((c) => c.state === 'makeup').map((c) => c.dateKey), ['2026-10-24']);

  // 只有 21 号一行：22/23/24 连漏 3 天 → 昨天段长 3，不可补（missed）；
  // 19/20 段长 2（左界截在窗口左缘）→ 仍是可补格，这是 Ruling 2026-10-25 认下的口子
  await PointSigninModel.create({ userId: uid14, dateKey: '2026-10-21', streakDay: 1, points: 1, source: 'sign', createdAt: NOW });
  const noDayBefore = await getSigninState(String(uid14), NOW);
  assert.deepEqual(noDayBefore.cells.filter((c) => c.state === 'makeup').map((c) => c.dateKey), ['2026-10-19', '2026-10-20']);
  assert.equal(noDayBefore.cells.find((c) => c.dateKey === '2026-10-24')?.state, 'missed', '断签超 2 天不可补');
});

test('PS11 补签发分为 0（当日上限已满）→ 400、卡退回未使用、不留 0 分补签行', async () => {
  await wipe(uid);
  await seed('2026-10-23', 2);
  // 昨天（2026-10-24）已入账 100 分（每日上限），补签只能拿到 0 分
  await PointRecordModel.create({
    userId: uid, type: 'task', title: '占满当日上限', delta: 100, balanceAfter: 100,
    bizDate: '2026-10-24', idemKey: `${uid}:seed:cap`, createdAt: NOW,
  });
  const cardId = await giveCard();

  await assert.rejects(() => useMakeupCard(userId, '2026-10-24', NOW), /补签卡未消耗/);

  const cardAfter = await PointCardModel.findById(cardId).lean();
  assert.equal(cardAfter?.status, 'unused'); // 0 分不该白烧卡
  assert.equal(cardAfter?.usedForDate, '');
  assert.equal(await PointSigninModel.countDocuments({ userId: uid, dateKey: '2026-10-24' }), 0); // 无 0 分补签行
  assert.equal(await PointRecordModel.countDocuments({ userId: uid, type: 'makeup_reward' }), 0);
  assert.equal(await PointRecordModel.countDocuments({ userId: uid, type: 'makeup_topup' }), 0, '当天分没发成就不许发差额');
  assert.equal(await PointRecordModel.countDocuments({ userId: uid }), 1, '除了占满当日上限那条，账本上什么都没写');
  assert.equal(await PointSigninModel.countDocuments({ userId: uid }), 1, '只剩 seed 的那行，占位行已撤回');
});

test('PS12 发差额这步抛错：当天分扣回、卡退回、占位行撤回；卡退回后重试真能补上', async (t) => {
  const u12 = new Types.ObjectId();
  const id12 = String(u12);
  t.after(() => wipe(u12));
  await row(u12, '2026-10-22', 1, 1);
  await row(u12, '2026-10-23', 2, 2);
  const signed = await signIn(id12, NOW); // 今天先按「昨天没签」记第 1 天，只拿 1 分
  assert.equal(signed.credited, 1);
  const cardId = await giveCard(u12);

  type CreateFn = (...args: unknown[]) => Promise<unknown>;
  const realCreate = PointRecordModel.create.bind(PointRecordModel) as CreateFn;
  // 只掐 makeup_topup 这一笔：当天分已入账、卡已消耗，差额发不出去
  t.mock.method(PointRecordModel as unknown as { create: CreateFn }, 'create', async (...args: unknown[]) => {
    const doc = args[0] as { type?: string } | undefined;
    if (doc?.type === 'makeup_topup') throw new Error('模拟：差额发放失败');
    return realCreate(...args);
  });

  await assert.rejects(() => useMakeupCard(id12, '2026-10-24', NOW), /模拟/);

  // 逆序回滚：扣回当天分 → 退卡 → 撤行
  const rb = await PointRecordModel.findOne({ userId: u12, delta: { $lt: 0 }, refId: '2026-10-24' }).lean();
  assert.equal(rb?.type, 'makeup_reward_rollback', '已入账的当天分必须用 debitPoints 扣回去');
  assert.equal(rb?.delta, -3);
  assert.equal(rb?.bizDate, '2026-10-25', '钱是今天还回去的 → 记今天的业务日（不占 24 那天的额度）');
  assert.equal(await PointSigninModel.countDocuments({ userId: u12, dateKey: '2026-10-24' }), 0, '补签行撤回');
  assert.equal(await PointRecordModel.countDocuments({ userId: u12, type: 'makeup_topup' }), 0);
  const cardAfter = await PointCardModel.findById(cardId).lean();
  assert.equal(cardAfter?.status, 'unused', '卡退回未使用');
  assert.equal(cardAfter?.usedForDate, '');
  assert.equal((await PointAccountModel.findOne({ userId: u12 }).lean())?.balance, 1, '1（今天签到）+3-3');
  // 已接受风险（spec §5.2/§6.1）：校正写过的行不跟着回滚 —— 今天那行留着被顶上去的 streakDay，
  // 少发的差额找不回来（读路径永不下修）。
  assert.equal((await PointSigninModel.findOne({ userId: u12, dateKey: '2026-10-25' }).lean())?.streakDay, 4);

  // 放开这一步再重试：卡退回来就是要让人补得回来。
  // 幂等键只到日期的话，这一枪会被上一次已撤回的发放判成重放（credited 0）→ 那天永远补不上。
  t.mock.restoreAll();
  const retry = await useMakeupCard(id12, '2026-10-24', NOW);
  assert.equal(retry.credited, 3, '重试重新发出当天分');
  assert.equal(retry.toppedUp, 0, '今天已被上次校正顶到第 4 天，这次重排算不出欠分——那 3 分是认下的不可追回');
  await assertLedgerHolds(u12, 4, 'PS12 回滚 + 重试');
});

test('PS14 summary 下发 7 格：状态、分值与 todayRewardAfter 一致', async () => {
  await wipe(uid);
  await seed('2026-10-20', 1); await seed('2026-10-21', 2);
  await seed('2026-10-22', 3); await seed('2026-10-23', 4);
  const s = await getSigninState(userId, NOW); // NOW = 2026-10-25 10:00
  assert.equal(s.cells.length, 7);
  assert.equal(s.cells[0].dateKey, '2026-10-19');
  assert.deepEqual(s.cells.map((c) => c.state),
    ['makeup', 'signed', 'signed', 'signed', 'signed', 'makeup', 'today']);
  assert.equal(s.cells[5].todayRewardAfter, 6, '补 24 → 今天 6 分');
  assert.equal(s.cells[6].reward, 1);
  assert.equal(s.nextReward, 1);
  assert.equal((s as unknown as { makeupDate?: string }).makeupDate, undefined, '旧字段要删掉');
});

test('PS15 窗外行不参与可补判定：service 只读窗口这 7 天', async (t) => {
  await wipe(uid);
  await seed('2026-10-16', 1);
  await seed('2026-10-20', 1); await seed('2026-10-21', 2);
  await seed('2026-10-22', 3); await seed('2026-10-23', 4);
  const s = await getSigninState(userId, NOW);
  assert.equal(s.cells[0].dateKey, '2026-10-19', '10-16 在窗外 → 19 左侧出窗即停，段长 1，仍可补');
  assert.equal(s.cells.filter((c) => c.state === 'makeup').length, 2, '19 与 24 都可补');

  // 紧贴窗左界的窗外行（10-18，库存值故意离谱）：读范围契约要求 service 一行窗外都不喂给
  // planSigninCells——positionIfSigned 往左走没有硬左界，窗外旧行一旦进 map 就当锚点、格子全错。
  // 正确实现下 10-18 被读范围挡掉，格子与上面（等价于行集 20..23）完全一致。
  const uid15b = new Types.ObjectId();
  const u15b = String(uid15b);
  t.after(() => wipe(uid15b));
  await PointSigninModel.create({ userId: uid15b, dateKey: '2026-10-18', streakDay: 99, points: 7, source: 'sign', createdAt: NOW });
  await PointSigninModel.create({ userId: uid15b, dateKey: '2026-10-20', streakDay: 1, points: 1, source: 'sign', createdAt: NOW });
  await PointSigninModel.create({ userId: uid15b, dateKey: '2026-10-21', streakDay: 2, points: 2, source: 'sign', createdAt: NOW });
  await PointSigninModel.create({ userId: uid15b, dateKey: '2026-10-22', streakDay: 3, points: 3, source: 'sign', createdAt: NOW });
  await PointSigninModel.create({ userId: uid15b, dateKey: '2026-10-23', streakDay: 4, points: 4, source: 'sign', createdAt: NOW });
  const s15b = await getSigninState(u15b, NOW);
  assert.deepEqual(s15b.cells, s.cells, '窗外 10-18 的行不得改变任何一格');
});

test('PS16 今天签到时若并发补签刚落了昨天，今天按重排后的位置发分并补差', async () => {
  await wipe(uid);
  await seed('2026-10-23', 3);
  const r = await signIn(userId, NOW); // 昨天没签 → 今天第 1 天 +1
  assert.equal(r.credited, 1);
  // 模拟「今天行已落，随后补签把昨天插进来」：直接写昨天那行，再走一次校正
  await PointSigninModel.create({
    userId: uid, dateKey: '2026-10-24', streakDay: 4, points: 4, source: 'makeup', createdAt: NOW,
  });
  const top = await creditStreakTopUp(userId, '2026-10-24', NOW);
  assert.equal(top, 4, '今天从第 1 天变第 5 天（23→3、24→4、25→5），欠 4 分');
  assert.equal((await PointSigninModel.findOne({ userId: uid, dateKey: '2026-10-25' }).lean())?.streakDay, 5);
});

test('PS17 signIn 收尾接校正：库里留着错位行时，签到把校正后的差额一并入账', async () => {
  await wipe(uid);
  await seed('2026-10-23', 3);
  // 24 号是上次崩在半路留下的错位行（该 4 记 1），今天签到会把它一并校正回来
  await PointSigninModel.create({ userId: uid, dateKey: '2026-10-24', streakDay: 1, points: 1, source: 'sign', createdAt: NOW });
  const r = await signIn(userId, NOW); // 今天先按昨天库存 1 记第 2 天 +2，收尾校正 24→4、25→5 补 6
  assert.equal(r.credited, 8, '签到 2 分 + 差额 6 分');
  assert.equal(r.balance, 8);
  assert.equal(r.streakDay, 5);
  assert.equal((await PointSigninModel.findOne({ userId: uid, dateKey: '2026-10-24' }).lean())?.streakDay, 4);
  const recs = await PointRecordModel.find({ userId: uid }).lean();
  assert.equal(recs.length, 2);
  const signinRec = recs.find((x) => x.type === 'signin');
  const topRec = recs.find((x) => x.type === 'makeup_topup');
  assert.equal(signinRec?.delta, 2);
  assert.equal(topRec?.idemKey, `${userId}:makeup_topup:2026-10-25`, 'trigger 是今天，天然一天一次');
  assert.equal(topRec?.bizDate, '2026-10-25');
  assert.equal(topRec?.delta, 6);
  // 账本不变式：Σ record.delta === account.balance === Σ 未过期 lot.remaining
  const account = await PointAccountModel.findOne({ userId: uid }).lean();
  assert.equal(account?.balance, 8);
  const lotSum = (await PointLotModel.find({ userId: uid, expireAt: { $gt: NOW } }).lean())
    .reduce((s, l) => s + l.remaining, 0);
  assert.equal(lotSum, 8);
});

test('PS18 streakDay 只报接得上的那条链：隔着断口的旧链长度不算当前连签', async (t) => {
  const uA = new Types.ObjectId();
  const uB = new Types.ObjectId();
  const uC = new Types.ObjectId();
  t.after(() => Promise.all([wipe(uA), wipe(uB), wipe(uC)]));

  // (A) 用户实测场景：20-23 签了、24 漏、今天没签。窗口里最右的已签格是 23（库存 4），
  // 但那是「上一段链的长度」——同一屏报「已连续 4 天」又报「今天签到得 1 分」是自相矛盾。
  await row(uA, '2026-10-20', 1, 1); await row(uA, '2026-10-21', 2, 2);
  await row(uA, '2026-10-22', 3, 3); await row(uA, '2026-10-23', 4, 4);
  const sA = await getSigninState(String(uA), NOW);
  assert.equal(sA.todaySigned, false);
  assert.equal(sA.streakDay, 0, '昨天没签 → 当前连签 0');
  assert.equal(sA.nextReward, 1, '今天签是第 1 天，与 streakDay 0 自洽');
  assert.equal(sA.cells.find((c) => c.dateKey === '2026-10-24')?.state, 'makeup', '24 仍是可补格');

  // (B) 昨天签了 → 报昨天的库存值（链接得上）
  await row(uB, '2026-10-21', 1, 1); await row(uB, '2026-10-22', 2, 2);
  await row(uB, '2026-10-23', 3, 3); await row(uB, '2026-10-24', 4, 4);
  const sB = await getSigninState(String(uB), NOW);
  assert.equal(sB.todaySigned, false);
  assert.equal(sB.streakDay, 4, '昨天(24)的库存值');
  assert.equal(sB.nextReward, 5);

  // (C) 今天已签 → 报今天的库存值（不是昨天的）
  await row(uC, '2026-10-23', 1, 1); await row(uC, '2026-10-24', 2, 2);
  await row(uC, '2026-10-25', 3, 3);
  const sC = await getSigninState(String(uC), NOW);
  assert.equal(sC.todaySigned, true);
  assert.equal(sC.streakDay, 3, '今天的库存值');
  assert.equal(sC.todayReward, 3);
  assert.equal(sC.nextReward, 4);
});

test('PS19 格子与 todayReward 报名义规则分；实际入账分只活在积分明细流水里（Ruling 2026-10-25 名义分）', async (t) => {
  const u19 = new Types.ObjectId();
  t.after(() => wipe(u19));
  // 24 与今天都被 DAILY_CAP 截断：名义 2 / 3，库里行的 points 只有 1；
  // 明细页另有一条实发 1 分的流水（bizDate=今天）——钱的真相在那里，格子负责讲规则。
  await row(u19, '2026-10-23', 1, 1);
  await row(u19, '2026-10-24', 2, 1);
  await row(u19, '2026-10-25', 3, 1);
  await creditPoints(String(u19), {
    type: 'signin', title: '连续签到第 3 天', points: 1, bizDate: '2026-10-25',
    refType: 'signin', refId: '2026-10-25', idemKey: `${String(u19)}:signin:2026-10-25`,
  }, NOW);
  const s = await getSigninState(String(u19), NOW);
  assert.equal(s.cells.find((c) => c.dateKey === '2026-10-24')?.reward, 2, '格子报名义 min(2,7)，行里 points=1 不参与');
  assert.equal(s.cells.find((c) => c.dateKey === '2026-10-25')?.reward, 3, '今天格同样报名义 3');
  assert.equal(s.todayReward, 3, 'todayReward 与格子同源，都是规则分');
  assert.equal(s.streakDay, 3, 'streakDay 仍是库存天数，分值口径不影响它');
  assert.equal(s.nextReward, 4, 'nextReward 是「明天能拿几分」，仍按名义位置');
  const rec = await PointRecordModel.findOne({ userId: u19, bizDate: '2026-10-25' }).lean();
  assert.equal(rec?.delta, 1, '实际入账分记在流水里（明细页按 bizDate 报钱），不靠七格下发');
});

test('PS20 同一天重试把上次没发成的差额补回来（提前返回路径也走校正）', async (t) => {
  const u20 = new Types.ObjectId();
  const id20 = String(u20);
  t.after(() => wipe(u20));
  // 复现崩溃夹缝：上一次 signIn 已经把「今天的行 + 当天 2 分」落了库，收尾校正没跑成
  //（24 该 4 记 1、25 该 5 记 2，欠 6 分）。修法之前用户再点一次走「今天已签」早退，欠分锁到明天。
  await row(u20, '2026-10-23', 3, 3);
  await row(u20, '2026-10-24', 1, 1);
  await row(u20, '2026-10-25', 2, 2);
  await creditPoints(id20, {
    type: 'signin', title: '连续签到第 2 天', points: 2, bizDate: '2026-10-25',
    refType: 'signin', refId: '2026-10-25', idemKey: `${id20}:signin:2026-10-25`,
  }, NOW);

  const again = await signIn(id20, NOW);
  assert.equal(again.alreadySigned, true);
  assert.equal(again.credited, 6, '24:1→4 补 3、25:2→5 补 3');
  assert.equal(again.balance, 8);
  assert.equal(again.streakDay, 5, '校正后的链条才是要报给前端的连签天数');
  assert.equal((await PointSigninModel.findOne({ userId: u20, dateKey: '2026-10-24' }).lean())?.streakDay, 4);
  assert.equal((await PointSigninModel.findOne({ userId: u20, dateKey: '2026-10-25' }).lean())?.streakDay, 5);
  const top = await PointRecordModel.findOne({ userId: u20, type: 'makeup_topup' }).lean();
  assert.equal(top?.delta, 6);
  assert.equal(top?.idemKey, `${id20}:makeup_topup:2026-10-25`, '幂等键仍是今天的 trigger');

  // 第三次点：链条已正 → 幂等键 + 「已正返回 0」保证一分都不再多发
  const third = await signIn(id20, NOW);
  assert.equal(third.alreadySigned, true);
  assert.equal(third.credited, 0);
  assert.equal(third.balance, 8);
  assert.equal(await PointRecordModel.countDocuments({ userId: u20, type: 'makeup_topup' }), 1);
  // 账本不变式：Σ record.delta === account.balance === Σ 未过期 lot.remaining
  const recs = await PointRecordModel.find({ userId: u20 }).lean();
  assert.equal(recs.reduce((s, r) => s + r.delta, 0), 8);
  assert.equal((await PointAccountModel.findOne({ userId: u20 }).lean())?.balance, 8);
  const lotSum = (await PointLotModel.find({ userId: u20, expireAt: { $gt: NOW } }).lean())
    .reduce((s, l) => s + l.remaining, 0);
  assert.equal(lotSum, 8);
});

test('PS21 并发重放（唯一键冲突那条早退路）同样不放过欠着的差额', async (t) => {
  const u21 = new Types.ObjectId();
  const id21 = String(u21);
  t.after(() => wipe(u21));
  await row(u21, '2026-10-23', 3, 3);
  await row(u21, '2026-10-24', 1, 1); // 错位行：该 4 记 1

  type CreateFn = (...args: unknown[]) => Promise<unknown>;
  const realCreate = PointSigninModel.create.bind(PointSigninModel) as CreateFn;
  // 抢赢的那一路：建了今天的行、发了当天 2 分，随后死在收尾校正之前 → 本次请求撞唯一键早退
  t.mock.method(PointSigninModel as unknown as { create: CreateFn }, 'create', async (...args: unknown[]) => {
    const doc = args[0] as { source?: string; userId?: unknown; streakDay?: number } | undefined;
    if (doc?.source === 'sign' && String(doc.userId) === id21) {
      await realCreate({ userId: u21, dateKey: '2026-10-25', streakDay: doc.streakDay, points: 2, source: 'sign', createdAt: NOW });
      await creditPoints(id21, {
        type: 'signin', title: '连续签到第 2 天', points: 2, bizDate: '2026-10-25',
        refType: 'signin', refId: '2026-10-25', idemKey: `${id21}:signin:2026-10-25`,
      }, NOW);
      throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
    }
    return realCreate(...args);
  });

  const r = await signIn(id21, NOW);
  assert.equal(r.alreadySigned, true);
  assert.equal(r.credited, 6, '24:1→4 补 3、25:2→5 补 3');
  assert.equal((await PointSigninModel.findOne({ userId: u21, dateKey: '2026-10-25' }).lean())?.streakDay, 5);
  assert.equal(await PointRecordModel.countDocuments({ userId: u21, type: 'makeup_topup' }), 1);
});
