import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { config } from '../src/config/index.js';
import { PointSigninModel, PointCardModel, PointRecordModel, PointAccountModel, PointLotModel } from '../src/models/point.model.js';
import { signIn, useMakeupCard, getSigninState } from '../src/services/points-signin.js';
import { creditStreakTopUp } from '../src/services/points-streak.js';

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

test('PS4 补签：昨天第 3 天，补 +3，今天签到第 4 天 +4', async (t) => {
  const uid4 = new Types.ObjectId();
  t.after(() => wipe(uid4));
  await PointSigninModel.create({ userId: uid4, dateKey: '2026-10-23', streakDay: 2, points: 2, source: 'sign', createdAt: NOW });
  const card = await PointCardModel.create({ userId: uid4, expiresAt: NOW + 86400000, createdAt: NOW });
  const r = await useMakeupCard(String(uid4), String(card._id), NOW);
  assert.equal(r.credited, 3);
  assert.equal(r.streakDay, 3);
  assert.equal(r.nextReward, 4); // 补完昨天，今天还能签第 4 天
  assert.deepEqual(r.cells.filter((c) => c.state === 'makeup').map((c) => c.dateKey), [], '昨天已补上，不再有可补格');
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
  for (const [dateKey, streakDay] of [['2026-10-23', 2], ['2026-10-24', 3], ['2026-10-25', 4]] as const) {
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
  for (const [dateKey, streakDay] of [['2026-10-23', 2], ['2026-10-24', 3]] as const) {
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
  await PointSigninModel.create({ userId: uid8, dateKey: '2026-10-23', streakDay: 2, points: 2, source: 'sign', createdAt: NOW });
  const card = await PointCardModel.create({ userId: uid8, expiresAt: NOW - 1, createdAt: NOW });
  await assert.rejects(useMakeupCard(String(uid8), String(card._id), NOW), /不可用或已过期/);
  assert.equal(await PointSigninModel.countDocuments({ userId: uid8, dateKey: '2026-10-24' }), 0); // 占位行已撤回
  assert.equal(await PointRecordModel.countDocuments({ userId: uid8 }), 0);
  assert.equal((await PointCardModel.findById(card._id).lean())?.status, 'unused');
});

test('PS9 补签卡已用过：拒绝且不改动原卡的 usedForDate', async (t) => {
  const uid9 = new Types.ObjectId();
  t.after(() => wipe(uid9));
  await PointSigninModel.create({ userId: uid9, dateKey: '2026-10-23', streakDay: 2, points: 2, source: 'sign', createdAt: NOW });
  const card = await PointCardModel.create({
    userId: uid9, status: 'used', usedForDate: '2026-10-20', expiresAt: NOW + 86400000, createdAt: NOW,
  });
  await assert.rejects(useMakeupCard(String(uid9), String(card._id), NOW), /不可用或已过期/);
  const cardAfter = await PointCardModel.findById(card._id).lean();
  assert.equal(cardAfter?.status, 'used');
  assert.equal(cardAfter?.usedForDate, '2026-10-20');
  assert.equal(await PointSigninModel.countDocuments({ userId: uid9, dateKey: '2026-10-24' }), 0);
});

test('PS10 并发交错：今天的行抢在补签落库前出现 → 补签拒绝、卡不消耗、补签行已撤回', async (t) => {
  const uid10 = new Types.ObjectId();
  t.after(() => wipe(uid10));
  const u10 = String(uid10);
  await PointSigninModel.create({ userId: uid10, dateKey: '2026-10-23', streakDay: 2, points: 2, source: 'sign', createdAt: NOW });
  const card = await PointCardModel.create({ userId: uid10, expiresAt: NOW + 86400000, createdAt: NOW });

  type CreateFn = (...args: unknown[]) => Promise<unknown>;
  const realCreate = PointSigninModel.create.bind(PointSigninModel) as CreateFn;
  // 精确模拟交错：补签占位行落库的这一刻，并发 signIn 已经写入了今天的签到行
  // （它读 yesterday 时补签行还不存在，所以 streakDay=1）
  t.mock.method(PointSigninModel as unknown as { create: CreateFn }, 'create', async (...args: unknown[]) => {
    const doc = args[0] as { source?: string; userId?: unknown } | undefined;
    if (doc?.source === 'makeup' && String(doc.userId) === u10) {
      await realCreate({ userId: uid10, dateKey: '2026-10-25', streakDay: 1, points: 1, source: 'sign', createdAt: NOW });
    }
    return realCreate(...args);
  });

  await assert.rejects(useMakeupCard(u10, String(card._id), NOW), /今天已签到/);

  // 补签行已撤回：只剩前天 + 今天的行，明天不会被补签行污染成「昨天已签到」
  const dateKeys = (await PointSigninModel.find({ userId: uid10 }).lean()).map((r) => r.dateKey).sort();
  assert.deepEqual(dateKeys, ['2026-10-23', '2026-10-25']);
  assert.equal((await PointCardModel.findById(card._id).lean())?.status, 'unused'); // 卡未消耗
  assert.equal(await PointRecordModel.countDocuments({ userId: uid10 }), 0); // 未发分
});

test('PS12 可补格与卡数量解耦：无卡也下发 makeup 格，供前端引导兑换', async (t) => {
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

test('PS13 cells 改版：今天已签仍可补昨天（口径 3）；连漏 3 天的昨天不可补', async (t) => {
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

test('PS11 补签发分为 0（当日已满）→ 400、卡退回未使用、不留 0 分补签行', async (t) => {
  const uid11 = new Types.ObjectId();
  t.after(() => wipe(uid11));
  await PointSigninModel.create({ userId: uid11, dateKey: '2026-10-23', streakDay: 2, points: 2, source: 'sign', createdAt: NOW });
  // 昨天（2026-10-24）已入账 100 分（每日上限），补签只能拿到 0 分
  await PointRecordModel.create({
    userId: uid11, type: 'task', title: '占满当日上限', delta: 100, balanceAfter: 100,
    bizDate: '2026-10-24', idemKey: `${uid11}:seed:cap`, createdAt: NOW,
  });
  const card = await PointCardModel.create({ userId: uid11, expiresAt: NOW + 86400000, createdAt: NOW });

  await assert.rejects(useMakeupCard(String(uid11), String(card._id), NOW), /补签卡未消耗/);

  const cardAfter = await PointCardModel.findById(card._id).lean();
  assert.equal(cardAfter?.status, 'unused'); // 0 分不该白烧卡
  assert.equal(cardAfter?.usedForDate, '');
  assert.equal(await PointSigninModel.countDocuments({ userId: uid11, dateKey: '2026-10-24' }), 0); // 无 0 分补签行
  assert.equal(await PointRecordModel.countDocuments({ userId: uid11, idemKey: `${uid11}:makeup:2026-10-24` }), 0);
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
