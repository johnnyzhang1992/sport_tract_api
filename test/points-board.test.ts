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
  claimBoardSettlement,
  flipBoardSettlementToCredited,
  recordBoardSettlementSkipped,
  isBoardSettlementSkipped,
  releaseBoardSettlementPending,
  settlePeriod,
  settleDueForUser,
  computeSettleUnits,
  periodStartMsFromKey,
  boardLabel,
  boardPeriodTag,
  type BoardCandidate,
  type BoardPeriod,
  type BoardReward,
  type PlanOpts,
} from '../src/services/points-board.js';
import {
  BoardSettlementModel,
  PointAccountModel,
  PointDailyModel,
  PointLotModel,
  PointRecordModel,
  BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID,
  BOARD_SETTLEMENT_PERIODS,
  BOARD_SETTLEMENT_STATUSES,
  type BoardSettlementPeriod,
} from '../src/models/point.model.js';
import { NotificationModel } from '../src/models/notification.model.js';
import { hasNoPace, NO_PACE_TYPES } from '../src/utils/pace.js';
import { DRIFT_SCORE_PB_GATE, MIN_PLAUSIBLE_PACE_SEC_PER_KM, ACTIVITY_TYPES } from '../src/config/constants.js';
import { BOARD_REWARDS } from '../src/config/points.js';
import { creditPoints, getBalance } from '../src/services/points-ledger.js';
import { BJ_OFFSET_MS } from '../src/utils/bj-time.js';

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
/** 灰度开关在「import 时刻」的默认值快照：SP-4 钉它必须是 false（spec §6），下面的 before 会翻开供其余用例跑结算 */
const FLAG_DEFAULT_AT_IMPORT = BOARD_REWARDS.enabled;

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
  // 台账的幂等全靠那条唯一索引，而 autoIndex 是异步的：不先等它建完就断言 E11000 会假绿
  // （与 test/points-models.test.ts:12 同款）
  await Promise.all([BoardSettlementModel.init()]);
  // SP-* 要真发钱：测试进程内把灰度开关翻开（默认值 false 由 SP-4 用 FLAG_DEFAULT_AT_IMPORT 钉住）。
  // 开关不许写死进 service——结算就是读它，SP-4 关掉它验证短路。
  BOARD_REWARDS.enabled = true;
});

