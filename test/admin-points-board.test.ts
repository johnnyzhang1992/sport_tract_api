import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import mongoose, { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import {
  BoardSettlementModel,
  PointAccountModel,
  PointDailyModel,
  PointLotModel,
  PointRecordModel,
  BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID,
  BOARD_SETTLEMENT_SETTLED_MARKER_REASON_PREFIX,
  BOARD_SETTLEMENT_THRESHOLD_SKIP_REASON_PREFIX,
  isBoardLevelRow,
  isSettledMarker,
  isThresholdSkip,
} from '../src/models/point.model.js';
import { NotificationModel } from '../src/models/notification.model.js';
import { AppSettingModel } from '../src/models/app-setting.model.js';
import { isBoardRewardsEnabled, resetBoardSwitchCacheForTest } from '../src/services/board-switch.js';
import { hasBoardSettlementAdminReadIndex } from '../src/utils/guard-index.js';
import { creditPoints, debitPoints } from '../src/services/points-ledger.js';
import {
  markBoardSettled,
  recordBoardSettlementSkipped,
  thresholdSkipReason,
  revokeBoardSettlement,
  boardSettlementListFilter,
  BOARD_REVOKE_ROLLBACK_TYPE,
  PERIOD_LABEL,
  TYPE_LABEL,
  boardPeriodTag,
} from '../src/services/points-board.js';

/**
 * 后台·榜单发放台账（Task 10，spec §4.7/§4.8 第 4 条）：列表 + 撤回（备注必填 + 定向通知）。
 *
 * 断言分工：
 * - AB-1：两条新路由都要过 adminAuth（照 admin-points-auth 的 PT-15 口径——状态码之外还要点名凭证，
 *   且**不许是 404**：没挂上的路由同样回 404，只断 401/403 会把「路由压根不存在」当成「鉴权生效」）。
 * - AB-2：撤回成对（照 makeup_reward_rollback 的形状）——反向流水 + 台账 revoked + **定向**通知；
 *   §4.8 第 4 条文案逐字（含 −U+2212），备注原文出现在正文末尾；recordId  linkage 不许被动过（审计可追溯）。
 * - AB-3/4/5：备注必填、重复撤回幂等、余额不得扣成负数（错误点名对象+实际值+上限）。
 * - AB-6/6b：settlePeriod 写出的两类 status='skipped' 哨兵行（门槛占位 / 完成标记）**不是发放行**，
 *   撤回必须被拒（不是静默成功），列表默认也不许把它们混进发放行；判别式是 reason 常量前缀 +
 *   结构（哨兵 userId），reason 认不出来的整榜行照样按整榜行处理（结构判定优先于自由文本）。
 * - AB-9/9b（修复轮 1，评审 Important 1+2；编号补上原本缺的 AB-9，文件顺序仍是 8→9→9b→10 单调）：
 *   撤回前那道「对着原流水冲销」的对账闸门——recordId 指向一条已被删掉的流水（AB-9），以及台账行与
 *   流水在 type / refId / userId / **delta（金额）** 四处任一对不上（AB-9b，金额这条就是修复轮 1 补的），
 *   都必须 400 交人工对账，且一笔都不许多写（反向流水 0 条、通知 0 条、台账仍 credited、余额不动）。
 *   钱账依据与到账侧的补翻牌同一条不变式（points-board.ts:705 的 dupRecord.delta !== r.points）。
 * - AB-10：Task 6 评审点名的 {period,status} 读路径——新索引声明侧 + 真实库侧 + EXPLAIN 三处钉住；
 *   修复轮 1（评审 Minor）把声明侧与库侧都改成调 src/utils/guard-index.ts 的同一个谓词
 *   `hasBoardSettlementAdminReadIndex`：本文件原来只比 `Object.keys().join(',')`＝认得出键序、
 *   认不出方向（status: -1 照样绿），谓词还要求每个键值都是 1，两侧从此核对同一件事。
 *
 * 共享 dev 库纪律（本文件绝不碰真实用户）：
 * - **不调用 settlePeriod / settleDueForUser**（一个真榜的 TOP3 在 dev 库里是真实用户，
 *   债务修复轮的教训见 test/points-board.test.ts 文件头 G1/G2）；台账行与流水全部手工种，
 *   收款人一律本文件自造的 ObjectId。
 * - periodKey 全取 2034-03/04 的未来周（东八区周一，且不与 points-board 的 WEEK_KEYS 重合）：
 *   别的会话不会往这些周期落行，按 periodKey 收口的绝对计数与 after() 清理才成立。
 * - after() 按 OWN_* 键与 fixtureUsers 双路清理，并跑一遍「越界核对」（G1/G2 同款）：
 *   本文件拥有的单元里出现非夹具用户的 board_reward / board_reward_rollback 流水 ⇒ 红。
 */

const BASE = '/sport-track/api/admin';
const ADMIN_USER = 'admin_board_t10';
const ADMIN_PASS = 'test123456';

/** 本文件独占的未来周键（全部是东八区周一，见 test/points-board.test.ts 的键形态纪律） */
const W_PAYOUT = '2034-03-06'; // AB-2/3/4/5/11/12：发放行撤回现场
const W_MIX = '2034-03-13';    // AB-6/6b/7/8/10：一榜多态（3 发放行 + 2 整榜占位）
const W_SENTINEL = '2034-03-20'; // AB-6：两种占位行各自落下
const W_DIRTY = '2034-03-27';   // AB-6b：reason 不是任何常量的整榜行
const W_OTHER = '2034-04-03';   // AB-8：给「按用户跨单元筛」当第二个单元
const W_FILTER = '2034-04-10';  // AB-8：筛选用例独占单元（不与 AB-7 共用，免得计数互相踩）
const W_RECONCILE = '2034-04-17'; // AB-9/9b：原流水对账分支独占（删/改流水的现场各起一行，不牵连别的用例）
const OWN_WEEK_KEYS = [W_PAYOUT, W_MIX, W_SENTINEL, W_DIRTY, W_OTHER, W_FILTER, W_RECONCILE];

const ADMIN_NOTE = '该周轨迹经复核为搭车刷量';

/**
 * §4.8 通知正文与列表 periodLabel 的周期标签：日期内部用 '/'（U+002F）、区间用「至」。
 * 分隔符写成码点而不是抄字面量：这条形态是用户逐字确认的（与流水标题的 8 位紧凑形态刻意两套，
 * SP-6 已各自钉死），写成可见字面量容易被"顺手统一"成 '-'——码点形式让任何改动都必须经过这里。
 */
const SL = String.fromCharCode(47);
const WEEK_LABEL_PAYOUT = `2034${SL}03${SL}06 至 2034${SL}03${SL}12 这一周`;
const WEEK_LABEL_MIX = `2034${SL}03${SL}13 至 2034${SL}03${SL}19 这一周`;

let app: FastifyInstance;
let adminToken = '';
let userToken = '';
let adminId = '';
const fixtureUsers: Types.ObjectId[] = [];

function mkUser(): Types.ObjectId {
  const u = new Types.ObjectId();
  fixtureUsers.push(u);
  return u;
}

/** 手工种一笔「已发放」的榜奖：真实走 creditPoints（钱与流水成对），台账行手工落 credited + recordId */
async function seedCreditedPayout(opts: {
  userId: Types.ObjectId;
  type?: string;
  period?: 'week' | 'month' | 'year';
  periodKey: string;
  rank?: number;
  points?: number;
}) {
  const type = opts.type ?? 'cycling';
  const period = opts.period ?? 'week';
  const rank = opts.rank ?? 1;
  const points = opts.points ?? 50;
  const c = await creditPoints(String(opts.userId), {
    type: 'board_reward',
    title: `${TYPE_LABEL[type]}·${PERIOD_LABEL[period]}第 ${rank} 名·${boardPeriodTag(period, opts.periodKey)}`,
    points,
    bizDate: '2034-03-13',
    refType: 'board',
    refId: `${type}:${period}:${opts.periodKey}`,
    idemKey: `${opts.userId}:board:${type}:${period}:${opts.periodKey}`,
    ignoreDailyCap: true,
  });
  const row = await BoardSettlementModel.create({
    type, period, periodKey: opts.periodKey, userId: opts.userId,
    rank, points, status: 'credited', recordId: c.recordId,
  });
  return { row, recordId: c.recordId as string };
}

/** 临时劫持 console.error 捕获留痕（--test-concurrency=1 + 文件内串行，劫持安全） */
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

const get = (url: string, token = adminToken) => app.inject({
  method: 'GET',
  url,
  headers: token ? { authorization: `Bearer ${token}` } : {},
});
const post = (url: string, payload: unknown, token = adminToken) => app.inject({
  method: 'POST',
  url,
  headers: token ? { authorization: `Bearer ${token}` } : {},
  payload: payload as object,
});

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await BoardSettlementModel.init(); // 唯一键与新读索引都是异步建的，不等就断言会假绿
  await AdminModel.deleteOne({ username: ADMIN_USER });
  const admin = await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  adminId = String(admin._id);
  const login = await app.inject({ method: 'POST', url: `${BASE}/login`, payload: { username: ADMIN_USER, password: ADMIN_PASS } });
  adminToken = login.json().data.token;
  assert.ok(adminToken, '管理员登录应成功');
  userToken = app.signAccessToken(String(new Types.ObjectId()));
});

