import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import {
  PointAccountModel, PointCardModel, PointDailyModel, PointExchangeModel, PointItemModel, PointLotModel, PointRecordModel,
  PointSigninModel, PointTaskModel,
} from '../src/models/point.model.js';
import { UserModel } from '../src/models/user.model.js';
import { LoginLogModel } from '../src/models/login-log.model.js';
import { BOARD_REWARDS, POINTS, boardRulesText } from '../src/config/points.js';
import { creditPoints } from '../src/services/points-ledger.js';
import { bjDateStr } from '../src/utils/bj-time.js';
import { previousDateKey, shiftDateKey } from '../src/utils/points-domain.js';
import {
  SETTLE_TRIGGER_WINDOW_MS, lazySettleDeps, resetLazySettleDebounceForTest, scheduleLazySettle,
} from '../src/services/board-lazy-settle.js';
import { settleDueForUser } from '../src/services/points-board.js';

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

/**
 * 目录是后台可增删的共享表：断「下发集合 == 库内在架集合」而不锁条数，
 * 后台多上一件在架商品不该打挂全链路；反向（在架项漏发）与「下架项混进来」
 * 都由集合相等抓住——后者靠库里恒有的三条 active:false 种子当对照。
 */
const activeCatalogKeys = async (): Promise<string[]> => (
  (await PointItemModel.find({ active: true }).select({ key: 1 }).lean())
    .map((i) => String(i.key)).sort()
);

/**
 * 补签卡目录行的实时配置（价格与配图都是后台可改的运营项，2026-10-28 价格 200→49）：
 * 全链路用例按实时值算账，别把 200 写死在断言里。
 */
const makeupCatalog = () => PointItemModel.findOne({ key: 'makeup_card' })
  .select({ price: 1, image: 1 }).lean();

/** 配了图必须签名缩略链下发，没配图才是空串（私有桶裸链会 403） */
const assertItemImageDto = (imageUrl: string, image: string): void => {
  if (!image) assert.equal(imageUrl, '', '未配图的道具下发空串');
  else assert.match(imageUrl, /^https:\/\/.+Signature=/, '配了图必须签名下发');
};

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

/** 每日上限 100：按业务日拆分发放，凑够兑换一张卡（按目录实时价） */
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
  // 清单 = points.routes.ts 里注册的全部**需登录**路由；公开的 GET /points/rules（同 /ads 的公开口径）
  // 不在表内，由 PR-RULES-2 正向钉住「不带 token 也 200」。
  // 少一条就是那条没挂 authenticate —— 新增需登录路由必须同步进这张表
  const cases = [
    ['GET', '/points/summary'],
    ['POST', '/points/sign-in'],
    ['GET', '/points/records'],
    ['POST', '/points/tasks/daily_video/claim'],
    ['GET', '/points/items'],
    ['POST', '/points/items/makeup_card/exchange'],
    ['GET', '/points/orders'],
    ['POST', '/points/orders/000000000000000000000000/confirm'],
    ['POST', '/points/signin/makeup'],
    ['POST', '/points/cards/000000000000000000000000/activate'],
    ['GET', '/points/exchanges'],
  ] as const;
  assert.equal(cases.length, 11, '用户侧 /points 路由共 11 条，漏一条就是漏一道登录闸门');
  for (const [method, url] of cases) {
    const res = await app.inject({ method, url: `${API}${url}` });
    assert.equal(res.statusCode, 401, `${method} ${url} 游客应 401`);
  }
});

/**
 * 规则页榜单文案（spec §4.8 第 1 条，用户逐字定稿）：分值/门槛/3 榜上限全部从
 * BOARD_REWARDS 插值，文案里不许出现第二份数字。六句逐字钉住，渲染结果必须与定稿一字不差。
 */
