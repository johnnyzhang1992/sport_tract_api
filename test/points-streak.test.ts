import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { config } from '../src/config/index.js';
import { PointSigninModel, PointRecordModel, PointAccountModel, PointLotModel } from '../src/models/point.model.js';
import { reconcileStreaks, creditStreakTopUp } from '../src/services/points-streak.js';
import { shiftDateKey } from '../src/utils/points-domain.js';

const userId = String(new Types.ObjectId());
const uid = new Types.ObjectId(userId);
const NOW = Date.UTC(2026, 9, 25, 2, 0, 0); // 2026-10-25 10:00 东八区
const TODAY = '2026-10-25';
const back = (n: number) => shiftDateKey(TODAY, -n);

const put = (dateKey: string, streakDay: number, points: number) =>
  PointSigninModel.create({ userId: uid, dateKey, streakDay, points, source: 'sign', createdAt: NOW });
const wipe = () => Promise.all([
  PointSigninModel.deleteMany({ userId: uid }),
  PointRecordModel.deleteMany({ userId: uid }),
  PointAccountModel.deleteMany({ userId: uid }),
  PointLotModel.deleteMany({ userId: uid }),
]);

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  await PointSigninModel.init();
});
after(async () => { await wipe(); await mongoose.disconnect().catch(() => {}); });

test('RK1 正常链条不动它：fixes 空、差额 0', async () => {
  await wipe();
  await put(back(3), 1, 1); await put(back(2), 2, 2); await put(back(1), 3, 3);
  const r = await reconcileStreaks(userId, NOW);
  assert.deepEqual(r.fixes, []);
  assert.equal(r.topUpPoints, 0);
});

test('RK2 并发交错留下的错位（今天记 1、昨天刚被补成 5）→ 校正今天为 6 并补 5 分', async () => {
  await wipe();
  await put(back(5), 1, 1); await put(back(4), 2, 2); await put(back(3), 3, 3); await put(back(2), 4, 4);
  await put(back(1), 5, 5); // 刚补出来的昨天
  await put(TODAY, 1, 1); // 今天抢在补签之前落的行
  const r = await reconcileStreaks(userId, NOW);
  assert.deepEqual(r.fixes, [{ dateKey: TODAY, from: 1, to: 6 }]);
  assert.equal(r.topUpPoints, 5, '今天实际只拿了 1 分，新位置该 6 分 → 欠 5（差额不封顶在 1）');
  assert.equal((await PointSigninModel.findOne({ userId: uid, dateKey: TODAY }).lean())?.streakDay, 6);
});

test('RK3 封顶 7 之后重排不产生差额（也不写空流水）', async () => {
  await wipe();
  await put(back(8), 1, 1); await put(back(7), 2, 2); await put(back(6), 3, 3);
  await put(back(5), 4, 4); await put(back(4), 5, 5); await put(back(3), 6, 6);
  await put(back(2), 7, 7); await put(back(1), 7, 7); // 昨天被补过，行还记着旧值 7
  const r = await reconcileStreaks(userId, NOW);
  assert.equal(r.fixes.length, 1, '只有昨天需要 7→8；今天没签，不落行也不校');
  assert.equal(r.fixes[0].dateKey, back(1));
  assert.equal(r.fixes[0].to, 8);
  assert.equal(r.topUpPoints, 0, '7→8 名义分不变，不该写空流水');
  assert.equal(await PointRecordModel.countDocuments({ userId: uid }), 0, 'reconcile 只校正不落库金额');
});

test('RK4 发差额：一条 makeup_topup 流水记在今天，重复调用不重复发', async () => {
  await wipe();
  await put(back(2), 4, 4); await put(back(1), 5, 5); await put(TODAY, 1, 1);
  const first = await creditStreakTopUp(userId, back(1), NOW);
  assert.equal(first, 5, '今天 1→6 位置分，欠 5');
  const recs = await PointRecordModel.find({ userId: uid }).sort({ createdAt: 1 }).lean();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].type, 'makeup_topup');
  assert.equal(recs[0].bizDate, TODAY);
  assert.equal(recs[0].idemKey, `${userId}:makeup_topup:${back(1)}`);
  assert.equal(recs[0].delta, 5);
  assert.equal(await creditStreakTopUp(userId, back(1), NOW), 0, '链条已正，第二次不该再发');
  assert.equal(await PointRecordModel.countDocuments({ userId: uid }), 1, '第二次调用不落新流水');
  assert.equal((await PointAccountModel.findOne({ userId: uid }).lean())?.balance, 5);
  // 账本不变式：Σ record.delta === account.balance === Σ 未过期 lot.remaining
  const account = await PointAccountModel.findOne({ userId: uid }).lean();
  const lotSum = (await PointLotModel.find({ userId: uid, expireAt: { $gt: NOW } }).lean())
    .reduce((s, l) => s + l.remaining, 0);
  assert.equal(recs.reduce((s, x) => s + x.delta, 0), account?.balance);
  assert.equal(lotSum, account?.balance, '余额必须有批次兜底（FIFO/过期口径不破）');
});

