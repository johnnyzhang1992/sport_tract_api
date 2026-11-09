/**
 * 榜单上榜通知（2026-11-05 产品裁定）。
 *
 * 口径：周榜/月榜前 10 名（含并列）每人每周期一条汇总；年榜不发；
 * **与发分开关解耦**——关闸时没人收到到账通知，前 3 名也要发；开闸时已有
 * credited/revoked 台账行（真的发过到账/撤回通知）的人被排除，不重复发。
 *
 * 覆盖：
 * - OL-1 纯函数 planOnTheList：前 N 名、并列全含、跨榜按用户汇总
 * - OL-2 纯函数 onTheListContent：单项 / 多项汇总文案（服务端统一生成）
 * - OL-3 开关关闭：前 3 名也收到上榜通知（且没有积分发放）
 * - OL-4 开关开启：前 3 名拿积分+到账通知，上榜通知只覆盖第 4-10 名
 * - OL-5 幂等：同上单元重复调用不新增通知（dedupeKey 唯一）
 * - OL-6 年榜不发；周期未结束不发
 *
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/board-on-the-list.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { ActivityModel } from '../src/models/activity.model.js';
import {
  BoardSettlementModel,
  PointAccountModel,
  PointDailyModel,
  PointLotModel,
  PointRecordModel,
} from '../src/models/point.model.js';
import { NotificationModel } from '../src/models/notification.model.js';
import { AppSettingModel } from '../src/models/app-setting.model.js';
import { config } from '../src/config/index.js';
import { BJ_OFFSET_MS } from '../src/utils/bj-time.js';
import { MIN_PLAUSIBLE_PACE_SEC_PER_KM } from '../src/config/constants.js';
import {
  onTheListTitle,
  boardOnTheListDedupeKey,
  notifyOnTheListOfBoards,
  onTheListContent,
  planOnTheList,
  settlePeriod,
  type BoardPeriod,
} from '../src/services/points-board.js';
import { resetBoardSwitchCacheForTest, setBoardRewardsEnabled } from '../src/services/board-switch.js';

const DAY_MS = 86_400_000;
const BJ = 8 * 3600_000;
const bjMid = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) - BJ;

/**
 * 专用周期单元（远离真实数据，也远离 points-board.test.ts 的 WEEK_KEYS 区间）：
 * 用 2031 年的周与月，避免与真实用户/其它夹具的单元互相污染。
 */
const WEEK_KEY = '2031-03-03'; // 周一
const WEEK_START = bjMid(2031, 3, 3);
const WEEK_END = WEEK_START + 7 * DAY_MS;
const MONTH_KEY = '2031-03';
const MONTH_START = bjMid(2031, 3, 1);
const MONTH_END = bjMid(2031, 4, 1);

const seededUsers: Types.ObjectId[] = [];

function mkUser(): Types.ObjectId {
  const u = new Types.ObjectId();
  seededUsers.push(u);
  return u;
}

async function mkActivity(userId: Types.ObjectId, type: string, distance: number, startTime: number) {
  await ActivityModel.create({
    userId,
    type,
    status: 'finished',
    startTime,
    distance,
    // 完全可信的形状：配速取可信下限之上
    avgPace: MIN_PLAUSIBLE_PACE_SEC_PER_KM + 100,
  });
}

/** 造一条 12 人参与的跑步榜（过 minParticipants=10 门槛），距离 12000..1000 递减 */
async function seedRunBoard(startMs: number): Promise<Types.ObjectId[]> {
  const users: Types.ObjectId[] = [];
  for (let i = 0; i < 12; i += 1) {
    const u = mkUser();
    users.push(u);
    await mkActivity(u, 'running', 12_000 - i * 1000, startMs + DAY_MS);
  }
  return users;
}

/**
 * 清理必须**收全账本五件套**（流水/账户/批次/日汇总/台账）：OL-4 会真跑 settlePeriod 发积分，
 * 只删流水不删账户/日汇总会把别的用例的「balance == 毛发放 − 撤回 − 兑换 − 过期」不变式打红。
 * 台账含哨兵行（board 级），按本文件独有的 periodKey 收口。
 */
