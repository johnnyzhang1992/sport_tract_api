import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { config } from '../src/config/index.js';
import { PointAccountModel, PointDailyModel, PointLotModel, PointRecordModel } from '../src/models/point.model.js';
import { creditPoints, debitPoints, settleExpired, getBalance, listPointRecords, reverseDebit } from '../src/services/points-ledger.js';

const userId = String(new Types.ObjectId());
const uid = new Types.ObjectId(userId);
const NOW = Date.UTC(2026, 9, 24, 2, 0, 0); // 2026-10-24 10:00 BJ

// 幂等键带本次运行后缀：万一进程被中途杀掉、after 没跑到，残留记录也不会让下一轮的首发被当成「重复」。
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const key = (s: string) => `ledger:${RUN}:${s}`;

// FIFO / 不变量 / 余额闸门用独立用户，避免受前面用例的批次结构影响
const fifoUser = String(new Types.ObjectId());
const fifoUid = new Types.ObjectId(fifoUser);
const invariantUser = String(new Types.ObjectId());
const invariantUid = new Types.ObjectId(invariantUser);
const clampUser = String(new Types.ObjectId());
const clampUid = new Types.ObjectId(clampUser);
const ALL_USER_IDS = [uid, fifoUid, invariantUid, clampUid];

/** 不变量：Σ批次 remaining === 账户余额，且没有负剩余批次 */
async function assertLotsMatchBalance(userIdStr: string) {
  const account = await PointAccountModel.findOne({ userId: new Types.ObjectId(userIdStr) }).lean();
  const lots = await PointLotModel.find({ userId: new Types.ObjectId(userIdStr) }).lean();
  assert.equal(lots.reduce((sum, lot) => sum + lot.remaining, 0), account?.balance ?? 0);
  assert.ok(lots.every((lot) => lot.remaining >= 0), '批次 remaining 不允许为负');
  return account?.balance ?? 0;
}

before(async () => {
  // 单文件直跑不经过 app 的 mongodb 插件，这里自行连接；不连时 Model.init() 会一直 buffering
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  // 唯一索引是异步建的，等 init 完成后再断言幂等行为
  await Promise.all([PointAccountModel.init(), PointLotModel.init(), PointRecordModel.init()]);
});
after(async () => {
  await Promise.all([
    PointAccountModel.deleteMany({ userId: { $in: ALL_USER_IDS } }),
    PointLotModel.deleteMany({ userId: { $in: ALL_USER_IDS } }),
    PointRecordModel.deleteMany({ userId: { $in: ALL_USER_IDS } }),
  ]);
  await mongoose.disconnect().catch(() => {});
});

test('PL1 发放幂等：同 idemKey 只加一次', async () => {
  const input = { type: 'signin', title: '签到', points: 7, bizDate: '2026-10-24', idemKey: key('signin') };
  assert.equal((await creditPoints(userId, input, NOW)).credited, 7);
  const again = await creditPoints(userId, input, NOW);
  assert.equal(again.duplicated, true);
  assert.equal(again.credited, 0);
  assert.equal(await getBalance(userId, NOW), 7);
});

test('PL2 每日上限 100：超出部分不入账', async () => {
  // 上限按 bizDate 计；2026-10-24 已被 PL1 占用 7 分，这里换到前一天单独验上限算术
  const first = await creditPoints(userId, { type: 'admin', title: '测试', points: 95, bizDate: '2026-10-23', idemKey: key('cap:95') }, NOW);
  assert.equal(first.credited, 95);
  const r = await creditPoints(userId, { type: 'admin', title: '测试', points: 10, bizDate: '2026-10-23', idemKey: key('cap:10') }, NOW);
  assert.equal(r.credited, 5);
  assert.equal(r.capped, true);
  assert.equal(await getBalance(userId, NOW), 107);
  // 当天额度已满：再发 0 分，且不写明细
  const more = await creditPoints(userId, { type: 'admin', title: '测试', points: 10, bizDate: '2026-10-23', idemKey: key('cap:more') }, NOW);
  assert.equal(more.credited, 0);
  assert.equal(more.capped, true);
  assert.equal(await getBalance(userId, NOW), 107);
});