after(async () => {
  // 清理失败必须可见：吞掉错误会把本文件种下的测试轨迹永久留在共享 dev 库，
  // 后续所有按窗口/类型聚合的用例（含榜单类）会被无声污染
  const fixtureUserIds = seededUsers.map((u) => String(u));
  /*
   * 结构性防线（债务修复轮 2026-10-29）：本文件只许给「自己种下的夹具用户」发榜奖。
   * 旧 SP-4 把窗口种在 2026-12、假时钟 NOW4 敲到平台 year:2026 的到期界，settleDueForUser
   * 替全平台真实 TOP3 发了钱；after 的流水清理按 seededUsers 收口删不掉真实用户的钱，
   * 台账却按 key 删了 ⇒ 钱滞留、Task 10 撤回面失明（取证：devdb-stranded-board-rewards.md）。
   * 两道核对都在清理**之前**取数（清理会删掉 G2 的现场），失败先记账、清理照跑、最后 throw：
   * - G1 流水：本文件拥有的单元（SP_PERIOD_KEYS×3 period×8 类型）下出现 userId∉夹具 的
   *   board_reward 流水。跨轮重放的泄漏（idemKey 幂等、不再新增流水）也会被这里按 refId 抓住。
   * - G2 台账：同一 key 集合下出现 userId∉夹具 的 credited 行——泄漏本轮新抢锁补翻牌的现场。
   * 已知取舍：两个会话并发跑本文件会互看夹具台账（同 key 不同用户）触发 G2——但那种并发本来
   * 就会打爆 SP-1「credited==3」的绝对计数断言，属既有并发纪律，不是守卫的新增负担。
   * TEST_PERIOD_KEY（BS-* 假类型域）不在名单内：那里的非夹具台账用户是设计行为。
   */
  const guardMsgs: string[] = [];
  try {
    const ownedRefIds: string[] = [];
    for (const key of SP_PERIOD_KEYS) {
      for (const t of ACTIVITY_TYPES) {
        for (const p of ['week', 'month', 'year'] as const) ownedRefIds.push(`${t}:${p}:${key}`);
      }
    }
    const [foreignRecs, foreignLedger] = await Promise.all([
      PointRecordModel.find({ type: 'board_reward', refId: { $in: ownedRefIds }, userId: { $nin: fixtureUserIds } })
        .select({ userId: 1, refId: 1, delta: 1 }).lean(),
      BoardSettlementModel.find({ status: 'credited', periodKey: { $in: SP_PERIOD_KEYS }, userId: { $nin: seededUsers } })
        .select({ userId: 1, type: 1, periodKey: 1, points: 1 }).lean(),
    ]);
    if (foreignRecs.length > 0) {
      guardMsgs.push(`G1 越界流水 ${foreignRecs.length} 条：${foreignRecs.slice(0, 3).map((r) => `user=${r.userId} ref=${r.refId} delta=${r.delta}`).join(' | ')}`);
    }
    if (foreignLedger.length > 0) {
      guardMsgs.push(`G2 越界台账 ${foreignLedger.length} 行：${foreignLedger.slice(0, 3).map((r) => `user=${r.userId} ${r.type}:${r.periodKey} +${r.points}`).join(' | ')}`);
    }
  } catch (e) {
    guardMsgs.push(`守卫查询自身失败（不许因此放行）：${(e as Error).message}`);
  }
  try {
    await ActivityModel.deleteMany({ userId: { $in: seededUsers } });
    // 台账行按「本次运行独有的 periodKey」收口，只删自己种的（共享 dev 库纪律：不碰别人的行）。
    // SP_PERIOD_KEYS 是本文件自用的真实周期键（2026-12 之后的未来窗口，别的会话不会往这些周期落行）；
    // skipped 占位行是哨兵 userId，按 user 删不掉，只能按 key 收口。
    await BoardSettlementModel.deleteMany({
      periodKey: { $in: [TEST_PERIOD_KEY, ...SP_PERIOD_KEYS] },
    });
    await PointRecordModel.deleteMany({ userId: { $in: fixtureUserIds } });
    await PointAccountModel.deleteMany({ userId: { $in: fixtureUserIds } });
    await PointLotModel.deleteMany({ userId: { $in: fixtureUserIds } });
    await PointDailyModel.deleteMany({ userId: { $in: fixtureUserIds } });
    await NotificationModel.deleteMany({ userId: { $in: seededUsers } });
  } catch (err) {
    console.error('[points-board.test] fixture 轨迹清理失败，dev 库有残留', err);
  }
  await app.close();
  await mongoose.disconnect().catch(() => {});
  // 守卫红要在清理**之后**才 throw：清理没跑完就红，会把越界现场连同夹具一起留在共享 dev 库
  if (guardMsgs.length > 0) {
    throw new Error(
      `[points-board.test] 夹具给真实用户发钱越界（结构性防线红，取证见 devdb-stranded-board-rewards.md）：\n${guardMsgs.join('\n')}`,
    );
  }
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
 * 数字表（spec §3 D2/D4/D5 ＋ D10 2026-10-29 裁定「并列全发，不设单榜总额上限」，逐字取 plan Task 5）：
 *   rewards：周 50/30/20、月 100/80/50、年 500/400/300（TOP1/2/3）
 *   minParticipants＝10（判定 rows.length **>** 10，恰好 10 人不发）
 *   perUserBoards＝3（同一期一个用户最多计 3 个榜）
 *   无单榜总额上限：周榜 5 人并列第 1＝5×50＝250 照发（PR-5 钉死；cap 已于修复轮 1 移除）
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
  // 三档发放总额分别＝该榜 TOP3 之和（周 100、月 230、年 1200）——正常三人各得一条，
  // 恰好发满 TOP3 之和；并列全发时可以到这个数以上（见 PR-5），没有单榜总额上限
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
    '4×50＝200 照发：无单榜总额上限（2026-10-29 裁定），并列不许砍人',
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

test('PR-5 并列人数打爆 TOP3 之和时整组照发——既不截断也不整组不发（2026-10-29 裁定）', () => {
  // (a) 5 人并列第 1：5×50＝250 超过 TOP3 之和 100——无单榜总额上限，整组全发（每个都拿钱，谁也不掉）
  const five: BoardCandidate[] = ['a', 'b', 'c', 'd', 'e'].map((userId) => ({
    userId,
    distance: 1000,
  }));
  const tail = Array.from({ length: 6 }, (_, i) => ({ userId: `t${i}`, distance: 800 - i * 100 }));
  const weekRows = [...five, ...tail];
  assert.equal(weekRows.length, 11, '夹具过门槛：11 行 > 10');
  const paidGroup = planPeriodRewards('week', [{ type: 'running', rows: weekRows }], OPTS);
  assert.deepEqual(paidGroup.map(key), [
    'running/a#r1/50',
    'running/b#r1/50',
    'running/c#r1/50',
    'running/d#r1/50',
    'running/e#r1/50',
  ]);
  assert.equal(
    paidGroup.reduce((s, r) => s + r.points, 0),
    250,
    '周榜 5 人并列第 1 ⇒ 该榜发 5×50＝250（裁定原文的算例，不许砍成 200 也不许发 0）',
  );
  assert.ok(paidGroup.every((r) => r.rank === 1), '并列组全员第 1 名，第 2/3 名顺延为空');

  // (b) 第 1 名 1 人（50）＋第 2 名 6 人并列（6×30＝180）＝230：旧 cap 下会「先到先得＋整组不发」，
  // 现在两条规则都不存在——7 人全发，榜也不因“总额超了”提前停
  const winner: BoardCandidate = { userId: 'w', distance: 2000 };
  const six: BoardCandidate[] = ['a', 'b', 'c', 'd', 'e', 'f'].map((userId) => ({
    userId,
    distance: 1000,
  }));
  const rest = Array.from({ length: 4 }, (_, i) => ({ userId: `t${i}`, distance: 900 - i * 100 }));
  const boards = [{ type: 'running', rows: [winner, ...six, ...rest] }];
  assert.equal(boards[0].rows.length, 11, '夹具过门槛：11 行 > 10');
  const paidAll = planPeriodRewards('week', boards, OPTS);
  assert.equal(paidAll.length, 7, '1 个第 1 名 + 6 人并列第 2 名全部照发');
  assert.deepEqual(paidAll.map((r) => r.rank), [1, 2, 2, 2, 2, 2, 2]);
  assert.equal(paidAll.reduce((s, r) => s + r.points, 0), 230);

  // (c) 同输入两次调用逐字节相同（去掉 cap 后结算仍必须可重放）
  assert.deepEqual(planPeriodRewards('week', boards, OPTS), paidAll);
});

test('PR-6 名次按距离降序，距离相同视为并列（不比 createdAt、不比 userId）', () => {
  // 乱序入参：函数自己按距离降序排（除此之外不加任何二级判据）。
  // 并列组刻意排成 B 在 A 前＝输入序 ≠ userId 码点序（'A' < 'B'）：
  // 实现若偷加 (distance, userId) 第二把尺，下面两条深比较立刻红（修复轮 1 前该组是 A 在前，抓不住）。
  const rows: BoardCandidate[] = [
    { userId: 'C', distance: 900 },
    { userId: 'f1', distance: 700 },
    { userId: 'B', distance: 1000 },
    { userId: 'f2', distance: 300 },
    { userId: 'A', distance: 1000 },
    { userId: 'f3', distance: 800 },
    { userId: 'f4', distance: 600 },
    { userId: 'f5', distance: 500 },
    { userId: 'f6', distance: 400 },
    { userId: 'f7', distance: 200 },
    { userId: 'f8', distance: 100 },
  ];
  assert.ok(
    rows.filter((r) => r.distance === 1000).map((r) => r.userId).join() === 'B,A'
      && 'A' < 'B',
    '夹具自证：并列组输入序（B,A）与 userId 码点序（A,B）相反',
  );
  assert.equal(rows.length, 11, '夹具过门槛：11 行 > 10');
  const got = planPeriodRewards('week', [{ type: 'running', rows }], OPTS);
  // A、B 同分并列第 1 各拿 50；C 顺延到第 3 名（竞赛排名跳过第 2）拿 20
  assert.deepEqual(got.map(key), ['running/B#r1/50', 'running/A#r1/50', 'running/C#r3/20']);
  const byUser = new Map(got.map((r) => [r.userId, r]));
  assert.equal(byUser.get('A')?.points, byUser.get('B')?.points, '同距离必须同分值');
  assert.equal(byUser.get('A')?.rank, byUser.get('B')?.rank, '同距离必须同名次');
  assert.equal(byUser.get('C')?.rank, 3, '并列使名次跳过：1,1,3 而不是 1,1,2');
  assert.deepEqual(
    got.map((r) => r.userId),
    ['B', 'A', 'C'],
    '并列组内保持调用方给的先后（稳定排序）：B 在 A 前＝输入序，绝不引入 createdAt/userId 之类的第二把尺',
  );
  // 全部同分＝一个 11 人大并列组：11×50＝550 整组全发（无单榜总额上限，2026-10-29 裁定）
  const allTied = Array.from({ length: 11 }, (_, i) => ({ userId: `x${i}`, distance: 500 }));
  const allPaid = planPeriodRewards('week', [{ type: 'running', rows: allTied }], OPTS);
  assert.equal(allPaid.length, 11, '11 人大并列整组照发，一个都不砍');
  assert.ok(allPaid.every((r) => r.rank === 1 && r.points === 50));
  assert.equal(allPaid.reduce((s, r) => s + r.points, 0), 550);
  // 月榜 4 人并列 TOP1 ×100＝400 同样全发（发放条数只受 out.length<3 闸门＋并列不许砍人约束）
  const fourTied = Array.from({ length: 4 }, (_, i) => ({ userId: `y${i}`, distance: 500 }));
  const monthTail = Array.from({ length: 7 }, (_, i) => ({ userId: `m${i}`, distance: 400 - i * 10 }));
  const monthRows = [...fourTied, ...monthTail];
  const monthGot = planPeriodRewards('month', [{ type: 'running', rows: monthRows }], OPTS);
  assert.equal(monthGot.length, 4);
  assert.ok(monthGot.every((r) => r.points === 100 && r.rank === 1));
});

test('PR-7 并列全发照样占用每人 3 榜额度；没过门槛的空榜不占额度', () => {
  // running 榜：me/a/b/c/d 五人并列第 1 → 5×50＝250 整组照发（2026-10-29 裁定），me 在本榜有一条 50 分
  const tiedFive: BoardCandidate[] = ['me', 'a', 'b', 'c', 'd'].map((userId) => ({
    userId,
    distance: 1000,
  }));
  const runningTail = Array.from({ length: 6 }, (_, i) => ({ userId: `r${i}`, distance: 800 - i * 100 }));
  const running = { type: 'running', rows: [...tiedFive, ...runningTail] };
  // cycling/hiking/swimming：me 都是第 1 名（50）→ me 跨 4 个榜、4 条候选分值全等 → 只留 3
  const others = ['cycling', 'hiking', 'swimming'].map((type) =>
    boardWithMeAt(type, ME_DISTANCE_BY_RANK[1]),
  );
  // walking：10 行（me + 9 陪跑）不过门槛 → 整榜不发，也就不占 me 的额度（空榜不代打的最后一处）
  const deadWalking = { type: 'walking', rows: [...many(9), { userId: 'me', distance: 1100 }] };
  const boards = [running, ...others, deadWalking];
  assert.ok(running.rows.length > OPTS.minParticipants, '夹具：并列榜过门槛，整组照发');
  assert.equal(deadWalking.rows.length, OPTS.minParticipants, '夹具：walking 恰好 10 行＝不发');

  const got = planPeriodRewards('week', boards, OPTS);
  assert.deepEqual(
    got.filter((r) => r.type === 'walking'),
    [],
    '没发钱的榜一条都没有，自然也不占额度',
  );
  assert.equal(
    got.filter((r) => r.type === 'running').length,
    5,
    '并列的 running 榜 5 条全发（上限结算之前它先拿到全额）',
  );
  const mine = got.filter((r) => r.userId === 'me');
  assert.equal(mine.length, 3, 'me 在 4 个等分（50）榜上只留 3 个——每人 3 榜上限压在并列全发之上');
  assert.deepEqual(
    mine.map((r) => r.type).sort(),
    ['cycling', 'hiking', 'running'],
    '同分值按 type 码点升序留（砍掉 swimming）；并列榜与正常榜在额度上平权',
  );
  assert.deepEqual(mine.map((r) => r.points), [50, 50, 50]);
  // running 250 + cycling/hiking 各 100 + swimming 剩 p0/p1 两条 50 ＝ 500；条数 5+3+3+2＝13
  assert.equal(got.length, 13);
  assert.equal(got.reduce((s, r) => s + r.points, 0), 500);
});

/* ====================================================================
 * BoardSettlement 发放台账（Task 6）：唯一键幂等 + 抢锁原语 + 索引形状
 *
 * 台账是「这笔榜单奖励发过没有」的唯一事实源。懒结算（Task 9）把 settlePeriod 挂在用户入口上，
 * 同一期同一榜同一人会被反复触发，还会在两台设备／两个标签页里**同时**触发；积分是真金白银，
 * 所以「一次且仅一次」只能钉在 DB 的唯一索引 {type,period,periodKey,userId} 上——
 * 应用层「先查再插」总有并发窗口（与 PointDailyQuota / campaignmembers 同一条教训）。
 *
 * 夹具纪律（共享 dev 库）：
 * - periodKey 用本次运行独有的 `t_<WIN_START>`，after 只按它删自己种的行，不碰别人的；
 * - type 用 t_b* 前缀（真实榜单的 type 只会是 ACTIVITY_TYPES 那 8 个值，永不撞名）；
 * - userId 全是自造 ObjectId（不落 user 文档），断言只按自己的键收口，不声明平台绝对值。
 *
 * 「发分」在这里用内存计数器代表：本任务不碰 creditPoints，也不往共享库的 pointrecords 里种假流水
 * （真实流水与定稿文案的断言是 Task 7 的 SP-*）。fakeSettleOnce 里 `return 1` 那一行
 * 就是 Task 7 换成 creditPoints(...) 的位置。
 * ================================================================== */

/** 本次运行独有的 periodKey＝台账行的清理锚点（见 after） */
const TEST_PERIOD_KEY = `t_${WIN_START}`;

function mkLedgerUser(): Types.ObjectId {
  return new Types.ObjectId();
}

/**
 * 一次「假想发放」＝ Task 7 settlePeriod 循环体里的一条：抢锁 → 翻牌 → 发分。
 * 返回 1 表示本次真的发了钱，0 表示安静跳过（已有人占位／没拿到发放权）。
 */
async function fakeSettleOnce(type: string, userId: Types.ObjectId, period: BoardPeriod = 'week'): Promise<number> {
  const key = { type, period, periodKey: TEST_PERIOD_KEY, userId: String(userId) };
  const { won } = await claimBoardSettlement(key, { rank: 1, points: 50 });
  if (!won) return 0;
  const credited = await flipBoardSettlementToCredited(key);
  if (!credited) return 0;
  return 1; // ← Task 7：这一行换成 creditPoints(...)
}

test('BS-1 同一 (type, period, periodKey, userId) 重复结算只发一次（撞唯一键即跳过）', async () => {
  const u = mkLedgerUser();
  const board = 't_b1_running';
  assert.equal(await fakeSettleOnce(board, u), 1, '首次结算要拿到发放权');
  assert.equal(await fakeSettleOnce(board, u), 0, '第二次进页面不得再发');
  assert.equal(await fakeSettleOnce(board, u), 0, '第三次同样不得再发，而且必须是安静跳过：抛错会把整批 8 个榜打断');
  assert.equal(
    await BoardSettlementModel.countDocuments({ type: board, periodKey: TEST_PERIOD_KEY }),
    1,
    '台账只能留一行（重复结算不留垃圾行）',
  );

  // 唯一键的四元组一个都不能少：换个维度就是另一笔奖励，照样要发得出去
  assert.equal(await fakeSettleOnce(board, mkLedgerUser()), 1, '同榜不同人＝另一笔奖励');
  assert.equal(await fakeSettleOnce('t_b1_cycling', u), 1, '同人不同榜＝另一笔奖励');
  assert.equal(await fakeSettleOnce(board, u, 'month'), 1, '同人同榜不同周期＝另一笔奖励');

  // DB 层直接取证（不经过抢锁原语）：裸 create 第二次必撞 E11000。
  // Task 7 的「败者退化」钉的就是这条约束；摘掉 unique:true 这一句先红。
  const raw = {
    type: 't_b1_raw', period: 'week' as const, periodKey: TEST_PERIOD_KEY,
    userId: u, rank: 2, points: 30, status: 'credited' as const,
  };
  await BoardSettlementModel.create(raw);
  await assert.rejects(
    () => BoardSettlementModel.create({ ...raw, points: 999 }),
    /E11000/,
    '唯一键没拦住第二行：同一笔奖励会被发两遍',
  );
});

test('BS-1b 翻牌带 status=pending 条件：一行只许拿到一次发放权', async () => {
  const u = mkLedgerUser();
  const key = { type: 't_b1b_running', period: 'week' as const, periodKey: TEST_PERIOD_KEY, userId: String(u) };
  assert.equal((await claimBoardSettlement(key, { rank: 1, points: 50 })).won, true, '抢锁要成功');
  const first = await flipBoardSettlementToCredited(key);
  assert.equal(first?.status, 'credited', '首次翻牌拿到发放权');
  assert.equal(await flipBoardSettlementToCredited(key), null, '第二次翻牌必须拿不到发放权——这是「只发一次」的第二道闸');
  assert.equal(await BoardSettlementModel.countDocuments(key), 1);

  // 崩在翻牌之前留下的 pending 行：现在会被当成「已占位」继续挡住发放（won=false）。
  // 这里先把现状钉住——Task 7 要么在失败路径删/改这行，要么加超时接管，语义变了必须显式改这条断言。
  const stale = { type: 't_b1b_stale', period: 'week' as const, periodKey: TEST_PERIOD_KEY, userId: String(mkLedgerUser()) };
  await claimBoardSettlement(stale, { rank: 3, points: 20 });
  assert.equal((await claimBoardSettlement(stale, { rank: 3, points: 20 })).won, false, '遗留 pending 行仍占键（已知敞口，Task 7 收口）');
});

test('BS-2 并发双请求不双发', async () => {
  const u = mkLedgerUser();
  const board = 't_b2_running';
  const paid = await Promise.all([fakeSettleOnce(board, u), fakeSettleOnce(board, u)]);
  assert.equal(paid[0] + paid[1], 1, `并发双发！两次各自拿到发放权：${JSON.stringify(paid)}`);
  const rows = await BoardSettlementModel.find({ type: board, periodKey: TEST_PERIOD_KEY }).lean();
  assert.equal(rows.length, 1, '并发只留一行台账');
  assert.equal(rows[0].status, 'credited', '留下的那行必须是已发放终态');

  // 扇出更宽的并发：同一个人 6 个入口同时进来（两设备 × 三入口），仍然只发一笔
  const many = await Promise.all(Array.from({ length: 6 }, () => fakeSettleOnce('t_b2_cycling', u)));
  assert.equal(many.reduce((s, n) => s + n, 0), 1, `6 路并发只能发 1 笔，实际 ${JSON.stringify(many)}`);
  assert.equal(await BoardSettlementModel.countDocuments({ type: 't_b2_cycling', periodKey: TEST_PERIOD_KEY }), 1);

  // 抢锁层取证：证明「撞唯一键 → 安静跳过」这条分支真的走到了（不是被串行化侥幸躲过）
  const key6 = { type: 't_b2_swimming', period: 'week' as const, periodKey: TEST_PERIOD_KEY, userId: String(u) };
  const claims = await Promise.all(Array.from({ length: 6 }, () => claimBoardSettlement(key6, { rank: 1, points: 50 })));
  assert.equal(claims.filter((c) => c.won).length, 1, '并发抢锁恰好一个胜者');
  assert.equal(claims.filter((c) => !c.won).length, 5, '其余 5 路都要走败者分支');
  assert.ok(
    claims.filter((c) => !c.won).every((c) => c.existing !== null),
    '败者要拿回已存在的那行（E11000 退化分支被真实执行，且不抛错）',
  );
});

test('BS-4 未过人数门槛的榜写 skipped 占位行：不重复重算、reason 留痕、不替真人挡发放', async () => {
  const board = { type: 't_b4_running', period: 'week' as const, periodKey: TEST_PERIOD_KEY };
  assert.equal(await isBoardSettlementSkipped(board), false, '夹具自证：开跑前没有占位行');
  assert.equal(await recordBoardSettlementSkipped(board, '参与人数 8 未过门槛 10'), true, '首次要落下占位行');
  assert.equal(await isBoardSettlementSkipped(board), true, '第二次进页面直接跳过整榜聚合（发分口径一榜一个 aggregate，8 个榜都省掉）');
  assert.equal(await recordBoardSettlementSkipped(board, '重复调用'), false, '占位行只写一次，第二次是安静跳过不是抛错');

  const row = await BoardSettlementModel.findOne(board).lean();
  assert.equal(row?.status, 'skipped');
  assert.equal(row?.reason, '参与人数 8 未过门槛 10', 'reason 要留得下来：后台台账页（Task 10）要看为什么没发');
  assert.equal(String(row?.userId), BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID, 'skipped 是「整榜级」行，不属于任何用户');
  assert.equal(row?.rank, 0, '整榜级行没有名次可言，用 0 表达不适用');
  assert.equal(row?.points, 0, '整榜级行不发分');

  // 整榜级占位不能把真人的奖励一起挡掉：唯一键含 userId，哨兵行与真人行不同键
  assert.equal(await fakeSettleOnce(board.type, mkLedgerUser()), 1, 'skipped 占位行不得替用户挡发放');
});

test('BS-5 revoked 不释放唯一键、recordId 回指流水：撤回过的行不会被懒结算再发一次', async () => {
  const u = mkLedgerUser();
  const key = { type: 't_b5_running', period: 'month' as const, periodKey: TEST_PERIOD_KEY, userId: String(u) };
  assert.equal((await claimBoardSettlement(key, { rank: 1, points: 100 })).won, true);
  const recordId = new Types.ObjectId(); // Task 7 写进来的是 creditPoints 落下的 pointrecords._id
  const flipped = await flipBoardSettlementToCredited(key, recordId);
  assert.equal(flipped?.status, 'credited');
  assert.equal(String(flipped?.recordId), String(recordId), '台账要能回指那笔流水，Task 10 才冲得回去');

  // 运营撤回（Task 10 的动作）：改状态、不删行
  await BoardSettlementModel.updateOne(key, { $set: { status: 'revoked', reason: '运营复核：判定刷分' } });
  assert.equal(await fakeSettleOnce(key.type, u, key.period), 0, '撤回后再来一次懒结算不得重发');
  assert.equal(await BoardSettlementModel.countDocuments(key), 1, 'revoked 不删行＝唯一键继续占位，撤回才是终态');
  const row = await BoardSettlementModel.findOne(key).lean();
  assert.equal(row?.status, 'revoked');
  assert.equal(String(row?.recordId), String(recordId), '撤回行仍然指着原流水（冲销凭据不能丢）');
  assert.equal(await flipBoardSettlementToCredited(key), null, '已 revoked 的行不能被翻回 credited 再领一次发放权');
});

test('BS-6 status/period 枚举闸门：四态都能落库、拼错的值写不进去', async () => {
  /**
   * 编译期闸门：模型侧的 period 联合与 service 侧的 BoardPeriod 必须双向可赋值。
   * 两边任一处改动而另一边没跟上，这个 const 的类型就塌成 false，`npm run typecheck` 直接红
   * （BoardPeriod 是纯类型、没有运行值，所以运行时报不了这个漂移）。
   */
  const periodUnionMatches:
    [BoardPeriod] extends [BoardSettlementPeriod]
      ? ([BoardSettlementPeriod] extends [BoardPeriod] ? true : false)
      : false = true;
  assert.equal(periodUnionMatches, true, 'models 的 period 联合与 services 的 BoardPeriod 不同形');
  assert.deepEqual([...BOARD_SETTLEMENT_PERIODS].sort(), ['month', 'week', 'year']);

  // 四态逐个落库。'pending' 是控制器裁定加进来的：Task 7 先写 pending 行抢锁、再翻成 credited
  const statuses = ['pending', 'credited', 'skipped', 'revoked'] as const;
  assert.deepEqual([...BOARD_SETTLEMENT_STATUSES].sort(), [...statuses].sort());
  for (const status of statuses) {
    const created = await BoardSettlementModel.create({
      type: `t_b6_${status}`, period: 'week', periodKey: TEST_PERIOD_KEY,
      userId: mkLedgerUser(), rank: 1, points: 50, status,
    });
    assert.equal(created.status, status, `${status} 必须是合法终态`);
  }

  // 拼错的终态必须拒掉：静默入库的行既进不了后台台账（Task 10）的筛选，也挡不住下一次发放
  const base = {
    type: 't_b6_reject', period: 'week' as const, periodKey: TEST_PERIOD_KEY,
    userId: mkLedgerUser(), rank: 1, points: 50,
  };
  await assert.rejects(
    () => BoardSettlementModel.create({ ...base, status: 'creditd' }),
    (e: unknown) => {
      const err = e as { name?: string; errors?: Record<string, unknown> };
      assert.equal(err.name, 'ValidationError');
      assert.ok(err.errors?.status, '拒绝点要落在 status 上');
      return true;
    },
    'enum 闸门没生效：拼错的 status 被静默写进台账',
  );
  await assert.rejects(
    () => BoardSettlementModel.create({ ...base, status: 'credited', period: 'daily' }),
    (e: unknown) => {
      const err = e as { name?: string; errors?: Record<string, unknown> };
      assert.equal(err.name, 'ValidationError');
      assert.ok(err.errors?.period, '拒绝点要落在 period 上');
      return true;
    },
    'enum 闸门没生效：未知周期被静默写进台账',
  );
  // 名次/分值有下限：0 只留给整榜级 skipped 行，负数一条都不许进台账（-1 分＝凭空造钱）
  await assert.rejects(
    () => BoardSettlementModel.create({ ...base, status: 'credited', rank: -1 }),
    /min/,
    'rank 的下限闸门没生效',
  );
  await assert.rejects(
    () => BoardSettlementModel.create({ ...base, status: 'credited', points: -1 }),
    /min/,
    'points 的下限闸门没生效',
  );
});

/* ====================================================================
 * settlePeriod / settleDueForUser 接线（Task 7）：发分 + 台账 + 通知 + 文案
 *
 * 夹具纪律（共享 dev 库 + 真实 money 路径）：
 * - 周单元全部取 **2026-12 之后的未来窗口**（周键=周一、月键='YYYY-MM'、年键='YYYY'，
 *   规范形态）。别的会话不会在未来窗口种轨迹，trustedBoardRows 的聚合因此只看见本文件的数据；
 *   「与平台真实历史数据隔离」靠时间窗实现，不靠假 type 名——settlePeriod 只扫 ACTIVITY_TYPES 真类型。
 * - **settleDueForUser 的假时钟绝不许敲到任何真实平台单元到期**：它一脚做全榜结算，
 *   2026 及更早的真实用户会被发钱（债务修复轮教训，SP-4 窗口因此整体挪到 2031-01，
 *   月/年派生单元在 NOW 下未到期）。
 * - 发分对象是真实 ObjectId 用户（不落 user 文档）：creditPoints 的 settleExpired 无账户即静默返回，
 *   过期结算不会在测试中途回收任何批次（所有夹具时刻都选在 expireAtFor 的未来端点之前）。
 * - now 全部是**假时钟**（未来），台账/流水上的真实时间戳只用于唯一键与清理，不进断言。
 * - after 按 seededUsers（含全部夹具用户）与本文件独占的 SP_PERIOD_KEYS 收口删除。
 * ================================================================== */

const DAY_MS = 86_400_000;
const BJ = BJ_OFFSET_MS;
/** 东八区墙上时间零点 → epoch ms */
const bjMid = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) - BJ;

const WEEK_KEYS = [
  '2026-12-07', // U1：SP-1/2/9（cycling 12 人；running 8 人→回填到 11 人）
  '2026-12-14', // U2：SP-3 幂等
  '2026-12-21', // U3：SP-8 懒结算入口（触发者排第 13，不发钱）
  '2031-01-06', // U4：SP-4 灰度开关（窗口整体落在 2031-01：NOW4 只到周界的到期，派生的月/年单元都未到期，绝不顺带结算真实平台单元——债务修复轮，见文件头守卫注释）
  '2027-01-11', // U5：SP-11 超时接管
  '2027-01-18', // U6：SP-10 每人 3 榜上限（4 个榜全过门槛）
  '2027-02-01', // U7：SP-12 失败路径（release/金额不符/重试）
  '2027-02-08', // U8：SP-13 通知失败不吞钱
  '2027-02-15', // U9：SP-14 崩在发分与翻牌之间（幂等补翻牌）
  '2027-02-22', // U10：SP-15 已结算单元完成标记（聚合计数取证）
  '2027-03-01', // U11：SP-16 占位过期重算同结论 → 刷新 TTL
  '2027-03-08', // U12：SP-17 补翻牌前的流水金额核对
  '2027-03-15', // U13：SP-18 场景一（榜上还有他人持有的新鲜锁 ⇒ 不落完成标记）
  '2027-03-22', // U14：SP-18 场景二（翻牌竞态落空 ⇒ 同上）
  '2027-03-29', // U15：SP-19 完成标记过期重评后同结论 → 续期归位
  '2027-04-05', // U16：SP-17 场景二（补翻牌竞态落空 ⇒ 未落定，不落标记）
] as const;
const U_START = (key: string) => bjMid(Number(key.slice(0, 4)), Number(key.slice(5, 7)), Number(key.slice(8, 10)));
const U_END = (key: string) => U_START(key) + 7 * DAY_MS;
const U1 = WEEK_KEYS[0]; const U1_START = U_START(U1); const U1_END = U_END(U1); const NOW1 = U1_END;
const U2 = WEEK_KEYS[1]; const U2_START = U_START(U2); const U2_END = U_END(U2); const NOW2 = U2_END;
const U3 = WEEK_KEYS[2]; const U3_START = U_START(U3); const U3_END = U_END(U3); const NOW3 = U3_END;
const U4 = WEEK_KEYS[3]; const U4_START = U_START(U4); const U4_END = U_END(U4); const NOW4 = U4_END;
const U5 = WEEK_KEYS[4]; const U5_START = U_START(U5); const U5_END = U_END(U5); const NOW5 = U5_END;
const U6 = WEEK_KEYS[5]; const U6_START = U_START(U6); const U6_END = U_END(U6); const NOW6 = U6_END;
const U7 = WEEK_KEYS[6]; const U7_START = U_START(U7); const U7_END = U_END(U7); const NOW7 = U7_END;
const U8 = WEEK_KEYS[7]; const U8_START = U_START(U8); const U8_END = U_END(U8); const NOW8 = U8_END;
const U9 = WEEK_KEYS[8]; const U9_START = U_START(U9); const U9_END = U_END(U9); const NOW9 = U9_END;
const U10 = WEEK_KEYS[9]; const U10_START = U_START(U10); const U10_END = U_END(U10); const NOW10 = U10_END;
const U11 = WEEK_KEYS[10]; const U11_START = U_START(U11); const U11_END = U_END(U11); const NOW11 = U11_END;
const U12 = WEEK_KEYS[11]; const U12_START = U_START(U12); const U12_END = U_END(U12); const NOW12 = U12_END;
const U13 = WEEK_KEYS[12]; const U13_START = U_START(U13); const U13_END = U_END(U13); const NOW13 = U13_END;
const U14 = WEEK_KEYS[13]; const U14_START = U_START(U14); const U14_END = U_END(U14); const NOW14 = U14_END;
const U15 = WEEK_KEYS[14]; const U15_START = U_START(U15); const U15_END = U_END(U15); const NOW15 = U15_END;
const U16 = WEEK_KEYS[15]; const U16_START = U_START(U16); const U16_END = U_END(U16); const NOW16 = U16_END;
/** 月/年单元：SP-5 滞后闸门（2026-12 的结算界是 2027-01-01）与 SP-7 年榜 500 分。
 *  年榜夹具用 2027 年——2026/更早年份的窗口里有真实用户数据，绝不当结算对象。 */
const M_DEC = '2026-12';
const Y_START = bjMid(2027, 1, 1);
const Y_END = bjMid(2028, 1, 1);
const NOW_Y = Y_END + 8 * 3600_000; // 2028-01-01 08:00 BJ（bizDate '2028-01-01'）
/** after 清理锚点：本文件独占的真实周期键。
 *  债务修复轮：SP-4 窗口移去 2031 后本文件不再结算 '2026' 单元——**真实平台键绝不许进这个名单**
 *  （既是删别人的台账，也是把「越界结算」洗成自家数据）。同时它是 after() 守卫 G1/G2 的「本文件拥有的单元集合」。 */
const SP_PERIOD_KEYS: string[] = [...WEEK_KEYS, M_DEC, '2027'];

/** 种一榜：按给定距离（降序自定）一人一条可信 finished 轨迹，返回 userId 数组（全部登记清理） */
async function seedBoard(type: string, startMs: number, distances: number[]): Promise<Types.ObjectId[]> {
  const users: Types.ObjectId[] = [];
  for (const distance of distances) {
    const u = mkUser();
    users.push(u);
    await mkActivity(u, type, distance, { startTime: startMs + DAY_MS, avgPace: hasNoPace(type) ? null : MIN_PLAUSIBLE_PACE_SEC_PER_KM + 100 });
  }
  return users;
}

/** 钱账对账不变式：某单元的台账 credited 行数 == board_reward 流水条数（fixture 范围内） */
async function assertUnitLedgerMatchesRecords(period: BoardPeriod, periodKey: string) {
  const refIds = ACTIVITY_TYPES.map((t) => `${t}:${period}:${periodKey}`);
  const [creditedRows, records] = await Promise.all([
    BoardSettlementModel.countDocuments({ period, periodKey, status: 'credited' }),
    PointRecordModel.countDocuments({ type: 'board_reward', refType: 'board', refId: { $in: refIds } }),
  ]);
  assert.equal(records, creditedRows, `单元 ${period}/${periodKey}：流水条数必须等于台账 credited 行数`);
}

/** 每人同期不超过 perUserBoards 个榜（credited 台账按 userId 分组数 type） */
async function assertPerUserBoardCap(period: BoardPeriod, periodKey: string) {
  const rows = await BoardSettlementModel.find({ period, periodKey, status: 'credited' }).select({ userId: 1, type: 1 }).lean();
  const per = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = per.get(String(r.userId)) ?? new Set<string>();
    set.add(String(r.type));
    per.set(String(r.userId), set);
  }
  for (const [u, types] of per) {
    assert.ok(types.size <= BOARD_REWARDS.perUserBoards, `用户 ${u} 在 ${period}/${periodKey} 占了 ${types.size} 个榜，超过上限`);
  }
}

