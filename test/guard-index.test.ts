/**
 * 唯一索引兜底核对：应用层 findOne 挡不住并发，实体是 activities 上那条
 * {userId,status} unique + partial(status='in_progress') 索引。
 *
 * 两个真实风险：
 * 1) 索引声明被删/改名/改属性，Mongoose autoIndex 只异步建索引，失败时仅一条 warning，防线静默消失；
 * 2) E11000→409 的兜底也依赖它——没有索引就没有 E11000，那条分支会变成死代码。
 * 所以启动时要能"确认它在"，而不是假设它在。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { hasUniqueInProgressIndex } from '../src/utils/guard-index.js';

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
});

test('真实库里的防线：unique + 仅对 in_progress 生效 + 字段是 userId/status', async () => {
  const idx = await ActivityModel.collection.indexes();
  assert.ok(
    hasUniqueInProgressIndex(idx),
    `防线不在！现有索引：${JSON.stringify(idx.map((i) => ({ name: i.name, unique: i.unique, key: i.key, partial: i.partialFilterExpression })))}`,
  );
});

test('普通索引（非 unique）不算防线：拦不住并发创建', () => {
  assert.equal(
    hasUniqueInProgressIndex([{ name: 'x', key: { userId: 1, status: 1 }, partialFilterExpression: { status: 'in_progress' } }]),
    false,
  );
});

test('全量 unique（缺 partialFilterExpression）不算防线：会把同用户多条已完成判成冲突', () => {
  assert.equal(hasUniqueInProgressIndex([{ name: 'x', key: { userId: 1, status: 1 }, unique: true }]), false);
});

test('字段组合不对（只有 userId）不算防线', () => {
  assert.equal(
    hasUniqueInProgressIndex([{ name: 'x', key: { userId: 1 }, unique: true, partialFilterExpression: { status: 'in_progress' } }]),
    false,
  );
});

test('partial 条件写错状态（不是 in_progress）不算防线', () => {
  assert.equal(
    hasUniqueInProgressIndex([{ name: 'x', key: { userId: 1, status: 1 }, unique: true, partialFilterExpression: { status: 'finished' } }]),
    false,
  );
});