test('PL3 扣减余额不足报 400，正常扣减写明细', async () => {
  await assert.rejects(
    debitPoints(userId, { type: 'exchange', title: '兑换', points: 999, bizDate: '2026-10-24', idemKey: key('ex:fail') }, NOW),
    /积分不足/,
  );
  const r = await debitPoints(userId, { type: 'exchange', title: '兑换补签卡', points: 100, bizDate: '2026-10-24', idemKey: key('ex:100') }, NOW);
  assert.equal(r.balance, 7);
  // 批次扣减后：所有批次 remaining 之和 = 余额，且没有任何批次被扣成负数
  const lots = await PointLotModel.find({ userId: uid }).lean();
  assert.equal(lots.reduce((sum, lot) => sum + lot.remaining, 0), 7);
  assert.ok(lots.every((lot) => lot.remaining >= 0 && lot.remaining <= lot.earned));
});

test('PL4 过期批次结算：余额扣减并写 expire 明细', async () => {
  await creditPoints(userId, { type: 'signin', title: '过期测试', points: 10, bizDate: '2025-01-01', idemKey: key('exp:10') }, Date.UTC(2025, 0, 1));
  await settleExpired(userId, Date.UTC(2027, 0, 1)); // 2027-01-01 BJ，2026 年底已过
  assert.equal(await getBalance(userId, NOW), 7);
  const rows = await PointRecordModel.find({ userId: uid, type: 'expire' }).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].delta, -10);
});

test('PL5 明细按时间倒序且带余额', async () => {
  const r = await listPointRecords(userId, 1, 20, NOW);
  assert.equal(r.balance, 7);
  assert.ok(r.items.length >= 3);
  assert.equal(r.items[0].balanceAfter, 7);
  // 明细 6 条：签到 7 / 95 / 5 / 兑换 -100 / 过期批次入账 10 / 过期 -10
  assert.equal(r.total, 6);
  for (let i = 1; i < r.items.length; i += 1) {
    assert.ok(r.items[i - 1].createdAt >= r.items[i].createdAt);
  }
  // 需求 §6.3：Σdelta（含 expire）恒等于当前余额
  const [agg] = await PointRecordModel.aggregate<{ sum: number }>([
    { $match: { userId: uid } },
    { $group: { _id: null, sum: { $sum: '$delta' } } },
  ]);
  assert.equal(agg.sum, r.balance);
});

test('PL5b 明细类型筛选：type=exchange 只返回兑换记录（兑换记录入口）', async () => {
  const r = await listPointRecords(userId, 1, 20, NOW, 'exchange');
  assert.ok(r.items.length >= 1, '主用户应有兑换记录');
  assert.ok(r.items.every((it) => it.type === 'exchange'), '筛选后必须全是 exchange');
  // 全量对照：确实混有非 exchange 类型，说明筛选真的生效
  const all = await listPointRecords(userId, 1, 20, NOW);
  assert.ok(all.items.some((it) => it.type !== 'exchange'));
  // 不存在的类型：返回空但不报错
  const none = await listPointRecords(userId, 1, 20, NOW, 'no_such_type');
  assert.equal(none.items.length, 0);
  assert.equal(none.total, 0);
});

test('PL6 扣减幂等：同 idemKey 只扣一次，重放返回同一条明细', async () => {
  const input = { type: 'exchange', title: '兑换', points: 3, bizDate: '2026-10-24', idemKey: key('ex:replay') };
  const first = await debitPoints(userId, input, NOW);
  const again = await debitPoints(userId, input, NOW);
  assert.equal(again.recordId, first.recordId);
  assert.equal(again.balance, first.balance);
  assert.equal(await getBalance(userId, NOW), first.balance);
  const rows = await PointRecordModel.find({ idemKey: input.idemKey }).lean();
  assert.equal(rows.length, 1);
});

test('PL7 批次 FIFO：先到期的批次先扣', async () => {
  const input = (points: number, bizDate: string, idemKey: string) => ({ type: 'admin', title: 'FIFO', points, bizDate, idemKey });
  // 两批分到期时间不同：2025 年入账 → 2026 年底过期；2026 年入账 → 2027 年底过期
  await creditPoints(fifoUser, input(5, '2025-06-01', key('fifo:old')), Date.UTC(2025, 5, 1));
  await creditPoints(fifoUser, input(5, '2026-10-24', key('fifo:new')), NOW);

  const before = await PointLotModel.find({ userId: fifoUid }).sort({ expireAt: 1 }).lean();
  assert.equal(before.length, 2);
  assert.ok(before[0].expireAt < before[1].expireAt, '前置条件：两批到期时间必须不同，否则排序退化看不出 FIFO');

  // 扣 3：只应从先到期批次扣
  await debitPoints(fifoUser, input(3, '2026-10-24', key('fifo:debit3')), NOW);
  const after3 = await PointLotModel.find({ userId: fifoUid }).sort({ expireAt: 1 }).lean();
  assert.equal(after3[0].remaining, 2, '先到期批次应先被扣（5-3）');
  assert.equal(after3[1].remaining, 5, '后到期批次不应被触碰');

  // 再扣 4：先把先到期批次扣完（2），剩余 2 从后到期批次扣
  await debitPoints(fifoUser, input(4, '2026-10-24', key('fifo:debit4')), NOW);
  const after7 = await PointLotModel.find({ userId: fifoUid }).sort({ expireAt: 1 }).lean();
  assert.equal(after7[0].remaining, 0);
  assert.equal(after7[1].remaining, 3);
  assert.equal(await getBalance(fifoUser, NOW), 3);
  assert.equal(await assertLotsMatchBalance(fifoUser), 3);
});