test('PR-RULES-1 boardRulesText 六句逐字定稿，数字全部来自配置插值', () => {
  const rules = boardRulesText(BOARD_REWARDS.rewards, BOARD_REWARDS);
  assert.equal(rules.length, 6);
  assert.deepEqual(rules, [
    '每周/每月/每年，各运动类型的全国榜按总距离排名，前三名获得积分：周榜第 1 名 50 分、第 2 名 30 分、第 3 名 20 分；月榜 100 / 80 / 50 分；年榜 500 / 400 / 300 分。',
    '榜单奖励只发给"大家都来动"的榜：同一周期内，该运动类型的全国榜参与人数超过 10 人才发放，人数不足则本期不发。',
    '同一期内，每人最多计成绩最好的 3 个榜单，其余名次不再叠加积分。',
    '奖励在周期结束后顺延发放：上周（周一至周日）的周榜在下周一到账，上月的月榜在下月 1 日到账，上一年的年榜在次年 1 月 1 日到账。',
    '只有可信的运动记录计入排名：疑似搭车、轨迹漂移异常、配速不合理的记录会被剔除。',
    '积分奖励会同时发一条消息通知，并在「积分明细」里留一条记录。',
  ]);
  // 插值不是装饰：换一份配置，三句数字文案必须跟着变（否则就是文案里另写了一份数字）
  const custom = boardRulesText(
    { week: [7, 5, 3], month: [8, 6, 4], year: [9, 7, 5] },
    { minParticipants: 11, perUserBoards: 2 },
  );
  assert.ok(custom[0].includes('周榜第 1 名 7 分、第 2 名 5 分、第 3 名 3 分'));
  assert.ok(custom[0].includes('月榜 8 / 6 / 4 分'));
  assert.ok(custom[0].includes('年榜 9 / 7 / 5 分'));
  assert.ok(custom[1].includes('超过 11 人才发放'));
  assert.ok(custom[2].includes('成绩最好的 2 个榜单'));
});

