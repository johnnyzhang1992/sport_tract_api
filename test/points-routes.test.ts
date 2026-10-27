import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import {
  PointAccountModel, PointCardModel, PointDailyModel, PointExchangeModel, PointLotModel, PointRecordModel,
  PointSigninModel, PointTaskModel,
} from '../src/models/point.model.js';
import { UserModel } from '../src/models/user.model.js';
import { LoginLogModel } from '../src/models/login-log.model.js';
import { POINTS } from '../src/config/points.js';
import { creditPoints } from '../src/services/points-ledger.js';
import { bjDateStr } from '../src/utils/bj-time.js';
import { previousDateKey, shiftDateKey } from '../src/utils/points-domain.js';

/**
 * /points/* HTTP 接线：登录闸门、汇总结构（cells 原样下发、旧 makeupCardId 已撤）、
 * 「汇总 → 兑换 → 补签 → 签到 → 领任务」全链路，以及补窗口最左日（PR4）与
 * 差额被 DAILY_CAP 截断报实发值（PR5）两条账本路径。
 *
 * 时间是路由内 Date.now()，所以造数据一律相对「今天（东八区）」：
 * 前天有签到行、昨天/今天留空 → 昨天是窗口内的可补格，补签接口按 dateKey 走。
 * 清理只动本用例自己登录出来的那个用户及其积分行，不碰库里其他数据。
 */

const API = '/sport-track/api';
const DAY = 86400000;

const TODAY = bjDateStr(Date.now());
const YESTERDAY = previousDateKey(TODAY);
const DAY_BEFORE = previousDateKey(YESTERDAY);

interface SigninCell {
  dateKey: string;
  state: string;
  streakDay: number;
  reward: number;
  todayRewardAfter?: number;
}

interface SigninState {
  todaySigned: boolean;
  streakDay: number;
  todayReward: number;
  nextReward: number;
  cards: number;
  // 改版口径（spec §5.1）：canMakeUp/makeupDate/makeupCardId 全部撤掉，
  // 可补与否只看 cells 里的 makeup 格（makeupCardId 用下面的 undefined 断言钉死）。
  cells: SigninCell[];
}

const makeupKeys = (s: SigninState) => s.cells.filter((c) => c.state === 'makeup').map((c) => c.dateKey);

interface TaskRow {
  key: string;
  title: string;
  points: number;
  status: string;
  actionText: string;
}

interface ItemRow {
  key: string;
  name: string;
  subtitle: string;
  price: number;
  validDays: number;
  description: string;
  notes: string[];
  effect: { kind: string; days: number };
  imageUrl: string;
}

interface Summary {
  balance: number;
  signin: SigninState;
  tasks: TaskRow[];
  items: ItemRow[];
  // Task 3 新增（spec §7.3）：免广告到期时刻（0=从未激活）与按道具分组的持卡数
  adFreeUntil: number;
  cards: { itemKey: string; unused: number }[];
}

interface RecordPage {
  items: { type: string; delta: number; balanceAfter: number }[];
  total: number;
  balance: number;
}

interface ExchangeRow {
  itemKey: string;
  cost: number;
  cardId: string;
  status: string;
  statusText: string;
  usedForDate: string;
}

let app: FastifyInstance;
let token = '';
let userId = '';
let uid: Types.ObjectId;

const auth = () => ({ authorization: `Bearer ${token}` });
const data = <T>(res: { json: () => { data: T } }): T => res.json().data;

const get = (url: string) =>
  app.inject({ method: 'GET', url: `${API}${url}`, headers: auth() });
