/**
 * 清理「已作废」轨迹（管理员专用）
 *
 * 作废行对用户不可见、也不能纠偏，唯一价值是管理员点「恢复」的退路。
 * 但库里 3000+ 条作废行里绝大多数是 0 点空壳或"恢复出来也过不了同一道守卫"的碎数据
 * （dev 库实测：3172 条 / 1.4MB，点数最多的那条也只有 21 点、distance 0m）。
 * 所以判据不是"有没有点"，而是"恢复后能不能成一条运动"：
 *   status=cancelled ∧ updatedAt 早于保留期 ∧ ¬(点数 ≥ MIN_EFFECTIVE_POINTS ∧ 距离 ≥ MIN_EFFECTIVE_DISTANCE_M)
 * 默认 dryRun —— 先看数，再决定删。
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { UserModel } from '../src/models/user.model.js';
import { MIN_EFFECTIVE_DISTANCE_M, MIN_EFFECTIVE_POINTS } from '../src/config/constants.js';

const ADMIN_USER = 'test_purge_cancelled';
const ADMIN_PASS = 'pc_pass_123';
const OPENID = 'test-purge-cancelled';
const DAY = 86400_000;

let app: FastifyInstance;
let adminToken = '';
let userId = '';
let otherUserId = '';
const OTHER_OPENID = 'test-purge-cancelled-other';

// 每个用例都带 userId 作用域：清理本身是全库操作，测试绝不能有删到别人数据的能力
const post = (body: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/activities/purge-cancelled',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { userId, ...body },
  });

/** 造一条活动并回填 updatedAt（mongoose 的 timestamps 会覆盖 create 里的值，必须单独关时间戳写） */
async function seed(status: 'cancelled' | 'finished' | 'in_progress', pts: number, distance: number, ageDays: number, owner?: string) {
  const trackPoints = Array.from({ length: pts }, (_, k) => ({
    seq: k + 1,
    lat: 31.23 + k * 0.0002,
    lng: 121.47,
    timestamp: Date.now() - ageDays * DAY - (pts - k) * 10000,
  }));
  const doc = await ActivityModel.create({ userId: owner ?? userId, type: 'running', status, startTime: Date.now() - ageDays * DAY, trackPoints, distance });
  await ActivityModel.updateOne({ _id: doc._id }, { $set: { updatedAt: new Date(Date.now() - ageDays * DAY) } }, { timestamps: false });
  return String(doc._id);
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const existing = await AdminModel.findOne({ username: ADMIN_USER });
  if (existing) {
    existing.passwordHash = await hashPassword(ADMIN_PASS);
    await existing.save();
  } else {
    await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  }
  const login = await app.inject({ method: 'POST', url: '/sport-track/api/admin/login', payload: { username: ADMIN_USER, password: ADMIN_PASS } });
  adminToken = login.json().data.token;
  const ulogin = await app.inject({ method: 'POST', url: '/sport-track/api/auth/login', payload: { code: OPENID } });
  userId = ulogin.json().data.user.id;
  const ologin = await app.inject({ method: 'POST', url: '/sport-track/api/auth/login', payload: { code: OTHER_OPENID } });
  otherUserId = ologin.json().data.user.id;
});

async function cleanup() {
  const ids = [userId, otherUserId].filter(Boolean) as string[];
  if (ids.length) await ActivityModel.deleteMany({ userId: { $in: ids } });
  await UserModel.deleteMany({ openid: { $in: [OPENID, OTHER_OPENID] } });
}

beforeEach(cleanup);