after(async () => {
  const ids = fixtureUsers.map((u) => String(u));
  // 越界核对（points-board G1/G2 同款，清理之前取数）：本文件拥有的单元里不许出现非夹具用户的榜奖流水
  const guardMsgs: string[] = [];
  try {
    const ownedRefIds = OWN_WEEK_KEYS.flatMap((k) => ['cycling', 'running', 'walking'].flatMap((t) => [
      `${t}:week:${k}`, `${t}:month:${k}`, `${t}:year:${k}`,
    ]));
    const foreign = await PointRecordModel.find({
      type: { $in: ['board_reward', BOARD_REVOKE_ROLLBACK_TYPE] },
      refId: { $in: ownedRefIds },
      userId: { $nin: ids },
    }).select({ userId: 1, refId: 1, delta: 1 }).lean();
    if (foreign.length > 0) {
      guardMsgs.push(`G1 越界流水 ${foreign.length} 条：${foreign.slice(0, 3).map((r) => `user=${r.userId} ref=${r.refId} delta=${r.delta}`).join(' | ')}`);
    }
  } catch (e) {
    guardMsgs.push(`守卫查询自身失败（不许因此放行）：${(e as Error).message}`);
  }
  try {
    await BoardSettlementModel.deleteMany({ periodKey: { $in: OWN_WEEK_KEYS } });
    await PointRecordModel.deleteMany({ userId: { $in: ids } });
    await PointAccountModel.deleteMany({ userId: { $in: ids } });
    await PointLotModel.deleteMany({ userId: { $in: ids } });
    await PointDailyModel.deleteMany({ userId: { $in: ids } });
    await NotificationModel.deleteMany({ userId: { $in: fixtureUsers } });
  } catch (err) {
    console.error('[admin-points-board.test] 夹具清理失败，dev 库有残留', err);
  }
  await AdminModel.deleteOne({ username: ADMIN_USER });
  await app.close();
  await mongoose.disconnect().catch(() => {});
  if (guardMsgs.length > 0) {
    throw new Error(`[admin-points-board.test] 夹具给真实用户发/扣榜奖越界：\n${guardMsgs.join('\n')}`);
  }
});

/* ==================================================================
 * AB-1 鉴权闸门
 * ================================================================== */

test('AB-1 未登录/非 admin → 401/403（两条路由都要）', async () => {
  const routes: Array<{ method: 'GET' | 'POST'; url: string; payload?: unknown }> = [
    { method: 'GET', url: `${BASE}/points/board-settlements` },
    { method: 'POST', url: `${BASE}/points/board-settlements/${new Types.ObjectId()}/revoke`, payload: { note: ADMIN_NOTE } },
  ];
  for (const r of routes) {
    const anon = await (r.method === 'GET' ? get(r.url, '') : post(r.url, r.payload, ''));
    assert.notEqual(anon.statusCode, 404, `${r.method} ${r.url} 回 404 ＝ 路由没挂上，不是鉴权生效`);
    assert.ok(anon.statusCode === 401 || anon.statusCode === 403, `匿名应 401/403，实际 ${anon.statusCode}：${anon.body}`);
    assert.match(anon.json().message, /管理员|凭证|token|权限/i, `匿名 message 要点名凭证：${anon.body}`);

    const asUser = await (r.method === 'GET' ? get(r.url, userToken) : post(r.url, r.payload, userToken));
    assert.notEqual(asUser.statusCode, 404, `${r.method} ${r.url} 用户 token 回 404 ＝ 路由没挂上`);
    assert.ok(asUser.statusCode === 401 || asUser.statusCode === 403, `用户 token 应 401/403，实际 ${asUser.statusCode}：${asUser.body}`);
    assert.match(asUser.json().message, /管理员|凭证|token|权限/i, `用户 token 的 message 要点名凭证：${asUser.body}`);
  }
  // 反证：路由确实存在且管理员能过闸门（空结果 200，不是 404）
  const ok = await get(`${BASE}/points/board-settlements?period=week&periodKey=${W_OTHER}`);
  assert.equal(ok.statusCode, 200, `管理员凭证下应 200：${ok.body}`);
});

