import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import mongoose, { Types } from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { trustedBoardRows } from '../src/services/points-board.js';
import { hasNoPace, NO_PACE_TYPES } from '../src/utils/pace.js';
import { DRIFT_SCORE_PB_GATE, MIN_PLAUSIBLE_PACE_SEC_PER_KM } from '../src/config/constants.js';

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
