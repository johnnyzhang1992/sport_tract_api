/**
 * 唯一索引兜底核对：应用层 findOne 挡不住并发，实体是 activities 上那条
 * {userId,status} unique + partial(status='in_progress')，以及 campaignmembers 上那条
 * {campaignId,userId} unique + partial(state='joined') 索引。
 *
 * 两个真实风险：
 * 1) 索引声明被删/改名/改属性，Mongoose autoIndex 只异步建索引，失败时仅一条 warning，防线静默消失；
 * 2) E11000→409 的兜底也依赖它——没有索引就没有 E11000，那条分支会变成死代码。
 * 所以启动时要能"确认它在"，而不是假设它在。
 *
 * campaignmembers 那条静默失败时：同一用户在同一活动可留两条 joined，getCampaignDetail 的
 * totals 按行求和、排行榜按行映射 → 同一个人被算两次 / 列两次。
 *
 * 另核对 pointrecords 的热路径性能索引 {type,refType,bizDate,refId}（IMP-1）：不是 unique 防线，
 * 但同样「声明被删只留 warning」，缺了它积分页每次加载全表扫台账。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { CampaignMemberModel } from '../src/models/campaign-member.model.js';
import { PointRecordModel } from '../src/models/point.model.js';
import { hasUniqueInProgressIndex, hasUniqueJoinedIndex, hasExchangeLedgerIndex } from '../src/utils/guard-index.js';

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

test('campaignmembers 真实库里的防线：unique + 仅对 joined 生效 + 字段是 campaignId/userId', async () => {
  await CampaignMemberModel.createIndexes(); // 与 plugins/mongodb.ts 同款：显式等建完再核对形状
  const idx = await CampaignMemberModel.collection.indexes();
  assert.ok(
    hasUniqueJoinedIndex(idx),
    `防线不在！现有索引：${JSON.stringify(idx.map((i) => ({ name: i.name, unique: i.unique, key: i.key, partial: i.partialFilterExpression })))}`,
  );
});

test('campaignmembers：普通索引（非 unique）不算防线：同一人可留两条 joined', () => {
  assert.equal(
    hasUniqueJoinedIndex([{ name: 'x', key: { campaignId: 1, userId: 1 }, partialFilterExpression: { state: 'joined' } }]),
    false,
  );
});

test('campaignmembers：全量 unique（缺 partialFilterExpression）不算防线：会把同用户多条历史段判成冲突', () => {
  assert.equal(hasUniqueJoinedIndex([{ name: 'x', key: { campaignId: 1, userId: 1 }, unique: true }]), false);
});

test('campaignmembers：字段组合不对（只有 userId）不算防线', () => {
  assert.equal(
    hasUniqueJoinedIndex([{ name: 'x', key: { userId: 1 }, unique: true, partialFilterExpression: { state: 'joined' } }]),
    false,
  );
});

test('campaignmembers：partial 条件写错状态（不是 joined）不算防线', () => {
  assert.equal(
    hasUniqueJoinedIndex([{ name: 'x', key: { campaignId: 1, userId: 1 }, unique: true, partialFilterExpression: { state: 'left' } }]),
    false,
  );
});

/**
 * pointrecords 热路径索引（IMP-1，2026-10-29）：listActiveItems 的「今日剩余」聚合
 * `{type:'exchange', refType:'item', bizDate:当日, refId:{$in}}` 没有它就只能 COLLSCAN 全表扫积分台账，
 * 积分页每次加载都随账本增长变慢。索引声明被删/改名/换序时 autoIndex 同样只留 warning，
 * 这里显式 createIndexes 等建完再核对形状——防线不在就红，不许假设它在。
 */
test('pointrecords 真实库里的防线：{type,refType,bizDate,refId} 热路径索引在', async () => {
  await PointRecordModel.createIndexes(); // 与 plugins/mongodb.ts / campaignmembers 同款：显式等建完再核对形状
  const idx = await PointRecordModel.collection.indexes();
  assert.ok(
    hasExchangeLedgerIndex(idx),
    `防线不在！现有索引：${JSON.stringify(idx.map((i) => ({ name: i.name, key: i.key })))}`,
  );
});

test('pointrecords：字段改名（bizDate→date）不算防线', () => {
  assert.equal(hasExchangeLedgerIndex([{ name: 'x', key: { type: 1, refType: 1, date: 1, refId: 1 } }]), false);
});

test('pointrecords：键序不对（$in 的 refId 不做收尾）不算防线：等值前缀断在 $in 处', () => {
  assert.equal(hasExchangeLedgerIndex([{ name: 'x', key: { refId: 1, type: 1, refType: 1, bizDate: 1 } }]), false);
});

test('pointrecords：缺字段（没有 refType）不算防线', () => {
  assert.equal(hasExchangeLedgerIndex([{ name: 'x', key: { type: 1, bizDate: 1, refId: 1 } }]), false);
});
