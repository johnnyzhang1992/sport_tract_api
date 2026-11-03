/**
 * 发货、退款与 iOS 问询（spec §7.2、§7.4、§7.5、§10.2、§10.4、§10.5、§10.6）。
 *
 * 三条最要紧的：
 * - 幂等：同一 wxOrderId 重复推送只发一次货、只发一条通知（DL-2/2b）；
 * - 「任何一类异常都不许静默成功」：陌生单吞掉但留痕（DL-3），反查不到用户要重试（DL-4）；
 * - 退款方案 a 的核心断言：**改成全额退款，权益仍截断到当天**（RF-3），且尚未生效的顺延单退款
 *   不许把会员到期往后推一整段（RF-5）。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/xpay-deliver.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { config } from '../src/config/index.js';
import { XpayOrderModel } from '../src/models/xpay-order.model.js';
import { UserModel } from '../src/models/user.model.js';
import { NotificationModel } from '../src/models/notification.model.js';
import {
  handleXpayNotify, deliverOrder, applyRefund, answerIosRefundQuery, lazySyncOrders, suggestRefundFeeFen,
} from '../src/services/xpay-deliver.js';
import { __setEntitlementFetchersForTest, entitlementsOf } from '../src/services/entitlements.js';
import { __setXpayFetcherForTest } from '../src/services/xpay-api.js';

const DAY = 86_400_000;
const RUN = Date.now().toString(36);
const OPENID = `dlt_test_${RUN}`;
const allPerks = { adFree: true, exportBundle: true, photoQuota: 300, subscribeNotice: true };
let uid: Types.ObjectId;
let seq = 0;

async function mkOrder(over: Record<string, unknown> = {}) {
  seq += 1;
  return XpayOrderModel.create({
    outTradeNo: `DLT${RUN}${String(seq).padStart(3, '0')}`.slice(0, 32),
    userId: uid, openid: OPENID,
    productKey: 'month_card', name: '会员月卡', priceFen: 199, durationDays: 30,
    perksSnapshot: allPerks,
    status: 'created', attach: '', channel: 'android', ...over,
  });
}

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  const u = await UserModel.findOneAndUpdate(
    { openid: OPENID },
    { $set: { nickname: 'dlt 测试' }, $setOnInsert: { openid: OPENID } },
    { upsert: true, new: true, lean: true },
  );
  uid = (u as { _id: Types.ObjectId })._id;
});
beforeEach(async () => {
  await XpayOrderModel.deleteMany({ openid: OPENID });
  await NotificationModel.deleteMany({ userId: uid, dedupeKey: { $regex: '^xpay_deliver:' } });
  __setEntitlementFetchersForTest(null);
});
after(async () => {
  await XpayOrderModel.deleteMany({ openid: OPENID });
  await NotificationModel.deleteMany({ userId: uid, dedupeKey: { $regex: '^xpay_deliver:' } });
  await UserModel.deleteOne({ _id: uid });
  __setXpayFetcherForTest(null);
  __setEntitlementFetchersForTest(null);
  await mongoose.disconnect().catch(() => {});
});

test('DL-1 支付成功推送 → 发货、落区间快照、回 ErrCode 0、发一条定向通知', async () => {
  const o = await mkOrder();
  // 通知入口发货前要复核查单（推送不可信），夹具返回已支付
  __setXpayFetcherForTest(async (api) => {
    assert.equal(api, 'query_order');
    return { errcode: 0, order: { status: 3, left_fee: 199, order_no: "wx1" } };
  });
  const now = Date.now();
  const r = await handleXpayNotify('xpay_goods_deliver_notify', {
    openid: OPENID, out_trade_no: o.outTradeNo, WeChatPayInfo: { MchOrderNo: 'wx1', paid_dt: now },
  });
  assert.equal(r.ok, true);
  const row = await XpayOrderModel.findById(o._id).lean();
  assert.equal(row?.status, 'delivered');
  assert.equal(row?.wxOrderId, 'wx1');
  assert.equal(row?.periodStart, now, '无历史区间时从支付时刻起算');
  assert.equal(row?.periodEnd, now + 30 * DAY);
  assert.ok(row?.notifiedAt, '通知出箱要留痕');
  const n = await NotificationModel.find({ userId: uid, dedupeKey: { $regex: '^xpay_deliver:' } }).lean();
  assert.equal(n.length, 1);
  assert.equal(n[0].published, true, '定向通知要已发布，否则用户看不见');
  assert.match(String(n[0].content), /会员月卡已生效/, '通知正文用批准稿 MC-16');
});

test('DL-2 幂等：同一 wxOrderId 第二次推送不再发货、不再发通知', async () => {
  const o = await mkOrder({
    status: 'delivered', wxOrderId: 'wx2', periodStart: 1_700_000_000_000, periodEnd: 1_700_000_000_000 + 30 * DAY, notifiedAt: 1,
  });
  const r = await deliverOrder({ outTradeNo: o.outTradeNo, wxOrderId: 'wx2', paidAt: Date.now() });
  assert.equal(r.ok, true);
  const row = await XpayOrderModel.findById(o._id).lean();
  assert.equal(row?.periodStart, 1_700_000_000_000, '重复推送不许把区间往后挪');
  assert.equal(await NotificationModel.countDocuments({ userId: uid, dedupeKey: 'xpay_deliver:wx2' }), 0);
});

test('DL-2b 并发两路推送同一个人：只有一笔区间被写入（按用户串行 + CAS 双保险）', async () => {
  const o = await mkOrder();
  const [a, b] = await Promise.all([
    deliverOrder({ outTradeNo: o.outTradeNo, wxOrderId: 'wxA', paidAt: Date.now() }),
    deliverOrder({ outTradeNo: o.outTradeNo, wxOrderId: 'wxB', paidAt: Date.now() }),
  ]);
  assert.ok(a.ok && b.ok);
  const row = await XpayOrderModel.findById(o._id).lean();
  assert.equal(row?.status, 'delivered');
  assert.ok(row?.wxOrderId === 'wxA' || row?.wxOrderId === 'wxB');
  assert.equal((row?.periodEnd ?? 0) - (row?.periodStart ?? 0), 30 * DAY, '区间只有一个起点（没把 30 天算成 60 天）');
});

test('DL-3 陌生单（库里没有这个 outTradeNo）→ 吞掉（ok）但不新建行', async () => {
  const before = await XpayOrderModel.countDocuments({ openid: OPENID });
  const r = await handleXpayNotify('xpay_goods_deliver_notify', {
    openid: OPENID, out_trade_no: `DLT_NO_SUCH_${RUN}`, WeChatPayInfo: { MchOrderNo: 'wxZ' },
  });
  assert.equal(r.ok, true, '陌生单重试改变不了结果，要止住 15 次重试');
  assert.equal(r.dropNoRetry, true, 'Task 8 的 dropNoRetry 分支就是为它存在的');
  assert.equal(await XpayOrderModel.countDocuments({ openid: OPENID }), before, '绝不凭空造一行');
});

test('DL-4 单存在但反查不到用户 → 回非 0 让微信重试，并累加 deliverAttempts', async () => {
  const ghost = new Types.ObjectId(); // 不存在的用户
  const o = await mkOrder({ userId: ghost });
  const r = await deliverOrder({ outTradeNo: o.outTradeNo, wxOrderId: 'wxQ', paidAt: Date.now() });
  assert.equal(r.ok, false, '不能静默成功（付了钱没权益比收不到推送更糟）');
  const row = await XpayOrderModel.findById(o._id).lean();
  assert.equal(row?.status, 'created');
  assert.ok((row?.deliverAttempts ?? 0) >= 1);
});

test('DL-5 顺延：已有会员到 T 时新单从 T 起算（不是从今天）', async () => {
  const T = Date.now() + 10 * DAY;
  await mkOrder({ status: 'delivered', wxOrderId: 'wx_first', periodStart: Date.now() - DAY, periodEnd: T });
  const o = await mkOrder();
  await deliverOrder({ outTradeNo: o.outTradeNo, wxOrderId: 'wx_second', paidAt: Date.now() });
  const row = await XpayOrderModel.findById(o._id).lean();
  assert.equal(row?.periodStart, T);
  assert.equal(row?.periodEnd, T + 30 * DAY);
  const e = await entitlementsOf(String(uid), Date.now());
  assert.equal(e.memberUntil, T + 30 * DAY, '两笔串起来：会员到期＝第二笔末尾');
});

test('DL-6 空窗不补偿：上一笔已过期 60 天再买，从今天起算 30 天', async () => {
  const past = Date.now() - 90 * DAY;
  await mkOrder({ status: 'delivered', wxOrderId: 'wx_old', periodStart: past - 30 * DAY, periodEnd: past });
  const o = await mkOrder();
  const now = Date.now();
  await deliverOrder({ outTradeNo: o.outTradeNo, wxOrderId: 'wx_new', paidAt: now });
  const row = await XpayOrderModel.findById(o._id).lean();
  assert.equal(row?.periodStart, now);
  assert.equal(row?.periodEnd, now + 30 * DAY);
});

test('DL-7 iOS 问询四档阈值各一条（spec §7.4），且应答不依赖任何外部 HTTP', async () => {
  __setXpayFetcherForTest(async () => { throw new Error('不该发生网络调用'); });
  assert.deepEqual(
    await answerIosRefundQuery({ out_trade_no: 'NOPE_0000000', openid: OPENID }),
    { result_code: 0, evidence: '未查到该订单，建议退款' },
  );
  const un = await mkOrder();
  assert.equal((await answerIosRefundQuery({ out_trade_no: un.outTradeNo })).result_code, 0, '未发货放过');
  const fresh = await mkOrder({ status: 'delivered', wxOrderId: 'wxfresh', periodStart: Date.now() - 12 * 3600_000, periodEnd: Date.now() + 29 * DAY });
  const a3 = await answerIosRefundQuery({ out_trade_no: fresh.outTradeNo });
  assert.equal(a3.result_code, 0, '已用 ≤1 天放过');
  assert.match(a3.evidence, /共 30 天/);
  const used = await mkOrder({ status: 'delivered', wxOrderId: 'wxused', periodStart: Date.now() - 10 * DAY, periodEnd: Date.now() + 20 * DAY });
  const a4 = await answerIosRefundQuery({ out_trade_no: used.outTradeNo });
  assert.equal(a4.result_code, 1, '已用 >1 天拦截');
  assert.match(a4.evidence, /使用 10 天（共 30 天）/);
});

test('RF-1 月卡第 10 天退款：建议值 132 分、权益截断到当天', async () => {
  const start = Date.now() - 10 * DAY;
  const o = await mkOrder({ status: 'delivered', wxOrderId: 'wxr1', periodStart: start, periodEnd: start + 30 * DAY });
  assert.equal(suggestRefundFeeFen({ leftFeeFen: 199, periodStart: start, periodEnd: start + 30 * DAY }), 132);
  await applyRefund({ outTradeNo: o.outTradeNo, refundFeeFen: 132 });
  const row = await XpayOrderModel.findById(o._id).lean();
  assert.equal(row?.refundedFen, 132);
  assert.equal(row?.status, 'delivered', '部分退款不新增状态');
  const e = await entitlementsOf(String(uid), Date.now());
  assert.ok(e.memberUntil <= Date.now() + DAY, `权益应截断到当天，实际 ${e.memberUntil}`);
});

test('RF-2 先退 100 再退 99：累计到全额才置 refunded，对账净收入 0', async () => {
  const start = Date.now() - 10 * DAY;
  const o = await mkOrder({ status: 'delivered', wxOrderId: 'wxr2', periodStart: start, periodEnd: start + 30 * DAY });
  await applyRefund({ outTradeNo: o.outTradeNo, refundFeeFen: 100 });
  let row = await XpayOrderModel.findById(o._id).lean();
  assert.equal(row?.refundedFen, 100);
  assert.equal(row?.status, 'delivered');
  assert.equal(row?.refundCount, 1);
  await applyRefund({ outTradeNo: o.outTradeNo, refundFeeFen: 99 });
  row = await XpayOrderModel.findById(o._id).lean();
  assert.equal(row?.refundedFen, 199);
  assert.equal(row?.status, 'refunded');
  assert.equal((row?.priceFen ?? 0) - (row?.refundedFen ?? 0), 0, '对账净收入');
});

test('RF-3 方案 a 核心：全额退款 199 分时权益同样只截断到当天', async () => {
  const start = Date.now() - 10 * DAY;
  const o = await mkOrder({ status: 'delivered', wxOrderId: 'wxr3', periodStart: start, periodEnd: start + 30 * DAY });
  assert.ok((await entitlementsOf(String(uid), Date.now())).memberUntil > Date.now(), '退款前是会员');
  await applyRefund({ outTradeNo: o.outTradeNo, refundFeeFen: 199 });
  const after = await entitlementsOf(String(uid), Date.now());
  assert.ok(after.memberUntil <= Date.now() + DAY, '截断到当天');
  // 这两条合起来才排得掉「截断到起点」那种变异：>= now-1天 证明已用掉的 10 天仍算覆盖
  assert.ok(after.memberUntil >= Date.now() - DAY, `已用掉的天数必须保住（实际 ${after.memberUntil}）`);
  assert.ok(after.memberUntil >= start, '绝不能把区间收回退款之前的时刻');
});

test('RF-4 未发货订单退款：建议值＝leftFee 全额，且没有区间可截断', async () => {
  const o = await mkOrder();
  assert.equal(suggestRefundFeeFen({ leftFeeFen: 199, periodStart: 0, periodEnd: 0 }), 199);
  await applyRefund({ outTradeNo: o.outTradeNo, refundFeeFen: 199 });
  const row = await XpayOrderModel.findById(o._id).lean();
  assert.equal(row?.status, 'refunded');
  assert.equal(row?.truncatedAt, 0, '没生效过的单不需要截断');
});

test('RF-5 尚未生效的顺延单退款：不截断正在生效那一笔，也不把到期往后推', async () => {
  const T = Date.now() + 10 * DAY;
  const live = await mkOrder({ status: 'delivered', wxOrderId: 'wxr5a', periodStart: Date.now() - DAY, periodEnd: T });
  const queued = await mkOrder({ status: 'delivered', wxOrderId: 'wxr5b', periodStart: T, periodEnd: T + 30 * DAY });
  assert.equal((await entitlementsOf(String(uid), Date.now())).memberUntil, T + 30 * DAY);
  await applyRefund({ outTradeNo: queued.outTradeNo, refundFeeFen: 199 });
  const e1 = await entitlementsOf(String(uid), Date.now());
  assert.equal(e1.memberUntil, T, '只剔掉被退那一笔的区间');
  assert.equal((await XpayOrderModel.findById(live._id).lean())?.truncatedAt, 0, '在生效的那笔不受影响');
});

test('RF-5b 唯一一笔是尚未生效的顺延单、被退款 → 一天会员都不给（不能白送到它的起点）', async () => {
  const T = Date.now() + 10 * DAY;
  const queued = await mkOrder({ status: 'delivered', wxOrderId: 'wxr5c', periodStart: T, periodEnd: T + 30 * DAY });
  assert.equal((await entitlementsOf(String(uid), Date.now())).memberUntil, T + 30 * DAY, '退款前按已排好的顺延算');
  await applyRefund({ outTradeNo: queued.outTradeNo, refundFeeFen: 199 });
  assert.equal((await entitlementsOf(String(uid), Date.now())).memberUntil, 0, '从未生效的单退款后一天都不给');
});

test('RF-6 重复退款通知只回收一次（按 refundOrderId 去重）', async () => {
  const start = Date.now() - 10 * DAY;
  const o = await mkOrder({
    status: 'refunding', wxOrderId: 'wxr6', periodStart: start, periodEnd: start + 30 * DAY, refundOrderId: 'rf6', refundedFen: 0,
  });
  __setXpayFetcherForTest(async () => ({ errcode: 0, order: { status: 3, left_fee: 67 } })); // 通知入口落账前要复核「这单确实付过」
  await handleXpayNotify('xpay_refund_notify', { openid: OPENID, out_trade_no: o.outTradeNo, refund_id: 'rf6', refund_fee: 132, status: 5 });
  const first = await XpayOrderModel.findById(o._id).lean();
  await handleXpayNotify('xpay_refund_notify', { openid: OPENID, out_trade_no: o.outTradeNo, refund_id: 'rf6', refund_fee: 132, status: 5 });
  const again = await XpayOrderModel.findById(o._id).lean();
  assert.equal(again?.refundedFen, first?.refundedFen, `重复通知多扣了：${first?.refundedFen} → ${again?.refundedFen}`);
});

test('LQ-1 懒查单：查到的已支付单补发货；未知 status 不补（保守）', async () => {
  const o = await mkOrder();
  __setXpayFetcherForTest(async (api) => {
    assert.equal(api, 'query_order');
    return { errcode: 0, order: { status: 3, left_fee: 199, order_no: "wxlazy" } };
  });
  assert.equal(await lazySyncOrders(String(uid), Date.now()), 1);
  assert.equal((await XpayOrderModel.findById(o._id).lean())?.status, 'delivered');

  await mkOrder({ outTradeNo: `DLT_UNKNOWN_${RUN}`.slice(0, 32) });
  __setXpayFetcherForTest(async () => ({ errcode: 0, order: { status: 99, left_fee: 199 } }));
  assert.equal(await lazySyncOrders(String(uid), Date.now() + 61_000), 0, '未知 status 不能补发货');
});

test('LQ-2 限频：lastQueryAt 未超 60s 的单不再查', async () => {
  await mkOrder({ lastQueryAt: Date.now() - 10_000, queryAttempts: 1 });
  let calls = 0;
  __setXpayFetcherForTest(async () => { calls++; return { errcode: 0, order: { status: 99 } }; });
  await lazySyncOrders(String(uid), Date.now());
  assert.equal(calls, 0);
});

test('LQ-3 查单超 20 次转 closed 并留 lastError（不再无限骚扰微信）', async () => {
  const o = await mkOrder({ queryAttempts: 19, lastQueryAt: Date.now() - 120_000 });
  __setXpayFetcherForTest(async () => { throw new Error('ETIMEDOUT'); });
  await lazySyncOrders(String(uid), Date.now());
  const row = await XpayOrderModel.findById(o._id).lean();
  assert.equal(row?.status, 'closed');
  assert.match(String(row?.lastError), /ETIMEDOUT|查单 20 次/);
});

test('DL-7 伪造推送：查单未支付 → 拒绝发货并留痕（明文分支无来源证明的兑底）', async () => {
  // 攻击面：建单后伪造明文 deliver_notify 白拿会员。防线＝通知入口发货前以微信查单为准。
  const o = await mkOrder(); // status='created'，从未支付
  __setXpayFetcherForTest(async (api) => {
    assert.equal(api, 'query_order');
    return { errcode: 0, order: { status: 1, left_fee: 199 } }; // 1=创建未支付：伪造者手里的单只可能是这个状态
  });
  const r = await handleXpayNotify('xpay_goods_deliver_notify', {
    openid: OPENID, out_trade_no: o.outTradeNo, WeChatPayInfo: { MchOrderNo: 'wx_forged' },
  });
  assert.equal(r.ok, true, '伪造包重试改变不了结果，吞掉止住 15 次重试');
  assert.equal(r.dropNoRetry, true);
  const row = await XpayOrderModel.findById(o._id).lean();
  assert.equal(row?.status, 'created', '绝不凭推送发货');
  assert.equal(row?.wxOrderId ?? '', '', '伪造商户单号不能落库');
  assert.match(String(row?.lastError), /拒绝发货/);
});

test('DL-10 推送 paid_dt 是秒级时间戳（真单实测）→ 权益起点不落到 1970 年', async () => {
  const o = await mkOrder();
  __setXpayFetcherForTest(async (api) => {
    assert.equal(api, 'query_order');
    return { errcode: 0, order: { status: 3, left_fee: 199 } };
  });
  const paidDtSec = Math.floor(Date.now() / 1000); // 微信 paid_dt/paid_time 是秒
  const before = Date.now();
  const r = await handleXpayNotify('xpay_goods_deliver_notify', {
    openid: OPENID, out_trade_no: o.outTradeNo,
    WeChatPayInfo: { MchOrderNo: 'wx_sec', paid_dt: paidDtSec },
  });
  assert.equal(r.ok, true);
  const row = await XpayOrderModel.findById(o._id).lean();
  assert.equal(row?.status, 'delivered');
  assert.ok(
    (row?.periodStart ?? 0) >= before - 60_000 && (row?.periodStart ?? 0) <= Date.now(),
    `periodStart 应是近期时刻，实际 ${row?.periodStart}（秒当毫秒用会落到 1970）`,
  );
  assert.equal((row?.periodEnd ?? 0) - (row?.periodStart ?? 0), 30 * DAY);
});

test('DL-8 复核查单确认已支付 → 正常发货（真单不被误伤）', async () => {
  const o = await mkOrder();
  __setXpayFetcherForTest(async (api) => {
    assert.equal(api, 'query_order');
    return { errcode: 0, order: { status: 3, left_fee: 199 } };
  });
  const r = await handleXpayNotify('xpay_goods_deliver_notify', {
    openid: OPENID, out_trade_no: o.outTradeNo, WeChatPayInfo: { MchOrderNo: 'wx_real' },
  });
  assert.equal(r.ok, true);
  const row = await XpayOrderModel.findById(o._id).lean();
  assert.equal(row?.status, 'delivered');
  assert.equal(row?.wxOrderId, 'wx_real');
});

test('DL-9 复核查单网络失败 → 回非 0 让微信重试（不静默、不吞）', async () => {
  const o = await mkOrder();
  __setXpayFetcherForTest(async () => { throw new Error('ETIMEDOUT'); });
  const r = await deliverOrder({ outTradeNo: o.outTradeNo, wxOrderId: 'wx_x', verifyWithWechat: true });
  assert.equal(r.ok, false, '无法证实也未证伪时要重试，不能静默成功');
  assert.equal((await XpayOrderModel.findById(o._id).lean())?.status, 'created');
});

test('RF-7 伪造退款推送：查单未支付 → 拒绝落账（一分都不动）', async () => {
  const o = await mkOrder({ status: 'delivered', wxOrderId: 'wxr7', periodStart: Date.now() - DAY, periodEnd: Date.now() + 29 * DAY });
  __setXpayFetcherForTest(async () => ({ errcode: 0, order: { status: 99, left_fee: 199 } }));
  const r = await handleXpayNotify('xpay_refund_notify', { openid: OPENID, out_trade_no: o.outTradeNo, refund_id: 'rf7', refund_fee: 199 });
  assert.equal(r.ok, true);
  assert.equal(r.dropNoRetry, true);
  const row = await XpayOrderModel.findById(o._id).lean();
  assert.equal(row?.refundedFen ?? 0, 0, '伪造退款一分都不能落');
  assert.equal(row?.refundedAt ?? 0, 0);
  assert.match(String(row?.lastError), /拒绝落账/);
});