/** 临时劫持 console.error 捕获留痕（node --test-concurrency=1 + 文件内串行，劫持安全） */
async function captureErrors(fn: () => Promise<void>): Promise<string> {
  const orig = console.error;
  const cap: string[] = [];
  console.error = (...a: unknown[]) => { cap.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')); };
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return cap.join('\n');
}

test('SP-6 周期标签两套形态各自钉死（spec §4.8）', () => {
  // 通知正文形态：日期内 '/'、区间「至」（spec §4.8 表第一行）
  assert.equal(boardLabel('week', '2026-10-19'), '2026/10/19 至 2026/10/25 这一周');
  assert.equal(boardLabel('month', '2026-10'), '2026年10月');
  assert.equal(boardLabel('year', '2026'), '2026年');
  // 流水标题后缀形态：周是 8 位无分隔紧凑形态（用户 2026-10-28 指定，与上面刻意不同式）
  assert.equal(boardPeriodTag('week', '2026-10-19'), '20261019周');
  assert.equal(boardPeriodTag('month', '2026-10'), '2026年10月');
  assert.equal(boardPeriodTag('year', '2026'), '2026年');
  // 两套不许被"顺手统一"：同入参两个输出形态不同（周），月/年恰好同式也各自钉住
  assert.notEqual(boardLabel('week', '2026-12-07'), boardPeriodTag('week', '2026-12-07'));
  assert.equal(boardLabel('week', '2026-12-07'), '2026/12/07 至 2026/12/13 这一周');
  assert.equal(boardPeriodTag('week', '2026-12-07'), '20261207周');
  assert.equal(boardLabel('month', '2027-01'), '2027年1月');
});

test('SP-5 滞后窗口未到不结算：本周结束于昨天，今天进页面不该发', async () => {
  // C1：周单元要过"次周一 00:00（东八）"的滞后界才许结。U1 的界＝2026-12-14 00:00 BJ，
  // 差 1ms 都不许动台账——一条占位都不落（占位是"已评估"的缓存，未评估不许伪造）。
  const res = await captureErrors(async () => {
    const r = await settlePeriod('week', U1, U1_END, NOW1 - 1);
    assert.deepEqual(r, { credited: 0, skippedTypes: [] });
  });
  assert.equal(res, '', '滞后未到不该有任何留痕');
  assert.equal(await BoardSettlementModel.countDocuments({ period: 'week', periodKey: U1 }), 0, '未到界：一行都不许落（含 skipped 占位）');
  const u1Refs = ACTIVITY_TYPES.map((t) => `${t}:week:${U1}`);
  assert.equal(await PointRecordModel.countDocuments({ type: 'board_reward', refId: { $in: u1Refs } }), 0, '未到界：一分钱都不该落账（收口到本单元 refId，不声明平台绝对值）');
  // 月榜界=次月 1 日、年榜界=次年 1 月 1 日：12-14 进页面不许评估 2026-12 月榜（界 2027-01-01）
  const m = await settlePeriod('month', M_DEC, Y_START, NOW1);
  assert.deepEqual(m, { credited: 0, skippedTypes: [] });
  assert.equal(await BoardSettlementModel.countDocuments({ period: 'month', periodKey: M_DEC }), 0);
  // periodKey 规范形态之外的脏值必须炸出来而不是静默算出错窗（'20261207' 正是 boardPeriodTag 的形态，混进键＝双发隐患）
  await assert.rejects(() => settlePeriod('week', '20261207', U1_END, NOW1), /periodKey/);
});

test('SP-1 周榜结算：发分流水 type=board_reward、idemKey 带周期、台账 credited', async () => {
  // cycling 12 人过门槛；running 8 人不过（给 SP-2/SP-9 当占位夹具）
  const cyc = await seedBoard('cycling', U1_START, [3000, 2900, 2800, 2000, 1900, 1800, 1700, 1600, 1500, 1400, 1300, 1200]);
  const run = await seedBoard('running', U1_START, [1000, 900, 800, 700, 600, 500, 400, 300]);
  const res = await settlePeriod('week', U1, U1_END, NOW1);
  assert.equal(res.credited, 3, 'TOP3 三条');
  assert.deepEqual(
    [...res.skippedTypes].sort(),
    ['hiking', 'mountaineering', 'rowing', 'running', 'skiing', 'swimming', 'walking'],
    '除 cycling 外 7 个榜全跳过（running 8 人未过 >10 门槛）',
  );
  // 流水（§4.8 第 5 条 + refId/idemKey/bizDate）
  const rec1 = await PointRecordModel.findOne({ idemKey: `${cyc[0]}:board:cycling:week:${U1}` }).lean();
  assert.ok(rec1, 'idemKey 必须逐字是 `${userId}:board:${type}:${period}:${periodKey}`');
  assert.equal(rec1.type, 'board_reward');
  assert.equal(rec1.title, '骑行·周榜第 1 名·20261207周');
  assert.equal(rec1.delta, 50);
  assert.equal(rec1.bizDate, '2026-12-14', 'bizDate＝结算日（now 的东八日期串）');
  assert.equal(rec1.refType, 'board');
  assert.equal(rec1.refId, `cycling:week:${U1}`);
  const rec2 = await PointRecordModel.findOne({ userId: cyc[1] }).lean();
  assert.equal(rec2?.title, '骑行·周榜第 2 名·20261207周');
  assert.equal(rec2?.delta, 30);
  // 没过门槛的榜一条不发（"nobody paid for a board that failed the threshold"）
  assert.equal(await PointRecordModel.countDocuments({ userId: { $in: run.map(String) }, type: 'board_reward' }), 0);
  // 台账行：credited + recordId 回指流水（Task 10 的冲销凭据）
  const led = await BoardSettlementModel.findOne({ type: 'cycling', period: 'week', periodKey: U1, userId: cyc[0] }).lean();
  assert.equal(led?.status, 'credited');
  assert.equal(led?.rank, 1);
  assert.equal(led?.points, 50);
  assert.equal(String(led?.recordId), String(rec1._id), '台账必须回指那笔流水');
  // 定向通知（§4.8 第 3 条逐字）
  const notes = await NotificationModel.find({ userId: cyc[0] }).lean();
  assert.equal(notes.length, 1, '每人一条，不许重发');
  assert.equal(notes[0].title, '榜单积分奖励到账');
  assert.equal(notes[0].content, '恭喜获得「骑行·周榜」第 1 名奖励 +50 积分（2026/12/07 至 2026/12/13 这一周）。');
  assert.equal(notes[0].published, true);
  // 不占每日上限：当天就这一笔，全额入账
  assert.equal(await getBalance(String(cyc[0]), NOW1), 50);
  // 钱账对账 + 每人 3 榜上限（fixture 范围内的不变式）
  await assertUnitLedgerMatchesRecords('week', U1);
  await assertPerUserBoardCap('week', U1);
});

test('SP-2 没过人数门槛 → 记 skipped 台账，不重复算（占位有效期内是缓存）', async () => {
  const led = await BoardSettlementModel.findOne({ type: 'running', period: 'week', periodKey: U1 }).lean();
  assert.equal(led?.status, 'skipped');
  assert.equal(String(led?.userId), BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID);
  assert.match(led?.reason ?? '', /人数/);
  // 把占位行的 updatedAt 归一到 SP-1 的结算时刻（占位行是真实时钟落的，freshness 比较用假时钟）
  // 用 driver 原始句柄写 updatedAt：mongoose 的 timestamps 插件会在 updateOne/findOneAndUpdate
  // 上强行覆盖 updatedAt（模型开了 timestamps），"归一占位时间"必须绕过插件才落得下去。
  await BoardSettlementModel.collection.updateOne({ _id: led?._id }, { $set: { updatedAt: new Date(NOW1) } });
  // 回填把 running 从 8 人推到 11 人（越过门槛）——占位 24h 内是**缓存**：不许重算、不许补发
  const rb = await seedBoard('running', U1_START, [5000, 4900, 4800]);
  const res = await settlePeriod('week', U1, U1_END, NOW1 + 3600_000);
  assert.equal(res.credited, 0, 'cycling 三条已被 SP-1 发完（claim 败者路径），running 被占位挡住');
  assert.ok(res.skippedTypes.includes('running'));
  assert.equal(await PointRecordModel.countDocuments({ userId: { $in: rb.map(String) }, type: 'board_reward' }), 0, '有效期内不许重算门槛');
  assert.equal(await BoardSettlementModel.countDocuments({ type: 'running', period: 'week', periodKey: U1 }), 1, '占位行不重复落');
});

test('SP-9 skipped 是缓存不是判决：占位过期（>24h）后重算，回填过门槛就补发', async () => {
  const rb = await PointRecordModel.countDocuments({ type: 'board_reward', refId: `running:week:${U1}` });
  assert.equal(rb, 0, '夹具：SP-2 之后 running 还没发过分');
  // 假时钟推过占位的 24h 有效期（updatedAt 在 SP-2 里归一到 NOW1，这里 now＝NOW1+25h）
  const res = await settlePeriod('week', U1, U1_END, NOW1 + DAY_MS + 3600_000);
  assert.equal(res.credited, 3, '11 人越门槛，回填的三个头部用户补发 TOP3');
  assert.ok(!res.skippedTypes.includes('running'), '重算后 running 不再是 skipped');
  const top = await PointRecordModel.findOne({ type: 'board_reward', refId: `running:week:${U1}`, delta: 50 }).lean();
  assert.equal(top?.title, '跑步·周榜第 1 名·20261207周');
  assert.equal(await PointRecordModel.countDocuments({ type: 'board_reward', refId: `running:week:${U1}` }), 3);
  await assertUnitLedgerMatchesRecords('week', U1);
});

test('SP-3 重复调用 settlePeriod 不二次发分（幂等）', async () => {
  const cyc = await seedBoard('cycling', U2_START, [2700, 2600, 2500, 2000, 1900, 1800, 1700, 1600, 1500, 1400, 1300, 1200]);
  const first = await settlePeriod('week', U2, U2_END, NOW2);
  assert.equal(first.credited, 3);
  const recs = await PointRecordModel.countDocuments({ type: 'board_reward', refId: `cycling:week:${U2}` });
  const notes = await NotificationModel.countDocuments({ userId: cyc[0] });
  // 串行重复：三条已 credited 的行 claim 撞键败者路径，一分不再
  const again = await settlePeriod('week', U2, U2_END, NOW2 + 60_000);
  assert.equal(again.credited, 0);
  // 并发双请求（懒结算的真场景：两台设备同时进页面）也必须颗粒不进
  const both = await Promise.all([settlePeriod('week', U2, U2_END, NOW2 + 61_000), settlePeriod('week', U2, U2_END, NOW2 + 61_000)]);
  assert.equal(both.reduce((s, r) => s + r.credited, 0), 0, '重复调用/并发重入都不得二次发分');
  assert.equal(await PointRecordModel.countDocuments({ type: 'board_reward', refId: `cycling:week:${U2}` }), recs, '流水一条不多');
  assert.equal(await NotificationModel.countDocuments({ userId: cyc[0] }), notes, '通知不重发');
  assert.equal(await BoardSettlementModel.countDocuments({ period: 'week', periodKey: U2, status: 'credited' }), 3);
  await assertUnitLedgerMatchesRecords('week', U2);
});

test('SP-8 懒结算入口：只评估该用户有可信行的到期单元，但一脚结全榜', async () => {
  // U3 cycling 13 行：t3 排第 13（1000m，不发钱），TOP3 是别的用户
  const cyc = await seedBoard('cycling', U3_START, [2400, 2300, 2200, 2000, 1900, 1800, 1700, 1600, 1500, 1400, 1300, 1200]);
  const t3 = mkUser();
  await mkActivity(t3, 'cycling', 1000, { startTime: U3_START + DAY_MS, avgPace: null });
  // 单元枚举（C2）：t3 的行落在 2026-12-22 → 周/月/年都是候选，但 NOW3=2026-12-28 只有周过了滞后界
  const units = await computeSettleUnits(String(t3), NOW3);
  assert.deepEqual(units.map((u) => `${u.period}:${u.periodKey}`), [`week:${U3}`], '月/年滞后界（2027-01-01）未到，不许进结算');
  await settleDueForUser(String(t3), NOW3);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(
      await PointRecordModel.countDocuments({ type: 'board_reward', userId: cyc[i], refId: `cycling:week:${U3}` }),
      1,
      `触发者不是赢家也要把全榜 TOP${i + 1} 发出去（第一个人替所有人干活）`,
    );
  }
  assert.equal(await PointRecordModel.countDocuments({ userId: t3, type: 'board_reward' }), 0, '第 13 名没有奖励');
  // 与该用户无关的到期单元（2026-11-02 的周榜，早过滞后界）一条台账都不许碰——
  // 摘掉"用户有行"过滤器，这里就会冒出整批哨兵占位行
  assert.equal(await BoardSettlementModel.countDocuments({ periodKey: '2026-11-02' }), 0);
  // 月/年未到期：同样一行不落
  assert.equal(await BoardSettlementModel.countDocuments({ period: 'month', periodKey: M_DEC }), 0);
  assert.equal(await BoardSettlementModel.countDocuments({ period: 'year', periodKey: '2026' }), 0);
  // 入口永不抛错：畸形 userId 也要安静吞掉（Task 9 挂在页面请求上，500 会把积分页打挂）
  await captureErrors(async () => { await settleDueForUser('not-an-objectid', NOW3); });
  await assertUnitLedgerMatchesRecords('week', U3);
});