async function cleanup() {
  await ActivityModel.deleteMany({ userId: { $in: seededUsers } });
  await NotificationModel.deleteMany({ userId: { $in: seededUsers } });
  await PointRecordModel.deleteMany({ userId: { $in: seededUsers } });
  await PointAccountModel.deleteMany({ userId: { $in: seededUsers } });
  await PointLotModel.deleteMany({ userId: { $in: seededUsers } });
  await PointDailyModel.deleteMany({ userId: { $in: seededUsers } });
  await BoardSettlementModel.deleteMany({ periodKey: { $in: [WEEK_KEY, MONTH_KEY] } });
  await AppSettingModel.deleteMany({ _id: 'boardRewardsEnabled' });
  resetBoardSwitchCacheForTest();
  seededUsers.length = 0;
}

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
});

after(async () => {
  await cleanup();
  await mongoose.disconnect().catch(() => {});
});

/* ------------------------------- 纯函数 ------------------------------- */

test('OL-1 planOnTheList：前 N 名 + 并列全含 + 跨榜按用户汇总', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    userId: `u${i + 1}`,
    distance: 12_000 - i * 1000,
  }));
  // u4 与 u5 距离相同（并列第 4）——用同一距离造出并列
  rows[4].distance = rows[3].distance;
  const plan = planOnTheList([{ type: 'running', rows }], 10);
  assert.deepEqual([...plan.keys()].sort(), ['u1', 'u10', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9'].sort(),
    '前 10 名（并列让 u5 也进来，u11/u12 不进）');
  assert.deepEqual(plan.get('u1'), [{ type: 'running', rank: 1 }]);
  assert.deepEqual(plan.get('u4'), [{ type: 'running', rank: 4 }]);
  assert.deepEqual(plan.get('u5'), [{ type: 'running', rank: 4 }], '并列同名次');
  assert.equal(plan.has('u11'), false, '第 11 名不上榜');

  // 跨榜汇总：u1 同时在跑步榜第 1、骑行榜第 2
  const plan2 = planOnTheList([
    { type: 'running', rows: [{ userId: 'u1', distance: 100 }, { userId: 'u2', distance: 90 }] },
    { type: 'cycling', rows: [{ userId: 'u3', distance: 100 }, { userId: 'u1', distance: 90 }] },
  ], 10);
  assert.deepEqual(plan2.get('u1'), [
    { type: 'running', rank: 1 },
    { type: 'cycling', rank: 2 },
  ], '一个人上多个榜要合并到同一条');
});

test('OL-2 onTheListContent：多行分块、逐榜一行、名次好的排前面', () => {
  const one = onTheListContent('week', WEEK_KEY, [{ type: 'running', rank: 3 }]);
  const oneLines = one.split('\n');
  assert.equal(oneLines[0], '恭喜！你在「跑步榜」获得第 3 名');
  assert.equal(oneLines[1], '', '结论与周期之间留空行');
  assert.match(one, /^统计周期：/m);
  assert.equal(one.includes('这一周'), false, '统计周期不带「这一周」后缀');
  assert.match(one, /继续加油/);

  const many = onTheListContent('month', MONTH_KEY, [
    { type: 'running', rank: 5 },
    { type: 'cycling', rank: 2 },
  ]);
  const lines = many.split('\n');
  assert.equal(lines[0], '恭喜！你在本期榜单上榜 2 项');
  assert.equal(lines[1], '', '空行分隔');
  assert.equal(lines[2], '骑行榜：第 2 名', '名次好的排前面');
  assert.equal(lines[3], '跑步榜：第 5 名');
  assert.equal(many.includes('最高名次'), false, '删最高名次行（明细首行即最好成绩）');
  assert.equal(many.includes('。最高'), false, '不再是一段到底的长句');
});

/* ------------------------------ 端到端 ------------------------------ */