test('PL8 不变量：每次发放/扣减后 Σ批次remaining === 账户余额', async () => {
  await creditPoints(invariantUser, { type: 'signin', title: '签到', points: 10, bizDate: '2026-10-24', idemKey: key('inv:10') }, NOW);
  assert.equal(await assertLotsMatchBalance(invariantUser), 10);

  await debitPoints(invariantUser, { type: 'exchange', title: '兑换', points: 4, bizDate: '2026-10-24', idemKey: key('inv:debit4') }, NOW);
  assert.equal(await assertLotsMatchBalance(invariantUser), 6);

  // 新批次入账后再扣，跨批次也要守恒
  await creditPoints(invariantUser, { type: 'admin', title: '补发', points: 3, bizDate: '2026-10-25', idemKey: key('inv:3') }, NOW);
  assert.equal(await assertLotsMatchBalance(invariantUser), 9);
  await debitPoints(invariantUser, { type: 'exchange', title: '兑换', points: 8, bizDate: '2026-10-24', idemKey: key('inv:debit8') }, NOW);
  assert.equal(await assertLotsMatchBalance(invariantUser), 1);
  // Σ明细 delta（含 expire）也等于余额
  const [agg] = await PointRecordModel.aggregate<{ sum: number }>([
    { $match: { userId: invariantUid } },
    { $group: { _id: null, sum: { $sum: '$delta' } } },
  ]);
  assert.equal(agg.sum, 1);
});

test('PL9 余额闸门：孤儿批次（批次剩余 > 余额）过期不会把余额扣成负数', async () => {
  // 正常入账 10（2026 年底过期）
  await creditPoints(clampUser, { type: 'signin', title: '签到', points: 10, bizDate: '2025-01-01', idemKey: key('clamp:10') }, Date.UTC(2025, 0, 1));
  // 人为造孤儿批次：50 分批次，但账户里没有对应余额（模拟「余额被并发扣减、批次没跟上」的脏数据）
  await PointLotModel.create({
    userId: clampUid,
    recordId: new Types.ObjectId(),
    earned: 50,
    remaining: 50,
    earnedAt: Date.UTC(2025, 0, 1),
    expireAt: Date.UTC(2025, 0, 1),
  });

  await settleExpired(clampUser, NOW);

  const account = await PointAccountModel.findOne({ userId: clampUid }).lean();
  assert.equal(account?.balance, 0, '余额封顶扣减：10 - 10 = 0，不会变成 -40');
  const expires = await PointRecordModel.find({ userId: clampUid, type: 'expire' }).lean();
  assert.equal(expires.length, 1, '孤儿批次无余额可扣，不写明细');
  assert.equal(expires[0].delta, -10, 'expire 只记余额能覆盖的部分');
  assert.equal(expires[0].balanceAfter, 0);
  // 孤儿批次清零核销；正常批次未到期，remaining 不动
  const orphan = await PointLotModel.findOne({ userId: clampUid, earned: 50 }).lean();
  assert.equal(orphan?.remaining, 0);
  const normal = await PointLotModel.findOne({ userId: clampUid, earned: 10 }).lean();
  assert.equal(normal?.remaining, 10);
  assert.ok((account?.balance ?? 0) >= 0);
  // 余额为 0 时扣 1 分仍然报「积分不足」，不会白拿孤儿批次里的分
  await assert.rejects(
    debitPoints(clampUser, { type: 'exchange', title: '兑换', points: 1, bizDate: '2026-10-24', idemKey: key('clamp:debit') }, NOW),
    /积分不足/,
  );
});