test('SP-4 开关关闭时 settleDueForUser 什么都不做', async () => {
  assert.equal(FLAG_DEFAULT_AT_IMPORT, false, '灰度开关默认值必须是 false（spec §6：线上小流量验完再放开）');
  const cyc = await seedBoard('cycling', U4_START, [2100, 2050, 2000, 1900, 1800, 1700, 1600, 1500, 1400, 1300, 1200, 1100]);
  const t4 = mkUser();
  await mkActivity(t4, 'cycling', 1000, { startTime: U4_START + DAY_MS, avgPace: null });
  // 窗口形状钉死（债务修复轮）：夹具整体落在 2031-01 的同一个周单元里，NOW4 只敲开**周**的到期界——
  // 派生的月/年单元滞后界都在未来，settleDueForUser 结构性碰不到任何会混进真实平台数据的单元
  // （旧夹具用 2026-12 窗口把平台 year:2026 敲到期，替真实 TOP3 发了钱，见 after 守卫注释）。
  const units4 = await computeSettleUnits(String(t4), NOW4);
  assert.deepEqual(units4.map((u) => `${u.period}:${u.periodKey}`), [`week:${U4}`], 'SP-4 只允许派生出自家周单元：月/年未到期');
  BOARD_REWARDS.enabled = false;
  try {
    await settleDueForUser(String(t4), NOW4);
    const off = await settlePeriod('week', U4, U4_END, NOW4);
    assert.deepEqual(off, { credited: 0, skippedTypes: [] });
    assert.equal(await BoardSettlementModel.countDocuments({ periodKey: U4 }), 0, '开关关闭：连 skipped 占位都不落');
    assert.equal(await PointRecordModel.countDocuments({ userId: { $in: cyc.map(String) }, type: 'board_reward' }), 0);
  } finally {
    BOARD_REWARDS.enabled = true;
  }
  // 翻开开关后同一入口立刻开工：证明上面短路的是开关，不是时窗/夹具
  await settleDueForUser(String(t4), NOW4);
  assert.equal(await PointRecordModel.countDocuments({ type: 'board_reward', userId: cyc[0], refId: `cycling:week:${U4}` }), 1);
  assert.equal(await BoardSettlementModel.countDocuments({ periodKey: { $in: ['2031-01', '2031'] } }), 0, '翻开开关也只结到周单元：未到期的月/年一行不落（夹具窗口与平台数据结构性隔离）');
});

