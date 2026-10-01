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
