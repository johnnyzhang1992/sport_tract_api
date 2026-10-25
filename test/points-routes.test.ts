import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import {
  PointAccountModel, PointCardModel, PointExchangeModel, PointLotModel, PointRecordModel,
  PointSigninModel, PointTaskModel,
} from '../src/models/point.model.js';
import { UserModel } from '../src/models/user.model.js';
import { LoginLogModel } from '../src/models/login-log.model.js';
import { POINTS } from '../src/config/points.js';
import { creditPoints } from '../src/services/points-ledger.js';
import { bjDateStr } from '../src/utils/bj-time.js';
import { previousDateKey } from '../src/utils/points-domain.js';

/**
 * /points/* HTTP 接线：登录闸门、汇总结构、以及「汇总 → 兑换 → 补签 → 签到 → 领任务」全链路。
 *
 * 时间是路由内 Date.now()，所以造数据一律相对「今天（东八区）」：
 * 前天有签到行（补签卡可用的前提）、昨天/今天留空（补签只能补昨天）。
 * 清理只动本用例自己登录出来的那个用户及其积分行，不碰库里其他数据。
 */

const API = '/sport-track/api';
const DAY = 86400000;

const TODAY = bjDateStr(Date.now());
const YESTERDAY = previousDateKey(TODAY);
const DAY_BEFORE = previousDateKey(YESTERDAY);

interface SigninState {
  todaySigned: boolean;
  streakDay: number;
  todayReward: number;
  nextReward: number;
  canMakeUp: boolean;
  makeupDate: string;
  cards: number;
}

interface TaskRow {
  key: string;
  title: string;
  points: number;
  status: string;
  actionText: string;
}

interface Summary {
  balance: number;
  signin: SigninState;
  tasks: TaskRow[];
  item: { key: string; price: number; validDays: number };
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

  // 前天签到：补签卡「只能补昨天」的前提；昨天/今天留空
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
    ['POST', '/points/cards/000000000000000000000000/use'],
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
  assert.equal(s0.signin.todaySigned, false);
  assert.equal(s0.signin.streakDay, 0);
  assert.equal(s0.signin.todayReward, 0);
  assert.equal(s0.signin.nextReward, 1, '首签 1 分');
  assert.equal(s0.signin.cards, 0);
  assert.equal(s0.signin.canMakeUp, false, '没有卡不能补签');
  assert.equal(s0.tasks.length, 5);
  assert.ok(s0.tasks.every((t) => t.status !== 'claimed'), '新用户没有已领取任务');
  assert.equal(s0.item.key, 'makeup_card');
  assert.equal(s0.item.price, POINTS.MAKEUP_CARD_PRICE);

  // 2) 授 200 分后 summary 余额同步
  await seedPoints(userId, POINTS.MAKEUP_CARD_PRICE);
  const s1 = data<Summary>(await get('/points/summary'));
  assert.equal(s1.balance, 200);

  // 3) 商品列表
  const items = data<{ key: string; price: number; validDays: number }[]>(await get('/points/items'));
  assert.equal(items.length, 1);
  assert.equal(items[0].key, 'makeup_card');
  assert.equal(items[0].price, 200);
  assert.equal(items[0].validDays, POINTS.MAKEUP_CARD_VALID_DAYS);

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

  // 5) 汇总带出未使用卡数量与可补签日期（昨天）
  const s2 = data<Summary>(await get('/points/summary'));
  assert.equal(s2.balance, 0);
  assert.equal(s2.signin.cards, 1);
  assert.equal(s2.signin.canMakeUp, true);
  assert.equal(s2.signin.makeupDate, YESTERDAY);

  // 6) 非法卡 id → service 的 400 原样透出
  const badCard = await post('/points/cards/not-an-object-id/use');
  assert.equal(badCard.statusCode, 400, badCard.body);
  assert.match(badCard.json().message, /补签卡/);

  // 7) 用卡补签昨天：连签接到前天（3），得 3 分；今天仍未签到
  const used = await post(`/points/cards/${cardId}/use`);
  assert.equal(used.statusCode, 200, used.body);
  const useData = data<{ credited: number; balance: number } & SigninState>(used);
  assert.equal(useData.credited, 3);
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
  assert.equal(s3.signin.canMakeUp, false);
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

test('PR3 路由参数错误透出 service 的 400/404', async () => {
  const noRequestId = await post('/points/items/makeup_card/exchange', {});
  assert.equal(noRequestId.statusCode, 400, noRequestId.body);
  assert.match(noRequestId.json().message, /兑换请求 ID/);

  const unknownTask = await post('/points/tasks/not_a_task/claim');
  assert.equal(unknownTask.statusCode, 404, unknownTask.body);
  assert.match(unknownTask.json().message, /任务不存在/);
});