test('SP-10 同期第 4 个榜一条不发（每人 3 榜上限在结算侧同样生效）', async () => {
  // multi 在 4 个榜全是第 1 名（各 9000）：plan 只留分值降序→type 码点升序的前 3 个
  // （cycling < hiking < rowing < walking；walking 那条必须被砍）
  const multi = mkUser();
  const others: Record<string, Types.ObjectId[]> = {};
  for (const type of ['cycling', 'hiking', 'rowing', 'walking']) {
    others[type] = await seedBoard(type, U6_START, [8000, 7900, 7000, 6900, 6800, 6700, 6600, 6500, 6400, 6300, 6200]);
    await mkActivity(multi, type, 9000, { startTime: U6_START + DAY_MS, avgPace: hasNoPace(type) ? null : MIN_PLAUSIBLE_PACE_SEC_PER_KM + 100 });
  }
  const res = await settlePeriod('week', U6, U6_END, NOW6);
  assert.equal(res.credited, 11, '4 榜×3 条=12，multi 的第 4 条被 3 榜上限砍掉');
  assert.equal(await PointRecordModel.countDocuments({ userId: multi, type: 'board_reward' }), 3);
  assert.equal(await PointRecordModel.countDocuments({ userId: multi, refId: `walking:week:${U6}` }), 0, '被砍的榜连台账都不该有');
  assert.equal(await BoardSettlementModel.countDocuments({ period: 'week', periodKey: U6, userId: multi, type: 'walking' }), 0);
  // walking 榜的第 2、3 名不受 multi 被砍影响，照发
  assert.equal(await PointRecordModel.countDocuments({ userId: others.walking[0], type: 'board_reward' }), 1);
  await assertUnitLedgerMatchesRecords('week', U6);
  await assertPerUserBoardCap('week', U6);
});

