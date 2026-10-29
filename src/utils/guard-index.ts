/** collection.indexes() 返回项里核对防线需要的字段 */
type IndexShape = {
  name?: string;
  unique?: boolean;
  key?: Record<string, unknown>;
  partialFilterExpression?: Record<string, unknown>;
};

/**
 * 同用户「同时只允许一条进行中轨迹」的 DB 级防线是否真在。
 * 三个条件缺一不可：
 * - 字段同时含 userId+status：只按 userId 唯一会把历史轨迹一并拒掉；
 * - unique：普通索引拦不住并发写入，等于没有；
 * - partialFilterExpression 限定 status='in_progress'：全量唯一会把同用户多条已完成判成冲突。
 * 按字段组合而不是索引名判断——名字改了防线照样在，反之删了属性才算失效。
 */
export function hasUniqueInProgressIndex(indexes: IndexShape[]): boolean {
  return indexes.some((i) => {
    const fields = Object.keys(i.key ?? {}).sort().join(',');
    return fields === 'status,userId' && i.unique === true && i.partialFilterExpression?.status === 'in_progress';
  });
}

/**
 * 同活动同人「同时只允许一条 joined」的 DB 级防线是否真在（campaignmembers）。
 * 与 hasUniqueInProgressIndex 同口径、同三个条件：
 * - 字段同时含 campaignId+userId：只按 userId 唯一会把别人的活动行也拒掉；
 * - unique：普通索引拦不住并发写入；
 * - partialFilterExpression 限定 state='joined'：全量唯一会把同用户多条历史段（left/removed）判成冲突。
 * 它静默消失时：同一用户可留两条 joined，getCampaignDetail 的 totals 按行求和、排行榜按行映射
 * → 同一个人被算两次 / 列两次；E11000→409 的兜底也随之变成死代码。
 */
export function hasUniqueJoinedIndex(indexes: IndexShape[]): boolean {
  return indexes.some((i) => {
    const fields = Object.keys(i.key ?? {}).sort().join(',');
    return fields === 'campaignId,userId' && i.unique === true && i.partialFilterExpression?.state === 'joined';
  });
}

/**
 * 积分页热路径索引是否真在（pointrecords）：listActiveItems 的今日剩余聚合
 * `{type:'exchange', refType:'item', bizDate:当日, refId:{$in:在架 keys}}` 靠它免全表扫。
 * 与上面两条 unique 防线不同，这是性能索引：不看 unique/partial，但认键序——
 * {type,refType,bizDate,refId} 是这里选定的规范形状（等值在前、$in 收尾），不是 Mongo 硬要求
 * （$in 也能按等值绑定，换序仍可能 IXSCAN）；guard 钉的是 exact 键组合，改名/换序都按「防线不在」处理
 * （索引名是 Mongoose 自动生成的，按键组合认，不认名字）。
 */
export function hasExchangeLedgerIndex(indexes: IndexShape[]): boolean {
  return indexes.some((i) => {
    const fields = Object.keys(i.key ?? {}).join(',');
    return fields === 'type,refType,bizDate,refId' && Object.values(i.key ?? {}).every((v) => v === 1);
  });
}

/**
 * 每日投放计数器（pointdailyquotas）的唯一防线是否真在：{key,dateKey,userId} unique。
 * 这是正确性防线不是性能索引：takeDailyQuota 先 upsert 建基线行、再走「不带 upsert 的条件 $inc」，
 * 并发首次建行的两个请求靠这条唯一索引让败者撞 E11000 退化；删了它基线行会插成多份，
 * 条件闸门只守得住其中一份——超发+额度回补错位，且不会有任何报错。
 * 认字段组合（排序后比对）不认键序也不认名字：三字段在闸门里全是等值条件，唯一性约束与键序无关。
 */
export function hasUniqueDailyQuotaIndex(indexes: IndexShape[]): boolean {
  return indexes.some((i) => {
    const fields = Object.keys(i.key ?? {}).sort().join(',');
    return fields === 'dateKey,key,userId' && i.unique === true;
  });
}