test('RK5 窗口外的历史行不参与校正（只看最近 7 格）', async () => {
  await wipe();
  await put(back(9), 1, 1); await put(back(8), 99, 7); // 明显偏离，但在窗口外
  const r = await reconcileStreaks(userId, NOW);
  assert.equal(r.fixes.find((f) => f.dateKey === back(8)), undefined);
});

test('RK6 空档断链：段首以库存值为锚（不回按 1 起），向下归位校行不扣已拿的分', async () => {
  await wipe();
  await put(back(5), 1, 1); await put(back(4), 2, 2); // 20-21 连续链 1..2
  await put(back(2), 4, 4); // 23：22 是空档 → 段首，库存值 4 当锚（D1：可信，不按 1 重开）
  await put(back(1), 9, 9); // 24：该顶到 23+1=5，记了 9 → 向下归位
  const r = await reconcileStreaks(userId, NOW);
  assert.deepEqual(r.fixes, [{ dateKey: back(1), from: 9, to: 5 }], '空档不被左侧残值 push（prev 归零），断口右段首不动');
  assert.equal(r.topUpPoints, 0, '向下归位不发分也不回扣');
  assert.equal((await PointSigninModel.findOne({ userId: uid, dateKey: back(2) }).lean())?.streakDay, 4);
  assert.equal((await PointSigninModel.findOne({ userId: uid, dateKey: back(1) }).lean())?.streakDay, 5);
});

test('RK7 差额按 trigger 各发一份：幂等键 makeup_topup 含 trigger，两笔全额入账', async () => {
  await wipe();
  await put(back(5), 1, 1); await put(back(4), 2, 2); await put(back(3), 3, 3); // 20..22 链
  await put(back(1), 1, 1); await put(TODAY, 2, 2); // 23 空档：24/今天按新链落了 1/2
  await put(back(2), 4, 4); // 补签 23：接在 22 之后 → 第 4 天，下游要重排
  assert.equal(await creditStreakTopUp(userId, back(2), NOW), 8, '24 1→5 欠 4、今天 2→6 欠 4，全额 8');
  await put(back(6), 1, 1); // 再补签 19：整条链右移一格
  assert.equal(await creditStreakTopUp(userId, back(6), NOW), 6, '20..25 各 +1 档 → 6 天欠 6 分');
  assert.equal(await creditStreakTopUp(userId, back(6), NOW), 0, '链条已正，同 trigger 重放不再发');
  const recs = await PointRecordModel.find({ userId: uid }).sort({ createdAt: 1 }).lean();
  assert.equal(recs.length, 2);
  assert.deepEqual(recs.map((x) => x.idemKey).sort(), [
    `${userId}:makeup_topup:${back(2)}`, `${userId}:makeup_topup:${back(6)}`,
  ].sort());
  // 账本不变式：Σ record.delta === account.balance === Σ 未过期 lot.remaining
  const account = await PointAccountModel.findOne({ userId: uid }).lean();
  assert.equal(recs.reduce((s, x) => s + x.delta, 0), 14);
  assert.equal(account?.balance, 14);
  const lotSum = (await PointLotModel.find({ userId: uid, expireAt: { $gt: NOW } }).lean())
    .reduce((s, l) => s + l.remaining, 0);
  assert.equal(lotSum, 14);
});

test('RK8 读后写前的并发改动不被覆盖：CAS 条件 streakDay=读到的旧值', async (t) => {
  await wipe();
  await put(back(5), 1, 1); await put(back(4), 2, 2); await put(back(3), 3, 3); await put(back(2), 4, 4);
  await put(back(1), 5, 5); await put(TODAY, 1, 1); // RK2 同款错位，只有今天一行会被写
  type UpdateFn = (...args: unknown[]) => Promise<unknown>;
  const realUpdate = PointSigninModel.updateOne.bind(PointSigninModel) as unknown as UpdateFn;
  let hijacked = false;
  t.mock.method(PointSigninModel as unknown as { updateOne: UpdateFn }, 'updateOne', async (...args: unknown[]) => {
    const filter = args[0] as { dateKey?: string };
    if (!hijacked && filter.dateKey === TODAY) {
      hijacked = true;
      // 并发另一路抢在 CAS 落笔前把今天这行动了 +1（走集合原语，绕开本 mock）
      await PointSigninModel.collection.updateOne(
        { userId: uid, dateKey: TODAY }, { $inc: { streakDay: 1 } },
      );
    }
    return realUpdate(...args);
  });
  const r = await reconcileStreaks(userId, NOW);
  assert.equal(hijacked, true, '并发注入确实发生在读与写之间');
  assert.deepEqual(r.fixes, [{ dateKey: TODAY, from: 1, to: 6 }]);
  assert.equal(
    (await PointSigninModel.findOne({ userId: uid, dateKey: TODAY }).lean())?.streakDay, 2,
    'CAS 条件不再匹配 → 本次不写，对方成果保住，留给下一次写路径再校',
  );
});
