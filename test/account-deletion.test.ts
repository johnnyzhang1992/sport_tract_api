/**
 * 账号注销（2026-11-17）：src/services/account-deletion.ts + POST /users/me/deactivate
 *
 * 守的承诺：
 *   1. 昵称宽松匹配（忽略首尾空格/大小写）；空昵称用「注销」确认
 *   2. 校验不通过**绝不删任何东西**（顺序：先校验后删除）
 *   3. 业务数据全删、支付订单保留
 *   4. 用户本身被删除（openid 清掉 → 再次进入是全新账号）
 *   5. 可重入：重复注销不报错（deleteMany 幂等）
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test test/account-deletion.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { PointAccountModel, PointRecordModel } from '../src/models/point.model.js';
import { XpayOrderModel } from '../src/models/xpay-order.model.js';
import { NotificationModel } from '../src/models/notification.model.js';
import { FootprintRecordModel } from '../src/models/footprint-record.model.js';
import { confirmWordMatches, purgeUser } from '../src/services/account-deletion.js';
import { hashOpenid, recordAccountDeletion } from '../src/services/account-audit.js';
import { AccountDeletionModel } from '../src/models/account-deletion.model.js';

const OPENID = 'acct-del-fixed';
/**
 * 「只注销过一次」的第二个 openid：用来反证 repeatOnly 真的过滤了
 * （开发库若有历史数据，单靠「我自己出现两次」无法区分 repeatOnly 是否生效）
 */
const OPENID_ONCE = 'acct-del-fixed-once';
/** 测试照片的假 OSS 前缀（cleanup 按它清理；不真的访问网络） */
const OSS_BASE = 'https://oss-test.example.com/acct-del';
let app: any;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await cleanup();
  await mongoose.disconnect();
  await app.close();
});

async function cleanup() {
  const u = await UserModel.findOne({ openid: OPENID });
  if (u) {
    await Promise.all([
      ActivityModel.deleteMany({ userId: u._id }),
      FootprintRecordModel.deleteMany({ userId: u._id }),
      PointAccountModel.deleteMany({ userId: u._id }),
      PointRecordModel.deleteMany({ userId: u._id }),
      XpayOrderModel.deleteMany({ userId: u._id }),
      NotificationModel.deleteMany({ userId: u._id }),
    ]);
    await UserModel.deleteOne({ _id: u._id });
  }
  await UserModel.deleteMany({ openid: OPENID });
  // 留痕按 openid 哈希精确清理（共享 dev 库，禁止裸 deleteMany）
  await AccountDeletionModel.deleteMany({ openidHash: hashOpenid(OPENID) });
  await AccountDeletionModel.deleteMany({ openidHash: hashOpenid(OPENID_ONCE) });
}

/** 建一个有完整数据的测试用户 */
async function seed(nickname: string) {
  await cleanup();
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: `openid:${OPENID}` },
  });
  const token = login.json().data.accessToken;
  const u = await UserModel.findOne({ openid: OPENID });
  await UserModel.updateOne({ _id: u!._id }, { nickname });

  // 塞几类数据，验证真的会被删
  await ActivityModel.create({
    userId: u!._id, type: 'running', status: 'finished',
    startTime: Date.now() - 3600_000, endTime: Date.now(),
    distance: 5000, duration: 1800, points: [],
    markers: [{
      id: 'm1', lat: 30, lng: 120, timestamp: Date.now(), type: 'checkpoint',
      photoUrl: `${OSS_BASE}/track-first.jpg`,
      photos: [`${OSS_BASE}/track-a.jpg`, `${OSS_BASE}/track-b.jpg`],
    }],
  } as any);
  await FootprintRecordModel.create({
    userId: u!._id, visitDate: '2026-11-17', title: '足迹', people: [], description: '',
    location: { name: '测试点', latitude: 30, longitude: 120, province: '浙江省', city: '杭州市' },
    photos: [`${OSS_BASE}/fp-a.jpg`],
  } as any);
  await PointAccountModel.create({ userId: u!._id, balance: 100 });
  await PointRecordModel.create({
    userId: u!._id, type: 'signin', title: '签到', delta: 100, balanceAfter: 100,
    bizDate: '2026-11-17', idemKey: `test-${Date.now()}`, createdAt: Date.now(),
  });
  await NotificationModel.create({ userId: u!._id, title: 't', content: 'c' });
  // 支付订单：注销后必须保留
  await XpayOrderModel.create({
    outTradeNo: `test-${Date.now()}`, userId: u!._id, openid: OPENID,
    productKey: 'test', name: '测试会员', priceFen: 100, durationDays: 30,
    status: 'paid',
  });
  return { userId: String(u!._id), token };
}

