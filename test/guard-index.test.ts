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
import { NotificationModel } from '../src/models/notification.model.js';
import { PointDailyQuotaModel, PointRecordModel, BoardSettlementModel } from '../src/models/point.model.js';
import {
  hasUniqueInProgressIndex, hasUniqueJoinedIndex, hasExchangeLedgerIndex, hasUniqueDailyQuotaIndex,
  hasNotificationRecipientIndex, hasUniqueBoardSettlementIndex, hasBoardSettlementAdminReadIndex,
  hasBoardTrustedAggregateIndex,
} from '../src/utils/guard-index.js';

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
 * 这里两侧都核对：声明侧（schema.indexes()）保证「代码里还写着」，真实库侧（createIndexes 等建完
 * 再核对形状）保证「库里真在」——createIndexes 只增不删，删了声明但库里留着旧索引时库侧仍是绿的，
 * 少了声明侧这条就会假绿（防线不在就红，不许假设它在）。
 */
test('pointrecords 热路径索引：声明侧与真实库侧的防线都在（{type,refType,bizDate,refId}）', async () => {
  // 声明侧：认字段组合与键序，不认索引名。删掉/改名 recordSchema.index(...) 时这一条先红，
  // 不受库里残留索引影响。
  const declared = PointRecordModel.schema.indexes();
  assert.ok(
    declared.some(([keys]) => Object.keys(keys).join(',') === 'type,refType,bizDate,refId'),
    `schema 里的索引声明没有 {type,refType,bizDate,refId} 这条！现有声明：${JSON.stringify(declared.map(([keys]) => keys))}`,
  );
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

/**
 * 每日投放计数器（Task 3）的 {key,dateKey,userId} unique 防线：正确性防线——
 * ensureQuotaRow 的并发建行去重、takeDailyQuota 的条件 $inc 都钉在「一个 key+日+人只有一行」上，
 * 声明被删时 autoIndex 只留 warning，基线行可能插成多份、闸门只守住其中一份（超发且无声）。
 * 两侧都核对（同 pointrecords 热路径索引的 10-29 教训）：删声明但库里留着旧索引时库侧假绿，
 * 声明侧这条先红。
 * 修复轮 1（finding 4）：声明侧必须连 opts.unique 一起断——只认键组合时，
 * 有人把 unique: true 删了（留一条同名普通索引）这条自检照样绿，防线没了却测不出来。
 */
test('pointdailyquotas 防线：unique {key,dateKey,userId} 声明侧与真实库侧都在', async () => {
  const declared = PointDailyQuotaModel.schema.indexes();
  assert.ok(
    declared.some(([keys, opts]) => Object.keys(keys).sort().join(',') === 'dateKey,key,userId'
      && (opts as { unique?: boolean } | undefined)?.unique === true),
    `schema 里的索引声明没有 {key,dateKey,userId} + unique:true 这条！现有声明：${JSON.stringify(declared)}`,
  );
  await PointDailyQuotaModel.createIndexes(); // 与 plugins/mongodb.ts 同款：显式等建完再核对形状
  const idx = await PointDailyQuotaModel.collection.indexes();
  assert.ok(
    hasUniqueDailyQuotaIndex(idx),
    `防线不在！现有索引：${JSON.stringify(idx.map((i) => ({ name: i.name, unique: i.unique, key: i.key })))}`,
  );
});

test('pointdailyquotas：普通索引（非 unique）不算防线：并发建基线行会插成多份', () => {
  assert.equal(hasUniqueDailyQuotaIndex([{ name: 'x', key: { key: 1, dateKey: 1, userId: 1 } }]), false);
});

test('pointdailyquotas：字段不全（缺 dateKey）不算防线：跨日行会互相顶掉', () => {
  assert.equal(hasUniqueDailyQuotaIndex([{ name: 'x', key: { key: 1, userId: 1 }, unique: true }]), false);
});

/**
 * 定向通知（notifications，Task 8）读路径索引 {userId:1, published:1, publishedAt:-1}：
 * publishedRows 登录侧过滤是 `{published:true, $or:[{userId:null},{userId:me}]}`，$or 的 isosolution
 * 按分支走本索引（userId、published 等值前缀 + publishedAt 倒序收尾，免内存排序）；游客/畸形 userId
 * 收敛成 `{userId:null, published:true}`，同样落在等值前缀上。性能索引，同 pointrecords 的 10-29 教训
 * 两侧都核对：删声明但库里留旧索引时库侧假绿，声明侧先红；既认键序也认方向（publishedAt 写成升序
 * 就服务不了倒序排序，按「防线不在」处理）。既有的 {published:1, publishedAt:-1} 是方案保留项，
 * 声明侧一并钉住，不许顺手删。
 */
test('notifications 定向读路径索引：声明侧与真实库侧的防线都在（{userId,published,publishedAt}）', async () => {
  const declared = NotificationModel.schema.indexes();
  assert.ok(
    declared.some(([keys]) => Object.keys(keys).join(',') === 'userId,published,publishedAt'
      && keys.userId === 1 && keys.published === 1 && keys.publishedAt === -1),
    `schema 里的索引声明没有 {userId:1,published:1,publishedAt:-1} 这条！现有声明：${JSON.stringify(declared.map(([keys]) => keys))}`,
  );
  assert.ok(
    declared.some(([keys]) => Object.keys(keys).join(',') === 'published,publishedAt' && keys.publishedAt === -1),
    `既有的 {published:1,publishedAt:-1} 声明不能被删！现有声明：${JSON.stringify(declared.map(([keys]) => keys))}`,
  );
  await NotificationModel.createIndexes(); // 与 plugins/mongodb.ts 同款：显式等建完再核对形状
  const idx = await NotificationModel.collection.indexes();
  assert.ok(
    hasNotificationRecipientIndex(idx),
    `防线不在！现有索引：${JSON.stringify(idx.map((i) => ({ name: i.name, key: i.key })))}`,
  );
});

test('notifications：键序不对（published 在前）不算定向防线：$or 分支前缀是 userId', () => {
  assert.equal(hasNotificationRecipientIndex([{ name: 'x', key: { published: 1, userId: 1, publishedAt: -1 } }]), false);
});

test('notifications：publishedAt 方向写成升序不算防线：列表口径是倒序', () => {
  assert.equal(hasNotificationRecipientIndex([{ name: 'x', key: { userId: 1, published: 1, publishedAt: 1 } }]), false);
});

test('notifications：缺字段（没有 published）不算防线：草稿会混进结果集', () => {
  assert.equal(hasNotificationRecipientIndex([{ name: 'x', key: { userId: 1, publishedAt: -1 } }]), false);
});

/**
 * 榜单发放台账（boardsettlements，Task 6）的 {type,period,periodKey,userId} unique 防线。
 * 正确性防线，不是性能索引：settlePeriod 挂在用户入口上做懒结算（Task 9），同一期同一榜同一人
 * 会被反复触发、还会并发触发，「这笔发过没有」只由这一行台账裁决。
 * 声明被删时 autoIndex 只留一条 warning，症状是同一笔榜单奖励发两遍（真金白银的资损）且没有任何报错，
 * 同时 E11000→安静退化的败者分支（claimBoardSettlement 的 won=false）也永不触发，变成死代码。
 * 两侧都核对（同 pointrecords/pointdailyquotas 的教训）：只核对库里那份，被删了声明但 dev 库
 * 还留着历史索引时会假绿；声明侧这条先红，且要连 opts.unique 一起断（把 unique: true 删成
 * 同名普通索引，只认键组合的写法测不出来）。
 */
test('BS-3 索引自检：模型 init 后唯一索引存在（照 campaignmembers 那条的先例）', async () => {
  // 声明侧：认 exact 键组合与**键序**（Task 7 的读路径要 {type,period,periodKey} 前缀能用上它）
  // 加 opts.unique。键序只在声明侧钉，库侧谓词按排序后的字段组合认（唯一性约束与键序无关）。
  const declared = BoardSettlementModel.schema.indexes();
  assert.ok(
    declared.some(([keys, opts]) => Object.keys(keys).join(',') === 'type,period,periodKey,userId'
      && (opts as { unique?: boolean } | undefined)?.unique === true),
    `schema 里的索引声明没有 {type,period,periodKey,userId} + unique:true 这条！现有声明：${JSON.stringify(declared)}`,
  );
  await BoardSettlementModel.createIndexes(); // 与 plugins/mongodb.ts 同款：显式等建完再核对形状
  const idx = await BoardSettlementModel.collection.indexes();
  assert.ok(
    hasUniqueBoardSettlementIndex(idx),
    `防线不在！现有索引：${JSON.stringify(idx.map((i) => ({ name: i.name, unique: i.unique, key: i.key })))}`,
  );
});

test('boardsettlements：普通索引（非 unique）不算防线：并发懒结算会各插一行、各发一笔', () => {
  assert.equal(hasUniqueBoardSettlementIndex([{ name: 'x', key: { type: 1, period: 1, periodKey: 1, userId: 1 } }]), false);
});

test('boardsettlements：字段不全（缺 periodKey）不算防线：不同期会互相顶掉发放', () => {
  assert.equal(hasUniqueBoardSettlementIndex([{ name: 'x', key: { type: 1, period: 1, userId: 1 }, unique: true }]), false);
});

test('boardsettlements：只按 userId 唯一不算防线：一个人同期只能上一次榜', () => {
  assert.equal(hasUniqueBoardSettlementIndex([{ name: 'x', key: { userId: 1 }, unique: true }]), false);
});

/**
 * 榜单发放台账的管理端读路径索引（Task 10）：{period,periodKey,status,type,userId} 全等值。
 * 唯一索引的前缀是 type，而后台台账页的主路径是「按周期单元看这一期」（period+periodKey，八张榜
 * 一起对账）——type 缺席时唯一索引服务不了它（Task 6 评审点名的 {period,status} 无索引读路径）。
 * 性能索引，同 pointrecords/notifications 的 10-29 教训两侧都核对：删声明但 dev 库留着旧索引时
 * 库侧假绿，声明侧先红；exact 键组合与键序一起认（换成 status 打头就服务不了「先按周期收窄」）。
 */
test('boardsettlements 管理端读索引：声明侧与真实库侧的防线都在（{period,periodKey,status,type,userId}）', async () => {
  const declared = BoardSettlementModel.schema.indexes();
  assert.ok(
    declared.some(([keys]) => Object.keys(keys).join(',') === 'period,periodKey,status,type,userId'
      && Object.values(keys).every((v) => v === 1)),
    `schema 里的索引声明没有 {period,periodKey,status,type,userId} 这条！现有声明：${JSON.stringify(declared.map(([keys]) => keys))}`,
  );
  await BoardSettlementModel.createIndexes(); // 与 plugins/mongodb.ts 同款：显式等建完再核对形状
  const idx = await BoardSettlementModel.collection.indexes();
  assert.ok(
    hasBoardSettlementAdminReadIndex(idx),
    `防线不在！现有索引：${JSON.stringify(idx.map((i) => ({ name: i.name, key: i.key })))}`,
  );
});

test('boardsettlements：读索引键序不对（status 打头）不算防线：周期前缀断了', () => {
  assert.equal(
    hasBoardSettlementAdminReadIndex([{ name: 'x', key: { status: 1, period: 1, periodKey: 1, type: 1, userId: 1 } }]),
    false,
  );
});

test('boardsettlements：读索引缺字段（没有 status）不算防线：{period,periodKey} 之后还要按状态收窄', () => {
  assert.equal(
    hasBoardSettlementAdminReadIndex([{ name: 'x', key: { period: 1, periodKey: 1, type: 1, userId: 1 } }]),
    false,
  );
});

test('boardsettlements：唯一索引不算管理端读防线（前缀是 type，周期查询用不上）', () => {
  assert.equal(
    hasBoardSettlementAdminReadIndex([{ name: 'x', key: { type: 1, period: 1, periodKey: 1, userId: 1 }, unique: true }]),
    false,
  );
});

/**
 * activities 上榜单发分聚合的读索引（2026-10-29 终审 must-fix #4）：
 * trustedBoardRows 的 $match 是 `{type, status:'finished', startTime:{$gte,$lt}}`，四道可信判据
 * 都是文档内过滤。没有它时实际计划退到 status_1 单键——一次结算 pass 的 8 个榜各扫一遍
 * 全部 finished 轨迹（dev 库 1000 keys/1000 docs 每榜）。慢查询不是错数，但随账本增长会把
 * 懒结算拖成页面超时，所以同 pointrecords 的 10-29 教训两侧都核对：删声明但库里留旧索引时
 * 库侧假绿，声明侧这条先红；exact 键组合 + 键序 + 全 1 方向一起认。
 */
test('activities 发分聚合读索引：声明侧与真实库侧的防线都在（{type,status,startTime}）', async () => {
  const declared = ActivityModel.schema.indexes();
  assert.ok(
    declared.some(([keys]) => Object.keys(keys).join(',') === 'type,status,startTime'
      && Object.values(keys).every((v) => v === 1)),
    `schema 里的索引声明没有 {type:1,status:1,startTime:1} 这条！现有声明：${JSON.stringify(declared.map(([keys]) => keys))}`,
  );
  await ActivityModel.createIndexes(); // 与 plugins/mongodb.ts 同款：显式等建完再核对形状
  const idx = await ActivityModel.collection.indexes();
  assert.ok(
    hasBoardTrustedAggregateIndex(idx),
    `防线不在！现有索引：${JSON.stringify(idx.map((i) => ({ name: i.name, key: i.key })))}`,
  );
});

test('activities：键序不对（startTime 打头）不算发分防线：等值前缀断了', () => {
  assert.equal(hasBoardTrustedAggregateIndex([{ name: 'x', key: { startTime: 1, type: 1, status: 1 } }]), false);
});

test('activities：缺 type（只剩 status+startTime）不算发分防线：一次 pass 会扫全部类型', () => {
  assert.equal(hasBoardTrustedAggregateIndex([{ name: 'x', key: { status: 1, startTime: 1 } }]), false);
});

test('activities：startTime 方向写成倒序不算发分防线：区间是正序收尾', () => {
  assert.equal(hasBoardTrustedAggregateIndex([{ name: 'x', key: { type: 1, status: 1, startTime: -1 } }]), false);
});
