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