/* ==================================================================
 * AB-2 成对撤回
 * ================================================================== */

test('AB-2 撤回：反向流水（type=board_reward_rollback）+ 台账 revoked + 定向通知含备注', async () => {
  const u = mkUser();
  const { row, recordId } = await seedCreditedPayout({ userId: u, periodKey: W_PAYOUT, rank: 1, points: 50 });
  const res = await post(`${BASE}/points/board-settlements/${row._id}/revoke`, { note: ADMIN_NOTE });
  assert.equal(res.statusCode, 200, `撤回应成功：${res.body}`);
  const data = res.json().data;
  assert.equal(data.status, 'revoked');
  assert.equal(data.points, 50);
  assert.equal(data.userId, String(u));
  assert.ok(data.rollbackRecordId, '响应带回反向流水 id（操作台要能跳到那笔流水）');

  // ① 反向流水：type 走 _rollback 族（points-admin-stats 的 ROLLBACK_RE 同口径），分值取负
  const back = await PointRecordModel.findOne({ idemKey: `${u}:board_rollback:cycling:week:${W_PAYOUT}` }).lean();
  assert.ok(back, '必须落下反向流水（幂等键＝userId:board_rollback:type:period:periodKey）');
  assert.equal(back!.type, BOARD_REVOKE_ROLLBACK_TYPE);
  assert.equal(back!.type, 'board_reward_rollback');
  assert.equal(back!.delta, -50);
  assert.equal(back!.refType, 'board');
  assert.equal(back!.refId, `cycling:week:${W_PAYOUT}`);
  // 流水标题沿用 boardPeriodTag 形态（周＝8 位无分隔紧凑串，与通知正文的 boardLabel 刻意不同式，SP-6 同纪律）
  assert.equal(back!.title, '撤回骑行·周榜第 1 名·20340306周');
  assert.match(back!.bizDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(String(back!._id), String(data.rollbackRecordId));

  // ② 台账行：revoked + 备注进 reason + 操作人留痕，**recordId 原样不动**（审计链：流水 → 台账行 → 通知）
  const led = await BoardSettlementModel.findById(row._id).lean();
  assert.equal(led!.status, 'revoked');
  assert.equal(led!.reason, ADMIN_NOTE, '后台备注要落在台账行的 reason 上');
  assert.equal(String(led!.recordId), recordId, '撤回不许擦掉原流水凭据（record→ledger 反查链）');
  assert.equal(String(led!.revokedBy), adminId, '留痕谁撤的');
  assert.ok(Number(led!.revokedAt) > 0);
  // 唯一键继续占位（不删行）：懒结算不会把这笔钱再发一遍
  assert.equal(await BoardSettlementModel.countDocuments({ type: 'cycling', periodKey: W_PAYOUT, userId: u }), 1);

  // ③ 定向通知：§4.8 第 4 条逐字（标题 + 正文 + −U+2212 + 备注原文）
  const notes = await NotificationModel.find({ userId: u }).lean();
  assert.equal(notes.length, 1, '一条定向通知，不许多发');
  assert.equal(notes[0].title, '榜单积分奖励调整');
  assert.equal(
    notes[0].content,
    `「骑行·周榜」第 1 名奖励 +50 积分已撤回 −50 积分（${WEEK_LABEL_PAYOUT}）。原因：${ADMIN_NOTE}`,
  );
  assert.equal(notes[0].published, true);
  assert.equal(data.notification.content, notes[0].content, '响应带回通知正文（弹窗二次确认之外还要能核对）');
  // 钱真扣回来了
  assert.equal(data.balance, 0);
  assert.equal((await PointAccountModel.findOne({ userId: u }).lean())!.balance, 0);
});

/* ==================================================================
 * AB-3 备注必填
 * ================================================================== */

test('AB-3 备注缺失 → 400，文案点明「撤回备注必填」', async () => {
  const u = mkUser();
  const { row } = await seedCreditedPayout({ userId: u, periodKey: W_PAYOUT, points: 50 });
  for (const body of [{}, { note: '' }, { note: '   ' }, { note: null }, undefined]) {
    const res = await post(`${BASE}/points/board-settlements/${row._id}/revoke`, body);
    assert.equal(res.statusCode, 400, `缺备注必须 400（收到 ${JSON.stringify(body)}）：${res.body}`);
    const msg = res.json().message;
    assert.match(msg, /撤回备注必填/, `文案要点名「撤回备注必填」：${msg}`);
    // 修复轮 1（评审 Minor）：字段名只出现一次——原句是「撤回备注必填：…（撤回备注必填）」自己抄自己
    assert.equal(msg.split('撤回备注必填').length - 1, 1, `同一句话里不许把字段名写两遍：${msg}`);
    assert.match(msg, /通知/, `文案要说清为什么要紧（会出现在用户通知里）：${msg}`);
  }
  // 一笔都没动：没有反向流水、没有通知、台账还是 credited
  assert.equal(await PointRecordModel.countDocuments({ userId: u, type: 'board_reward_rollback' }), 0);
  assert.equal(await NotificationModel.countDocuments({ userId: u }), 0);
  assert.equal((await BoardSettlementModel.findById(row._id).lean())!.status, 'credited');
  // 超长备注同样拒绝（会原文进用户通知，不能当自由文本塞）
  const tooLong = await post(`${BASE}/points/board-settlements/${row._id}/revoke`, { note: '啊'.repeat(201) });
  assert.equal(tooLong.statusCode, 400, `超长备注应 400：${tooLong.body}`);
  assert.match(tooLong.json().message, /200/);
  assert.equal((await BoardSettlementModel.findById(row._id).lean())!.status, 'credited');
});

/* ==================================================================
 * AB-4 幂等
 * ================================================================== */

test('AB-4 撤回幂等：已 revoked 再撤 → 400，不产生第二条反向流水', async () => {
  const u = mkUser();
  const { row } = await seedCreditedPayout({ userId: u, periodKey: W_PAYOUT, points: 50 });
  const first = await post(`${BASE}/points/board-settlements/${row._id}/revoke`, { note: ADMIN_NOTE });
  assert.equal(first.statusCode, 200, `首次撤回应成功：${first.body}`);

  const second = await post(`${BASE}/points/board-settlements/${row._id}/revoke`, { note: '第二次手滑' });
  assert.equal(second.statusCode, 400, `重复撤回必须 400：${second.body}`);
  assert.match(second.json().message, /该发放记录已撤回/, `文案要用 revoked 专属那条话术（不是兜底分支）：${second.body}`);

  assert.equal(await PointRecordModel.countDocuments({ userId: u, type: 'board_reward_rollback' }), 1, '绝不产生第二条反向流水');
  assert.equal(await PointRecordModel.countDocuments({ userId: u }), 2, '一笔发放 + 一笔撤回，共两条流水');
  assert.equal(await NotificationModel.countDocuments({ userId: u }), 1, '通知也不重发');
  assert.equal((await PointAccountModel.findOne({ userId: u }).lean())!.balance, 0, '余额不能被第二次撤回再扣 50（会变负）');
  const led = await BoardSettlementModel.findById(row._id).lean();
  assert.equal(led!.status, 'revoked');
  assert.equal(led!.reason, ADMIN_NOTE, '第二次被拒 ⇒ 备注不许被改写');
});

/* ==================================================================
 * AB-5 余额闸门
 * ================================================================== */

test('AB-5 撤回不能把余额扣成负数（余额不足时 400 并说明实际余额）', async () => {
  const u = mkUser();
  const { row } = await seedCreditedPayout({ userId: u, periodKey: W_PAYOUT, points: 50 });
  // 用户已把这 50 分花掉 30：余额只剩 20
  await debitPoints(String(u), {
    type: 'exchange', title: '兑换免广告卡', points: 30, bizDate: '2034-03-13',
    refType: 'item', refId: 'ad_free_30', idemKey: `${u}:exchange:fixture`,
  });
  const before = (await PointAccountModel.findOne({ userId: u }).lean())!.balance;
  assert.equal(before, 20, '夹具自证：余额 20 < 应撤 50');

  const res = await post(`${BASE}/points/board-settlements/${row._id}/revoke`, { note: ADMIN_NOTE });
  assert.equal(res.statusCode, 400, `余额不足必须 400：${res.body}`);
  const msg = res.json().message;
  // 对象 + 实际值 + 上限（本仓错误文案纪律：点名收到/实际的数，别只说「操作失败」）
  assert.match(msg, /余额不足/, `文案要点名余额不足：${msg}`);
  assert.ok(msg.includes('20'), `文案要带实际余额 20：${msg}`);
  assert.ok(msg.includes('50'), `文案要带应扣回的上限 50：${msg}`);
  assert.match(msg, /上限/, `文案要点名可扣上限：${msg}`);

  // 什么都没发生：钱没扣、台账没翻、没有反向流水与通知
  assert.equal((await PointAccountModel.findOne({ userId: u }).lean())!.balance, 20);
  assert.equal((await BoardSettlementModel.findById(row._id).lean())!.status, 'credited');
  assert.equal(await PointRecordModel.countDocuments({ userId: u, type: 'board_reward_rollback' }), 0);
  assert.equal(await NotificationModel.countDocuments({ userId: u }), 0);
});

/* ==================================================================
 * AB-6 / AB-6b 判别式：两类 skipped 哨兵行都不是发放行
 * ================================================================== */

test('AB-6 门槛占位与完成标记各自被结构排除：列表不混入、撤回直接拒绝', async () => {
  const board = { type: 'cycling', period: 'week' as const, periodKey: W_SENTINEL };
  assert.equal(
    await recordBoardSettlementSkipped(board, thresholdSkipReason(8, 10)),
    true,
    '门槛占位落下',
  );
  const settledBoard = { type: 'running', period: 'week' as const, periodKey: W_SENTINEL };
  await markBoardSettled(settledBoard); // 完成标记（与门槛占位同形，只有 reason 常量不同）

  const thresholdRow = await BoardSettlementModel.findOne(board).lean();
  const markerRow = await BoardSettlementModel.findOne(settledBoard).lean();
  assert.ok(thresholdRow && markerRow, '两行哨兵都在');

  // 判别式：常量前缀 + 结构（哨兵 userId）
  assert.equal(String(thresholdRow!.userId), BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID);
  assert.equal(isBoardLevelRow(thresholdRow), true);
  assert.equal(isThresholdSkip(thresholdRow), true, `reason 前缀必须是门槛常量：${thresholdRow!.reason}`);
  assert.equal(isSettledMarker(thresholdRow), false);
  assert.equal(thresholdRow!.reason.startsWith(BOARD_SETTLEMENT_THRESHOLD_SKIP_REASON_PREFIX), true);

  assert.equal(isBoardLevelRow(markerRow), true);
  assert.equal(isSettledMarker(markerRow), true, `reason 前缀必须是完成标记常量：${markerRow!.reason}`);
  assert.equal(isThresholdSkip(markerRow), false);
  assert.equal(markerRow!.reason.startsWith(BOARD_SETTLEMENT_SETTLED_MARKER_REASON_PREFIX), true);

  // 真人行不受影响
  const u = mkUser();
  const payout = await seedCreditedPayout({ userId: u, periodKey: W_SENTINEL, points: 50 });
  const payoutRow = await BoardSettlementModel.findById(payout.row._id).lean();
  assert.equal(isBoardLevelRow(payoutRow), false);
  assert.equal(isSettledMarker(payoutRow), false);
  assert.equal(isThresholdSkip(payoutRow), false);

  // 撤回两个哨兵行各自被拒（不是静默成功），一分钱都不动
  for (const sentinel of [thresholdRow!, markerRow!]) {
    const res = await post(`${BASE}/points/board-settlements/${sentinel._id}/revoke`, { note: ADMIN_NOTE });
    assert.equal(res.statusCode, 400, `整榜级行撤回必须 400（id=${sentinel._id}）：${res.body}`);
    assert.match(res.json().message, /整榜级/, `文案要点名整榜级占位行：${res.body}`);
    const after = await BoardSettlementModel.findById(sentinel._id).lean();
    assert.equal(after!.status, 'skipped', '被拒的占位行状态不许变');
    assert.equal(after!.points, 0);
  }
  assert.equal(await PointRecordModel.countDocuments({ userId: u, type: 'board_reward_rollback' }), 0, '撤回占位行不得牵连任何真人的流水');
  assert.equal(await NotificationModel.countDocuments({ userId: u }), 0, '更不该发出「奖励已撤回」的通知');

  // 列表：默认只出发放行；status=skipped 才给这两行，且 kind/boardLevel/canRevoke 三项都标注到位
  const list = (await get(`${BASE}/points/board-settlements?period=week&periodKey=${W_SENTINEL}`)).json().data;
  assert.equal(list.payoutRowsOnly, true);
  assert.deepEqual(list.items.map((i: { kind: string }) => i.kind), ['payout']);
  const skipped = (await get(`${BASE}/points/board-settlements?period=week&periodKey=${W_SENTINEL}&status=skipped`)).json().data;
  assert.equal(skipped.total, 2, '整榜级行只有显式要 status=skipped 才出现');
  assert.deepEqual(
    skipped.items.map((i: { kind: string }) => i.kind).sort(),
    ['settled_marker', 'threshold_skip'],
  );
  for (const item of skipped.items) {
    assert.equal(item.boardLevel, true);
    assert.equal(item.canRevoke, false, '整榜级行不渲染撤回按钮');
    assert.equal(item.userId, null, '哨兵 userId 不外泄成「某个用户」');
    assert.equal(item.points, 0);
  }
});

test('AB-6b reason 认不出来的整榜行仍按整榜行处理（结构判定优先于自由文本）', async () => {
  // 手工种一行「skipped + 别的文案」（历史上写过的旧文案 / 别的调用方给的 reason）
  const row = await BoardSettlementModel.create({
    type: 'walking', period: 'week', periodKey: W_DIRTY,
    userId: BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID, rank: 0, points: 0,
    status: 'skipped', reason: '上一世留下的自由文本',
  });
  assert.equal(isBoardLevelRow(row), true, '结构（哨兵 userId + skipped）就足以判定整榜级');
  assert.equal(isSettledMarker(row), false);
  assert.equal(isThresholdSkip(row), false);

  const res = await post(`${BASE}/points/board-settlements/${row._id}/revoke`, { note: ADMIN_NOTE });
  assert.equal(res.statusCode, 400, `未分类的整榜行同样不许撤回：${res.body}`);
  assert.match(res.json().message, /整榜级/);

  const list = (await get(`${BASE}/points/board-settlements?period=week&periodKey=${W_DIRTY}`)).json().data;
  assert.equal(list.total, 0, '默认列表里一行都不许出现');
  const skipped = (await get(`${BASE}/points/board-settlements?period=week&periodKey=${W_DIRTY}&status=skipped`)).json().data;
  assert.equal(skipped.items.length, 1);
  assert.equal(skipped.items[0].kind, 'board_level', 'reason 不认识 ⇒ 归「整榜级未分类」，仍不是发放行');
  assert.equal(skipped.items[0].canRevoke, false);
});

/* ==================================================================
 * AB-7 列表：发放行 vs 整榜行的分界 + 分页
 * ================================================================== */

test('AB-7 台账列表默认只出发放行（pending/credited/revoked 在列，两类占位不混入），并正确分页', async () => {
  const u1 = mkUser();
  const u2 = mkUser();
  const credited = await seedCreditedPayout({ userId: u1, periodKey: W_MIX, rank: 1, points: 50 });
  await BoardSettlementModel.create({
    type: 'running', period: 'week', periodKey: W_MIX, userId: u2, rank: 2, points: 30, status: 'pending',
  });
  await BoardSettlementModel.create({
    type: 'walking', period: 'week', periodKey: W_MIX, userId: mkUser(), rank: 3, points: 20,
    status: 'revoked', reason: '运营复核：判定刷分',
  });
  await recordBoardSettlementSkipped({ type: 'hiking', period: 'week', periodKey: W_MIX }, thresholdSkipReason(4, 10));
  await markBoardSettled({ type: 'skiing', period: 'week', periodKey: W_MIX });

  const list = (await get(`${BASE}/points/board-settlements?period=week&periodKey=${W_MIX}`)).json().data;
  assert.equal(list.total, 3, '三行发放台账（pending/credited/revoked），两行整榜占位不在内');
  assert.equal(list.payoutRowsOnly, true);
  const byStatus = Object.fromEntries(list.items.map((i: { status: string; id: string }) => [i.status, i]));
  assert.deepEqual(Object.keys(byStatus).sort(), ['credited', 'pending', 'revoked']);
  assert.equal(byStatus.credited.id, String(credited.row._id));
  for (const item of list.items) {
    assert.equal(item.boardLevel, false);
    assert.equal(item.kind, 'payout');
    assert.equal(item.userId && Types.ObjectId.isValid(item.userId), true, '发放行的 userId 是真用户 id');
    assert.equal(typeof item.nickname, 'string');
    assert.equal(typeof item.uid, 'number');
  }
  // 只有 credited 行给撤回按钮
  assert.equal(byStatus.credited.canRevoke, true);
  assert.equal(byStatus.pending.canRevoke, false, 'pending 是锁持有中，不是已完成发放');
  assert.equal(byStatus.revoked.canRevoke, false, '已撤回的行不再提供撤回');
  // 展示字段（Task 11 直接渲染，不再自己拼文案）
  assert.equal(byStatus.credited.typeLabel, '骑行');
  assert.equal(byStatus.credited.periodLabel, WEEK_LABEL_MIX);
  assert.equal(byStatus.credited.points, 50);
  assert.equal(byStatus.credited.rank, 1);
  assert.equal(byStatus.credited.recordId, credited.recordId);

  // 分页：按筛选后的总数翻页
  const p1 = (await get(`${BASE}/points/board-settlements?period=week&periodKey=${W_MIX}&pageSize=2&page=1`)).json().data;
  const p2 = (await get(`${BASE}/points/board-settlements?period=week&periodKey=${W_MIX}&pageSize=2&page=2`)).json().data;
  assert.equal(p1.total, 3);
  assert.equal(p1.pageSize, 2);
  assert.equal(p1.items.length, 2);
  assert.equal(p2.items.length, 1);
  assert.deepEqual(
    [...p1.items.map((i: { id: string }) => i.id), ...p2.items.map((i: { id: string }) => i.id)].sort(),
    list.items.map((i: { id: string }) => i.id).sort(),
    '两页拼起来＝不分页的全集（不重不漏）',
  );
  // 排序稳定（同一筛选条件下翻页不跳行）：按 _id 倒序＝后落的行在前
  const ids = list.items.map((i: { id: string }) => i.id);
  assert.deepEqual(ids, [...ids].sort().reverse(), '默认排序必须是 _id 倒序（否则翻页会重行/漏行）');

  // 显式要整榜行时才出现，且此时不含发放行
  const skipped = (await get(`${BASE}/points/board-settlements?period=week&periodKey=${W_MIX}&status=skipped`)).json().data;
  assert.equal(skipped.total, 2);
  assert.equal(skipped.payoutRowsOnly, false);
  assert.deepEqual(skipped.items.map((i: { kind: string }) => i.kind).sort(), ['settled_marker', 'threshold_skip']);
});

/* ==================================================================
 * AB-8 筛选与入参闸门
 * ================================================================== */

test('AB-8 筛选 type/userId/status 各自收窄，非法入参 400 点名收到的值', async () => {
  const u = mkUser();
  const { row } = await seedCreditedPayout({ userId: u, periodKey: W_FILTER, type: 'cycling', rank: 1, points: 50 });
  await seedCreditedPayout({ userId: u, periodKey: W_OTHER, type: 'running', rank: 2, points: 30 });

  const byType = (await get(`${BASE}/points/board-settlements?period=week&periodKey=${W_FILTER}&type=cycling`)).json().data;
  assert.deepEqual(byType.items.map((i: { type: string }) => i.type), ['cycling']);
  const byUser = (await get(`${BASE}/points/board-settlements?userId=${u}`)).json().data;
  assert.equal(byUser.total, 2, '按用户筛：两个单元的发放行都在（默认仍排除整榜行）');
  const byUserAndPeriod = (await get(`${BASE}/points/board-settlements?userId=${u}&period=week&periodKey=${W_OTHER}`)).json().data;
  assert.deepEqual(byUserAndPeriod.items.map((i: { type: string }) => i.type), ['running']);
  const revokedOnly = (await get(`${BASE}/points/board-settlements?period=week&periodKey=${W_FILTER}&status=credited`)).json().data;
  assert.ok(revokedOnly.items.some((i: { id: string }) => i.id === String(row._id)));

  // 非法入参：一律 400 且点名收到的值（本仓错误文案纪律）
  const bad: Array<[string, RegExp]> = [
    ['status', /筛选状态只能是 pending \/ credited \/ skipped \/ revoked/],
    ['period', /筛选周期只能是 week \/ month \/ year/],
    ['type', /运动类型/],
    ['userId', /用户 ID 不合法/],
    ['periodKey', /periodKey/],
  ];
  for (const [field, copy] of bad) {
    const q = field === 'userId' ? 'userId=not-an-id'
      : field === 'periodKey' ? `period=week&periodKey=20340313`
      : field === 'type' ? 'type=t_fake_type'
      : field === 'period' ? 'period=daily'
      : 'status=done';
    const res = await get(`${BASE}/points/board-settlements?${q}`);
    assert.equal(res.statusCode, 400, `${field} 非法应 400：${res.body}`);
    assert.match(res.json().message, copy, `${field} 的文案不对：${res.body}`);
  }
  // periodKey 必须与 period 同传（新索引的前缀是 {period, periodKey}，只给 periodKey 就落不到索引上）
  const lonely = await get(`${BASE}/points/board-settlements?periodKey=${W_MIX}`);
  assert.equal(lonely.statusCode, 400, `只给 periodKey 不给 period：${lonely.body}`);
  assert.match(lonely.json().message, /必须同时给出 period/, `文案要点名「periodKey 必须与 period 同传」这条索引前缀纪律：${lonely.body}`);
});

/* ==================================================================
 * AB-9 / AB-9b 撤回前的原流水对账（修复轮 1：评审 Important 1+2）
 * ================================================================== */

/** 每笔现场共用的「什么都没写」自证：反向流水、通知、台账状态、余额都不许动（流水条数按改前的实测值比） */
async function assertNothingWritten(
  u: Types.ObjectId,
  rowId: unknown,
  expect: { recordId: string; balance: number; recordsBefore: number },
) {
  assert.equal(await PointRecordModel.countDocuments({ userId: u, type: BOARD_REVOKE_ROLLBACK_TYPE }), 0, '对账失败不得落下反向流水');
  assert.equal(
    await PointRecordModel.countDocuments({ userId: u }),
    expect.recordsBefore,
    '夹具自证：流水条数与动手之前一致（没多一笔撤回）',
  );
  assert.equal(await NotificationModel.countDocuments({ userId: u }), 0, '对账失败也不许给用户发通知');
  const led = await BoardSettlementModel.findById(rowId).lean();
  assert.equal(led!.status, 'credited', '被拒的撤回不许翻牌');
  assert.equal(String(led!.recordId), expect.recordId, '被拒的撤回不许顺手清掉 recordId');
  const acct = await PointAccountModel.findOne({ userId: u }).lean();
  assert.equal(acct!.balance, expect.balance, `余额一分未动（应为 ${expect.balance}）`);
}

test('AB-9 原流水已不存在（recordId 指向一条被删掉的流水）→ 400 交人工对账，不落任何一笔账', async () => {
  const u = mkUser();
  const { row, recordId } = await seedCreditedPayout({ userId: u, periodKey: W_RECONCILE, points: 50 });
  // 现场：台账行还带着 recordId，库里那条流水却没了（历史手工删账 / 别的清理脚本干的）
  const del = await PointRecordModel.deleteOne({ _id: recordId, userId: u });
  assert.equal(del.deletedCount, 1, '夹具自证：原流水确实被删掉了');

  const res = await post(`${BASE}/points/board-settlements/${row._id}/revoke`, { note: ADMIN_NOTE });
  assert.equal(res.statusCode, 400, `原流水缺失必须 400：${res.body}`);
  const msg = res.json().message;
  // 专属话术（不是 AB-11 的「缺少流水凭据」：recordId 是有值的，缺的是那条流水本身）
  assert.match(msg, /原流水已不存在/, `文案要用「原流水已不存在」专属分支：${msg}`);
  assert.ok(msg.includes(recordId), `文案要点名是哪条流水（对象）：${msg}`);
  assert.ok(msg.includes(String(row._id)), `文案要带上台账 id 便于人工对账：${msg}`);
  assert.match(msg, /人工对账/, `对不上账的行只能交人工，文案要这么说：${msg}`);

  await assertNothingWritten(u, row._id, { recordId, balance: 50, recordsBefore: 0 });
});

test('AB-9b 台账与原流水对不上（type / refId / userId / delta 四种漂移）→ 400 点名实际值，不落任何一笔账', async () => {
  const drifts: Array<{
    label: string;
    patch: (ctx: { other: Types.ObjectId }) => Record<string, unknown>;
    /** 文案必须点名的值（本仓纪律：对象 + 实际值；金额那条要求两个数同框） */
    pins: (msg: string, ctx: { other: Types.ObjectId }) => Array<[RegExp, string]>;
  }> = [
    {
      label: '流水 type 被改成别的种类',
      patch: () => ({ type: 'makeup_reward' }),
      pins: (msg) => [[/type=makeup_reward/, '文案要带流水那侧的 type 实际值'], [/delta=50/, '金额也要报出来'], [/points=50/, '金额也要报出来']],
    },
    {
      label: '流水 refId 挂到另一张榜上',
      patch: () => ({ refId: `walking:week:${W_RECONCILE}` }),
      pins: (msg) => [[new RegExp(`refId=walking:week:${W_RECONCILE}`), '文案要带流水那侧的 refId 实际值'], [/delta=50/, '金额也要报出来'], [/points=50/, '金额也要报出来']],
    },
    {
      label: '流水的 userId 与台账行不是同一个人',
      patch: ({ other }) => ({ userId: other }),
      pins: (msg, ctx) => [[new RegExp(`userId=${ctx.other}`), '文案要带流水那侧的 userId 实际值'], [/delta=50/, '金额也要报出来'], [/points=50/, '金额也要报出来']],
    },
    {
      // 修复轮 1（评审 Important 1）：扣的是台账 points，凭据是流水 delta——不等＝撤得比发出来的多（少），
      // 与到账侧补翻牌的同一条不变式（points-board.ts:705）对齐。两个数必须在文案里同框。
      label: '流水 delta(40) ≠ 台账 points(50)：钱账漂移',
      patch: () => ({ delta: 40 }),
      pins: (msg) => [[/delta=40/, '文案要带流水的实际入账金额 40'], [/points=50/, '文案要带台账要扣回的金额 50']],
    },
  ];
  for (const d of drifts) {
    const u = mkUser();
    const other = mkUser(); // 夹具用户（在 fixtureUsers 名单里）：改完仍归本文件清理，也不触发 G1 越界
    const ctx = { other };
    const { row, recordId } = await seedCreditedPayout({ userId: u, periodKey: W_RECONCILE, points: 50 });
    const patched = d.patch(ctx);
    const upd = await PointRecordModel.updateOne({ _id: recordId, userId: u }, { $set: patched });
    assert.equal(upd.matchedCount, 1, `夹具自证：${d.label} 改到了（patch=${JSON.stringify(patched)}）`);
    const recordsBefore = await PointRecordModel.countDocuments({ userId: u });

    const res = await post(`${BASE}/points/board-settlements/${row._id}/revoke`, { note: ADMIN_NOTE });
    assert.equal(res.statusCode, 400, `${d.label} 必须 400：${res.body}`);
    const msg = res.json().message;
    assert.match(msg, /与原流水对不上/, `${d.label}：文案要用对账分支：${msg}`);
    assert.match(msg, /人工对账/, `${d.label}：对不上的钱只能交人工：${msg}`);
    assert.ok(msg.includes(String(row._id)), `${d.label}：文案要带上台账 id：${msg}`);
    for (const [re, why] of d.pins(msg, ctx)) assert.match(msg, re, `${d.label}：${why}：${msg}`);

    await assertNothingWritten(u, row._id, { recordId, balance: 50, recordsBefore });
  }
});

/* ==================================================================
 * AB-10 索引防线（Task 6 评审点名的 {period,status} 读路径）
 * ================================================================== */

test('AB-10 管理端读索引：声明侧与真实库侧都在，且列表查询走 IXSCAN 不做集合扫描', async () => {
  // 修复轮 1（评审 Minor）：声明侧改成调 guard-index 的**同一个谓词**——原来只比
  // `Object.keys(keys).join(',')`＝认得出键序、认不出方向（status: -1 也照样绿），
  // 谓词还要求每个键值都是 1，两侧从此核对同一件事（少一处"测试比防线宽"的口径）。
  const declared = BoardSettlementModel.schema.indexes().map(([keys]) => ({ key: keys as Record<string, unknown> }));
  assert.ok(
    hasBoardSettlementAdminReadIndex(declared),
    `schema 里没有 {period,periodKey,status,type,userId}（全 1 方向）这条声明！现有声明：${JSON.stringify(declared.map((d) => d.key))}`,
  );
  await BoardSettlementModel.createIndexes();
  const idx = await BoardSettlementModel.collection.indexes();
  const adminIdx = idx.find((i) => hasBoardSettlementAdminReadIndex([i]));
  assert.ok(adminIdx, `真实库里没有这条读索引！现有索引：${JSON.stringify(idx.map((i) => i.key))}`);

  // EXPLAIN：服务层实际构造的过滤器形状必须 IXSCAN 且「取到的文档数＝返回数」
  // （等值前缀 period+periodKey+status 全部命中索引，不留 COLLSCAN、也不逐文档回表过滤）
  await BoardSettlementModel.create({ type: 'swimming', period: 'week', periodKey: W_MIX, userId: mkUser(), rank: 1, points: 50, status: 'credited' });
  const explain: any = await BoardSettlementModel
    .find(boardSettlementListFilter({ period: 'week', periodKey: W_MIX, status: 'credited' }))
    .sort({ _id: -1 })
    .explain('executionStats');
  const stages: string[] = [];
  const indexNames: string[] = [];
  const walk = (node: any) => {
    if (!node) return;
    if (node.stage) stages.push(node.stage);
    if (node.indexName) indexNames.push(node.indexName);
    walk(node.inputStage);
    for (const child of node.inputStages ?? []) walk(child);
    if (node.queryPlanner) walk(node.queryPlanner.winningPlan);
  };
  walk(explain.queryPlanner?.winningPlan ?? explain);
  assert.equal(stages.includes('COLLSCAN'), false, `列表查询走了集合扫描：${JSON.stringify(stages)}`);
  assert.ok(stages.includes('IXSCAN'), `没有 IXSCAN：${JSON.stringify(stages)}`);
  assert.ok(indexNames.includes(String(adminIdx!.name)),
    `这条筛选没落到新读索引 ${adminIdx!.name} 上（Task 6 评审点名的 {period,status} 读路径）：${JSON.stringify(indexNames)}`);
  const stats = explain.executionStats ?? {};
  assert.ok(Number(stats.nReturned ?? 0) >= 1, '夹具自证：这条筛选至少命中一行');
  assert.equal(stats.totalDocsExamined, stats.totalKeysExamined,
    `等值前缀没有全部落在索引上（回表取数 ${stats.totalDocsExamined} / 键 ${stats.totalKeysExamined}）`);
});

/* ==================================================================
 * AB-11 / AB-12 撤回的其余闸门
 * ================================================================== */

test('AB-11 台账行缺流水凭据（recordId 为空）→ 400 交人工对账，不发反向流水', async () => {
  const u = mkUser();
  const row = await BoardSettlementModel.create({
    type: 'cycling', period: 'week', periodKey: W_PAYOUT, userId: u, rank: 1, points: 50, status: 'credited',
  });
  const res = await post(`${BASE}/points/board-settlements/${row._id}/revoke`, { note: ADMIN_NOTE });
  assert.equal(res.statusCode, 400, `无凭据必须 400：${res.body}`);
  assert.match(res.json().message, /缺少流水凭据/, `文案要用「缺少流水凭据」专属话术（不是流水缺失的兜底分支）：${res.body}`);
  assert.equal(await PointRecordModel.countDocuments({ userId: u, type: 'board_reward_rollback' }), 0);
  assert.equal((await BoardSettlementModel.findById(row._id).lean())!.status, 'credited');

  // 行不存在 / id 形态非法 → 404（仓内「外来 id 藏进 404」口径）
  const ghost = await post(`${BASE}/points/board-settlements/${new Types.ObjectId()}/revoke`, { note: ADMIN_NOTE });
  assert.equal(ghost.statusCode, 404, ghost.body);
  assert.match(ghost.json().message, /台账/);
  const malformed = await post(`${BASE}/points/board-settlements/not-an-id/revoke`, { note: ADMIN_NOTE });
  assert.equal(malformed.statusCode, 404, malformed.body);

  // 还在结算中的 pending 行不是「已发放」，撤回同样被拒
  const pending = await BoardSettlementModel.create({
    type: 'running', period: 'week', periodKey: W_PAYOUT, userId: mkUser(), rank: 2, points: 30, status: 'pending',
  });
  const r2 = await post(`${BASE}/points/board-settlements/${pending._id}/revoke`, { note: ADMIN_NOTE });
  assert.equal(r2.statusCode, 400, `pending 行不许撤回：${r2.body}`);
  assert.match(r2.json().message, /还在结算中/);
});

test('AB-12 通知发送失败不吞撤回：反向流水与台账照样成对，缺席的通知大声留痕', async () => {
  const u = mkUser();
  const { row } = await seedCreditedPayout({ userId: u, periodKey: W_PAYOUT, points: 50 });
  const logged = await captureErrors(async () => {
    const r = await revokeBoardSettlement(String(row._id), { note: ADMIN_NOTE }, {
      adminId,
      deps: { notify: async () => { throw new Error('通知服务超时'); } },
    });
    assert.equal(r.status, 'revoked');
  });
  assert.match(logged, /撤回通知/, `通知失败要留痕：${logged}`);
  assert.equal((await BoardSettlementModel.findById(row._id).lean())!.status, 'revoked');
  assert.equal(await PointRecordModel.countDocuments({ userId: u, type: 'board_reward_rollback' }), 1, '钱与台账成对，通知缺席是运营事故不是回滚理由');
  assert.equal(await NotificationModel.countDocuments({ userId: u }), 0);
});

// ==================== AB-S 榜单发放开关（后台点一下，不重启） ====================

test('AB-S1 开关端点：GET 缺省关 → POST 开 → GET 开 → settlePeriod 真被放开 → POST 关还原', async () => {
  // 清场：删设置行 + 清缓存，从「部署即关」的干净态出发（points-board 的 after 已删过，防别的文件留行）
  await AppSettingModel.deleteMany({ _id: 'boardRewardsEnabled' });
  resetBoardSwitchCacheForTest();

  const get1 = await app.inject({
    method: 'GET', url: '/sport-track/api/admin/points/board-switch',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(get1.statusCode, 200, get1.body);
  const s1 = get1.json().data;
  assert.equal(s1.enabled, false, '部署即关：无设置行=env 种子 false');
  assert.ok(s1.settleFromText, '起点日期要展示给运营看');
  assert.equal(typeof s1.settleFromIsDefault, 'boolean');

  const post = await app.inject({
    method: 'POST', url: '/sport-track/api/admin/points/board-switch',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { enabled: true },
  });
  assert.equal(post.statusCode, 200, post.body);
  assert.equal(post.json().data.enabled, true);

  // 服务侧真被放开（读侧 30s 缓存在写后立即可见，不必等 TTL）
  assert.equal(await isBoardRewardsEnabled(), true);
  // 再 GET：状态翻转可见
  const get2 = await app.inject({
    method: 'GET', url: '/sport-track/api/admin/points/board-switch',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(get2.json().data.enabled, true);

  // 还原：关回去 + 删行清缓存（共享 dev 库不留「开着」的态）
  await app.inject({
    method: 'POST', url: '/sport-track/api/admin/points/board-switch',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { enabled: false },
  });
  await AppSettingModel.deleteMany({ _id: 'boardRewardsEnabled' });
  resetBoardSwitchCacheForTest();
});

test('AB-S2 开关端点安全：用户 token 401；enabled 非 true 一律视为关（不猜真值）', async () => {
  const userLogin = await app.inject({
    method: 'POST', url: '/sport-track/api/auth/login',
    payload: { code: `openid:abs-switch-user` },
  });
  assert.equal(userLogin.statusCode, 200);
  const userToken = userLogin.json().data.token;

  const forbidden = await app.inject({
    method: 'POST', url: '/sport-track/api/admin/points/board-switch',
    headers: { authorization: `Bearer ${userToken}` },
    payload: { enabled: true },
  });
  assert.equal(forbidden.statusCode, 401, '用户 token 打管理开关必须 401');

  const weird = await app.inject({
    method: 'POST', url: '/sport-track/api/admin/points/board-switch',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { enabled: 'yes' },
  });
  assert.equal(weird.statusCode, 200);
  assert.equal(weird.json().data.enabled, false, '只有布尔 true 算开，字符串一律按关处理');
  await AppSettingModel.deleteMany({ _id: 'boardRewardsEnabled' });
  resetBoardSwitchCacheForTest();
});
