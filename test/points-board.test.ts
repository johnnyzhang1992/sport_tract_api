import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import mongoose, { Types } from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { ActivityModel } from '../src/models/activity.model.js';
import {
  trustedBoardRows,
  planPeriodRewards,
  flattenWithPerUserCap,
  type BoardCandidate,
  type BoardReward,
  type PlanOpts,
} from '../src/services/points-board.js';
import { hasNoPace, NO_PACE_TYPES } from '../src/utils/pace.js';
import { DRIFT_SCORE_PB_GATE, MIN_PLAUSIBLE_PACE_SEC_PER_KM, ACTIVITY_TYPES } from '../src/config/constants.js';

/**
 * 榜单发分专用的可信轨迹聚合（spec §7：发分口径比展示多四道防刷判据）。
 * - 四道判据逐条单独钉（PB-1..4），删掉任意一道守卫对应命名用例必须红；
 *   BR-1 是 brief 的组合口径，四道任意一道失效它同样红。
 * - BR-2 显式钉「缺字段＝可信」：vehicleMs/driftScore/corrected 用 $not/$gt、$ne 惯用法，
 *   判据写成 $lte/$gte 形态会把老文档全排掉（发分少钱且无声）。
 * - avgPace 与上面相反是**强要求**（缺/为 null 不计），BR-2b 钉住这个不对称是有意的，
 *   有人把 $gte「顺手统一」成 $not/$lt 形态时这里先红。
 * - 但配速判据只对「会算配速」的类型生效：游泳/骑行的 avgPace 恒为 null（utils/pace.ts
 *   的设计），PB-9/PB-9b 钉住这两类照样能进发分口径，否则总距离榜对它们永远空榜
 *   （spec §4.8「各运动类型的全国榜按总距离排名，前三名获得积分」就成了假话）；
 *   同一条用例同时钉住「其余三道判据一个都没跟着松掉」。
 *
 * 共享 dev 库纪律：每个用例用自造 ObjectId（不落 user 文档），窗口取本次运行的专属
 * 1 分钟区间（startTime ∈ [WIN_START, WIN_END)），断言只按自己的 userId 收口，
 * 不声明平台绝对值；after 删光本文件种下的轨迹。
 */

const WIN_START = Date.now();
const WIN_END = WIN_START + 60_000;
const NOW = WIN_START + 1_000;

let app: FastifyInstance;
const seededUsers: Types.ObjectId[] = [];

function mkUser(): Types.ObjectId {
  const u = new Types.ObjectId();
  seededUsers.push(u);
  return u;
}

/** 造一条 finished 轨迹；默认值是「完全可信」的形状（配速取可信下限之上的正值） */
async function mkActivity(
  userId: Types.ObjectId,
  type: string,
  distance: number,
  fields: Record<string, unknown> = {},
) {
  const doc = await ActivityModel.create({
    userId,
    type,
    status: 'finished',
    startTime: NOW,
    distance,
    avgPace: MIN_PLAUSIBLE_PACE_SEC_PER_KM + 100,
    ...fields,
  });
  return String(doc._id);
}

/** 本用户在某类型榜窗口内的可信总距离（无行＝0） */
async function totalForType(type: string, userId: Types.ObjectId): Promise<number> {
  const rows = await trustedBoardRows(type, WIN_START, WIN_END);
  return rows.find((r) => r.userId === String(userId))?.distance ?? 0;
}