test('PL10 扣减重放只认扣减明细：发放用过的 idemKey 不会被当成扣减重放', async () => {
  const reusedKey = key('replay:credit');
  await creditPoints(userId, { type: 'admin', title: '发放', points: 2, bizDate: '2026-10-24', idemKey: reusedKey }, NOW);
  const balanceBefore = await getBalance(userId, NOW);

  // 旧实现会把这条正数明细当成扣减重放并「成功」返回；现在应撞唯一键失败并回滚余额
  await assert.rejects(
    debitPoints(userId, { type: 'exchange', title: '扣减', points: 1, bizDate: '2026-10-24', idemKey: reusedKey }, NOW),
    (e: unknown) => (e as { code?: number } | null)?.code === 11000,
  );
  assert.equal(await getBalance(userId, NOW), balanceBefore, '失败的扣减必须回滚余额');
  const rows = await PointRecordModel.find({ idemKey: reusedKey }).lean();
  assert.equal(rows.length, 1);
  assert.ok(rows[0].delta > 0, '库里只有原来那条发放明细');
  assert.equal(await assertLotsMatchBalance(userId), balanceBefore);
});

test('PL11 reverseDebit：余额/totalSpent/批次复原，补偿行成对且幂等；重放不退款', async (t) => {
  const u = new Types.ObjectId();
  const us = String(u);
  t.after(async () => {
    await Promise.all([
      PointAccountModel.deleteMany({ userId: u }),
      PointLotModel.deleteMany({ userId: u }),
      PointRecordModel.deleteMany({ userId: u }),
    ]);
  });
  await creditPoints(us, { type: 'signin', title: '签到', points: 100, bizDate: '2026-10-24', idemKey: key('rev:seed') }, NOW);
  await creditPoints(us, { type: 'signin', title: '签到', points: 60, bizDate: '2026-10-25', idemKey: key('rev:seed2') }, NOW);
  const beforeLots = await PointLotModel.find({ userId: u }).sort({ _id: 1 }).lean();

  const d = await debitPoints(us, {
    type: 'exchange', title: '兑换补签卡', points: 70, bizDate: '2026-10-25', idemKey: key('rev:debit'),
  }, NOW);
  assert.equal(d.balance, 90);
  assert.equal(d.duplicated, false);

  const restored = await reverseDebit(us, d, '2026-10-25', NOW);
  assert.equal(restored, 160);
  const acc = await PointAccountModel.findOne({ userId: u }).lean();
  assert.equal(acc?.balance, 160);
  assert.equal(acc?.totalSpent, 0, 'totalSpent 一起回滚');
  const lots = await PointLotModel.find({ userId: u }).sort({ _id: 1 }).lean();
  assert.deepEqual(lots.map((l) => l.remaining), beforeLots.map((l) => l.remaining), '批次原路复原');
  // 补偿对：原扣分行降级 + 一条正数补偿，两个类型都不在 exchange / rollback 口径里
  assert.equal(await PointRecordModel.countDocuments({ userId: u, type: 'exchange' }), 0);
  assert.equal(await PointRecordModel.countDocuments({ userId: u, type: 'exchange_reversed' }), 1);
  assert.equal(await PointRecordModel.countDocuments({ userId: u, type: 'exchange_refund' }), 1);
  const [sum] = await PointRecordModel.aggregate<{ sum: number }>([
    { $match: { userId: u } }, { $group: { _id: null, sum: { $sum: '$delta' } } },
  ]);
  assert.equal(sum.sum, 160, 'Σdelta 仍等于余额');

  // 幂等：同一 recordId 再撤一次，不再加钱/不再写第二条补偿
  assert.equal(await reverseDebit(us, d, '2026-10-25', NOW), 160);
  assert.equal(await PointRecordModel.countDocuments({ userId: u, type: 'exchange_refund' }), 1);

  // 重放（duplicated=true）绝不退款：只返回当时的余额
  const d2 = await debitPoints(us, {
    type: 'exchange', title: '再兑换', points: 30, bizDate: '2026-10-25', idemKey: key('rev:debit2'),
  }, NOW);
  const replay = await debitPoints(us, {
    type: 'exchange', title: '再兑换', points: 30, bizDate: '2026-10-25', idemKey: key('rev:debit2'),
  }, NOW);
  assert.equal(replay.duplicated, true);
  assert.equal(await reverseDebit(us, replay, '2026-10-25', NOW), replay.balance,
    '重放没有真实扣分，补偿必须跳过');
  assert.equal((await PointAccountModel.findOne({ userId: u }).lean())?.balance, d2.balance);
  assert.equal(await PointRecordModel.countDocuments({ userId: u, type: 'exchange_refund' }), 1);
});