test('SP-11 卡死的 pending 可超时接管：进程崩在半路的用户不会永远拿不到钱', async () => {
  const cyc = await seedBoard('cycling', U5_START, [9000, 8900, 8800, 8000, 7900, 7800, 7700, 7600, 7500, 7400, 7300, 7200]);
  const key1 = { type: 'cycling', period: 'week' as const, periodKey: U5, userId: String(cyc[0]) };
  assert.equal((await claimBoardSettlement(key1, { rank: 1, points: 50 })).won, true, '夹具：先模拟"上一个进程抢到锁就死了"');
  // 把那行 pending 的 updatedAt 推到接管窗口（10min）之外（raw handle 绕过 timestamps 插件，同上）
  await BoardSettlementModel.collection.updateOne({ ...key1, status: 'pending' }, { $set: { updatedAt: new Date(NOW5 - 11 * 60_000) } });
  const res = await settlePeriod('week', U5, U5_END, NOW5);
  assert.equal(res.credited, 3, '超时 pending 被重领，TOP1 也被发出去');
  assert.equal(await PointRecordModel.countDocuments({ userId: cyc[0], type: 'board_reward', refId: `cycling:week:${U5}` }), 1);
  const led = await BoardSettlementModel.findOne(key1).lean();
  assert.equal(led?.status, 'credited');
  assert.ok(led?.recordId, '接管后照样回指流水');
});

test('BS-1c claim 超时接管窗口：新鲜 pending 仍挡路，终态行永不重领', async () => {
  const u = mkLedgerUser();
  const key = { type: 't_b1c_running', period: 'week' as const, periodKey: TEST_PERIOD_KEY, userId: String(u) };
  assert.equal((await claimBoardSettlement(key, { rank: 1, points: 50 })).won, true);
  assert.equal(
    (await claimBoardSettlement(key, { rank: 2, points: 30 }, Date.now() + 9 * 60_000)).won,
    false,
    '9 分钟的 pending 仍在锁持有期：两条路径同时领发放权会各发一笔（creditPoints 兜住双发，但台账会被搅乱）',
  );
  const re = await claimBoardSettlement(key, { rank: 1, points: 50 }, Date.now() + 11 * 60_000);
  assert.equal(re.won, true, '>10min 的 pending 视为持有者已死，可接管');
  const row = await BoardSettlementModel.findOne(key).lean();
  assert.equal(row?.status, 'pending', '接管只是续锁（仍 pending），不是发放凭据——翻牌仍须 flip 的 status 条件');
  // 终态行不吃超时窗口：credited/skipped/revoked 是判决，不是锁
  const k2 = { type: 't_b1c_cycling', period: 'week' as const, periodKey: TEST_PERIOD_KEY, userId: String(mkLedgerUser()) };
  await claimBoardSettlement(k2, { rank: 1, points: 50 });
  await flipBoardSettlementToCredited(k2, new Types.ObjectId());
  assert.equal((await claimBoardSettlement(k2, { rank: 1, points: 50 }, Date.now() + 60 * 60_000)).won, false, 'credited 行永不重领');
  const k3 = { type: 't_b1c_swimming', period: 'week' as const, periodKey: TEST_PERIOD_KEY, userId: String(mkLedgerUser()) };
  await claimBoardSettlement(k3, { rank: 3, points: 20 });
  const oid3 = new Types.ObjectId();
  const flippedRow = await flipBoardSettlementToCredited(k3, oid3);
  assert.equal(flippedRow?.status, 'credited', '翻牌必须回传翻完的那行（returnDocument after 口径）');
  assert.equal(String(flippedRow?.recordId), String(oid3), 'recordId 随翻牌写入并原样回传');
  assert.equal((await claimBoardSettlement(k3, { rank: 3, points: 20 }, Date.now() + 60 * 60_000)).won, false);
});

test('BS-1d release：只删自己那行 pending，终态行一个不碰', async () => {
  const u = mkLedgerUser();
  const key = { type: 't_b1d_running', period: 'week' as const, periodKey: TEST_PERIOD_KEY, userId: String(u) };
  await claimBoardSettlement(key, { rank: 3, points: 20 });
  assert.equal(await releaseBoardSettlementPending(key), true);
  assert.equal(await BoardSettlementModel.countDocuments(key), 0);
  assert.equal((await claimBoardSettlement(key, { rank: 3, points: 20 })).won, true, 'release 之后锁放开，重试能重领');
  // 已翻成 credited 的行不许被 release 删掉：那是发放凭据，删了＝下一次懒结算双发
  assert.ok(await flipBoardSettlementToCredited(key, new Types.ObjectId()));
  assert.equal(await releaseBoardSettlementPending(key), false);
  assert.equal((await BoardSettlementModel.findOne(key).lean())?.status, 'credited');
  // 哨兵 skipped 占位行 status≠pending，同样不碰
  const board = { type: 't_b1d_swimming', period: 'week' as const, periodKey: TEST_PERIOD_KEY };
  await recordBoardSettlementSkipped(board, '人数不足');
  assert.equal(await releaseBoardSettlementPending({ ...board, userId: BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID }), false);
  assert.equal(await isBoardSettlementSkipped(board), true);
});

test('SP-12 发分失败/金额不符：不翻牌、释放锁、大声留痕；重试补发', async () => {
  const cyc = await seedBoard('cycling', U7_START, [5500, 5400, 5300, 5000, 4900, 4800, 4700, 4600, 4500, 4400, 4300, 4200]);
  const neverNotify = async () => { throw new Error('注入：发分失败时根本不该走到通知'); };
  // (a) creditPoints 抛错：钱没出去，pending 必须被 release 删行，否则唯一键永远占位（那个用户 silently 拿不到钱）
  const logsA = await captureErrors(async () => {
    const r = await settlePeriod('week', U7, U7_END, NOW7, {
      credit: async () => { throw new Error('注入：发分炸了'); },
      notify: neverNotify as never,
    });
    assert.equal(r.credited, 0);
  });
  assert.match(logsA, /榜单|结算/, '失败路径必须 console.error 留痕（资损事故不能静默）');
  assert.equal(await BoardSettlementModel.countDocuments({ period: 'week', periodKey: U7, type: 'cycling', status: 'pending' }), 0, '失败后锁必须释放（删行）');
  assert.equal(await BoardSettlementModel.countDocuments({ period: 'week', periodKey: U7, type: 'cycling', status: 'skipped' }), 0, '失败绝不退化成 skipped（那是门槛缓存语义）');
  assert.equal(await PointRecordModel.countDocuments({ type: 'board_reward', refId: `cycling:week:${U7}` }), 0);
  // (b) 金额不符（credited !== points，比如被上限截断）：不许静默翻牌——钱账漂移要炸出来，同时释放锁待重试
  const logsB = await captureErrors(async () => {
    const r = await settlePeriod('week', U7, U7_END, NOW7 + 1000, {
      credit: async () => ({ credited: 49, balance: 49, duplicated: false, capped: true, recordId: null }),
      notify: neverNotify as never,
    });
    assert.equal(r.credited, 0);
  });
  assert.match(logsB, /不符|漂移/, '金额不符的留痕要能指认是钱账漂移');
  assert.equal(await BoardSettlementModel.countDocuments({ period: 'week', periodKey: U7, type: 'cycling', status: 'credited' }), 0, '金额不符不许翻牌');
  assert.equal(await BoardSettlementModel.countDocuments({ period: 'week', periodKey: U7, type: 'cycling', status: 'pending' }), 0, '金额不符也要释放锁');
  assert.equal(
    await BoardSettlementModel.countDocuments({ period: 'week', periodKey: U7, type: 'cycling', userId: BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID }),
    0,
    '金额不符 ⇒ 该榜本轮未落定，完成标记同样不落（标记只承诺"全部落定"，修复轮 1 Important 1）',
  );
  // (c) 真正可用的重试：前两轮都没把钱发出去，这一轮三条全补上，一条不多
  const ok = await settlePeriod('week', U7, U7_END, NOW7 + 2000);
  assert.equal(ok.credited, 3);
  assert.equal(await PointRecordModel.countDocuments({ type: 'board_reward', refId: `cycling:week:${U7}` }), 3);
  await assertUnitLedgerMatchesRecords('week', U7);
});

test('SP-13 通知失败不吞钱：台账与流水保持成对，缺席的通知大声留痕', async () => {
  const cyc = await seedBoard('cycling', U8_START, [5100, 5050, 5000, 4900, 4800, 4700, 4600, 4500, 4400, 4300, 4200, 4100]);
  const logs = await captureErrors(async () => {
    const r = await settlePeriod('week', U8, U8_END, NOW8, { notify: async () => { throw new Error('注入：通知服务挂了'); } });
    assert.equal(r.credited, 3, '通知失败不回滚钱——发放已成事实');
  });
  assert.match(logs, /通知/, '通知失败要单独留痕（定向通知缺席是运营事故，不是资损）');
  assert.equal(await PointRecordModel.countDocuments({ type: 'board_reward', refId: `cycling:week:${U8}` }), 3);
  assert.equal(await BoardSettlementModel.countDocuments({ period: 'week', periodKey: U8, status: 'credited' }), 3);
  assert.equal(await NotificationModel.countDocuments({ userId: cyc[0] }), 0);
  await assertUnitLedgerMatchesRecords('week', U8);
});