/** 本用户在 running 榜窗口内的可信总距离（无行＝0） */
async function totalFor(userId: Types.ObjectId): Promise<number> {
  return totalForType('running', userId);
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  // 清理失败必须可见：吞掉错误会把本文件种下的测试轨迹永久留在共享 dev 库，
  // 后续所有按窗口/类型聚合的用例（含榜单类）会被无声污染
  try {
    await ActivityModel.deleteMany({ userId: { $in: seededUsers } });
  } catch (err) {
    console.error('[points-board.test] fixture 轨迹清理失败，dev 库有残留', err);
  }
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

test('BR-1 疑似搭车/漂移超标/配速不合理/未纠偏的轨迹不计入发分距离', async () => {
  const u = mkUser();
  await mkActivity(u, 'running', 5_000, {});                                     // 可信
  await mkActivity(u, 'running', 50_000, { vehicleMs: 600_000 });                // 搭车
  await mkActivity(u, 'running', 50_000, { driftScore: DRIFT_SCORE_PB_GATE + 1 });
  await mkActivity(u, 'running', 50_000, { avgPace: MIN_PLAUSIBLE_PACE_SEC_PER_KM - 1 });
  await mkActivity(u, 'running', 50_000, { corrected: false });
  const rows = await trustedBoardRows('running', WIN_START, WIN_END);
  assert.equal(
    rows.find((r) => r.userId === String(u))!.distance,
    5_000,
    '四条不可信轨迹一条都不该进合计',
  );
});

test('PB-1 vehicleMs>0（疑似搭车）单独被第一道判据拦下', async () => {
  const u = mkUser();
  await mkActivity(u, 'running', 5_000, {});
  await mkActivity(u, 'running', 50_000, { vehicleMs: 600_000 });
  assert.equal(await totalFor(u), 5_000, '搭车行不该进发分合计');
});

test('PB-2 driftScore 超门禁单独被第二道判据拦下', async () => {
  const u = mkUser();
  await mkActivity(u, 'running', 5_000, {});
  // 恰好等于门禁不算超（$not/$gt 语义：> gate 才排除），gate+1 才排除
  await mkActivity(u, 'running', 3_000, { driftScore: DRIFT_SCORE_PB_GATE });
  await mkActivity(u, 'running', 50_000, { driftScore: DRIFT_SCORE_PB_GATE + 1 });
  assert.equal(await totalFor(u), 8_000, '漂移超门禁行不该进发分合计；恰等于门禁的仍可信');
});

test('PB-3 avgPace 低于可信下限单独被第三道判据拦下', async () => {
  const u = mkUser();
  await mkActivity(u, 'running', 5_000, {});
  await mkActivity(u, 'running', 50_000, { avgPace: MIN_PLAUSIBLE_PACE_SEC_PER_KM - 1 });
  assert.equal(await totalFor(u), 5_000, '不可能配速的行不该进发分合计');
});

test('PB-4 corrected:false（未纠偏）单独被第四道判据拦下', async () => {
  const u = mkUser();
  await mkActivity(u, 'running', 5_000, {});
  await mkActivity(u, 'running', 50_000, { corrected: false });
  assert.equal(await totalFor(u), 5_000, '未纠偏的行不该进发分合计');
});

test('BR-2 缺 vehicleMs/driftScore/corrected 字段的老文档按可信处理（$not/$gt 惯用法）', async () => {
  const u = mkUser();
  const legacy = await mkActivity(u, 'running', 7_000, {});
  // 模拟字段上线前入库的老文档：schema 默认写进去的值也 $unset 掉，让它真的没有该字段
  await ActivityModel.updateOne({ _id: legacy }, { $unset: { vehicleMs: 1, driftScore: 1, corrected: 1 } });
  assert.equal(await totalFor(u), 7_000, '缺字段＝可信；判据若写成 $lte/$ne 缺省形态会把老轨迹全排掉');
});

test('BR-2b avgPace 缺失/null 不计入发分距离（配速是强要求，与 BR-2 的弱要求相反）', async () => {
  const u = mkUser();
  await mkActivity(u, 'running', 5_000, {});
  // 导入/老数据 avgPace 默认 null：$gte 判据把它挡在发分之外，这是 spec 拍板的不对称
  await mkActivity(u, 'running', 50_000, { avgPace: null });
  assert.equal(await totalFor(u), 5_000, 'avgPace 为 null 的行不该进发分合计（$not/$lt 化会让它混进来）');
  // 字段整个缺失（连 null 都没有）同样被挡：$gte 不匹配 missing
  const legacy = await mkActivity(u, 'running', 30_000, {});
  await ActivityModel.updateOne({ _id: legacy }, { $unset: { avgPace: 1 } });
  assert.equal(await totalFor(u), 5_000, 'avgPace 字段缺失的跑步行同样不该进发分合计');
});

test('PB-3b 跑步类 distance<200m 的行没有配速，继续被第三道判据挡在发分之外', async () => {
  const u = mkUser();
  await mkActivity(u, 'running', 5_000, {});
  // utils/pace.ts：跑步/步行等有配速的类型，距离不足 MIN_PACE_DISTANCE_M 时 avgPace 也是 null
  // → 发分口径下这类短行依然不计（有意保留，不是漏网）
  const short = await mkActivity(u, 'running', 150, { avgPace: null });
  await ActivityModel.updateOne({ _id: short }, { $unset: { avgPace: 1 } });
  assert.equal(await totalFor(u), 5_000, '跑不出可信配速的短行不该进发分合计');
});

test('PB-9 骑行榜：avgPace 恒为 null 仍计入发分，其余三道判据一条不松', async () => {
  const u = mkUser();
  // 骑行的 avgPace 是 pace.ts 设计出来的 null（不展示配速），不该因此永远发不到分
  await mkActivity(u, 'cycling', 5_000, { avgPace: null });
  assert.equal(await totalForType('cycling', u), 5_000, '干净骑行行该进发分合计');
  // 同一个用户挂上其它三道判据的脏行：只松配速判据，另外三道照旧拦
  await mkActivity(u, 'cycling', 50_000, { avgPace: null, vehicleMs: 600_000 });
  await mkActivity(u, 'cycling', 50_000, { avgPace: null, driftScore: DRIFT_SCORE_PB_GATE + 1 });
  await mkActivity(u, 'cycling', 50_000, { avgPace: null, corrected: false });
  await mkActivity(u, 'cycling', 50_000, { avgPace: null, status: 'cancelled' });
  assert.equal(await totalForType('cycling', u), 5_000, '搭车/超漂移/未纠偏/未完成的骑行行一条都不该进合计');
});

test('PB-9b 游泳榜：avgPace 恒为 null 仍计入发分，其余三道判据一条不松', async () => {
  const u = mkUser();
  await mkActivity(u, 'swimming', 3_000, { avgPace: null });
  assert.equal(await totalForType('swimming', u), 3_000, '干净游泳行该进发分合计');
  await mkActivity(u, 'swimming', 40_000, { avgPace: null, vehicleMs: 600_000 });
  await mkActivity(u, 'swimming', 40_000, { avgPace: null, driftScore: DRIFT_SCORE_PB_GATE + 1 });
  await mkActivity(u, 'swimming', 40_000, { avgPace: null, corrected: false });
  assert.equal(await totalForType('swimming', u), 3_000, '另外三道判据对游泳同样生效');
});

test('PB-5 只有 status=finished 的行进入发分口径', async () => {
  const u = mkUser();
  await mkActivity(u, 'running', 5_000, {});
  await mkActivity(u, 'running', 20_000, { status: 'in_progress' });
  await mkActivity(u, 'running', 30_000, { status: 'cancelled' });
  assert.equal(await totalFor(u), 5_000, '进行中/已取消的轨迹不该进发分合计');
});

test('PB-6 同一用户多条可信轨迹按 $sum 合计', async () => {
  const u = mkUser();
  await mkActivity(u, 'running', 2_000, {});
  await mkActivity(u, 'running', 3_000, {});
  assert.equal(await totalFor(u), 5_000, '可信行要逐条累加而不是只取一条');
});

test('PB-7 窗口边界：startMs 含、endMs 不含', async () => {
  const u = mkUser();
  await mkActivity(u, 'running', 1_000, { startTime: WIN_START });
  await mkActivity(u, 'running', 20_000, { startTime: WIN_END }); // 恰落下界＝下一窗口
  await mkActivity(u, 'running', 30_000, { startTime: WIN_START - 1 });
  assert.equal(await totalFor(u), 1_000, 'startTime ∈ [start, end)：两端越界行都不计入');
});

test('PB-8 输出形状：userId 为字符串、按可信总距离降序', async () => {
  const a = mkUser();
  const b = mkUser();
  await mkActivity(a, 'running', 9_000, {});
  await mkActivity(b, 'running', 5_000, {});
  await mkActivity(b, 'running', 50_000, { vehicleMs: 600_000 }); // 不可信，不该把 b 抬到 a 前
  const rows = await trustedBoardRows('running', WIN_START, WIN_END);
  const idxA = rows.findIndex((r) => r.userId === String(a));
  const idxB = rows.findIndex((r) => r.userId === String(b));
  assert.ok(idxA >= 0 && idxB >= 0, '两个用户都该在榜上');
  assert.ok(idxA < idxB, '可信距离 9000 的 a 应排在可信距离 5000 的 b 前（按可信合计排序）');
  assert.ok(rows.every((r) => typeof r.userId === 'string' && typeof r.distance === 'number'));
});

/**
 * PB-10 源码级守卫：「哪些类型不配算配速」与「哪些类型发分不要求配速」必须是同一份表。
 * 这两个规则分处 pace.ts 与 points-board.ts，一旦有人把泳/骑这对字面量抄进发分查询，
 * 以后 pace.ts 改表就只改了一半——症状是某类运动无声地发不到分，运行时用例很难发现，
 * 所以这里直接钉住：points-board 只许引符号，不许出现第二份字面量。
 */
test('PB-10 配速豁免表单一事实源（源码级守卫）', () => {
  const pair = /'(?:swimming|cycling)'\s*,\s*'(?:swimming|cycling)'/;
  const paceSrc = readFileSync(new URL('../src/utils/pace.ts', import.meta.url), 'utf8');
  const boardSrc = readFileSync(new URL('../src/services/points-board.ts', import.meta.url), 'utf8');

  // 事实源本身：pace.ts 导出的表内容 = 泳/骑，且这对字面量在 pace.ts 里只出现一次
  assert.deepEqual([...NO_PACE_TYPES].sort(), ['cycling', 'swimming'], 'NO_PACE_TYPES 只能有游泳/骑行');
  assert.equal(hasNoPace('cycling') && hasNoPace('swimming'), true);
  assert.equal(hasNoPace('running'), false);
  assert.equal(
    (paceSrc.match(new RegExp(pair.source, 'g')) ?? []).length,
    1,
    'pace.ts 里这对字面量必须只有一份（豁免表被复制进局部常量＝迟早漂移）',
  );

  // 消费方：points-board 引的是 pace.js 的符号，自己没有第二份字面量
  assert.match(boardSrc, /from '\.\.\/utils\/pace\.js'/, 'points-board 要从 pace.js 引豁免判据');
  assert.match(boardSrc, /hasNoPace\(/, 'points-board 的配速判据要按 hasNoPace 生效');
  assert.doesNotMatch(boardSrc, pair, 'points-board 不许再抄一份游泳/骑行字面量数组');
});

/* ====================================================================
 * planPeriodRewards / flattenWithPerUserCap —— 结算数学（Task 5）
 *
 * 纯函数用例：不碰库、不碰 mongoose、不依赖时钟，PR-* 的断言全部由下表手算得出。
 * 上面的 PB/BR 系列是聚合口径用例（要 dev 库），两者同文件只是共用夹具目录，
 * PR-* 自身没有任何 await，输入全是内存里的 BoardCandidate[]。
 *
 * 数字表（spec §3 D2/D4/D5 ＋ D10 保留意见，逐字取 plan Task 5）：
 *   rewards：周 50/30/20、月 100/80/50、年 500/400/300（TOP1/2/3）
 *   minParticipants＝10（判定 rows.length **>** 10，恰好 10 人不发）
 *   perUserBoards＝3（同一期一个用户最多计 3 个榜）
 *   perBoardCapFactor＝2 → 单榜总额上限：周 (50+30+20)×2＝200、
 *                        月 (100+80+50)×2＝460、年 (500+400+300)×2＝1200
 *
 * 夹具纪律（避免"门槛代打"和"巧合绿"这两类本仓踩过的坑）：
 *   - many(n) 给 n 个**互不相等**的距离 1000,999,…，永不产生并列；
 *   - boardWithMeAt 每榜 11 行（10 个陪跑 ＋ me），PR-3 用 ACTIVITY_TYPES 的 8 个真实类型
 *     **全都过 >10 门槛**，所以砍掉 me 的第 4～8 条只能是 3 榜上限干的，不是门槛干的；
 *   - 陪跑 userId 带类型前缀（每个用户在每个榜只出现一次），只有 me 跨 8 榜，
 *     断言里"谁被砍"就只指向 3 榜上限这一条规则；
 *   - 距离取 1000/900/…/100 的宽间隔，me 想落第几名就给 1100/950/850，
 *     不会与任何陪跑同分（同分＝并列，会让"名次"断言变成巧合）；
 *   - PR-3 的 me 名次表刻意让"分值降序"≠"type 字典序"≠"入参顺序"，
 *     这样"上限按什么排序选榜"才是被断出来的，而不是碰巧一致。
 * ================================================================== */

const OPTS: PlanOpts = {
  rewards: { week: [50, 30, 20], month: [100, 80, 50], year: [500, 400, 300] },
  minParticipants: 10,
  perUserBoards: 3,
  perBoardCapFactor: 2,
};

/** n 个互不相等的距离：1000、999、998……（无并列） */
function many(n: number): BoardCandidate[] {
  return Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, distance: 1000 - i }));
}