/* ====================================================================
 * Task 7 前置改造（榜单结算要用到的两件事）：
 * - CR1：CreditResult.recordId —— 结算靠它把台账翻成 credited 并回指流水；
 *   「重复分支回已有行 id、截断/零分回 null」是钉死的形状约定，
 *   结算侧**不许**再按 idemKey 反查（find-then-insert 同款竞态）。
 * - CR2：ignoreDailyCap —— spec §4.2「不占每日上限 100」：年榜 500 一笔不能被
 *   DAILY_CAP 截断，也不得挤占 pointdaily 的当日投放计数。默认 false＝现有行为逐字节不动。
 * ================================================================== */

const crUser = String(new Types.ObjectId());
ALL_USER_IDS.push(new Types.ObjectId(crUser));

test('CR1 CreditResult.recordId：成功路径给新建流水 id，重复路径给已有行 id，截断/零分为 null', async () => {
  const input = { type: 'board_reward', title: '骑行·周榜第 1 名·20261207周', points: 50, bizDate: '2026-11-01', idemKey: key('cr1') };
  const ok = await creditPoints(crUser, input, NOW);
  assert.equal(ok.credited, 50);
  assert.ok(ok.recordId && /^[0-9a-f]{24}$/.test(ok.recordId), '成功发放必须回 recordId');
  const rec = await PointRecordModel.findOne({ idemKey: key('cr1') }).lean();
  assert.equal(ok.recordId, String(rec?._id), 'recordId 就是那条流水的 _id');
  const dup = await creditPoints(crUser, input, NOW);
  assert.equal(dup.duplicated, true);
  assert.equal(dup.recordId, ok.recordId, '重复分支要带回已有流水的 id：结算据此补翻牌，而不是反查 idemKey');
  // 当日额度（100）已被 cr1+bizDate 的 50 用掉一半以上后打满，拿「截到 0」的分支验 null
  await creditPoints(crUser, { type: 'admin', title: '占满', points: 100, bizDate: '2026-11-02', idemKey: key('cr1:full') }, NOW);
  const zero = await creditPoints(crUser, { type: 'admin', title: '超额', points: 10, bizDate: '2026-11-02', idemKey: key('cr1:over') }, NOW);
  assert.equal(zero.credited, 0);
  assert.equal(zero.capped, true);
  assert.equal(zero.recordId, null, '零分/截断到 0 的路径没有流水，recordId 只能是 null');
  // 部分截断（credited>0）的路径同样有真实流水，必须回它的 id（settle 守卫靠 credited!==points 拒翻牌，
  // 而"这半笔钱落在哪条行上"要能从结果直接拿到）
  await creditPoints(crUser, { type: 'admin', title: '再占满', points: 100, bizDate: '2026-11-03', idemKey: key('cr1:full3') }, NOW);
  const part = await creditPoints(crUser, { type: 'admin', title: '截一半', points: 30, bizDate: '2026-11-03', idemKey: key('cr1:part') }, NOW);
  assert.equal(part.credited, 0); // 100 满额：截到 0
  assert.equal(part.recordId, null);
});

test('CR2 ignoreDailyCap：不截断、不进当日计数器，且常规通道的上限原样生效', async () => {
  const d = '2026-11-04';
  const fill = await creditPoints(crUser, { type: 'admin', title: '占满当日', points: 100, bizDate: d, idemKey: key('cr2:fill') }, NOW);
  assert.equal(fill.credited, 100);
  const board = await creditPoints(crUser, {
    type: 'board_reward', title: '骑行·年榜第 1 名·2027年', points: 500, bizDate: d, idemKey: key('cr2:board'), ignoreDailyCap: true,
  }, NOW);
  assert.equal(board.credited, 500, '榜单发放不占每日上限：500 一笔全额入账');
  assert.equal(board.capped, false);
  assert.ok(board.recordId, '成功路径照常回 recordId');
  assert.equal(await getBalance(crUser, NOW), 850, 'CR1 累计 50+100(11-02)+100(11-03) + CR2 的 100+500');
  const daily = await PointDailyModel.findOne({ userId: new Types.ObjectId(crUser), bizDate: d }).lean();
  assert.equal(daily?.earned, 100, 'ignoreDailyCap 的这笔不进当日投放计数器');
  // 上限本身没有被"抬"：常规通道当天还是 0 余量
  const after = await creditPoints(crUser, { type: 'admin', title: '常规', points: 1, bizDate: d, idemKey: key('cr2:after') }, NOW);
  assert.equal(after.credited, 0);
  assert.equal(after.capped, true);
});