test('SP-14 崩在「已发分未翻牌」之间：release 后重试靠 idemKey 幂等补翻牌，绝不双发', async () => {
  const cyc = await seedBoard('cycling', U9_START, [4600, 4550, 4500, 4400, 4300, 4200, 4100, 4000, 3900, 3800, 3700, 3600]);
  // 注入：credit 真的落了账，然后进程"死在"翻牌之前（return 被换成 throw）
  await captureErrors(async () => {
    const r = await settlePeriod('week', U9, U9_END, NOW9, {
      credit: async (uid, input, n) => {
        await creditPoints(uid, input, n ?? NOW9);
        throw new Error('注入：落账后翻牌前进程死掉');
      },
      notify: (async () => { throw new Error('不该走到'); }) as never,
    });
    assert.equal(r.credited, 0);
  });
  // 钱已出、行被 release：台账零行、流水三条（这正是"删行而不是翻牌"的设计要救的现场）
  assert.equal(await BoardSettlementModel.countDocuments({ period: 'week', periodKey: U9, type: 'cycling', status: 'credited' }), 0);
  assert.equal(await PointRecordModel.countDocuments({ type: 'board_reward', refId: `cycling:week:${U9}` }), 3, '夹具自证：注入确实把钱发出去了（否则本用例假绿）');
  // 重试：重新抢锁 → creditPoints 撞 idemKey 返回 duplicated+recordId → 补翻牌，不再落第二笔钱
  const again = await settlePeriod('week', U9, U9_END, NOW9 + 60_000);
  assert.equal(again.credited, 3, '重复路径也要把台账补到终态（credited 计数含补翻牌）');
  assert.equal(await PointRecordModel.countDocuments({ type: 'board_reward', refId: `cycling:week:${U9}` }), 3, '重试绝不双发——还是那三条流水');
  assert.equal(await getBalance(String(cyc[0]), NOW9 + 60_000), 50, '余额只进一笔 50');
  assert.equal(await NotificationModel.countDocuments({ userId: cyc[0] }), 1, '补翻牌路径把到账通知也补齐');
  const led = await BoardSettlementModel.findOne({ type: 'cycling', period: 'week', periodKey: U9, userId: cyc[0] }).lean();
  assert.equal(led?.status, 'credited');
  assert.ok(led?.recordId, '补翻牌也要写下 recordId（指向那笔早已存在的流水）');
  await assertUnitLedgerMatchesRecords('week', U9);
});

test('SP-7 年榜 500 一笔不被每日上限截断；流水标题与通知按定稿文案拼', async () => {
  // 年榜夹具：2027 年窗口（未来年，真实数据不会混进来）
  const yUsers = await seedBoard('cycling', Y_START + 60 * DAY_MS, [9900, 9800, 9700, 8900, 8800, 8700, 8600, 8500, 8400, 8300, 8200, 8100]);
  const y1 = String(yUsers[0]);
  // 先把结算日的日常额度花到 95（走正常上限通道），再结年榜 500——
  // 若发分吃了 DAILY_CAP，年榜那笔只会被截成 5
  const pre = await creditPoints(y1, { type: 'daily', title: '运动记录', points: 95, bizDate: '2028-01-01', idemKey: `t7-pre-${WIN_START}:y1` }, NOW_Y);
  assert.equal(pre.credited, 95);
  const res = await settlePeriod('year', '2027', Y_END, NOW_Y);
  const recY = await PointRecordModel.findOne({ type: 'board_reward', userId: yUsers[0] }).lean();
  assert.equal(recY?.title, '骑行·年榜第 1 名·2027年', '年榜后缀是「2027年」（boardPeriodTag 的年形态），周榜的 8 位紧凑形态只属于周');
  assert.equal(recY?.delta, 500, '不占每日上限 100：年榜 500 一笔全额入账');
  assert.equal(recY?.bizDate, '2028-01-01');
  assert.equal(await getBalance(y1, NOW_Y), 595);
  const daily = await PointDailyModel.findOne({ userId: yUsers[0], bizDate: '2028-01-01' }).lean();
  assert.equal(daily?.earned, 95, '榜单发放不进每日投放计数器（否则挤占日常额度）');
  const noteY = await NotificationModel.findOne({ userId: yUsers[0] }).lean();
  assert.equal(noteY?.content, '恭喜获得「骑行·年榜」第 1 名奖励 +500 积分（2027年）。');
  // 年榜整体：cycling/hiking/rowing/walking（U6 那四个 2027-01 的榜）各 3 条，其余 4 个空榜 skipped
  assert.equal(res.credited, 12);
  assert.deepEqual([...res.skippedTypes].sort(), ['mountaineering', 'running', 'skiing', 'swimming']);
  await assertUnitLedgerMatchesRecords('year', '2027');
  await assertPerUserBoardCap('year', '2027');
});

/* ====================================================================
 * 修复轮 1（评审 Important 1/2 + Minor 5/6）
 *
 * Important 1 的取证需要"聚合次数"这个可观测量：trustedBoardRows 的唯一入口是
 * ActivityModel.aggregate，测试内临时换计数包装（node --test-concurrency=1 + 文件内串行，
 * finally 必还原——劫持口径同 captureErrors）。
 * ================================================================== */

/** 在 fn 执行期间统计 ActivityModel.aggregate 的调用次数（发分口径一榜一次 aggregate） */
async function withAggSpy<T>(fn: () => Promise<T>): Promise<{ count: number; result: T }> {
  const holder = ActivityModel as unknown as { aggregate: (...a: unknown[]) => unknown };
  const orig = holder.aggregate;
  let count = 0;
  holder.aggregate = (...a: unknown[]) => {
    count += 1;
    return (orig as (...x: unknown[]) => unknown).apply(ActivityModel, a);
  };
  try {
    const result = await fn();
    return { count, result };
  } finally {
    holder.aggregate = orig;
  }
}

test('SP-15 已结算单元有完成标记：二次进页零聚合；迟到赢家在 TTL 过期后重算补发（Important 1）', async () => {
  const cyc = await seedBoard('cycling', U10_START, [3200, 3100, 3000, 2000, 1900, 1800, 1700, 1600, 1500, 1400, 1300, 1200]);
  // (1) 首轮：8 个榜各聚合一次（1 个过门槛 + 7 个空榜），TOP3 发满
  const run1 = await withAggSpy(() => settlePeriod('week', U10, U10_END, NOW10));
  assert.equal(run1.result.credited, 3);
  assert.equal(run1.count, 8, '夹具自证：首次评估本来会跑 8 个聚合');
  // Minor 6：发 3 人 ⇒ 恰 3 条定向通知、0 条广播（userId null）——广播会发给全平台
  assert.equal(
    await NotificationModel.countDocuments({ userId: { $in: cyc.slice(0, 3) }, title: '榜单积分奖励到账' }),
    3,
    '每个赢家一条定向通知',
  );
  assert.equal(
    await NotificationModel.countDocuments({ userId: null, title: '榜单积分奖励到账' }),
    0,
    '榜单到账通知必须定向（spec §4.5/D14），一条都不许落广播',
  );
  // (2) 归一标记时刻：占位/完成标记落的是真实时钟，raw handle 推到假时钟（SP-2 同款）。
  // 注意走 collection 原语＝不过 schema 类型转换，哨兵 userId 要手动成 ObjectId 才匹配得上库里那批行。
  const marked = await BoardSettlementModel.collection.updateMany(
    { period: 'week', periodKey: U10, userId: new Types.ObjectId(BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID) },
    { $set: { updatedAt: new Date(NOW10) } },
  );
  assert.equal(marked.modifiedCount, 8, '8 个榜都要有完成/跳过标记（修复前过门槛的榜没有 ⇒ 本断言先红）');
  // (3) 二次进入：短路在聚合之前——0 次
  const run2 = await withAggSpy(() => settlePeriod('week', U10, U10_END, NOW10 + 3_600_000));
  assert.equal(run2.count, 0, '已结算单元再进页面：一个聚合都不许跑（修复前这里 ≥1，且永不归零）');
  assert.equal(run2.result.credited, 0);
  // (4) 迟到赢家：TTL 内被短路挡住（机制 (i) 的代价，报告写明最坏等待 ≤ skippedFreshMs＝24h）
  const [late] = await seedBoard('cycling', U10_START, [99_999]);
  const runTtl = await withAggSpy(() => settlePeriod('week', U10, U10_END, NOW10 + 2 * 3_600_000));
  assert.equal(runTtl.count, 0, '有效期内不重评：短路是标记的意义');
  assert.equal(await PointRecordModel.countDocuments({ userId: late, type: 'board_reward' }), 0);
  // (5) TTL 过期（>24h）：重评一轮，迟到 TOP1 补发——「标记是缓存不是判决」与裁定 2 同构
  const run3 = await withAggSpy(() => settlePeriod('week', U10, U10_END, NOW10 + DAY_MS + 2 * 3_600_000));
  assert.equal(run3.count, 8, '过期重算：每单元每天至多这一轮全扫');
  assert.equal(run3.result.credited, 1, '迟到 TOP1 补发一条（原 TOP1 降第 2 撞 credited 终态行，安静跳过）');
  assert.equal(await PointRecordModel.countDocuments({ userId: late, refId: `cycling:week:${U10}` }), 1);
  assert.equal(await getBalance(String(late), NOW10 + DAY_MS), 50, '迟到赢家拿的是 TOP1 的 50 分');
  // 钱账对账不变式照钉：短路/重算路径都没造出「流水与台账不成对」的行
  await assertUnitLedgerMatchesRecords('week', U10);
});

test('SP-16 占位过期重算后同结论：刷新 updatedAt 续期 TTL（否则第二天起每次进页全扫）', async () => {
  await seedBoard('running', U11_START, [1000, 900, 800, 700, 600]); // 5 人，稳不过门槛
  const r1 = await settlePeriod('week', U11, U11_END, NOW11);
  assert.ok(r1.skippedTypes.includes('running'));
  const key = { type: 'running', period: 'week' as const, periodKey: U11, userId: BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID };
  const row = await BoardSettlementModel.findOne(key).lean();
  assert.ok(row, '夹具：门槛占位已落');
  // 把占位推到 epoch 零：对任何假时钟都过期；重算同结论后若不续期，updatedAt 会停在 0（可观测）
  await BoardSettlementModel.collection.updateOne({ _id: row?._id }, { $set: { updatedAt: new Date(0) } });
  const reasonBefore = row?.reason;
  await settlePeriod('week', U11, U11_END, NOW11 + 60_000);
  const after = await BoardSettlementModel.findOne(key).lean();
  assert.ok((after?.updatedAt as Date).getTime() > 0, '重算同结论也要续期占位 TTL——不续期则修复前自第二天起每次进页都重聚合该榜');
  assert.equal(after?.reason, reasonBefore, '续期只动 TTL 不覆盖 reason（BS-4 的台账留痕纪律）');
  assert.equal(await BoardSettlementModel.countDocuments({ type: 'running', period: 'week', periodKey: U11 }), 1, '续期走撞键败者路径，不造重复行');
});