/** 11 行的一榜：10 个陪跑（1000/900/…/100，互不相等）＋ me 在 meDistance */
function boardWithMeAt(type: string, meDistance: number): { type: string; rows: BoardCandidate[] } {
  const filler = Array.from({ length: 10 }, (_, i) => ({
    userId: `${type}#p${i}`,
    distance: 1000 - i * 100,
  }));
  return { type, rows: [...filler, { userId: 'me', distance: meDistance }] };
}

/** me 落第几名就给哪个距离（陪跑间距 100，绝不同分） */
const ME_DISTANCE_BY_RANK: Record<1 | 2 | 3, number> = { 1: 1100, 2: 950, 3: 850 };

const key = (r: BoardReward) => `${r.type}/${r.userId}#r${r.rank}/${r.points}`;

test('PR-1 恰好 10 人不发、11 人才发（门槛是「>10」不是「>=10」）', () => {
  // 10 行＝不越过门槛，整榜一分不发（这是产品拍板的严格大于，不是笔误）
  assert.deepEqual(planPeriodRewards('week', [{ type: 'running', rows: many(10) }], OPTS), []);
  assert.deepEqual(
    planPeriodRewards('week', [{ type: 'running', rows: many(9) }], OPTS),
    [],
    '人数不足门槛时整榜跳过，TOP3 一条都不发',
  );
  const got = planPeriodRewards('week', [{ type: 'running', rows: many(11) }], OPTS);
  assert.deepEqual(got.map(key), ['running/u0#r1/50', 'running/u1#r2/30', 'running/u2#r3/20']);
  assert.equal(got.length, 3, '11 人刚越过门槛：只发 TOP3');
  // 门槛是按榜算的：两榜一过一不过，只有过的那榜发钱
  const mixed = planPeriodRewards(
    'week',
    [
      { type: 'running', rows: many(11) },
      { type: 'cycling', rows: many(10) },
    ],
    OPTS,
  );
  assert.equal(mixed.length, 3);
  assert.ok(mixed.every((r) => r.type === 'running'), '没过门槛的榜不该混进结果');
  assert.deepEqual(planPeriodRewards('week', [], OPTS), [], '一个榜都没有＝空结果');
  assert.deepEqual(planPeriodRewards('week', [{ type: 'running', rows: [] }], OPTS), []);
});