test('PR-RULES-2 GET /points/rules 公开可读（不带 token），下发与 boardRulesText 逐字相等', async () => {
  // 规则是配置不是用户数据（先例：公开 GET /ads）：游客进规则页也要能看到榜单说明
  const res = await app.inject({ method: 'GET', url: `${API}/points/rules` });
  assert.equal(res.statusCode, 200, res.body);
  const rules = (res.json().data as { boardRules: string[] }).boardRules;
  assert.equal(rules.length, 6);
  // 路由层不得改写文案：必须与函数本体逐字相等（防止「顺手」在路由里重排/加前缀）
  assert.deepEqual(rules, boardRulesText(BOARD_REWARDS.rewards, BOARD_REWARDS));
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
  assert.deepEqual(
    s0.items.map((i) => i.key).sort(), await activeCatalogKeys(),
    'summary 下发整张在架目录，积分页按它渲染商品卡',
  );
  assert.equal(s0.items[0].key, 'makeup_card', 'sortOrder 排第一的补签卡必须在首位（老端读 items[0]）');
  const catalog = await makeupCatalog();
  const price = catalog?.price ?? 0;
  assert.ok(price > 0, '目录行必须带价格');
  assert.equal(s0.items[0].price, price, '下发价 = 目录实时价');
  // 新 DTO 字段（spec §7.3）：notes/effect/imageUrl 必须随列表下发
  assert.deepEqual(s0.items[0].effect, { kind: 'makeup', days: 0 }, '补签卡 effect 快照');
  assert.ok(
    Array.isArray(s0.items[0].notes) && s0.items[0].notes.includes('兑换后不退积分'),
    'notes 由服务端下发（商品详情提示文案）',
  );
  assertItemImageDto(s0.items[0].imageUrl, catalog?.image ?? '');

  // 2) 按实时价凑够余额后 summary 同步
  await seedPoints(userId, price);
  const s1 = data<Summary>(await get('/points/summary'));
  assert.equal(s1.balance, price);

  // 3) 商品列表（/items 与 summary.items 同一路口径：目录在架项 + notes/effect/imageUrl）
  const items = data<ItemRow[]>(await get('/points/items'));
  assert.deepEqual(items.map((i) => i.key).sort(), await activeCatalogKeys(), '/points/items 与 summary.items 同一在架口径');
  assert.equal(items[0].key, 'makeup_card');
  assert.equal(items[0].price, price);
  assert.equal(items[0].validDays, POINTS.MAKEUP_CARD_VALID_DAYS);
  assert.deepEqual(items[0].effect, { kind: 'makeup', days: 0 });
  assert.ok(Array.isArray(items[0].notes) && items[0].notes.length >= 3, 'notes 至少含三条使用提示');
  assertItemImageDto(items[0].imageUrl, catalog?.image ?? '');

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
  assert.equal(exchanges[0].cost, price, '兑换记录记的是成交时的目录实时价');
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

  // 10) 领取每日任务（看广告视频，每天三次机会 × POINTS.VIDEO_REWARD 分）：前三次各发一次，第四次幂等
  for (let i = 1; i <= 3; i += 1) {
    const claim = await post('/points/tasks/daily_video/claim');
    assert.equal(claim.statusCode, 200, claim.body);
    const claimData = data<{ alreadyClaimed: boolean; credited: number }>(claim);
    assert.equal(claimData.alreadyClaimed, false, `第 ${i} 次应当真发分`);
    assert.equal(claimData.credited, POINTS.VIDEO_REWARD);
  }
  const claimAgain = data<{ alreadyClaimed: boolean; credited: number }>(await post('/points/tasks/daily_video/claim'));
  assert.equal(claimAgain.alreadyClaimed, true, '当天三次用完后走幂等返回');
  assert.equal(claimAgain.credited, 0);

  // 11) 收尾 summary：余额按账本逐笔算（兑换把刚 seed 的目录价扣光，之后补签 +3、签到 +4、
  //     视频三次各发 POINTS.VIDEO_REWARD，分值改了这里不用动字面量）、卡已用掉、任务状态已领取
  const expectedBalance = 3 + 4 + 3 * POINTS.VIDEO_REWARD;
  const s3 = data<Summary>(await get('/points/summary'));
  assert.equal(s3.balance, expectedBalance);
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

  // 12) 明细分页：种子发放按日上限拆成 ceil(价/100) 条，加兑换/补签/签到/视频三次共 6 条；余额与 summary 一致
  const seedRows = Math.ceil(price / POINTS.DAILY_CAP);
  const totalRecords = seedRows + 6;
  const p1 = data<RecordPage>(await get('/points/records?page=1&pageSize=2'));
  assert.equal(p1.total, totalRecords);
  assert.equal(p1.items.length, 2);
  assert.equal(p1.balance, expectedBalance);
  assert.deepEqual(p1.items.map((i) => i.type), ['task_daily_video', 'task_daily_video'], '按时间倒序');
  assert.equal(p1.items[0].delta, POINTS.VIDEO_REWARD, '视频发放流水记的是 VIDEO_REWARD，不锁字面量');
  assert.equal(p1.items[0].balanceAfter, expectedBalance);

  const p3 = data<RecordPage>(await get(`/points/records?page=${Math.ceil(totalRecords / 2)}&pageSize=2`));
  assert.ok(p3.items.length >= 1, '末页必须有行（分页总数与实收条数要自洽）');
  assert.deepEqual(
    [...new Set(p3.items.map((i) => i.type))], ['seed'],
    '时间倒序走到末页只剩造余额的种子发放行',
  );

  // 非法分页参数回落默认值，pageSize 上限 50：一页装下全部实收条数
  const clamped = data<RecordPage>(await get('/points/records?page=0&pageSize=999'));
  assert.equal(clamped.items.length, totalRecords);
  assert.equal(clamped.total, totalRecords);
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
  // 按目录实时价凑余额（2026-10-29 起补签卡价 99）：写死常量会在运营改价的当天假红
  await seedPoints(userId, (await makeupCatalog())?.price ?? 0);
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
  assert.equal(r.balance, POINTS.MAKEUP_CARD_PRICE + 1 + 97 + 4 + 2, '卡是直接发的、没走兑换扣分');

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

/**
 * ===== Task 9：懒结算挂用户入口（PR-R* / PR-D* / PR-L1）=====
 *
 * 共享 dev 库纪律：这些用例一律 stub 掉真结算实现（lazySettleDeps.settle），
 * 绝不在开着的灰度开关下跑真 settleDueForUser——它每一脚做**全榜**结算，
 * 在开发库上会替真实平台用户发钱、留下 board_reward 与台账行。
 * 真结算的算法与时序语义由 test/points-board.test.ts 端到端覆盖；
 * 本段只证三件事：入口挂上了（调度发生在请求内且只带 userId+now）、
 * 主响应不依赖它（pending/抛错都照常 200）、开关关闭零调度。
 *
 * 调度只收 (userId, now) 两个入参：period/periodKey 一律由 settleDueForUser 自己派生，
 * 路由的 query/body 不参与（Task 7 交接约束 3）。
 */

const summaryStatsGet = (url: string) =>
  app.inject({ method: 'GET', url: `${API}/stats/${url}`, headers: auth() });

test('PR-R1 进积分页会触发上一周结算（各一次请求内完成，不额外发请求）', async (t) => {
  resetLazySettleDebounceForTest();
  const calls: [string, number][] = [];
  // 永不 resolve 的结算：响应若敢 await 它，inject 就会挂死——超时即红，反向证明懒（fire-and-forget）
  const pending = new Promise<void>(() => {});
  t.mock.method(lazySettleDeps, 'settle', (u: string, now: number) => {
    calls.push([u, now]);
    return pending;
  });
  const enabled = BOARD_REWARDS.enabled;
  BOARD_REWARDS.enabled = true;
  try {
    const before = Date.now();
    const res = await get('/points/summary');
    assert.equal(res.statusCode, 200, res.body);
    const s = data<Summary>(res);
    assert.equal(typeof s.balance, 'number');
    assert.equal(s.signin.cells.length, 7, 'summary 主体照常下发（不等同步结算）');
    assert.equal(calls.length, 1, 'summary 请求内应调度一次懒结算');
    assert.equal(calls[0][0], userId, '调度必须只针对本人');
    assert.ok(calls[0][1] >= before && calls[0][1] <= Date.now(), 'now 由请求时刻传入');
  } finally {
    BOARD_REWARDS.enabled = enabled;
  }
});

test('PR-R2 结算失败不拖垮 summary（reject 与同步抛都吞掉，主响应 200 载荷照常）', async (t) => {
  resetLazySettleDebounceForTest();
  const enabled = BOARD_REWARDS.enabled;
  BOARD_REWARDS.enabled = true;
  try {
    // ① 后台 promise reject：必须被 .catch 吞掉（摘掉 swallow 会变 unhandledRejection 打挂进程）
    t.mock.method(lazySettleDeps, 'settle', async () => { throw new Error('boom：结算炸了'); });
    const res1 = await get('/points/summary');
    assert.equal(res1.statusCode, 200, res1.body);
    const s1 = data<Summary>(res1);
    assert.ok(Array.isArray(s1.items), '载荷字段照常');
    t.mock.restoreAll();

    // ② 同步抛（比 reject 更狠：绕过 .catch 的写法会直接 500）
    resetLazySettleDebounceForTest();
    t.mock.method(lazySettleDeps, 'settle', (() => { throw new Error('boom：同步抛'); }) as typeof lazySettleDeps.settle);
    const res2 = await get('/points/summary');
    assert.equal(res2.statusCode, 200, res2.body);
    assert.equal(typeof data<Summary>(res2).balance, 'number');
    t.mock.restoreAll();

    // ③ 榜单页同规格：后台抛错不许把 /leaderboard 变 500
    resetLazySettleDebounceForTest();
    t.mock.method(lazySettleDeps, 'settle', async () => { throw new Error('boom：榜单侧结算炸了'); });
    const res3 = await summaryStatsGet('leaderboard?type=running&period=week');
    assert.equal(res3.statusCode, 200, res3.body);
    assert.ok(Array.isArray(res3.json().data.top), '榜单主体照常');
    t.mock.restoreAll();
  } finally {
    BOARD_REWARDS.enabled = enabled;
  }
});

test('PR-R3 开关关闭时不调度（两个入口都零调度开销）', async (t) => {
  resetLazySettleDebounceForTest();
  const calls: string[] = [];
  t.mock.method(lazySettleDeps, 'settle', (u: string) => { calls.push(u); return Promise.resolve(); });
  assert.equal(BOARD_REWARDS.enabled, false, '灰度开关默认必须 false（spec §6），本用例不许翻它');
  try {
    const res = await get('/points/summary');
    assert.equal(res.statusCode, 200, res.body);
    const lb = await summaryStatsGet('leaderboard?type=running&period=week');
    assert.equal(lb.statusCode, 200, lb.body);
    assert.equal(calls.length, 0, '开关关闭：连调度都不发起（SP-4 语义在入口层再钉一道）');
  } finally {
    t.mock.restoreAll();
  }
});

test('PR-D1 每用户限频：窗口内同用户第二次进页不再调度（两入口共用同一闸门）', async (t) => {
  resetLazySettleDebounceForTest();
  let n = 0;
  t.mock.method(lazySettleDeps, 'settle', () => { n += 1; return Promise.resolve(); });
  const enabled = BOARD_REWARDS.enabled;
  BOARD_REWARDS.enabled = true;
  try {
    const r1 = await get('/points/summary');
    assert.equal(r1.statusCode, 200, r1.body);
    assert.equal(n, 1);
    // 同用户紧接着打榜单页：限频命中，不再调度（响应照常 200）
    const r2 = await summaryStatsGet('leaderboard?type=running&period=week');
    assert.equal(r2.statusCode, 200, r2.body);
    assert.equal(n, 1, `${SETTLE_TRIGGER_WINDOW_MS / 60000} 分钟窗口内第二次进页必须被限频`);
  } finally {
    BOARD_REWARDS.enabled = enabled;
    t.mock.restoreAll();
  }
});

test('PR-D2 限频按注入时刻放行：窗口内拦、到点放（纯 helper 单测，假 id 不碰库）', async (t) => {
  const fake = `debounce-unit-${Date.now()}`;
  let n = 0;
  t.mock.method(lazySettleDeps, 'settle', () => { n += 1; return Promise.resolve(); });
  const enabled = BOARD_REWARDS.enabled;
  BOARD_REWARDS.enabled = true;
  try {
    const T = Date.now();
    scheduleLazySettle(fake, T);
    assert.equal(n, 1, '首次调度');
    scheduleLazySettle(fake, T + SETTLE_TRIGGER_WINDOW_MS - 1);
    assert.equal(n, 1, '窗口内（差 1ms）拦截');
    scheduleLazySettle(fake, T + SETTLE_TRIGGER_WINDOW_MS);
    assert.equal(n, 2, '整窗过后放行');
    // 空串 userId（游客防御的第二道闸）永不调度
    scheduleLazySettle('', T + SETTLE_TRIGGER_WINDOW_MS);
    assert.equal(n, 2, '空 userId 不配占用闸门');
  } finally {
    BOARD_REWARDS.enabled = enabled;
    t.mock.restoreAll();
  }
});

test('PR-L1 游客看榜不给任何人触发结算；登录用户看榜触发一次', async (t) => {
  resetLazySettleDebounceForTest();
  const calls: [string, number][] = [];
  t.mock.method(lazySettleDeps, 'settle', (u: string, now: number) => {
    calls.push([u, now]);
    return Promise.resolve();
  });
  const enabled = BOARD_REWARDS.enabled;
  BOARD_REWARDS.enabled = true;
  try {
    // 游客：不带 token。榜单照常 200，但绝不允许替「某个用户」结算
    const guest = await app.inject({ method: 'GET', url: `${API}/stats/leaderboard?type=running&period=week` });
    assert.equal(guest.statusCode, 200, guest.body);
    assert.equal(guest.json().data.me, null, '游客 me 仍为 null（LB-G1 口径不回归）');
    assert.equal(calls.length, 0, '游客请求不许触发结算');
    // 登录用户：触发一次，且只带 (userId, now)——period 查询参数不参与调度
    const member = await summaryStatsGet('leaderboard?type=running&period=month');
    assert.equal(member.statusCode, 200, member.body);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], userId);
  } finally {
    BOARD_REWARDS.enabled = enabled;
    t.mock.restoreAll();
  }
});

test('PR-L2 测试缝的默认绑定就是 settleDueForUser（Task 9 接线钉死，不许悄悄换成 no-op）', () => {
  // 上面 PR-R*/PR-D*/PR-L1 全用 t.mock.method 替换 lazySettleDeps.settle——若默认绑定被改成
  // 空函数，那些用例照样绿（mock 覆盖了缝），1039 也全绿，但线上懒结算从此停摆。
  // 这条不经 mock 的直断言补上唯一的钉：入口层挂进 Map 闸门、后台调用的那个函数**本体**是谁。
  assert.equal(lazySettleDeps.settle, settleDueForUser, 'board-lazy-settle.ts 的 lazySettleDeps.settle 必须绑定 points-board 的 settleDueForUser');
});
