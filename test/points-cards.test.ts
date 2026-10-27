import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { config } from '../src/config/index.js';
import { PointCardModel } from '../src/models/point.model.js';
import {
  activateCard, adFreeUntilOf, countUnusedCards, replayAdFree,
} from '../src/services/points-cards.js';
import { AppError } from '../src/utils/app-error.js';

/**
 * 免广告卡激活与 adFreeUntil 推导（spec §5.4/§6.3，Task 3）。
 *
 * adFreeUntil 不落字段：每次现读卡行重放。CD-1 逐条钉 spec §5.4 的三行算例
 * （10-01+7→10-08；10-05+15→10-23 不浪费已生效天数；11-01+30→12-01 空窗不追溯）。
 * 断言全部落在 DB 读出上，不看日志；每个用例独立 userId，t.after 清卡。
 */

const DAY = 86400000;

const created: Types.ObjectId[] = [];
function newUser(): Types.ObjectId {
  const id = new Types.ObjectId();
  created.push(id);
  return id;
}
const wipe = (u: Types.ObjectId) => PointCardModel.deleteMany({ userId: u });

before(async () => {
  // 单文件直跑不经过 app 的 mongodb 插件，这里自行连接；不连时查询会一直 buffering
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  await PointCardModel.init();
});

after(async () => {
  for (const u of created) await wipe(u);
  await mongoose.disconnect().catch(() => {});
});

test('CD-1 adFreeUntil 顺延叠加算例（spec §5.4）', async (t) => {
  const u = newUser();
  t.after(() => wipe(u));
  const t0 = Date.parse('2026-10-01T00:00:00+08:00');
  const mk = (activatedAt: number, days: number) => ({
    userId: u, itemKey: `ad_free_${days}d`, status: 'used', source: 'exchange',
    benefitDays: days, activatedAt, expiresAt: activatedAt + 30 * DAY, createdAt: activatedAt,
  });
  await PointCardModel.insertMany([mk(t0, 7), mk(t0 + 4 * DAY, 15)]);
  // 10-01 激活 7 天 → 10-08；10-05 激活 15 天 → max(10-08,10-05)+15 = 10-23
  assert.equal(await adFreeUntilOf(String(u)), Date.parse('2026-10-23T00:00:00+08:00'));
  // 第三行算例是「11-01 才激活」：t0 + 31 天（10 月有 31 号），不是 t0 + 30 天（那是 10-31）
  await PointCardModel.insertMany([mk(Date.parse('2026-11-01T00:00:00+08:00'), 30)]);
  // 11-01 才激活 30 天卡：空窗不追溯 → 11-01 + 30 = 12-01
  assert.equal(await adFreeUntilOf(String(u)), Date.parse('2026-12-01T00:00:00+08:00'));
  // 纯函数与推导入口共用同一份算术：把三行算例按序喂给 replayAdFree 也得 12-01
  assert.equal(replayAdFree([
    { activatedAt: t0, benefitDays: 7 },
    { activatedAt: t0 + 4 * DAY, benefitDays: 15 },
    { activatedAt: Date.parse('2026-11-01T00:00:00+08:00'), benefitDays: 30 },
  ]), Date.parse('2026-12-01T00:00:00+08:00'));
});

test('CD-2 只算已激活的免广告卡：未激活、补签卡、benefitDays=0 都不参与', async (t) => {
  const u = newUser();
  t.after(() => wipe(u));
  await PointCardModel.create({
    userId: u, itemKey: 'ad_free_7d', status: 'unused', benefitDays: 7,
    activatedAt: 0, expiresAt: Date.now() + 1e9, createdAt: Date.now(),
  });
  await PointCardModel.create({
    userId: u, itemKey: 'makeup_card', status: 'used', benefitDays: 0,
    activatedAt: Date.now(), expiresAt: Date.now() + 1e9, createdAt: Date.now(),
  });
  assert.equal(await adFreeUntilOf(String(u)), 0, '未激活的卡不该给免广告期');
});