test('PR-2 周榜 TOP1/2/3＝50/30/20；月榜＝100/80/50；年榜＝500/400/300', () => {
  const rows = many(11);
  const boards = [{ type: 'running', rows }];
  assert.deepEqual(
    planPeriodRewards('week', boards, OPTS).map((r) => `${r.rank}:${r.points}`),
    ['1:50', '2:30', '3:20'],
  );
  assert.deepEqual(
    planPeriodRewards('month', boards, OPTS).map((r) => `${r.rank}:${r.points}`),
    ['1:100', '2:80', '3:50'],
  );
  assert.deepEqual(
    planPeriodRewards('year', boards, OPTS).map((r) => `${r.rank}:${r.points}`),
    ['1:500', '2:400', '3:300'],
  );
  // 三档发放总额分别＝该榜 TOP3 之和（周 100、月 230、年 1200），都远低于各自的
  // 单榜上限（200/460/2400）——正常三人各得一条时 cap 根本不该出手
  assert.deepEqual(
    (['week', 'month', 'year'] as const).map(
      (p) => planPeriodRewards(p, boards, OPTS).reduce((s, r) => s + r.points, 0),
    ),
    [100, 230, 1200],
  );
});

test('PR-3 同一期最多计 3 个榜：8 类型都上榜只拿分值最高的 3 个', () => {
  // me 在 8 个榜上的名次（3 个第 1、3 个第 2、2 个第 3）。刻意让"分值降序"既不等于
  // type 字典序、也不等于 ACTIVITY_TYPES 的入参顺序——否则"上限按什么排序"这条断不出来。
  const ME_RANK: Record<string, 1 | 2 | 3> = {
    hiking: 3, // 20
    walking: 2, // 30
    running: 3, // 20
    cycling: 2, // 30
    mountaineering: 1, // 50 ← 留
    swimming: 1, // 50 ← 留
    skiing: 2, // 30
    rowing: 1, // 50 ← 留
  };
  const boards = ACTIVITY_TYPES.map((type) =>
    boardWithMeAt(type, ME_DISTANCE_BY_RANK[ME_RANK[type]]),
  );

  // 先自证夹具：8 个榜全过门槛（否则门槛会替 3 榜上限"代打"，用例假绿）
  assert.equal(boards.length, 8, '平台就是这 8 个运动类型，周榜一起结算');
  assert.ok(
    boards.every((b) => b.rows.length > OPTS.minParticipants),
    '夹具的每个榜都必须过 >10 门槛，不然 PR-3 断的是门槛不是上限',
  );
  assert.ok(
    boards.every((b) => new Set(b.rows.map((r) => r.userId)).size === b.rows.length),
    '同一榜内 userId 不重复（重复会让 3 榜上限的计数失去意义）',
  );
  // 只有 me 跨 8 榜：陪跑 userId 带类型前缀，各榜互不相同，所以被砍的 5 条必然都是 me 的
  assert.equal(
    boards.reduce((s, b) => s + b.rows.length, 0),
    88,
    '8 榜 × 11 行＝88 个"用户-榜"席位，除 me 的 8 个之外其余 80 个都是单榜用户',
  );

  const got = planPeriodRewards('week', boards, OPTS);
  const mine = got.filter((r) => r.userId === 'me');
  assert.equal(mine.length, OPTS.perUserBoards, '同一期最多计 3 个榜');
  assert.deepEqual(mine.map((r) => r.points).sort((a, b) => b - a), [50, 50, 50]);
  // 留的是三个 50 分榜（分值优先），砍掉的必须是 30/30/30/20/20 那五个低分榜
  assert.deepEqual(mine.map((r) => r.type).sort(), ['mountaineering', 'rowing', 'swimming']);
  assert.equal(got.length, 19, '8 榜各发 3 人＝24 条，me 被 3 榜上限砍掉 5 条');
  assert.equal(
    got.reduce((s, r) => s + r.points, 0),
    (50 + 30 + 20) * 8 - (30 + 30 + 30 + 20 + 20),
    '被砍的是 me 的五个低分榜共 130 分（800→670）',
  );
  assert.equal(
    mine.reduce((s, r) => s + r.points, 0),
    150,
    'me 三条 50 分＝150 分（3 榜上限后 me 本期到手的全部）',
  );
  // 完整展开（榜的入参顺序＝ACTIVITY_TYPES 顺序 → 榜内名次顺序）逐条钉死内容与顺序：可重放的依据
  assert.deepEqual(got.map(key), [
    // hiking / running：me 第 3 名（20 分）被砍，第 1、2 名照发
    'hiking/hiking#p0#r1/50',
    'hiking/hiking#p1#r2/30',
    // walking / cycling / skiing：me 第 2 名（30 分）被砍，第 1、3 名照发（名次跳过 2）
    'walking/walking#p0#r1/50',
    'walking/walking#p1#r3/20',
    'running/running#p0#r1/50',
    'running/running#p1#r2/30',
    'cycling/cycling#p0#r1/50',
    'cycling/cycling#p1#r3/20',
    // mountaineering / swimming / rowing：me 第 1 名（50 分）的三个榜保留
    'mountaineering/me#r1/50',
    'mountaineering/mountaineering#p0#r2/30',
    'mountaineering/mountaineering#p1#r3/20',
    'swimming/me#r1/50',
    'swimming/swimming#p0#r2/30',
    'swimming/swimming#p1#r3/20',
    'skiing/skiing#p0#r1/50',
    'skiing/skiing#p1#r3/20',
    'rowing/me#r1/50',
    'rowing/rowing#p0#r2/30',
    'rowing/rowing#p1#r3/20',
  ]);
  // 3 榜上限只砍 me：陪跑每人只在一个榜上出现，一条不受影响（上限是"每人"不是"每榜"）
  assert.equal(got.filter((r) => r.userId !== 'me').length, 16, '16 条陪跑奖励一条都不该被砍');
  // 同输入两次调用逐字节相同（结算必须可重放）
  assert.deepEqual(planPeriodRewards('week', boards, OPTS), got);
});

