import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { config } from '../src/config/index.js';
import { PointAccountModel, PointLotModel, PointRecordModel } from '../src/models/point.model.js';
import { creditPoints, debitPoints, settleExpired, getBalance, listPointRecords } from '../src/services/points-ledger.js';

const userId = String(new Types.ObjectId());
const uid = new Types.ObjectId(userId);
const NOW = Date.UTC(2026, 9, 24, 2, 0, 0); // 2026-10-24 10:00 BJ

// 幂等键带本次运行后缀：万一进程被中途杀掉、after 没跑到，残留记录也不会让下一轮的首发被当成「重复」。
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const key = (s: string) => `ledger:${RUN}:${s}`;

before(async () => {
  // 单文件直跑不经过 app 的 mongodb 插件，这里自行连接；不连时 Model.init() 会一直 buffering
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  // 唯一索引是异步建的，等 init 完成后再断言幂等行为
  await Promise.all([PointAccountModel.init(), PointLotModel.init(), PointRecordModel.init()]);
});
after(async () => {
  await Promise.all([
    PointAccountModel.deleteMany({ userId: uid }),
    PointLotModel.deleteMany({ userId: uid }),
    PointRecordModel.deleteMany({ userId: uid }),
  ]);
  await mongoose.disconnect().catch(() => {});
});

test('PL1 发放幂等：同 idemKey 只加一次', async () => {
  const input = { type: 'signin', title: '签到', points: 7, bizDate: '2026-10-24', idemKey: key('signin') };
  assert.equal((await creditPoints(userId, input, NOW)).credited, 7);
  const again = await creditPoints(userId, input, NOW);
  assert.equal(again.duplicated, true);
  assert.equal(again.credited, 0);
  assert.equal(await getBalance(userId), 7);
});

test('PL2 每日上限 100：超出部分不入账', async () => {
  // 上限按 bizDate 计；2026-10-24 已被 PL1 占用 7 分，这里换到前一天单独验上限算术
  const first = await creditPoints(userId, { type: 'admin', title: '测试', points: 95, bizDate: '2026-10-23', idemKey: key('cap:95') }, NOW);
  assert.equal(first.credited, 95);
  const r = await creditPoints(userId, { type: 'admin', title: '测试', points: 10, bizDate: '2026-10-23', idemKey: key('cap:10') }, NOW);
  assert.equal(r.credited, 5);
  assert.equal(r.capped, true);
  assert.equal(await getBalance(userId), 107);
  // 当天额度已满：再发 0 分，且不写明细
  const more = await creditPoints(userId, { type: 'admin', title: '测试', points: 10, bizDate: '2026-10-23', idemKey: key('cap:more') }, NOW);
  assert.equal(more.credited, 0);
  assert.equal(more.capped, true);
  assert.equal(await getBalance(userId), 107);
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
  assert.equal(await getBalance(userId), 7);
  const rows = await PointRecordModel.find({ userId: uid, type: 'expire' }).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].delta, -10);
});

test('PL5 明细按时间倒序且带余额', async () => {
  const r = await listPointRecords(userId, 1, 20);
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

test('PL6 扣减幂等：同 idemKey 只扣一次，重放返回同一条明细', async () => {
  const input = { type: 'exchange', title: '兑换', points: 3, bizDate: '2026-10-24', idemKey: key('ex:replay') };
  const first = await debitPoints(userId, input, NOW);
  const again = await debitPoints(userId, input, NOW);
  assert.equal(again.recordId, first.recordId);
  assert.equal(again.balance, first.balance);
  assert.equal(await getBalance(userId), first.balance);
  const rows = await PointRecordModel.find({ idemKey: input.idemKey }).lean();
  assert.equal(rows.length, 1);
});