test('CD-3 激活闸门：非本人 404 / 补签卡 400 / 已激活 400 / 过期 400 / 正常写 activatedAt', async (t) => {
  const owner = newUser();
  const other = newUser();
  t.after(() => wipe(owner));
  const mk = (over: Record<string, unknown> = {}) => PointCardModel.create({
    userId: owner, itemKey: 'ad_free_7d', status: 'unused', source: 'exchange',
    benefitDays: 7, activatedAt: 0, expiresAt: Date.now() + 30 * DAY, createdAt: Date.now(), ...over,
  });
  const c1 = await mk();
  // 形态合法但不存在的 id / 非本人的卡：同一句 404「卡不存在」
  await assert.rejects(() => activateCard(String(other), String(c1._id)), (e) => (e as AppError).statusCode === 404);
  await assert.rejects(() => activateCard(String(owner), 'not-an-object-id'), (e) => (e as AppError).statusCode === 404);
  // 补签卡（benefitDays=0）不该走激活：文案指路补签窗口
  const makeup = await mk({ itemKey: 'makeup_card', benefitDays: 0 });
  await assert.rejects(() => activateCard(String(owner), String(makeup._id)), /无需激活/);
  // 老库形态：benefitDays 是 Task 1 才加的字段，历史行物理缺字段（raw insertOne 绕开 schema default）。
  // `undefined <= 0 === false` 会放行这类卡 → 闸门必须按「>0 才可激活」取反写
  await PointCardModel.collection.insertOne({
    _id: new Types.ObjectId(), userId: owner, itemKey: 'makeup_card', status: 'unused',
    expiresAt: Date.now() + 30 * DAY, createdAt: Date.now(),
  });
  const legacy = await PointCardModel.findOne({ userId: owner, benefitDays: { $exists: false } }).lean();
  assert.ok(legacy, '缺 benefitDays 的老行造出来了');
  await assert.rejects(() => activateCard(String(owner), String(legacy._id)), /无需激活/);
  // 过期卡 400，文案带有效期日期（对象+实际值）
  const expired = await mk({ expiresAt: Date.now() - 1000 });
  await assert.rejects(() => activateCard(String(owner), String(expired._id)), /已过期/);
  // 正常激活：返回值与落库都对得上
  const r = await activateCard(String(owner), String(c1._id), 1777000000000);
  assert.equal(r.adFreeUntil, 1777000000000 + 7 * DAY);
  const row = await PointCardModel.findById(c1._id).lean();
  assert.ok(row);
  assert.equal(row.status, 'used');
  assert.equal(row.activatedAt, 1777000000000);
  // 再激活同一张：CAS 之后落「该卡已使用」
  await assert.rejects(() => activateCard(String(owner), String(c1._id)), /已使用/);
});

test('CD-4 并发激活同一张卡只许一次成功（CAS 闸门）', async (t) => {
  const u = newUser();
  t.after(() => wipe(u));
  const card = await PointCardModel.create({
    userId: u, itemKey: 'ad_free_7d', status: 'unused', source: 'exchange',
    benefitDays: 7, activatedAt: 0, expiresAt: Date.now() + 30 * DAY, createdAt: Date.now(),
  });
  // 两个不同 now：去掉 CAS 的 status:'unused' 条件后，败者的 updateOne 也会 modifiedCount===1 而双双成功
  const [a, b] = await Promise.allSettled([
    activateCard(String(u), String(card._id), 1777000000000),
    activateCard(String(u), String(card._id), 1777000009999),
  ]);
  const ok = [a, b].filter((x) => x.status === 'fulfilled');
  assert.equal(ok.length, 1, '并发激活只能一个成功');
  const row = await PointCardModel.findById(card._id).lean();
  assert.ok(row);
  assert.equal(row.status, 'used');
  assert.ok([1777000000000, 1777000009999].includes(row.activatedAt));
  const loser = [a, b].find((x) => x.status === 'rejected') as PromiseRejectedResult;
  assert.match(String(loser.reason), /已使用/);
});

test('CD-5 countUnusedCards 按道具分组，只数未过期未使用的卡', async (t) => {
  const u = newUser();
  t.after(() => wipe(u));
  const now = Date.now();
  const mk = (over: Record<string, unknown>) => PointCardModel.create({
    userId: u, itemKey: 'ad_free_7d', status: 'unused', benefitDays: 7,
    activatedAt: 0, expiresAt: now + 30 * DAY, createdAt: now, ...over,
  });
  await mk({});
  await mk({});
  await mk({ itemKey: 'makeup_card', benefitDays: 0 });
  await mk({ expiresAt: now - 1000 }); // 已过期：不数
  await mk({ status: 'used', activatedAt: now }); // 已使用：不数
  const rows = await countUnusedCards(String(u), now);
  const byKey = Object.fromEntries(rows.map((r) => [r.itemKey, r.unused]));
  assert.deepEqual(byKey, { ad_free_7d: 2, makeup_card: 1 });
});