test('PR-3b flattenWithPerUserCap 单独可测：分值降序 → type 码点升序，逐用户独立', () => {
  const mk = (type: string, userId: string, points: number): BoardReward => ({
    userId,
    type,
    rank: 1,
    points,
  });
  // 入参顺序 c1 → a1 → b1 → x9 与 type 码点序（a1 < b1 < c1 < x9）刻意错开，两条规则各自可辨：
  //   · u 有四个候选 c1/20、a1/20、b1/20、x9/30 → 留 x9（分值优先，哪怕它 type 码点最大、最后出现），
  //     同分三个里按码点留 a1、b1，砍掉"最先出现"的 c1；
  //   · solo 只有两个榜（c1/7、x9/3），够不上上限，一条不砍。
  const perBoard = new Map<string, BoardReward[]>([
    ['c1', [mk('c1', 'u', 20), mk('c1', 'solo', 7)]],
    ['a1', [mk('a1', 'u', 20)]],
    ['b1', [mk('b1', 'u', 20)]],
    ['x9', [mk('x9', 'u', 30), mk('x9', 'solo', 3)]],
  ]);
  const allRows = [...perBoard.values()].flat();
  const kept = flattenWithPerUserCap(perBoard, 3);
  assert.deepEqual(kept.map((r) => `${r.type}:${r.userId}:${r.points}`), [
    'c1:solo:7',
    'a1:u:20',
    'b1:u:20',
    'x9:u:30',
    'x9:solo:3',
  ]);
  assert.deepEqual(
    kept.filter((r) => r.userId === 'u').map((r) => r.type),
    ['a1', 'b1', 'x9'],
    '留分值最高的 3 个；同分按 type 码点，而不是按入参先后',
  );
  assert.equal(kept.filter((r) => r.userId === 'solo').length, 2, '不到 3 个榜的用户一条不砍');
  assert.deepEqual(
    kept.map((r) => r.type),
    ['c1', 'a1', 'b1', 'x9', 'x9'],
    '输出顺序＝榜的入参顺序 → 榜内原顺序，不随分值重排（台账好对账）',
  );
  assert.deepEqual(flattenWithPerUserCap(perBoard, 4), allRows, 'N 覆盖全部候选时一条不砍');
  assert.deepEqual(flattenWithPerUserCap(perBoard, 0), [], 'N=0 → 一条不发');
  assert.deepEqual(
    flattenWithPerUserCap(perBoard, 1).map((r) => `${r.type}:${r.userId}`),
    ['c1:solo', 'x9:u'],
    'N=1 时每人各留自己分值最高的一条',
  );
  assert.deepEqual(flattenWithPerUserCap(new Map(), 3), []);
  assert.deepEqual(flattenWithPerUserCap(perBoard, 3), kept, '同输入必同输出（可重放）');
});