after(async () => {
  await cleanup();
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

/** 一套覆盖四种命运的样本：该删的 3 条 / 可恢复留下 / 未到保留期留下 / 非作废绝不许动 */
async function fixture() {
  const emptyOld = await seed('cancelled', 0, 0, 40); // 0 点空壳，超期 → 删
  const fewPts = await seed('cancelled', MIN_EFFECTIVE_POINTS - 1, 5000, 40); // 点数不够 → 删
  const shortDist = await seed('cancelled', 6, MIN_EFFECTIVE_DISTANCE_M - 1, 40); // 距离不够 → 删
  const rescuable = await seed('cancelled', 6, 5000, 40); // 恢复出来能成一条运动 → 留
  const tooRecent = await seed('cancelled', 0, 0, 10); // 未到 30 天保留期 → 留
  const finished = await seed('finished', 6, 5000, 40); // 有效轨迹：绝不许动
  const inProgress = await seed('in_progress', 6, 5000, 40); // 进行中：绝不许动
  return { emptyOld, fewPts, shortDist, rescuable, tooRecent, finished, inProgress };
}

test('PC1 dryRun（默认）只报数不删任何东西', async () => {
  const f = await fixture();
  const res = await post({});
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  assert.equal(d.dryRun, true, '不传参数必须按试运行处理，不能默认就删');
  assert.equal(d.wouldDelete, 3, `该删的是 3 条（0 点/点数不够/距离不够），实际 ${d.wouldDelete}：${JSON.stringify(d)}`);
  assert.equal(d.deleted, 0, '试运行一条都不该删');
  assert.equal(await ActivityModel.countDocuments({ userId }), 7, '试运行后库里条数不能变');

  const again = await post({ dryRun: false });
  assert.equal(again.json().data.deleted, 3, '真删时删掉的条数要和试运行说的一致');
  assert.equal(await ActivityModel.countDocuments({ userId }), 4);
});

test('PC2 只删超期的不可恢复作废行，其余一律不动', async () => {
  const f = await fixture();
  const res = await post({ dryRun: false });
  assert.equal(res.statusCode, 200, res.body);

  for (const id of [f.emptyOld, f.fewPts, f.shortDist]) {
    assert.equal(await ActivityModel.countDocuments({ _id: id }), 0, `${id} 应已被清掉`);
  }
  for (const id of [f.rescuable, f.tooRecent]) {
    assert.equal(await ActivityModel.countDocuments({ _id: id, status: 'cancelled' }), 1, `${id} 属于该保留的作废行`);
  }
  // 非作废的行连碰都不该碰到（状态 + 数据都原样）
  const fin = await ActivityModel.findById(f.finished).lean();
  assert.equal(fin!.status, 'finished');
  assert.equal(fin!.trackPoints.length, 6);
  assert.equal(fin!.distance, 5000);
  const ing = await ActivityModel.findById(f.inProgress).lean();
  assert.equal(ing!.status, 'in_progress', '进行中活动绝不能进这个过滤器（否则用户正在录的会被删）');
});

test('PC3 保留原因要分开报：可恢复 vs 未到保留期', async () => {
  await fixture();
  const res = await post({});
  const d = res.json().data;
  assert.equal(d.scanned, 4, `超期的作废行共 4 条（未到期那条不进扫描），实际 ${d.scanned}`);
  assert.equal(d.keptRescuable, 1, '可恢复的 1 条要单独说明，否则管理员以为被漏了');
  assert.equal(d.keptRecent, 1, '未到保留期的条数要报出来（它就是下一次能删的量）');
});

test('PC4 再跑一次无残留可删（幂等，不靠"上次删过了"蒙对）', async () => {
  await fixture();
  await post({ dryRun: false });
  const res = await post({});
  const d = res.json().data;
  assert.equal(d.wouldDelete, 0, `第二轮该无可删，实际 ${d.wouldDelete}`);
  assert.equal(d.scanned, 1, '只剩那条可恢复的还在超期作废里');
});

test('PC5 保留期可改但必须带上下限，非法值要说清收到的是多少', async () => {
  await fixture();
  const ok = await post({ dryRun: true, retentionDays: 3 });
  assert.equal(ok.statusCode, 200, ok.body);
  // 保留期缩到 3 天：那条 10 天大的空壳也进可删范围
  assert.equal(ok.json().data.wouldDelete, 4, `retentionDays=3 应多圈进 1 条，实际 ${ok.json().data.wouldDelete}`);

  for (const bad of [0, -1, 400]) {
    const res = await post({ dryRun: true, retentionDays: bad });
    assert.equal(res.statusCode, 400, `retentionDays=${bad} 应被拒，实际 ${res.statusCode}：${res.body}`);
    assert.match(res.json().message, /1[^\d]{0,3}365/, `提示要带允许区间，实际「${res.json().message}」`);
    assert.match(res.json().message, new RegExp(String(bad)), `提示要带上收到的实际值 ${bad}，实际「${res.json().message}」`);
  }
  assert.equal(await ActivityModel.countDocuments({ userId }), 7, '参数被拒后一条都不该动');
});

test('PC6 未登录管理员不能触发清理', async () => {
  await fixture();
  const res = await app.inject({ method: 'POST', url: '/sport-track/api/admin/activities/purge-cancelled', payload: { dryRun: false, userId } });
  assert.ok(res.statusCode === 401 || res.statusCode === 403, `应被 adminAuth 拦下，实际 ${res.statusCode}`);
  assert.equal(await ActivityModel.countDocuments({ userId }), 7, '被拦下时一条都不能少');
});

test('PC7 带 userId 时不得波及别的用户的作废行（清理是全库操作，作用域就是它的刹车）', async () => {
  await fixture();
  const otherOld = await seed('cancelled', 0, 0, 40, otherUserId); // 同样超期、同样 0 点
  const res = await post({ dryRun: false });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().data.deleted, 3, '只该删掉本用户名下那 3 条');
  assert.equal(
    await ActivityModel.countDocuments({ _id: otherOld, status: 'cancelled' }),
    1,
    '另一个用户同样符合条件的作废行必须原样留着',
  );
});

test('PC8 userId 形态非法 → 404 用户不存在，且不动任何数据', async () => {
  await fixture();
  const res = await post({ dryRun: false, userId: 'not-an-id' });
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(res.json().message, '用户不存在');
  assert.equal(await ActivityModel.countDocuments({ userId }), 7, '被拦下时一条都不能少');
});

test('PC9 管理员中途恢复的那行不会被删（改状态会顶新 updatedAt，两道过滤都站在它这边）', async () => {
  await fixture();
  const preview = await post({ dryRun: true });
  const target = preview.json().data.sampleIds[0] as string;
  assert.ok(target, '试运行要给出样本 id');

  // 交错：管理员在后台把这条恢复成有效了。updateOne 会顺带把 updatedAt 顶到当前时间，
  // 于是它既不是 cancelled、也不再"超期"——扫描阶段就被排除，压根进不了删除集合。
  // 单独摘掉扫描的 status 过滤时，PC3/PC4 会红（那才是钉住 status 过滤的用例）；这里守的是"恢复即免死"这个结果。
  await ActivityModel.updateOne({ _id: target }, { $set: { status: 'finished' } });

  const res = await post({ dryRun: false });
  assert.equal(res.json().data.deleted, 2, `已恢复的那条不该被删，实际删了 ${res.json().data.deleted} 条`);
  const back = await ActivityModel.findById(target).select('status').lean();
  assert.equal(back!.status, 'finished', '恢复结果必须保住');
});

test('PC10 列表接口只带「可清理」预览，绝不动数据', async () => {
  await fixture();
  // 基线用全库口径（列表里的预览是全库的，不带 userId 作用域）
  const global = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/activities/purge-cancelled',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { dryRun: true },
  });
  const base = global.json().data;

  const res = await app.inject({
    method: 'GET',
    url: '/sport-track/api/admin/activities?pageSize=5',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const p = res.json().data.purgePreview;
  assert.ok(p, '列表响应要带 purgePreview，后台才有东西可显示');
  assert.equal(p.wouldDelete, base.wouldDelete, '列表报的数必须等于真删会删的数，否则那行提示是骗人的');
  assert.equal(p.keptRescuable, base.keptRescuable);
  assert.equal(p.retentionDays, 30, `默认保留期应是 30 天，实际 ${p.retentionDays}`);
  assert.equal(await ActivityModel.countDocuments({ userId }), 7, '刷新列表一条都不能删');
});