test('SP-17 补翻牌前先核对既有流水分值：与台账应发分值不符 ⇒ 拒翻牌、释放锁、大声留痕（Minor 5）', async () => {
  const cyc = await seedBoard('cycling', U12_START, [6100, 6000, 5900, 5000, 4900, 4800, 4700, 4600, 4500, 4400, 4300, 4200]);
  const u1 = String(cyc[0]);
  // 埋一条「金额不符」的同 idemKey 流水（模拟上游漂移/人工改动后的现场）：只有 20 分，台账本轮要标 50
  const pre = await creditPoints(u1, {
    type: 'board_reward', title: '历史遗留流水', points: 20, bizDate: '2027-03-02',
    refType: 'board', refId: `cycling:week:${U12}`,
    idemKey: `${u1}:board:cycling:week:${U12}`, ignoreDailyCap: true,
  }, NOW12);
  assert.equal(pre.credited, 20, '夹具自证：先落了一条 20 分的流水');
  const logs = await captureErrors(async () => {
    const r = await settlePeriod('week', U12, U12_END, NOW12);
    assert.equal(r.credited, 2, 'u1 必须被拒翻牌（第 2、3 名正常发）');
  });
  assert.match(logs, /补翻牌/, '补翻牌金额核对失败要指认得出来');
  assert.equal(
    await BoardSettlementModel.countDocuments({ period: 'week', periodKey: U12, userId: cyc[0] }),
    0,
    '金额不符 ⇒ 释放锁（不留 pending/credited 行），等人工对账后重跑',
  );
  assert.equal(
    await BoardSettlementModel.countDocuments({ period: 'week', periodKey: U12, status: 'credited' }),
    2,
  );
  assert.equal(await PointRecordModel.countDocuments({ refId: `cycling:week:${U12}` }), 3, '20 分旧流水 + 两条新流水，没有第四笔');
  assert.equal(await getBalance(u1, NOW12), 20, 'u1 余额仍是那笔 20——补翻牌核对不许把钱变出来');
  // 场景二：金额核对通过、但补翻牌本身竞态落空（claim 与 flip 之间行被外部删除）⇒ 同样未落定：
  // 留痕、不落 credited、不落完成标记
  const cycB = await seedBoard('cycling', U16_START, [6300, 6200, 6150, 6000, 5900, 5800, 5700, 5600, 5500, 5400, 5300, 5200]);
  const preB = await creditPoints(String(cycB[1]), {
    type: 'board_reward', title: '先行流水', points: 30, bizDate: '2027-04-06',
    refType: 'board', refId: `cycling:week:${U16}`,
    idemKey: `${cycB[1]}:board:cycling:week:${U16}`, ignoreDailyCap: true,
  }, NOW16);
  assert.equal(preB.credited, 30, '夹具：TOP2 的 30 分流水已先行落账（金额与本轮 plan 一致）');
  const logsB = await captureErrors(async () => {
    const r = await settlePeriod('week', U16, U16_END, NOW16, {
      credit: async (uid, input, n) => {
        const paid = await creditPoints(uid, input, n ?? NOW16);
        if (uid === String(cycB[1])) {
          await BoardSettlementModel.deleteOne({ period: 'week', periodKey: U16, userId: uid, status: 'pending' });
        }
        return paid;
      },
    });
    assert.equal(r.credited, 2, 'TOP1/TOP3 正常；TOP2 补翻牌竞态落空，不计入 credited');
  });
  assert.match(logsB, /未能补翻牌/, '补翻牌竞态落空必须留痕（原有纪律）');
  assert.equal(
    await BoardSettlementModel.countDocuments({ type: 'cycling', period: 'week', periodKey: U16, userId: BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID, status: 'skipped' }),
    0,
    '有未落定条目 ⇒ 完成标记不落（标记只承诺"全部落定"）',
  );
});

test('PK-1 周 periodKey 必须是东八区周一：周二/周日的键直接炸（Important 2）', () => {
  // 现状：任意 \d{4}-\d{2}-\d{2} 都被接受 → 周二是「平移一天的另一期」，idemKey 不同 ⇒ 同一批钱双发
  assert.equal(periodStartMsFromKey('week', '2026-10-19'), Date.parse('2026-10-19T00:00:00+08:00'), '夹具：周一照旧通过');
  assert.throws(() => periodStartMsFromKey('week', '2026-10-20'), /periodKey/, '周二的键必须拒：它和 2026-10-19 是重叠窗口、不同 idemKey');
  assert.throws(() => periodStartMsFromKey('week', '2026-10-25'), /periodKey/);
  // 经由 settlePeriod 也要炸（Task 10 的调用面）
  return assert.rejects(() => settlePeriod('week', '2026-10-20', NOW1, NOW1), /periodKey/);
});

test('PK-2 周 periodKey 日期本身非法：NaN 时刻不许变成窗口', () => {
  assert.throws(() => periodStartMsFromKey('week', '2026-02-30'), /periodKey/);
  assert.throws(() => periodStartMsFromKey('week', '2026-13-05'), /periodKey/);
});

test('PK-3 月 periodKey 的月份必须落在 01–12：2026-13 不许滚进明年（Important 2）', () => {
  assert.equal(periodStartMsFromKey('month', '2026-12'), Date.UTC(2026, 11, 1) - BJ_OFFSET_MS, '夹具：12 月照旧通过');
  assert.throws(() => periodStartMsFromKey('month', '2026-13'), /periodKey/, 'Date.UTC 会把 13 月静默滚成次年 1 月——键与窗口错位＝双发隐患');
  assert.throws(() => periodStartMsFromKey('month', '2026-00'), /periodKey/, '00 月会滚成上一年 12 月');
});

test('PK-4 年 periodKey 必须是 4 位年份（Important 2）', () => {
  assert.equal(periodStartMsFromKey('year', '2026'), Date.UTC(2026, 0, 1) - BJ_OFFSET_MS, '夹具：4 位年照旧通过');
  assert.throws(() => periodStartMsFromKey('year', '26'), /periodKey/, '"26" 会被 Date.UTC 当成公元 26 年');
  assert.throws(() => periodStartMsFromKey('year', '20260'), /periodKey/);
});

test('SP-18 本轮未落定的榜不落完成标记：他人持锁/翻牌竞态都留给下轮重评（Important 1 的另一半）', async () => {
  // 场景一：cyc0 的发放锁被"另一个进程"新鲜持有（pending < 10min），本轮对它只能败者跳过——
  // 该榜算"未落定"。若照常落完成标记，那个进程死了也要等标记 TTL（24h）才重评，
  // 比 pendingStaleMs（10min）的接管窗口还慢一个数量级。
  const cyc = await seedBoard('cycling', U13_START, [7100, 7000, 6900, 6000, 5900, 5800, 5700, 5600, 5500, 5400, 5300, 5200]);
  assert.equal((await claimBoardSettlement(
    { type: 'cycling', period: 'week', periodKey: U13, userId: String(cyc[0]) },
    { rank: 1, points: 50 },
  )).won, true, '夹具：模拟并发对手刚抢到 TOP1 的锁');
  // 把锁的 updatedAt 归一到"假时钟 9 分钟前"：仍在 10min 持有窗口内（SP-11 的反向操作，同款 raw handle）——
  // 否则真实时钟的锁对未来的假 now 而言早已超时，会被接管，场景就演不成了
  await BoardSettlementModel.collection.updateOne(
    { type: 'cycling', period: 'week', periodKey: U13, status: 'pending' },
    { $set: { updatedAt: new Date(NOW13 - 9 * 60_000) } },
  );
  const res1 = await settlePeriod('week', U13, U13_END, NOW13);
  assert.equal(res1.credited, 2, 'TOP2/3 照发，一条重复键不许打断整批');
  assert.equal(
    await BoardSettlementModel.countDocuments({
      type: 'cycling', period: 'week', periodKey: U13,
      userId: BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID, status: 'skipped',
    }),
    0,
    '榜上有未落定条目 ⇒ 完成标记不落（SP-15 的短路是"全部落定"的短路）',
  );
  // 场景二：钱落了、翻牌前 pending 行易主（flip 条件落空）⇒ 同样算未落定，大声留痕 + 不落标记
  const cycB = await seedBoard('cycling', U14_START, [6600, 6500, 6400, 6000, 5900, 5800, 5700, 5600, 5500, 5400, 5300, 5200]);
  const logsB = await captureErrors(async () => {
    const r = await settlePeriod('week', U14, U14_END, NOW14, {
      credit: async (uid, input, n) => {
        const paid = await creditPoints(uid, input, n ?? NOW14);
        if (uid === String(cycB[0])) {
          // 模拟竞态：翻牌前我的 pending 行被后台清理删掉了——flip 条件落空，钱已到账
          await BoardSettlementModel.deleteOne({ period: 'week', periodKey: U14, userId: uid, status: 'pending' });
        }
        return paid;
      },
    });
    assert.equal(r.credited, 2, '翻牌落空的那条不计入 credited');
  });
  assert.match(logsB, /翻牌未命中/, '钱到账而翻牌落空必须留痕待人工对账（原有纪律不破）');
  assert.equal(
    await BoardSettlementModel.countDocuments({
      type: 'cycling', period: 'week', periodKey: U14,
      userId: BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID, status: 'skipped',
    }),
    0,
    '翻牌竞态 ⇒ 该榜本轮未落定，不落完成标记',
  );
  assert.equal(await PointRecordModel.countDocuments({ userId: cycB[0], refId: `cycling:week:${U14}` }), 1, '夹具自证：那条钱真的落了账');
});

test('SP-19 完成标记过期重评后同结论：reason 归位完成留痕并续期 TTL（markBoardSettled 撞键分支）', async () => {
  await seedBoard('cycling', U15_START, [6600, 6500, 6450, 6000, 5900, 5800, 5700, 5600, 5500, 5400, 5300, 5200]);
  await settlePeriod('week', U15, U15_END, NOW15);
  const key = { type: 'cycling', period: 'week' as const, periodKey: U15, userId: BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID };
  const row = await BoardSettlementModel.findOne(key).lean();
  assert.ok(row, '首轮：cycling 过门槛且全部落定 ⇒ 完成标记已落');
  assert.match(row?.reason ?? '', /已完成结算/);
  // 模拟"标记早已过期 + 上一世文案"：updatedAt 归零、reason 改写（raw handle 绕过 timestamps 插件）
  await BoardSettlementModel.collection.updateOne({ _id: row?._id }, { $set: { updatedAt: new Date(0), reason: '占位旧文案（过期模拟）' } });
  // 假时钟推过期后重评：榜仍过门槛、三条仍撞 credited 终态 ⇒ 全部落定，标记续期并归位
  await settlePeriod('week', U15, U15_END, NOW15 + DAY_MS + 60_000);
  const after = await BoardSettlementModel.findOne(key).lean();
  assert.match(after?.reason ?? '', /已完成结算/, '重评同结论 ⇒ reason 归位完成留痕（Task 10 台账页看最新结论）');
  assert.ok((after?.updatedAt as Date).getTime() > 0, '重评同结论 ⇒ 续期 TTL，否则从过期起每次进页重扫该榜');
  assert.equal(await BoardSettlementModel.countDocuments(key), 1, '撞键分支只更新既有行，不新增行');
});