test('PR-4 并列都发：4 人并列第 1 名全拿 TOP1 分，第 2 名顺延为空', () => {
  // 4 人同分 1000 ＋ 7 个互不相等的下位行（合计 11 行，过门槛）
  const tiedTop: BoardCandidate[] = ['a', 'b', 'c', 'd'].map((userId) => ({
    userId,
    distance: 1000,
  }));
  const tail = Array.from({ length: 7 }, (_, i) => ({ userId: `t${i}`, distance: 900 - i * 100 }));
  const got = planPeriodRewards('week', [{ type: 'running', rows: [...tiedTop, ...tail] }], OPTS);
  assert.deepEqual(got.map(key), [
    'running/a#r1/50',
    'running/b#r1/50',
    'running/c#r1/50',
    'running/d#r1/50',
  ]);
  assert.equal(new Set(got.map((r) => r.rank)).size, 1, '并列组只占一个名次');
  assert.ok(
    got.every((r) => r.rank === 1 && r.points === 50),
    '并列第 1 的四个人全拿 TOP1 分值（第 2/3 名顺延为空）',
  );
  assert.equal(
    got.reduce((s, r) => s + r.points, 0),
    200,
    '4×50 恰好等于周榜上限 200：并列把榜发到顶格也不截（cap 是「>」）',
  );
  // 并列也可以发生在第 2 名：第 1 名 1 人 + 第 2 名 2 人并列都发，第 3 名顺延为空（名次 1,2,2）
  const rows2: BoardCandidate[] = [
    { userId: 'w', distance: 2000 },
    { userId: 'a', distance: 1000 },
    { userId: 'b', distance: 1000 },
    ...Array.from({ length: 8 }, (_, i) => ({ userId: `s${i}`, distance: 900 - i * 100 })),
  ];
  assert.equal(rows2.length, 11);
  assert.deepEqual(planPeriodRewards('week', [{ type: 'running', rows: rows2 }], OPTS).map(key), [
    'running/w#r1/50',
    'running/a#r2/30',
    'running/b#r2/30',
  ]);
});

