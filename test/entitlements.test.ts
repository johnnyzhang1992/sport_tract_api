/**
 * 权益唯一读取层（spec §5.3/§5.4）。两条主线：
 * A. 算术：多笔顺延不叠加天数（第二笔从第一笔末尾接）、空窗不补偿、退款只截断对应那一笔；
 * B. 等价：只有积分免广告卡时，entitlementsOf().adFreeUntil 必须逐字等于旧的 adFreeUntilOf()
 *    ——合并来源最容易犯的错就是把已有卡算漏。
 * 夹具优先用 __setEntitlementFetchersForTest 注入（不写库）；「状态过滤」这一层必须走真实库，
 * 因为 status 的过滤在取数器里，纯函数看不见它。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/entitlements.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { config } from '../src/config/index.js';
import {
  replayMembership, entitlementsOf, membershipUntilOf, __setEntitlementFetchersForTest, MEMBER_COUNTING_STATUS,
} from '../src/services/entitlements.js';
import { adFreeUntilOf } from '../src/services/points-cards.js';
import { MAX_USER_PHOTOS } from '../src/config/constants.js';
import { XpayOrderModel } from '../src/models/xpay-order.model.js';
import { PointCardModel } from '../src/models/point.model.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 3, 4, 0, 0); // 2026-11-03 12:00 东八区
const RUN = Date.now().toString(36);          // 每跑一次换一批唯一键，避免与上次的残留撞唯一索引
const UID = new Types.ObjectId();
const OPENID = `ent_${RUN}`;

const allPerks = { adFree: true, exportBundle: true, photoQuota: 300, subscribeNotice: true };
type Row = Parameters<typeof replayMembership>[0][number];
const row = (over: Partial<Row> = {}): Row => ({
  periodStart: NOW, periodEnd: NOW + 30 * DAY, truncatedAt: 0, perksSnapshot: allPerks, ...over,
});

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
});
beforeEach(() => __setEntitlementFetchersForTest(null));
after(async () => {
  __setEntitlementFetchersForTest(null);
  await XpayOrderModel.deleteMany({ openid: OPENID });
  await PointCardModel.deleteMany({ userId: UID });
  await mongoose.disconnect().catch(() => {});
});

test('EQ-0 空列表＝无会员（到期 0）', () => {
  assert.equal(replayMembership([]), 0);
});

test('EQ-1 回放取有效区间末尾的最大值', () => {
  assert.equal(replayMembership([row()]), NOW + 30 * DAY);
  assert.equal(replayMembership([row(), row({ periodEnd: NOW + 5 * DAY })]), NOW + 30 * DAY);
});

test('EQ-2 退款截断：truncatedAt 落在区间内时按截断时刻收尾，且不影响另一笔已排好的顺延单', () => {
  const first = row({ periodStart: NOW - 20 * DAY, periodEnd: NOW + 10 * DAY, truncatedAt: NOW });
  const queued = row({ periodStart: NOW + 10 * DAY, periodEnd: NOW + 40 * DAY });
  assert.equal(replayMembership([first, queued]), NOW + 40 * DAY, '顺延单的位置不该因为前一笔被退就前移');
  assert.equal(replayMembership([first]), NOW, '只剩被退的那笔时，权益正好停在截断时刻');
});

test('EQ-3 periodStart 为 0（还没排进链）的行不给权益', () => {
  assert.equal(replayMembership([row({ periodStart: 0, periodEnd: 0 })]), 0);
});

test('EQ-4 只有积分卡时与旧的 adFreeUntilOf 逐字等价', async () => {
  const card = { activatedAt: NOW - DAY, benefitDays: 7 };
  __setEntitlementFetchersForTest({ orderRows: async () => [], adFreeCards: async () => [card] });
  const e = await entitlementsOf(String(UID), NOW);
  assert.equal(e.adFreeUntil, Math.max(0, card.activatedAt + card.benefitDays * DAY));
  assert.equal(e.memberActive, false);
  assert.equal(e.canExportBundle, false, '积分卡不给打包权益（它本来就没有这项）');
  assert.equal(e.photoQuotaLimit, MAX_USER_PHOTOS);
});

test('EQ-5 会员与积分卡两条来源取 max，退款不牵连积分卡', async () => {
  __setEntitlementFetchersForTest({
    orderRows: async () => [row({ periodEnd: NOW + 3 * DAY })],
    adFreeCards: async () => [{ activatedAt: NOW, benefitDays: 30 }],
  });
  assert.equal((await entitlementsOf(String(UID), NOW)).adFreeUntil, NOW + 30 * DAY, '积分卡 30 天 > 会员剩余 3 天');

  __setEntitlementFetchersForTest({
    orderRows: async () => [row({ periodEnd: NOW + 3 * DAY, truncatedAt: NOW })],
    adFreeCards: async () => [{ activatedAt: NOW, benefitDays: 30 }],
  });
  assert.equal((await entitlementsOf(String(UID), NOW)).adFreeUntil, NOW + 30 * DAY, '剔掉会员那笔，积分卡区间不受影响');
});

test('EQ-6 打包/照片两项只认「此刻正在生效」的那一笔：未来单带全套权益也不提前给', async () => {
  __setEntitlementFetchersForTest({
    // 关键：这一笔的 perks 是**全给的**。若判据只看「有没有这笔」而不看 periodStart，
    // 它就会让用户提前拿到打包权与 300 张额度——所以本用例必须用 true/300 才有牙
    orderRows: async () => [row({ periodStart: NOW + 30 * DAY, periodEnd: NOW + 60 * DAY })],
    adFreeCards: async () => [],
  });
  const e = await entitlementsOf(String(UID), NOW);
  assert.equal(e.memberActive, true, '未来生效的顺延单仍算会员');
  assert.equal(e.canExportBundle, false, '但当下不能打包');
  assert.equal(e.photoQuotaLimit, MAX_USER_PHOTOS, '照片额度也不提前涨');
  assert.equal(e.adFreeUntil, NOW + 60 * DAY, '免广告按到期时刻算，不受「当下是否生效」限制');
});

test('EQ-11 会员的免广告天数比积分卡长时取会员（只取卡会漏）', async () => {
  __setEntitlementFetchersForTest({
    orderRows: async () => [row({ periodEnd: NOW + 60 * DAY })],
    adFreeCards: async () => [{ activatedAt: NOW, benefitDays: 7 }],
  });
  assert.equal((await entitlementsOf(String(UID), NOW)).adFreeUntil, NOW + 60 * DAY);
});

test('EQ-7 任一查询失败按该来源无权益降级（另一来源照常给）', async () => {
  __setEntitlementFetchersForTest({
    orderRows: async () => { throw new Error('库炸了'); },
    adFreeCards: async () => [{ activatedAt: NOW, benefitDays: 7 }],
  });
  const e = await entitlementsOf(String(UID), NOW);
  assert.equal(e.memberActive, false);
  assert.equal(e.memberUntil, 0);
  assert.equal(e.photoQuotaLimit, MAX_USER_PHOTOS);
  assert.equal(e.adFreeUntil, NOW + 7 * DAY, '卡那条没坏，仍按它给');
});

test('EQ-8 MEMBER_COUNTING_STATUS 逐字＝delivered/refunding/refunded（refunding 期间权益不中断）', () => {
  assert.deepEqual([...MEMBER_COUNTING_STATUS], ['delivered', 'refunding', 'refunded']);
});

test('EQ-9 真实库：delivered 计入、created 不计入；与积分卡取较远者；旧接口口径不变', async () => {
  await XpayOrderModel.deleteMany({ openid: OPENID });
  await PointCardModel.deleteMany({ userId: UID });

  const base = {
    userId: UID, openid: OPENID, productKey: 'month_card', name: '会员月卡',
    priceFen: 199, durationDays: 30, perksSnapshot: allPerks,
  };
  await XpayOrderModel.create({
    ...base, outTradeNo: `ENT${RUN}A`.slice(0, 32), wxOrderId: `entwx${RUN}a`,
    status: 'delivered', periodStart: NOW - DAY, periodEnd: NOW + 60 * DAY,
  });
  await XpayOrderModel.create({
    ...base, outTradeNo: `ENT${RUN}B`.slice(0, 32), wxOrderId: '',
    status: 'created',
  });
  await PointCardModel.create({
    userId: UID, itemKey: 'ent_test_card', status: 'used', benefitDays: 90,
    activatedAt: NOW, expiresAt: NOW + DAY, usedForDate: '', source: 'exchange', createdAt: NOW,
  });

  const e = await entitlementsOf(String(UID), NOW);
  assert.equal(e.memberUntil, NOW + 60 * DAY, 'created 那笔不许被算进会员到期');
  assert.equal(e.adFreeUntil, NOW + 90 * DAY, '积分卡 90 天更远');
  assert.equal(e.canExportBundle, true);
  assert.equal(e.photoQuotaLimit, 300);
  assert.equal(await adFreeUntilOf(String(UID)), NOW + 90 * DAY, '旧接口口径不变');
  assert.equal(await membershipUntilOf(String(UID)), NOW + 60 * DAY);
});

test('EQ-10 畸形 userId 直接返回非会员，不进查询（不抛 CastError）', async () => {
  const e = await entitlementsOf('not-an-object-id');
  assert.equal(e.memberActive, false);
  assert.equal(e.memberUntil, 0);
  assert.equal(e.photoQuotaLimit, MAX_USER_PHOTOS);
});