/* ── 纯函数：确认词匹配 ─────────────────────────── */

test('AD1 宽松匹配：忽略首尾空格与大小写', () => {
  assert.equal(confirmWordMatches('小明', '小明'), true);
  assert.equal(confirmWordMatches('  小明  ', '小明'), true, '首尾空格忽略');
  assert.equal(confirmWordMatches('ABC', 'abc'), true, '大小写忽略');
  assert.equal(confirmWordMatches('小 明', '小明'), false, '中间空格不忽略（从严防误输）');
  assert.equal(confirmWordMatches('小明2', '小明'), false);
  assert.equal(confirmWordMatches('', '小明'), false);
});

test('AD2 空昵称：必须输入「注销」', () => {
  assert.equal(confirmWordMatches('注销', ''), true);
  assert.equal(confirmWordMatches(' 注销 ', ''), true);
  assert.equal(confirmWordMatches('小明', ''), false, '空昵称时输入别的词不算');
  assert.equal(confirmWordMatches('', ''), false, '什么都没输不算');
});

/* ── 接口：校验不通过不删任何东西 ───────────────── */

test('AD3 确认词不匹配 → 400 且用户与数据都还在', async () => {
  const { userId } = await seed('小明');
  const login = await app.inject({
    method: 'POST', url: '/sport-track/api/auth/login', payload: { code: `openid:${OPENID}` },
  });
  const token = login.json().data.accessToken;

  const r = await app.inject({
    method: 'POST', url: '/sport-track/api/users/me/deactivate',
    headers: { authorization: `Bearer ${token}` }, payload: { confirm: '小红' },
  });
  assert.equal(r.statusCode, 400, '错误确认词必须 400');
  assert.ok(r.json().message.includes('昵称不匹配'), `提示应说明原因：${r.json().message}`);

  assert.ok(await UserModel.findById(userId), '用户必须还在');
  assert.equal(await ActivityModel.countDocuments({ userId }), 1, '轨迹必须还在');
  assert.equal(await PointAccountModel.countDocuments({ userId }), 1, '积分必须还在');
});