test('PR-5 单榜总额超上限时按达成先后截断（并列人数打爆 cap 的极端）', () => {
  // (a) 5 人并列第 1：5×50＝250 > 周榜上限 200 → 整组不发（并列不许拆，拆了就是同分不同钱）
  const five: BoardCandidate[] = ['a', 'b', 'c', 'd', 'e'].map((userId) => ({
    userId,
    distance: 1000,
  }));
  const tail = Array.from({ length: 6 }, (_, i) => ({ userId: `t${i}`, distance: 800 - i * 100 }));
  assert.deepEqual(
    planPeriodRewards('week', [{ type: 'running', rows: [...five, ...tail] }], OPTS),
    [],
    '并列组越过上限时整组不发，绝不只发组内前 4 个（同分必须同钱）',
  );

  // (b) 先达成的保住了：第 1 名 1 人（50）＋ 第 2 名 6 人并列（180）＝230 > 200
  const winner: BoardCandidate = { userId: 'w', distance: 2000 };
  const six: BoardCandidate[] = ['a', 'b', 'c', 'd', 'e', 'f'].map((userId) => ({
    userId,
    distance: 1000,
  }));
  const rest = Array.from({ length: 4 }, (_, i) => ({ userId: `t${i}`, distance: 900 - i * 100 }));
  const boards = [{ type: 'running', rows: [winner, ...six, ...rest] }];
  assert.equal(boards[0].rows.length, 11, '夹具过门槛：11 行 > 10');
  const truncated = planPeriodRewards('week', boards, OPTS);
  assert.deepEqual(truncated.map(key), ['running/w#r1/50']);
  assert.equal(
    truncated.reduce((s, r) => s + r.points, 0),
    50,
    '截断保留先达成的第 1 名，并列的第 2 名整组不发',
  );
  // 截断后不"回头"发第 4 名以后的人：差名次不该比被截的好名次先拿到钱
  assert.ok(truncated.every((r) => r.rank === 1), '一旦某组被截断，该榜就地停止发放');

  // (c) 上限系数可配：perBoardCapFactor=3 → 上限 300，同一夹具 50+180 全发
  const full = planPeriodRewards('week', boards, { ...OPTS, perBoardCapFactor: 3 });
  assert.equal(full.length, 7, '系数提到 3 以后同榜 7 人全发（cap 真的读 opts，没写死 2）');
  assert.equal(full.reduce((s, r) => s + r.points, 0), 230);
  assert.deepEqual(full.map((r) => r.rank), [1, 2, 2, 2, 2, 2, 2]);
});