test('OL-3 发分开关关闭：前 3 名也收到上榜通知，且不发积分', async () => {
  await cleanup();
  await setBoardRewardsEnabled(false);
  const users = await seedRunBoard(WEEK_START);

  const r = await notifyOnTheListOfBoards('week', WEEK_KEY, WEEK_END, WEEK_END);
  assert.ok(r.notified >= 10, `至少前 10 名各一条，实际 ${r.notified}`);

  const top1 = await NotificationModel.findOne({
    dedupeKey: boardOnTheListDedupeKey('week', WEEK_KEY, String(users[0])),
  }).lean();
  assert.ok(top1, '开关关着，第 1 名也要收到上榜通知（他没有到账通知）');
  assert.equal(top1?.title, onTheListTitle('week'), '标题带榜单周期类型');
  assert.equal(top1?.category, 'sports', '归类运动数据，不再挂榜单奖励');
  assert.equal(top1?.published, true);

  assert.equal(
    await PointRecordModel.countDocuments({ type: 'board_reward', refId: `running:week:${WEEK_KEY}` }),
    0,
    '开关关着不发积分',
  );
});

test('OL-4 发分开关开启：前 3 名拿积分+到账通知，上榜通知只覆盖第 4 名之后', async () => {
  await cleanup();
  await setBoardRewardsEnabled(true);
  const users = await seedRunBoard(WEEK_START);

  // 先跑正常结算（发分 + 到账通知）
  await settlePeriod('week', WEEK_KEY, WEEK_END, WEEK_END);
  const credited = await BoardSettlementModel.countDocuments({ periodKey: WEEK_KEY, status: 'credited' });
  assert.ok(credited >= 3, `应至少发 3 人，实际 ${credited}`);

  const r = await notifyOnTheListOfBoards('week', WEEK_KEY, WEEK_END, WEEK_END);
  assert.ok(r.notified >= 7, `第 4-10 名应各一条，实际 ${r.notified}`);

  // 前 3 名：有到账通知，没有上榜通知
  for (const idx of [0, 1, 2]) {
    const uid = String(users[idx]);
    const credit = await NotificationModel.countDocuments({
      userId: users[idx], title: '榜单积分奖励到账',
    });
    const onList = await NotificationModel.countDocuments({
      dedupeKey: boardOnTheListDedupeKey('week', WEEK_KEY, uid),
    });
    assert.equal(credit, 1, `第 ${idx + 1} 名应有到账通知`);
    assert.equal(onList, 0, `第 ${idx + 1} 名不应再收到上榜通知（不重复）`);
  }
  // 第 4 名：只有上榜通知
  const fourth = users[3];
  assert.equal(await NotificationModel.countDocuments({ userId: fourth, title: '榜单积分奖励到账' }), 0);
  assert.equal(
    await NotificationModel.countDocuments({ dedupeKey: boardOnTheListDedupeKey('week', WEEK_KEY, String(fourth)) }),
    1,
    '第 4 名应有上榜通知',
  );
});

test('OL-5 幂等：同一单元重复调用不新增通知', async () => {
  await cleanup();
  await setBoardRewardsEnabled(false);
  await seedRunBoard(WEEK_START);
  await notifyOnTheListOfBoards('week', WEEK_KEY, WEEK_END, WEEK_END);
  const first = await NotificationModel.countDocuments({ title: onTheListTitle('week') });
  await notifyOnTheListOfBoards('week', WEEK_KEY, WEEK_END, WEEK_END);
  const second = await NotificationModel.countDocuments({ title: onTheListTitle('week') });
  assert.equal(second, first, '重复 pass 不能多发（dedupeKey 唯一）');
});

test('OL-6 年榜不发；周期未结束不发', async () => {
  await cleanup();
  await setBoardRewardsEnabled(false);
  await seedRunBoard(WEEK_START);
  const year = await notifyOnTheListOfBoards('year', '2031', bjMid(2032, 1, 1), bjMid(2032, 1, 1));
  assert.equal(year.notified, 0, '年榜不发上榜通知');
  const early = await notifyOnTheListOfBoards('week', WEEK_KEY, WEEK_END, WEEK_START + DAY_MS);
  assert.equal(early.notified, 0, '周期还没结束不发');
});