test('AD4 不传 confirm 也 400（不能空确认）', async () => {
  const { userId } = await seed('小明');
  const r = await app.inject({
    method: 'POST', url: '/sport-track/api/users/me/deactivate',
    headers: { authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/sport-track/api/auth/login', payload: { code: `openid:${OPENID}` } })).json().data.accessToken}` },
    payload: {},
  });
  assert.equal(r.statusCode, 400);
  assert.ok(await UserModel.findById(userId), '用户必须还在');
});

test('AD5 未登录调用 → 401', async () => {
  const r = await app.inject({
    method: 'POST', url: '/sport-track/api/users/me/deactivate', payload: { confirm: 'xx' },
  });
  assert.equal(r.statusCode, 401);
});

/* ── 注销成功：数据全删、订单保留 ───────────────── */

test('AD6 注销成功：业务数据清空、账号删除、支付订单保留', async () => {
  const { userId } = await seed('小明');
  const login = await app.inject({
    method: 'POST', url: '/sport-track/api/auth/login', payload: { code: `openid:${OPENID}` },
  });
  const token = login.json().data.accessToken;

  const r = await app.inject({
    method: 'POST', url: '/sport-track/api/users/me/deactivate',
    headers: { authorization: `Bearer ${token}` }, payload: { confirm: '小明' },
  });
  assert.equal(r.statusCode, 200, `应注销成功：${r.body}`);
  assert.equal(r.json().data.deleted, true);

  assert.equal(await UserModel.findById(userId), null, '账号必须被删除');
  assert.equal(await ActivityModel.countDocuments({ userId }), 0, '轨迹必须清空');
  assert.equal(await PointAccountModel.countDocuments({ userId }), 0, '积分账户必须清空');
  assert.equal(await PointRecordModel.countDocuments({ userId }), 0, '积分流水必须清空');
  assert.equal(await NotificationModel.countDocuments({ userId }), 0, '通知必须清空');
  assert.equal(await XpayOrderModel.countDocuments({ userId }), 1, '支付订单必须保留（对账/审计）');
});

test('AD7 注销后原 token 失效：重新登录得到全新账号（openid 已清）', async () => {
  const { token, userId: oldUserId } = await seed('小明');
  await app.inject({
    method: 'POST', url: '/sport-track/api/users/me/deactivate',
    headers: { authorization: `Bearer ${token}` }, payload: { confirm: '小明' },
  });

  // 旧 token 访问受保护接口 → 401
  const me = await app.inject({
    method: 'GET', url: '/sport-track/api/users/me', headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(me.statusCode, 401, '注销后旧 token 必须失效');

  // 同一微信再次登录 → 全新账号（昵称空、无轨迹）
  const again = await app.inject({
    method: 'POST', url: '/sport-track/api/auth/login', payload: { code: `openid:${OPENID}` },
  });
  const t2 = again.json().data.accessToken;
  const me2 = await app.inject({
    method: 'GET', url: '/sport-track/api/users/me', headers: { authorization: `Bearer ${t2}` },
  });
  assert.equal(me2.statusCode, 200);
  // 注意：登录时后端会自动生成默认昵称（迹路者XXXXX），所以不能拿昵称为空当「新账号」的判据；
  // 真正的判据是**旧的业务数据不回来了**
  const newId = me2.json().data.id;
  assert.notEqual(newId, oldUserId, '应是新的用户记录');
  assert.equal(await ActivityModel.countDocuments({ userId: newId }), 0, '新账号不该继承旧轨迹');
});

test('AD8 可重入：对同一用户重复 purge 不报错，第二次全是 0', async () => {
  const { userId } = await seed('小明');
  const first = await purgeUser(userId);
  assert.ok(first.activity >= 1, '第一次应删到轨迹');

  const second = await purgeUser(userId);
  assert.equal(second.activity, 0, '第二次没有可删的了');
  assert.equal(second.point, 0);
});
/* ── 2026-11-17 review 修复后的三条承诺 ─────────────────────────── */

test('AD9 OSS 照片随注销删除：轨迹打点 + 足迹的照片 URL 全被收集并删除', async () => {
  const { userId } = await seed('小明');
  const seen: string[][] = [];
  await purgeUser(userId, {
    deps: { deleteOss: async (urls) => { seen.push(urls); } },
  });

  assert.equal(seen.length, 1, '应调用一次 OSS 删除');
  const urls = seen[0];
  assert.equal(urls.length, 4, `应收集到 4 个照片 URL，实际 ${urls.length}：${JSON.stringify(urls)}`);
  for (const name of ['track-first.jpg', 'track-a.jpg', 'track-b.jpg', 'fp-a.jpg']) {
    assert.ok(urls.some((u) => u.endsWith(name)), `应包含 ${name}`);
  }
  // 去重语义：同一个 URL 不该出现两次
  assert.equal(new Set(urls).size, urls.length, 'URL 应去重');
});

test('AD10 OSS 清理失败不影响注销成功（只记日志）', async () => {
  const { token, userId } = await seed('小明');
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    // 走 HTTP 全链路：默认实现会真的调 OSS → 用不存在的地址/未配置都会抛，正好验证「失败不上抛」
    const r = await app.inject({
      method: 'POST', url: '/sport-track/api/users/me/deactivate',
      headers: { authorization: `Bearer ${token}` }, payload: { confirm: '小明' },
    });
    assert.equal(r.statusCode, 200, `OSS 失败不该让注销失败：${r.body}`);
  } finally {
    console.error = original;
  }
  assert.equal(await UserModel.findById(userId), null, '账号仍必须被删除');
});

test('AD11 管理员账号不能自助注销（403/400 + 数据不动）', async () => {
  const { token, userId } = await seed('管理员小明');
  await UserModel.updateOne({ _id: userId }, { role: 'admin' });

  const r = await app.inject({
    method: 'POST', url: '/sport-track/api/users/me/deactivate',
    headers: { authorization: `Bearer ${token}` }, payload: { confirm: '管理员小明' },
  });
  assert.equal(r.statusCode, 400, `管理员应被拦下：${r.body}`);
  // 错误信封：{ code: <HTTP 状态>, data: <extra> } → 机器可读的错误码在 data.code
  assert.equal(r.json().data?.code, 'ACCOUNT_PROTECTED');
  assert.ok(await UserModel.findById(userId), '管理员账号必须还在');
  assert.ok(await ActivityModel.countDocuments({ userId }) > 0, '管理员数据必须还在');
});

test('AD12 脏 token（userId 非 ObjectId / 用户已不存在）→ 401，不再是 500', async () => {
  const { token } = await seed('小明');
  // 1) 伪造 payload：userId 不是 ObjectId
  const dirty = jwt.sign({ userId: 'not-an-id', type: 'access' }, process.env.JWT_SECRET!, { expiresIn: '5m' });
  const r1 = await app.inject({
    method: 'GET', url: '/sport-track/api/users/me', headers: { authorization: `Bearer ${dirty}` },
  });
  assert.equal(r1.statusCode, 401, `脏 userId 应 401：${r1.body}`);

  // 2) 用户被删后，其（签名合法的）token 访问其它受保护接口也必须 401
  const ghost = jwt.sign({ userId: '000000000000000000000000', type: 'access' }, process.env.JWT_SECRET!, { expiresIn: '5m' });
  for (const url of ['/sport-track/api/plan/summary', '/sport-track/api/activities?page=1&pageSize=1', '/sport-track/api/points/items']) {
    const r = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${ghost}` } });
    assert.equal(r.statusCode, 401, `${url} 应 401：${r.body}`);
  }
  assert.ok(token, '前置');
});

test('AD13 数据库故障不被吞成 401（否则端上「刷新失败 → 全局登出」会把全站踢下线）', async () => {
  const { token } = await seed('小明');
  const orig = UserModel.exists;
  let boom = false;
  (UserModel as unknown as { exists: unknown }).exists = async () => {
    boom = true;
    throw new Error('模拟 MongoDB 抖动');
  };
  let status = 0;
  try {
    const r = await app.inject({
      method: 'GET', url: '/sport-track/api/users/me', headers: { authorization: `Bearer ${token}` },
    });
    status = r.statusCode;
  } finally {
    (UserModel as unknown as { exists: unknown }).exists = orig;
  }
  assert.ok(boom, '前置：应真的走到存在性校验');
  assert.notEqual(status, 401, '数据库故障不能返回 401（会被端上当成未登录并触发全局登出）');
  assert.ok(status >= 500, `应为 5xx，实际 ${status}`);
});

/* ── 注销留痕 + 防刷计数（2026-11-17）─────────────────────────── */

test('AD14 注销写一条留痕：uid/openid 哈希/条数都对，且不存 openid 原文', async () => {
  const { token, userId } = await seed('小明');
  const u = await UserModel.findById(userId).lean();
  const r = await app.inject({
    method: 'POST', url: '/sport-track/api/users/me/deactivate',
    headers: { authorization: `Bearer ${token}` }, payload: { confirm: '小明' },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().data.seq, 1, '首次注销应是第 1 次');

  const rec = await AccountDeletionModel.findOne({ userId }).lean();
  assert.ok(rec, '必须写入留痕记录');
  assert.equal(rec!.uid, Number(u!.uid), 'uid 要对上');
  assert.equal(rec!.seq, 1);
  assert.equal(rec!.openidHash, hashOpenid(OPENID));
  assert.ok(!String(rec!.openidHash).includes(OPENID), '不能存 openid 原文');
  assert.equal((rec!.stats as Record<string, number>).activity, 1, '留痕要记删了几条轨迹');
  assert.equal((rec!.stats as Record<string, number>).ossPhotos, 4, '留痕要记删了几个照片文件');
  assert.equal(await UserModel.findById(userId), null, '账号仍然被删除');
});

test('AD15 同一微信二次注销 → seq=2（防刷：注册-领奖-注销 反复会被计数）', async () => {
  // 第一次注销
  const first = await seed('小明');
  await app.inject({
    method: 'POST', url: '/sport-track/api/users/me/deactivate',
    headers: { authorization: `Bearer ${first.token}` }, payload: { confirm: '小明' },
  });
  // 同一微信再登录 = 新账号，再注销
  const again = await app.inject({
    method: 'POST', url: '/sport-track/api/auth/login', payload: { code: `openid:${OPENID}` },
  });
  const token2 = again.json().data.accessToken;
  const u2 = await UserModel.findOne({ openid: OPENID });
  await UserModel.updateOne({ _id: u2!._id }, { nickname: '小明2' });
  const second = await app.inject({
    method: 'POST', url: '/sport-track/api/users/me/deactivate',
    headers: { authorization: `Bearer ${token2}` }, payload: { confirm: '小明2' },
  });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().data.seq, 2, '同一 openid 第二次注销应记 seq=2');

  const all = await AccountDeletionModel.find({ openidHash: hashOpenid(OPENID) }).sort({ seq: 1 }).lean();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((x) => x.seq), [1, 2]);
});

test('AD16 管理端：未带管理员凭证 401；带上后可查列表与汇总', async () => {
  // 造两条记录（同一 openid 两次 → 重复注销账号 1 个）
  const first = await seed('小明');
  await app.inject({
    method: 'POST', url: '/sport-track/api/users/me/deactivate',
    headers: { authorization: `Bearer ${first.token}` }, payload: { confirm: '小明' },
  });
  const again = await app.inject({ method: 'POST', url: '/sport-track/api/auth/login', payload: { code: `openid:${OPENID}` } });
  const t2 = again.json().data.accessToken;
  const u2 = await UserModel.findOne({ openid: OPENID });
  await UserModel.updateOne({ _id: u2!._id }, { nickname: '小明2' });
  await app.inject({
    method: 'POST', url: '/sport-track/api/users/me/deactivate',
    headers: { authorization: `Bearer ${t2}` }, payload: { confirm: '小明2' },
  });

  /*
   * 造一个「只注销过一次」的账号（不同 openid），用来反证 repeatOnly 真的在过滤：
   * 若接口忽略 repeatOnly，这个 hash 会混进结果，下面的断言就会红。
   */
  const onceUser = await UserModel.create({ openid: OPENID_ONCE, nickname: '一次性注销号' });
  await recordAccountDeletion({
    userId: String(onceUser._id),
    uid: Number(onceUser.uid ?? 0),
    openid: OPENID_ONCE,
    nickname: '一次性注销号',
    stats: { activity: 0 } as never,
  });
  await UserModel.deleteOne({ _id: onceUser._id });

  const noAuth = await app.inject({ method: 'GET', url: '/sport-track/api/admin/account-deletions' });
  assert.equal(noAuth.statusCode, 401, '管理端接口必须拒绝普通/无凭证');

  const login = await app.inject({ method: 'POST', url: '/sport-track/api/admin/login', payload: { username: 'admin', password: 'admin123456' } });
  const adminToken = login.json().data.token;
  const r = await app.inject({
    method: 'GET', url: '/sport-track/api/admin/account-deletions',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json().data;
  assert.ok(d.total >= 2, `应有至少 2 条记录，实际 ${d.total}`);
  assert.ok(d.items[0].seq >= 1);
  assert.ok(d.summary.totalAll >= 2);
  assert.ok(d.summary.uniqueAccounts >= 1);
  assert.ok(d.summary.repeatAccounts >= 1, '同一 openid 两次注销 → 重复注销账号数 ≥1');
  assert.ok(typeof d.summary.last7Days === 'number');

  /*
   * 仅看重复注销（repeatOnly=1）：
   * 开发库里有历史注销记录（含手工测试留下的），所以不能断言「只有我的账号」；
   * 但**必须守住 repeatOnly 的语义**——返回的每一行，其 openidHash 在结果集里都要出现 ≥2 次。
   * 用 pageSize=100 拉大页，避免分页把某个 hash 的第二次截掉造成假阴性。
   */
  const rep = await app.inject({
    method: 'GET', url: '/sport-track/api/admin/account-deletions?repeatOnly=1&pageSize=100',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(rep.statusCode, 200);
  const rows = rep.json().data.items as Array<{ openidHash: string }>;
  assert.ok(
    rows.some((x) => x.openidHash === hashOpenid(OPENID)),
    `重复注销列表应包含本次测试账号，实际 ${rows.length} 条`,
  );
  assert.ok(
    !rows.some((x) => x.openidHash === hashOpenid(OPENID_ONCE)),
    'repeatOnly 不该返回「只注销过一次」的账号（否则等于没过滤）',
  );
  const countByHash: Record<string, number> = {};
  for (const x of rows) countByHash[x.openidHash] = (countByHash[x.openidHash] || 0) + 1;
  if (rep.json().data.total <= rows.length) {
    // 只在「一页装下了全部重复注销记录」时才能断言完整性，否则分页会截断
    for (const [hash, n] of Object.entries(countByHash)) {
      assert.ok(n >= 2, `repeatOnly 只该返回重复注销的 hash，${hash} 只出现 ${n} 次`);
    }
  } else {
    assert.ok(rows.length > 0, '分页未取全时至少要返回数据');
  }
});