test('PR-6 名次按距离降序，距离相同视为并列（不比 createdAt）', () => {
  // 乱序入参：函数自己按距离降序排（除此之外不加任何二级判据）
  const rows: BoardCandidate[] = [
    { userId: 'C', distance: 900 },
    { userId: 'f1', distance: 700 },
    { userId: 'A', distance: 1000 },
    { userId: 'f2', distance: 300 },
    { userId: 'B', distance: 1000 },
    { userId: 'f3', distance: 800 },
    { userId: 'f4', distance: 600 },
    { userId: 'f5', distance: 500 },
    { userId: 'f6', distance: 400 },
    { userId: 'f7', distance: 200 },
    { userId: 'f8', distance: 100 },
  ];
  assert.equal(rows.length, 11, '夹具过门槛：11 行 > 10');
  const got = planPeriodRewards('week', [{ type: 'running', rows }], OPTS);
  // A、B 同分并列第 1 各拿 50；C 顺延到第 3 名（竞赛排名跳过第 2）拿 20
  assert.deepEqual(got.map(key), ['running/A#r1/50', 'running/B#r1/50', 'running/C#r3/20']);
  const byUser = new Map(got.map((r) => [r.userId, r]));
  assert.equal(byUser.get('A')?.points, byUser.get('B')?.points, '同距离必须同分值');
  assert.equal(byUser.get('A')?.rank, byUser.get('B')?.rank, '同距离必须同名次');
  assert.equal(byUser.get('C')?.rank, 3, '并列使名次跳过：1,1,3 而不是 1,1,2');
  assert.deepEqual(
    got.map((r) => r.userId),
    ['A', 'B', 'C'],
    '并列组内保持调用方给的先后（稳定排序），绝不引入 createdAt/uid 之类的第二把尺',
  );
  // 全部同分＝一个 11 人大并列组：11×50＝550 > 周榜上限 200 → 整组不发（并列不许拆开）
  const allTied = Array.from({ length: 11 }, (_, i) => ({ userId: `x${i}`, distance: 500 }));
  assert.equal(planPeriodRewards('week', [{ type: 'running', rows: allTied }], OPTS).length, 0);
  // 距离完全相同且分值不撞 cap 时（月榜 TOP1 并列 4 人 ×100＝400 ≤ 上限 460）全发
  const fourTied = Array.from({ length: 4 }, (_, i) => ({ userId: `y${i}`, distance: 500 }));
  const monthTail = Array.from({ length: 7 }, (_, i) => ({ userId: `m${i}`, distance: 400 - i * 10 }));
  const monthRows = [...fourTied, ...monthTail];
  const monthGot = planPeriodRewards('month', [{ type: 'running', rows: monthRows }], OPTS);
  assert.equal(monthGot.length, 4);
  assert.ok(monthGot.every((r) => r.points === 100 && r.rank === 1));
});

test('PR-7 截断与 3 榜上限互不代打：被总额上限截掉的榜不占用户额度', () => {
  // running 榜：5 人并列第 1（含 me）→ 5×50＝250 > 周榜上限 200 → 整条榜不发
  const tiedFive: BoardCandidate[] = ['me', 'a', 'b', 'c', 'd'].map((userId) => ({
    userId,
    distance: 1000,
  }));
  const runningTail = Array.from({ length: 6 }, (_, i) => ({ userId: `r${i}`, distance: 800 - i * 100 }));
  const running = { type: 'running', rows: [...tiedFive, ...runningTail] };
  // 另外 4 个榜 me 都是第 1 名（各 50 分）：me 的"有效候选"正好 4 个，上限砍到 3 个
  const others = ['cycling', 'hiking', 'swimming', 'walking'].map((type) =>
    boardWithMeAt(type, ME_DISTANCE_BY_RANK[1]),
  );
  const boards = [running, ...others];
  assert.ok(boards.every((b) => b.rows.length > OPTS.minParticipants), '夹具：5 个榜全过门槛');

  const got = planPeriodRewards('week', boards, OPTS);
  assert.deepEqual(
    got.filter((r) => r.type === 'running'),
    [],
    'running 被总额上限截断＝一条不发，也就不该占 me 的三个额度',
  );
  const mine = got.filter((r) => r.userId === 'me');
  assert.equal(mine.length, 3, 'me 的 4 个 50 分候选留 3 砍 1');
  assert.deepEqual(
    mine.map((r) => r.type).sort(),
    ['cycling', 'hiking', 'swimming'],
    '同分值按 type 码点升序留（砍掉 walking）',
  );
  // 4 个正常榜各发 100 分，me 被砍掉一条 50 → 350
  assert.equal(got.reduce((s, r) => s + r.points, 0), 350);
  assert.equal(got.length, 11, '4 榜 × 3 条 − me 被砍的 1 条');
});