/**
 * 榜单发放台账（boardsettlements，Task 6）的 {type,period,periodKey,userId} unique 防线是否真在。
 * 正确性防线不是性能索引：settlePeriod 是懒结算，同一期同一榜同一人会在并发请求里被触发多次，
 * 「这笔发过没有」全靠这条唯一索引让败者撞 E11000 退化（services/points-board.ts 的 claimBoardSettlement）。
 * 删了它的症状：同一笔榜单奖励发两遍（资损），而且不报错——台账只是多出一行，
 * 败者分支（won=false）同时变成死代码。
 * 认排序后的字段组合而不是键序（唯一性约束与键序无关），也不认名字（名字是 Mongoose 自动生成的）；
 * 声明侧那半边的断言才钉 exact 键序，因为 Task 7 的读路径要 {type,period,periodKey} 这个前缀能用上索引。
 */
export function hasUniqueBoardSettlementIndex(indexes: IndexShape[]): boolean {
  return indexes.some((i) => {
    const fields = Object.keys(i.key ?? {}).sort().join(',');
    return fields === 'period,periodKey,type,userId' && i.unique === true;
  });
}

/**
 * 定向通知（notifications，Task 8）读路径索引是否真在：{userId:1, published:1, publishedAt:-1}。
 * 性能索引（非 unique），但认键序与方向：登录侧过滤是
 * `{published:true, $or:[{userId:null},{userId:me}]}`，$or 的 isosolution 下每个分支都按
 * userId（等值）→ published（等值）→ publishedAt（倒序收尾，免内存排序）走本索引；
 * 游客/畸形 userId 收敛成 `{userId:null, published:true}`，同样落在等值前缀上。
 * 键序换成 published 在前、或 publishedAt 方向写成升序，都按「防线不在」处理（索引名是
 * Mongoose 自动生成的，按键组合+方向认，不认名字）。
 */
export function hasNotificationRecipientIndex(indexes: IndexShape[]): boolean {
  return indexes.some((i) => {
    const key = i.key ?? {};
    return Object.keys(key).join(',') === 'userId,published,publishedAt'
      && key.userId === 1 && key.published === 1 && key.publishedAt === -1;
  });
}

/**
 * 榜单发放台账（boardsettlements，Task 10）的**管理端读路径**索引是否真在：
 * {period:1, periodKey:1, status:1, type:1, userId:1}（全等值前缀，无 unique）。
 * 为什么单开一条：唯一索引 {type,period,periodKey,userId} 的前缀是 type，而后台台账页的主路径是
 * 「按周期单元看这一期」（period + periodKey，八张榜一起对账）——type 缺席时唯一索引帮不上忙，
 * 这就是 Task 6 评审点名的 `{period,status}` 无索引读路径。
 * 性能防线，认 exact 键组合与键序（等值前缀换成 status 打头就服务不了「先按周期收窄」的形状），
 * 不认名字（名字是 Mongoose 自动生成的）。
 */
export function hasBoardSettlementAdminReadIndex(indexes: IndexShape[]): boolean {
  return indexes.some((i) => {
    const key = i.key ?? {};
    return Object.keys(key).join(',') === 'period,periodKey,status,type,userId'
      && Object.values(key).every((v) => v === 1);
  });
}

/**
 * 榜单发分聚合（activities，2026-10-29 终审 must-fix #4）的读路径索引是否真在：
 * {type:1, status:1, startTime:1}——trustedBoardRows 的 $match 是
 * `{type, status:'finished', startTime:{$gte,$lt}}`，四道可信判据都进不了索引。
 * 性能索引（非 unique），认 exact 键组合与键序（两个等值在前、区间收尾）与全 1 方向；
 * 换序（status/startTime 打头）或方向写成 -1 都按「防线不在」处理（索引名是 Mongoose
 * 自动生成的，按键组合+方向认，不认名字）。
 * 它静默消失时：一次结算 pass 的 8 个榜各自扫「全部 finished 轨迹」（dev 库实测
 * 1000 keys/1000 docs／榜），完成标记过期后每重评一次再付一遍——慢查询而不是错数，
 * 但 8× 全表扫会随账本增长把懒结算拖成页面超时。
 */
export function hasBoardTrustedAggregateIndex(indexes: IndexShape[]): boolean {
  return indexes.some((i) => {
    const key = i.key ?? {};
    return Object.keys(key).join(',') === 'type,status,startTime'
      && Object.values(key).every((v) => v === 1);
  });
}