const post = (url: string, payload?: unknown) =>
  app.inject({
    method: 'POST',
    url: `${API}${url}`,
    headers: auth(),
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const wipe = (u: Types.ObjectId) => Promise.all([
  PointExchangeModel.deleteMany({ userId: u }),
  PointCardModel.deleteMany({ userId: u }),
  PointSigninModel.deleteMany({ userId: u }),
  PointTaskModel.deleteMany({ userId: u }),
  PointRecordModel.deleteMany({ userId: u }),
  PointLotModel.deleteMany({ userId: u }),
  PointDailyModel.deleteMany({ userId: u }),
  PointAccountModel.deleteMany({ userId: u }),
]);

/** 每日上限 100：按业务日拆分发放，凑够兑换一张卡（200 分） */
async function seedPoints(u: string, total: number): Promise<void> {
  let left = total;
  for (let i = 0; left > 0; i++) {
    const at = Date.now() - (3 + i) * DAY;
    const points = Math.min(POINTS.DAILY_CAP, left);
    const r = await creditPoints(u, {
      type: 'seed',
      title: '测试积分',
      points,
      bizDate: bjDateStr(at),
      idemKey: `${u}:routes-seed:${i}`,
    }, at);
    assert.equal(r.credited, points);
    left -= points;
  }
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  const login = await app.inject({
    method: 'POST',
    url: `${API}/auth/login`,
    payload: { code: `openid:points-routes-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  assert.equal(login.statusCode, 200, login.body);
  const d = login.json().data;
  token = d.accessToken;
  userId = d.user?.id ?? d.user?._id;
  assert.ok(token && userId, 'mock 登录应返回 token 与 userId');
  uid = new Types.ObjectId(userId);

  // 唯一键（签到/任务/兑换/明细）是异步建的，等它们就绪再跑链路
  await Promise.all([
    PointSigninModel.init(), PointTaskModel.init(), PointExchangeModel.init(),
    PointRecordModel.init(), PointAccountModel.init(),
  ]);

  // 前天签到：让昨天成为「所在未签段 ≤2 天」的可补格；昨天/今天留空
  await PointSigninModel.create({
    userId: uid,
    dateKey: DAY_BEFORE,
    streakDay: 2,
    points: 2,
    source: 'sign',
    createdAt: Date.now() - 2 * DAY,
  });
});

after(async () => {
  if (uid) {
    await wipe(uid);
    // 登录日志是登录接口后置异步落的，最后再清一次
    await LoginLogModel.deleteMany({ userId: uid }).catch(() => {});
    await UserModel.deleteMany({ _id: uid });
  }
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

test('PR1 未登录访问 /points/* 全部 401', async () => {
  const cases = [
    ['GET', '/points/summary'],
    ['POST', '/points/sign-in'],
    ['GET', '/points/records'],
    ['POST', '/points/tasks/daily_video/claim'],
    ['GET', '/points/items'],
    ['POST', '/points/items/makeup_card/exchange'],
    ['POST', '/points/signin/makeup'],
    ['POST', '/points/cards/000000000000000000000000/activate'],
    ['GET', '/points/exchanges'],
  ] as const;
  for (const [method, url] of cases) {
    const res = await app.inject({ method, url: `${API}${url}` });
    assert.equal(res.statusCode, 401, `${method} ${url} 游客应 401`);
  }
});

test('PR2 summary → 兑换 → 补签 → 签到 → 领任务 全链路', async () => {
  // 1) 新用户空态：无余额、未签到、无卡；任务全量下发且都未领取
  const s0 = data<Summary>(await get('/points/summary'));
  assert.equal(s0.balance, 0);
  // Task 3：新用户在 summary 上也必须看到两个新字段（0 与空数组是「从未激活/无卡」的显式口径，不许缺省）
  assert.equal(s0.adFreeUntil, 0, '空态 adFreeUntil=0（0=从未激活）');
  assert.deepEqual(s0.cards, [], '空态持卡数组为空');
  assert.equal(s0.signin.todaySigned, false);
  // streakDay 只报接得上的那条链（spec §5.1 / Ruling 2026-10-25）：今天没签、昨天也没签 → 0。
  // 窗口里前天的行（库存 2）是「上一段链的长度」，不能当「现在连了几天」报出去。
  assert.equal(s0.signin.streakDay, 0);
  assert.equal(s0.signin.todayReward, 0);
  assert.equal(s0.signin.nextReward, 1, '首签 1 分');
  assert.equal(s0.signin.cards, 0);
  assert.equal(
    (s0.signin as unknown as { makeupCardId?: string }).makeupCardId, undefined,
    '旧契约字段 makeupCardId 已撤（spec §5.1），payload 里不该再出现',
  );
  // 段长放宽（2026-10-25）：窗口内全部漏签日都下发 makeup 格（前天有行 → 接得上）。
  // 日期按 TODAY 相对计算——写死日期会在跨天运行时整窗漂移（2026-10-26 实测踩过）
  assert.deepEqual(
    makeupKeys(s0.signin),
    [6, 5, 4, 3, 1].map((d) => shiftDateKey(TODAY, -d)),
    '无卡但昨天漏签时仍下发 makeup 格（供前端引导兑换）',
  );
  assert.equal(s0.tasks.length, 5);
  assert.ok(s0.tasks.every((t) => t.status !== 'claimed'), '新用户没有已领取任务');
  // 目录驱动后仍只下发在架项：三条 ad_free_* 种子 active:false，老端商品区不该多出点不动的卡
  assert.equal(s0.items.length, 1, 'summary 下发整张商品表（只含在架项），积分页按它渲染商品卡');
  assert.equal(s0.items[0].key, 'makeup_card');
  assert.equal(s0.items[0].price, POINTS.MAKEUP_CARD_PRICE);
  // 新 DTO 字段（spec §7.3）：notes/effect/imageUrl 必须随列表下发
  assert.deepEqual(s0.items[0].effect, { kind: 'makeup', days: 0 }, '补签卡 effect 快照');
  assert.ok(
    Array.isArray(s0.items[0].notes) && s0.items[0].notes.includes('兑换后不退积分'),
    'notes 由服务端下发（商品详情提示文案）',
  );
  assert.equal(s0.items[0].imageUrl, '', '种子未配图 → 空串（私有桶裸链会 403，不如有图时给缩略档签名链）');

  // 2) 授 200 分后 summary 余额同步
  await seedPoints(userId, POINTS.MAKEUP_CARD_PRICE);
  const s1 = data<Summary>(await get('/points/summary'));
  assert.equal(s1.balance, 200);

  // 3) 商品列表（/items 与 summary.items 同一路口径：目录在架项 + notes/effect/imageUrl）
  const items = data<ItemRow[]>(await get('/points/items'));
  assert.equal(items.length, 1);
  assert.equal(items[0].key, 'makeup_card');
  assert.equal(items[0].price, 200);
  assert.equal(items[0].validDays, POINTS.MAKEUP_CARD_VALID_DAYS);
  assert.deepEqual(items[0].effect, { kind: 'makeup', days: 0 });
  assert.ok(Array.isArray(items[0].notes) && items[0].notes.length >= 3, 'notes 至少含三条使用提示');
  assert.equal(items[0].imageUrl, '');

  // 4) 兑换补签卡：同一 requestId 连点只扣一次、只发一张卡
  const requestId = `routes-${Date.now()}`;
  const ex1 = await post('/points/items/makeup_card/exchange', { requestId });
  assert.equal(ex1.statusCode, 200, ex1.body);
  const cardId = data<{ cardId: string; balance: number }>(ex1).cardId;
  assert.ok(cardId, '兑换应返回卡 id');
  assert.equal(data<{ cardId: string; balance: number }>(ex1).balance, 0);

  const ex2 = await post('/points/items/makeup_card/exchange', { requestId });
  assert.equal(ex2.statusCode, 200, ex2.body);
  assert.equal(data<{ cardId: string; balance: number }>(ex2).cardId, cardId, '同一 requestId 复用同一张卡');
  assert.equal(data<{ cardId: string; balance: number }>(ex2).balance, 0, '不重复扣分');

  // 5) 汇总带出七格：段长放宽后窗口内漏签日全部可补，最左 = 窗口左界（今天-6）
  const s2 = data<Summary>(await get('/points/summary'));
  assert.equal(s2.balance, 0);
  assert.equal(s2.signin.cards, 1);
  // 持卡分组口径：兑换来的补签卡在 cards 里按 itemKey 出现（补签卡不占免广告期）
  assert.deepEqual(s2.cards, [{ itemKey: 'makeup_card', unused: 1 }]);
  assert.equal(s2.adFreeUntil, 0, '补签卡 benefitDays=0，不该推高 adFreeUntil');
  const makeupCell = s2.signin.cells.find((c) => c.state === 'makeup');
  assert.ok(makeupCell, '应有一格可补');
  assert.equal(makeupCell!.dateKey, shiftDateKey(TODAY, -6), '最左可补格 = 窗口左界');
  // 造数据是「前天有行、库存 streakDay=2」：只补窗口左界一格接不上今天 → 今天仍新段 1 分；
  // 补昨天才是接上链的那格（第 3 天，见下面第 7 步）。
  assert.equal(makeupCell!.streakDay, 1);
  assert.equal(makeupCell!.reward, 1);
  assert.equal(makeupCell!.todayRewardAfter, 1, '只补最左一格接不上今天');
  assert.equal(
    (s2.signin as unknown as { makeupCardId?: string }).makeupCardId, undefined,
    'summary 不再挑卡给客户端传 id（spec §5.2：卡由服务端自选）',
  );
  assert.deepEqual(
    makeupKeys(s2.signin),
    [6, 5, 4, 3, 1].map((d) => shiftDateKey(TODAY, -d)),
    '窗口内全部漏签日可补（段长放宽）',
  );

  // 6) 非法/出窗日期 → service 的 400 原样透出，卡不消耗；旧的按卡 id 接口已撤 → 404
  const badDate = await post('/points/signin/makeup', { dateKey: TODAY });
  assert.equal(badDate.statusCode, 400, badDate.body);
  assert.match(badDate.json().message, /不能补签/);
  assert.equal((await post('/points/signin/makeup', { dateKey: '2020-01-01' })).statusCode, 400, '出窗日期 400');
  assert.equal((await post(`/points/cards/${cardId}/use`)).statusCode, 404, '旧端点 /points/cards/:id/use 已撤');
  assert.equal((await PointCardModel.findOne({ userId: uid }).lean())?.status, 'unused', '参数错不烧卡');

  // 7) 按日期用卡补签昨天：连签接到前天（3），得 3 分；今天仍未签到、没欠分可补 → toppedUp 0
  const used = await post('/points/signin/makeup', { dateKey: YESTERDAY });
  assert.equal(used.statusCode, 200, used.body);
  const useData = data<{ credited: number; toppedUp: number; cardId: string; balance: number } & SigninState>(used);
  assert.equal(useData.credited, 3);
  assert.equal(useData.toppedUp, 0, '今天没签到行，重排没欠分');
  assert.equal(useData.cardId, cardId, '服务端挑的就是那个 exchange 拿到的卡');
  assert.equal(useData.balance, 3);
  assert.equal(useData.streakDay, 3);
  assert.equal(useData.todaySigned, false);
  assert.equal(useData.nextReward, 4, '今天签到可得第 4 天 4 分');

  // 8) 兑换记录：已使用，补签日期为昨天
  const exchanges = data<ExchangeRow[]>(await get('/points/exchanges'));
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].cardId, cardId);
  assert.equal(exchanges[0].cost, 200);
  assert.equal(exchanges[0].status, 'used');
  assert.equal(exchanges[0].statusText, '已使用');
  assert.equal(exchanges[0].usedForDate, YESTERDAY);

  // 9) 今天签到：接昨天连签 → 第 4 天 4 分；重复签到幂等
  const sign = await post('/points/sign-in');
  assert.equal(sign.statusCode, 200, sign.body);
  const signData = data<{ credited: number; balance: number; alreadySigned: boolean } & SigninState>(sign);
  assert.equal(signData.alreadySigned, false);
  assert.equal(signData.credited, 4);
  assert.equal(signData.balance, 7);
  assert.equal(signData.streakDay, 4);
  assert.equal(signData.todaySigned, true);
  assert.equal(signData.nextReward, 5);

  const again = data<{ credited: number; balance: number; alreadySigned: boolean }>(await post('/points/sign-in'));
  assert.equal(again.alreadySigned, true);
  assert.equal(again.credited, 0);
  assert.equal(again.balance, 7);

  // 10) 领取每日任务（看广告视频 5 分），重复领取幂等
  const claim = await post('/points/tasks/daily_video/claim');
  assert.equal(claim.statusCode, 200, claim.body);
  const claimData = data<{ alreadyClaimed: boolean; credited: number }>(claim);
  assert.equal(claimData.alreadyClaimed, false);
  assert.equal(claimData.credited, POINTS.VIDEO_REWARD);

  const claimAgain = data<{ alreadyClaimed: boolean; credited: number }>(await post('/points/tasks/daily_video/claim'));
  assert.equal(claimAgain.alreadyClaimed, true);
  assert.equal(claimAgain.credited, 0);

  // 11) 收尾 summary：余额 12（-200 +3 +4 +5）、卡已用掉、任务状态已领取
  const s3 = data<Summary>(await get('/points/summary'));
  assert.equal(s3.balance, 12);
  assert.equal(s3.signin.todaySigned, true);
  assert.equal(s3.signin.streakDay, 4);
  assert.equal(s3.signin.todayReward, 4);
  assert.equal(s3.signin.nextReward, 5);
  assert.equal(s3.signin.cards, 0);
  // 段长放宽后：窗口里剩余漏签日仍是可补格（卡已用完，点了会引导去兑换）；日期按 TODAY 相对算
  assert.deepEqual(
    makeupKeys(s3.signin),
    [6, 5, 4, 3].map((d) => shiftDateKey(TODAY, -d)),
    '已签/已补的格子消失，其余漏签日仍标记可补',
  );
  const video = s3.tasks.find((t) => t.key === 'daily_video');
  assert.equal(video?.status, 'claimed');
  assert.equal(video?.actionText, '已领取');

  // 12) 明细分页：6 条（2 条种子发放、兑换、补签、签到、任务），余额与 summary 一致
  const p1 = data<RecordPage>(await get('/points/records?page=1&pageSize=2'));
  assert.equal(p1.total, 6);
  assert.equal(p1.items.length, 2);
  assert.equal(p1.balance, 12);
  assert.deepEqual(p1.items.map((i) => i.type), ['task_daily_video', 'signin'], '按时间倒序');
  assert.equal(p1.items[0].delta, 5);
  assert.equal(p1.items[0].balanceAfter, 12);

  const p3 = data<RecordPage>(await get('/points/records?page=3&pageSize=2'));
  assert.equal(p3.items.length, 2);
  assert.deepEqual(p3.items.map((i) => i.type), ['seed', 'seed']);

  // 非法分页参数回落默认值，pageSize 上限 50
  const clamped = data<RecordPage>(await get('/points/records?page=0&pageSize=999'));
  assert.equal(clamped.items.length, 6);
  assert.equal(clamped.total, 6);
});

/** 账本不变式：Σ record.delta === account.balance === Σ 未过期 lot.remaining */
async function ledgerTotals(): Promise<{ deltaSum: number; balance: number; lotSum: number }> {
  const now = Date.now();
  const [recs, account, lots] = await Promise.all([
    PointRecordModel.find({ userId: uid }).lean(),
    PointAccountModel.findOne({ userId: uid }).lean(),
    PointLotModel.find({ userId: uid, remaining: { $gt: 0 }, expireAt: { $gt: now } }).lean(),
  ]);
  return {
    deltaSum: recs.reduce((s, r) => s + r.delta, 0),
    balance: account?.balance ?? 0,
    lotSum: lots.reduce((s, l) => s + l.remaining, 0),
  };
}

test('PR4 补窗口最左日：一条 makeup_reward + 一条 makeup_topup，明细分页能查到', async () => {
  // spec §4.2 算例的路由版：今天-5..今天-2 连签 1..4 天，今天-6 与昨天漏签。
  // 补最左日（今天-6）：它左边没接任何东西 → 当天分 1（记在它自己那天）；
  // 重排把 4 个已签日各顶一格 → 差额 4 一次发在今天。
  await wipe(uid);
  for (let i = 0; i < 4; i += 1) {
    await PointSigninModel.create({
      userId: uid, dateKey: shiftDateKey(TODAY, -5 + i), streakDay: i + 1, points: i + 1,
      source: 'sign', createdAt: Date.now(),
    });
  }
  await seedPoints(userId, POINTS.MAKEUP_CARD_PRICE);
  const ex = await post('/points/items/makeup_card/exchange', { requestId: `pr4-${Date.now()}` });
  assert.equal(ex.statusCode, 200, ex.body);

  const windowLeft = shiftDateKey(TODAY, -6);
  const m = await post('/points/signin/makeup', { dateKey: windowLeft });
  assert.equal(m.statusCode, 200, m.body);
  const r = data<{ credited: number; toppedUp: number; balance: number } & SigninState>(m);
  assert.equal(r.credited, 1, '最左日按新位置只值第 1 天 1 分');
  assert.equal(r.toppedUp, 4, '今天-5..今天-2 各被顶高一格，共 4 分差额');
  assert.equal(r.balance, 5);
  assert.deepEqual(makeupKeys(r), [YESTERDAY], '补掉最左日后，可补格只剩昨天');

  const page = data<RecordPage>(await get('/points/records?page=1&pageSize=10'));
  const topup = page.items.find((x) => x.type === 'makeup_topup');
  assert.ok(page.items.some((x) => x.type === 'makeup_reward'), '明细里有补签当天分');
  assert.equal(topup?.delta, 4, '明细里另有一条重排差额补发');
  const ledger = await ledgerTotals();
  assert.equal(ledger.deltaSum, ledger.balance, 'Σdelta === 余额');
  assert.equal(ledger.lotSum, ledger.balance, 'Σ未过期 lot.remaining === 余额');
});

test('PR5 差额被今天 DAILY_CAP 截断：响应报实发值，账本不变式仍成立（已接受风险，不补救）', async () => {
  await wipe(uid);
  // 前天（库存第 3 天）与今天（抢跑建成第 1 天）有行、昨天漏签 → 昨天可补；
  // 补上昨天把今天顶到第 5 天，名义差额 4，但今天额度只剩 2 → 实发 2。
  await PointSigninModel.create({ userId: uid, dateKey: DAY_BEFORE, streakDay: 3, points: 3, source: 'sign', createdAt: Date.now() });
  await PointSigninModel.create({ userId: uid, dateKey: TODAY, streakDay: 1, points: 1, source: 'sign', createdAt: Date.now() });
  await seedPoints(userId, POINTS.MAKEUP_CARD_PRICE);
  await PointCardModel.create({
    userId: uid, itemKey: 'makeup_card', status: 'unused',
    expiresAt: Date.now() + POINTS.MAKEUP_CARD_VALID_DAYS * DAY, createdAt: Date.now(),
  });
  // 把今天的额度占到只剩 2：今天签到行对应 1 分流水 + 再发 97 分（1+97=98，上限 100）
  const c1 = await creditPoints(userId, {
    type: 'signin', title: '连续签到第 1 天', points: 1, bizDate: TODAY,
    idemKey: `${userId}:pr5-signin`,
  });
  const c2 = await creditPoints(userId, {
    type: 'seed', title: '占满当日上限', points: 97, bizDate: TODAY,
    idemKey: `${userId}:pr5-cap`,
  });
  assert.equal(c1.credited, 1);
  assert.equal(c2.credited, 97);

  const m = await post('/points/signin/makeup', { dateKey: YESTERDAY });
  assert.equal(m.statusCode, 200, m.body);
  const r = data<{ credited: number; toppedUp: number; balance: number } & SigninState>(m);
  assert.equal(r.credited, 4, '当天分记在昨天那格自己的 bizDate，不受今天上限影响 → 全额');
  assert.equal(r.toppedUp, 2, '差额按今天入账，被 DAILY_CAP 截到只剩的 2 分——响应报实发而不是名义 4');
  assert.equal(r.balance, 200 + 1 + 97 + 4 + 2, '卡是直接发的、没走兑换扣分');

  const page = data<RecordPage>(await get('/points/records?page=1&pageSize=10'));
  assert.equal(page.items.find((x) => x.type === 'makeup_reward')?.delta, 4);
  assert.equal(page.items.find((x) => x.type === 'makeup_topup')?.delta, 2, '流水落的也是实发值');
  assert.equal(page.items.some((x) => x.type === 'makeup_reward_rollback'), false, '截断不是失败，不回滚');
  const ledger = await ledgerTotals();
  assert.equal(ledger.deltaSum, ledger.balance);
  assert.equal(ledger.lotSum, ledger.balance);
});

test('PR3 路由参数错误透出 service 的 400/404', async () => {
  const noRequestId = await post('/points/items/makeup_card/exchange', {});
  assert.equal(noRequestId.statusCode, 400, noRequestId.body);
  assert.match(noRequestId.json().message, /兑换请求 ID/);

  // 兑换路径已泛化为 /items/:itemKey/exchange：不存在的 key 走 404 文案含 key
  const unknownItem = await post('/points/items/not_an_item/exchange', { requestId: 'pr3-nope' });
  assert.equal(unknownItem.statusCode, 404, unknownItem.body);
  assert.match(unknownItem.json().message, /道具不存在：not_an_item/);

  const unknownTask = await post('/points/tasks/not_a_task/claim');
  assert.equal(unknownTask.statusCode, 404, unknownTask.body);
  assert.match(unknownTask.json().message, /任务不存在/);
});
