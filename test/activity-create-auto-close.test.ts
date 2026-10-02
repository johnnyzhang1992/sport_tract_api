/**
 * 新开轨迹时对「已存在的进行中活动」的处置：自动收尾，而不是硬拒 409。
 *
 * 硬拒在真机上会把用户锁死：「继续上次运动」入口靠本地 storage（index.js 读 ongoingActivity），
 * 清缓存/重装/换设备后入口消失，服务端那条 in_progress 就成孤儿——点开始一直 409，
 * 唯一出路是等 24h 懒清理。改成 create 前先收尾，收尾口径与懒清理完全一致：
 * 有有效点 → 跑自动管线落 finished（corrected:true）；空/清洗后无效 → cancelled 留底（不进列表）。
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { UserModel } from '../src/models/user.model.js';
import { closeAbandonedActivity, type AbandonedActivity } from '../src/services/activity.js';
import { hasUniqueInProgressIndex } from '../src/utils/guard-index.js';

const OPENID_NS = 'close-on-create';
const TEST_NOW = Date.now();

let app: FastifyInstance;
let token = '';
let userId = '';

const asUser = (path: string) => `/sport-track/api/activities${path}`;
const post = (path: string, body?: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'POST',
    url: asUser(path),
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });

/** 12 点 / 每点 22m / 10s 一步（2.2 m/s 正常配速），总位移 ~244m > MIN_EFFECTIVE_DISTANCE_M */
async function newActivityWithPoints(n = 12) {
  const created = await post('', { type: 'running', startTime: TEST_NOW - n * 10000 });
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().data.activityId as string;
  const points = Array.from({ length: n }, (_, k) => ({
    seq: k + 1,
    lat: 31.23 + k * 0.0002,
    lng: 121.47,
    timestamp: TEST_NOW - (n - k) * 10000,
  }));
  const up = await post(`/${id}/points`, { points });
  assert.equal(up.statusCode, 200, up.body);
  return id;
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

async function cleanup() {
  const ids = (await UserModel.find({ openid: new RegExp(`^${OPENID_NS}`) }).select('_id').lean()).map((u) => u._id);
  if (!ids.length) return;
  await ActivityModel.deleteMany({ userId: { $in: ids } });
  await UserModel.deleteMany({ _id: { $in: ids } });
}

beforeEach(async () => {
  await cleanup();
  // 每个用例一个独立 openid：mock 透传命名空间，不与其它文件的全局清理互删
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: `openid:${OPENID_NS}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().data.accessToken;
  userId = login.json().data.user.id;
});

after(async () => {
  await cleanup();
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

test('CC1 旧活动有有效轨迹点：新开时自动收尾成 finished（不硬拒），数据不丢', async () => {
  const abandoned = await newActivityWithPoints();
  const created = await post('', { type: 'running', startTime: TEST_NOW });
  assert.equal(created.statusCode, 200, `第二次创建不该被 409 挡死：${created.body}`);

  const old = await ActivityModel.findById(abandoned).lean();
  assert.equal(old!.status, 'finished', '上一场该被自动结束并保留');
  assert.equal(old!.corrected, true, '无人值守：与懒清理同口径，自动管线清好');
  assert.ok(old!.distance > 200, `距离应保留真实量级，实际 ${old!.distance}`);
  assert.ok(typeof old!.endTime === 'number' && old!.endTime > 0, 'endTime 以最后点上报时间为准');
  assert.ok(old!.duration > 0, '时长不该是 0');
  assert.equal(await ActivityModel.countDocuments({ userId, status: 'in_progress' }), 1, '库里只剩新建的那条');
});

test('CC2 旧活动一个点都没有：自动 cancelled 留底，且不进用户列表', async () => {
  const abandoned = await post('', { type: 'running', startTime: TEST_NOW - 60000 }).then((r) => r.json().data.activityId);
  const created = await post('', { type: 'walking', startTime: TEST_NOW });
  assert.equal(created.statusCode, 200, created.body);

  const old = await ActivityModel.findById(abandoned).select('status trackPoints endTime').lean();
  assert.equal(old!.status, 'cancelled', '空活动没有数据可保留，应作废');
  assert.equal(old!.trackPoints.length, 0);

  const list = await app.inject({ method: 'GET', url: asUser(''), headers: { authorization: `Bearer ${token}` } });
  const items = list.json().data.items as Array<{ id: string }>;
  assert.ok(!items.some((i) => i.id === abandoned), '作废留底不该出现在用户列表里');
});

test('CC3 连续三场都忘点结束：每次都收尾，库里恰好三条收尾活动 + 一条进行中', async () => {
  const closed: string[] = [];
  for (let round = 0; round < 3; round++) {
    closed.push(await newActivityWithPoints());
  }
  const latest = await post('', { type: 'running', startTime: TEST_NOW });
  assert.equal(latest.statusCode, 200, latest.body);

  const docs = await ActivityModel.find({ userId }).select('status').lean();
  assert.equal(docs.filter((d) => d.status === 'in_progress').length, 1, '同时进行的只应有一条');
  assert.equal(docs.length, 4, '三场收尾 + 一场进行中');
  for (const id of closed) {
    assert.equal((await ActivityModel.findById(id).select('status').lean())!.status, 'finished', `第 ${id} 场应已收尾`);
  }
});

test('CC4 两个 create 真同时打进来：结局必须只剩一条进行中（DB 防线不因收尾而松动）', async () => {
  const results = await Promise.all([
    post('', { type: 'running', startTime: TEST_NOW }),
    post('', { type: 'cycling', startTime: TEST_NOW + 1 }),
  ]);
  assert.ok(
    results.filter((r) => r.statusCode === 200).length >= 1,
    `至少要有一条建成：${results.map((r) => r.statusCode).join(',')}`,
  );
  assert.equal(await ActivityModel.countDocuments({ userId, status: 'in_progress' }), 1, '不允许双开');
});

/**
 * CC5/CC6 钉住收尾写入的 status:'in_progress' 条件。
 * 交错是确定性构造的：先取快照 → 模拟另一个写者抢先落地 → 再跑收尾。
 * 少了这个条件，收尾器会把用户自己刚 finish 的指标（距离/时长/corrected）整片盖掉。
 */
test('CC5 有点活动：别人先 finish 落地后，收尾器不覆盖它的指标', async () => {
  const id = await newActivityWithPoints();
  const snapshot = await ActivityModel.findOne({ _id: id, status: 'in_progress' })
    .select('userId type startTime pausedMs trackPoints')
    .lean();
  await ActivityModel.updateOne(
    { _id: id },
    { $set: { status: 'finished', distance: 999999, duration: 4321, corrected: false } },
  );

  const verdict = await closeAbandonedActivity(snapshot as unknown as AbandonedActivity);
  assert.equal(verdict, 'skipped', `条件写不该命中：${verdict}`);

  const after = await ActivityModel.findById(id).select('status distance duration corrected').lean();
  assert.equal(after!.distance, 999999, '并发对手写下的距离不该被收尾器覆盖');
  assert.equal(after!.duration, 4321, '时长同理');
  assert.equal(after!.corrected, false, '不该被擅自标成已纠偏');
});

test('CC6 空活动：别人先作废落地后，收尾器不重写 endTime', async () => {
  const id = await post('', { type: 'running', startTime: TEST_NOW }).then((r) => r.json().data.activityId as string);
  const snapshot = await ActivityModel.findOne({ _id: id, status: 'in_progress' })
    .select('userId type startTime pausedMs trackPoints')
    .lean();
  await ActivityModel.updateOne({ _id: id }, { $set: { status: 'cancelled', endTime: 123456 } });

  const verdict = await closeAbandonedActivity(snapshot as unknown as AbandonedActivity);
  assert.equal(verdict, 'skipped');
  const after = await ActivityModel.findById(id).select('endTime').lean();
  assert.equal(Number(after!.endTime), 123456, '已作废的时间戳不该被改成当前时间');
});

/**
 * CC7 旧存量：同用户多条进行中（2026-09 之前没有互斥，库里确实有这种形状）。
 * 唯一索引和这个状态天然互斥——正是它建不起来（或建不起来过）的库里才会存在，
 * 所以本用例临时撤索引造数据，finally 里立即重建并复验，不给后续用例留缺口。
 */
test('CC7 同用户多条进行中（旧存量）：新建时全部收尾，一条都不留', async () => {
  await ActivityModel.collection.dropIndex('unique_in_progress_per_user').catch(() => {});
  try {
    const emptyId = await post('', { type: 'running', startTime: TEST_NOW - 900000 }).then(
      (r) => r.json().data.activityId as string,
    );
    const withPoints = Array.from({ length: 12 }, (_, k) => ({
      seq: k + 1,
      lat: 31.3 + k * 0.0002,
      lng: 121.4,
      timestamp: TEST_NOW - 700000 + k * 10000,
    }));
    const seeded = await ActivityModel.create({
      userId,
      type: 'running',
      status: 'in_progress',
      startTime: TEST_NOW - 700000,
      trackPoints: withPoints,
    });

    assert.equal(
      await ActivityModel.countDocuments({ userId, status: 'in_progress' }),
      2,
      '前置：确实造出了两条进行中',
    );

    const created = await post('', { type: 'cycling', startTime: TEST_NOW });
    assert.equal(created.statusCode, 200, `两条存量都该被收尾，不该被 409 挡死：${created.body}`);

    assert.equal(
      await ActivityModel.countDocuments({ userId, status: 'in_progress' }),
      1,
      '收尾后只剩新建的这一条',
    );
    assert.equal((await ActivityModel.findById(emptyId).select('status').lean())!.status, 'cancelled', '空的那条作废');
    const closed = await ActivityModel.findById(seeded._id).select('status distance').lean();
    assert.equal(closed!.status, 'finished', '有点的那条保数据');
    assert.ok(closed!.distance > 200, `距离不该丢，实际 ${closed!.distance}`);
  } finally {
    // 先把本用例造的残留收干净再重建索引：留着多条进行中时 createIndexes 会直接抛 E11000
    // （这正是线上存量会卡住建索引的那件事），错误会盖住上面的断言，看不出真正失败点
    await ActivityModel.updateMany(
      { userId, status: 'in_progress' },
      { $set: { status: 'cancelled', endTime: Date.now() } },
    );
    await ActivityModel.createIndexes();
    assert.ok(
      hasUniqueInProgressIndex(await ActivityModel.collection.indexes()),
      '索引没重建成功——会污染后续用例的 DB 级防线',
    );
  }
});

/** 东八区墙上时间（容器时区是 UTC，直接用 toLocaleString 会差 8 小时） */
const BJ = Date.UTC(2026, 9, 1, 10, 0, 0); // = 2026-10-01 18:00:00 (UTC+8)

test('CC8 被踢的那台继续上传：409 要说清对象 + 实际结束时间 + 本次被丢的点数', async () => {
  const created = await post('', { type: 'running', startTime: BJ - 30000 });
  const id = created.json().data.activityId as string;
  await post(`/${id}/points`, {
    points: [0, 1, 2].map((k) => ({ seq: k + 1, lat: 31.23 + k * 0.0002, lng: 121.47, timestamp: BJ - (2 - k) * 10000 })),
  });
  // 另一台设备点开始 → 这条被自动收尾
  await post('', { type: 'cycling', startTime: TEST_NOW });

  const rejected = await post(`/${id}/points`, {
    points: [{ seq: 4, lat: 31.231, lng: 121.47, timestamp: BJ + 5000 }],
  });
  assert.equal(rejected.statusCode, 409, rejected.body);
  const body = rejected.json();
  assert.equal(body.data.code, 'ACTIVITY_FINISHED', 'code 不变，客户端只认一套');
  assert.match(body.message, /已于 10-01 18:00:00 结束/, `要带东八区的实际结束时间，实际「${body.message}」`);
  assert.match(body.message, /1 个点不再入库/, `要说清本次被丢的数量，实际「${body.message}」`);
});

test('CC9 收尾成作废的那台继续上传：文案要说「作废」而不是「结束」', async () => {
  const created = await post('', { type: 'running', startTime: BJ - 30000 });
  const id = created.json().data.activityId as string;
  // 只有 1 个点：收尾时走"点数不足"分支 → cancelled
  await post(`/${id}/points`, { points: [{ seq: 1, lat: 31.23, lng: 121.47, timestamp: BJ }] });
  await post('', { type: 'cycling', startTime: TEST_NOW });
  assert.equal((await ActivityModel.findById(id).select('status').lean())!.status, 'cancelled', '前置：这条已作废');

  const rejected = await post(`/${id}/points`, { points: [{ seq: 2, lat: 31.2301, lng: 121.47, timestamp: BJ + 5000 }] });
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.match(rejected.json().message, /已于 .+ 作废/, `状态不同要说清，实际「${rejected.json().message}」`);
});

/**
 * 走 50s → 暂停 600s（暂停期间端上完全不采点，恢复后首点带 pauseGap）→ 再走 50s。
 * 墙钟 700s，其中 600s 是暂停；库里 pausedMs 是 0（整场 sync 只传点，pausedMs 要等 finish 的 final 包）。
 */
async function newActivityWithPauseGap() {
  const start = TEST_NOW - 700_000;
  const created = await post('', { type: 'running', startTime: start });
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().data.activityId as string;
  let seq = 0;
  const pts: Array<Record<string, unknown>> = [];
  const push = (offsetSec: number, pauseGap = false) => {
    seq += 1;
    pts.push({
      seq,
      lat: 31.23 + seq * 0.0002,
      lng: 121.47,
      timestamp: start + offsetSec * 1000,
      ...(pauseGap ? { pauseGap: true } : {}),
    });
  };
  for (let k = 0; k <= 5; k++) push(k * 10);
  push(650, true);
  for (let k = 1; k <= 5; k++) push(650 + k * 10);
  const up = await post(`/${id}/points`, { points: pts });
  assert.equal(up.statusCode, 200, up.body);
  return { id, pointCount: pts.length };
}

test('CC10 收尾时暂停空窗不算运动时长：库里 pausedMs=0 也要按 pauseGap 点反推补上', async () => {
  const { id, pointCount } = await newActivityWithPauseGap();
  assert.equal(pointCount, 12);
  // 前置钉死：这条活动自己不知道暂停了多少（sync 不传 pausedMs），否则用例证不到东西
  const before = await ActivityModel.findById(id).select('pausedMs').lean();
  assert.equal(before!.pausedMs, 0, '前置：in_progress 期间库里 pausedMs 应为 0');

  await post('', { type: 'walking', startTime: TEST_NOW }); // 触发收尾

  const doc = await ActivityModel.findById(id).select('status duration pausedMs').lean();
  assert.equal(doc!.status, 'finished', doc ? '前置：这条应已收尾' : '活动不存在');
  assert.ok(
    Math.abs((doc!.pausedMs ?? 0) - 600_000) < 1000,
    `pausedMs 要按 pauseGap 空窗反推成 600s 并落库（后台「暂停时长」一栏读的就是它），实际 ${doc!.pausedMs}ms`,
  );
  assert.ok(
    doc!.duration > 90 && doc!.duration < 110,
    `运动时长应约 100s（墙钟 700 − 暂停 600），实际 ${doc!.duration}s`,
  );
});

test('CC11 pauseGap 点时间戳比上一点还早（乱序/伪造）：反推值不得为负，时长不得超墙钟', async () => {
  const start = TEST_NOW - 20_000;
  const created = await post('', { type: 'running', startTime: start });
  const id = created.json().data.activityId as string;
  await post(`/${id}/points`, {
    points: [
      { seq: 1, lat: 31.23, lng: 121.47, timestamp: start },
      { seq: 2, lat: 31.2302, lng: 121.47, timestamp: start + 10_000 },
      { seq: 3, lat: 31.2304, lng: 121.47, timestamp: start + 20_000 },
      // 恢复点却"回到"了 5 秒前：这一步是负间隔
      { seq: 4, lat: 31.2306, lng: 121.47, timestamp: start + 15_000, pauseGap: true },
    ],
  });

  await post('', { type: 'walking', startTime: TEST_NOW }); // 触发收尾

  const doc = await ActivityModel.findById(id).select('status duration pausedMs').lean();
  assert.equal(doc!.status, 'finished', '前置：这条应已收尾');
  assert.equal(doc!.pausedMs, 0, `负间隔不能计进暂停（计了会把时长倒撑超墙钟），实际 ${doc!.pausedMs}ms`);
  assert.ok(doc!.duration <= 20, `时长不得超过墙钟 20s，实际 ${doc!.duration}s`);
});
