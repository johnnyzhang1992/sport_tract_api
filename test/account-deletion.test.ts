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
import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { PointAccountModel, PointRecordModel } from '../src/models/point.model.js';
import { XpayOrderModel } from '../src/models/xpay-order.model.js';
import { NotificationModel } from '../src/models/notification.model.js';
import { confirmWordMatches, purgeUser } from '../src/services/account-deletion.js';

const OPENID = 'acct-del-fixed';
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
      PointAccountModel.deleteMany({ userId: u._id }),
      PointRecordModel.deleteMany({ userId: u._id }),
      XpayOrderModel.deleteMany({ userId: u._id }),
      NotificationModel.deleteMany({ userId: u._id }),
    ]);
    await UserModel.deleteOne({ _id: u._id });
  }
  await UserModel.deleteMany({ openid: OPENID });
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
    distance: 5000, duration: 1800, points: [], photos: [],
  });
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