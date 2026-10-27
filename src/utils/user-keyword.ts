import { escapeRegex } from './regex.js';

/**
 * 管理端「按昵称 / UID 搜人」的唯一口径（spec §6.7 / §7.1 / §7.2）。
 *
 * - 关键词一律按**字面量**处理：先过 escapeRegex，`.`、`(` 这类元字符不通配
 *   （用户列表 AU-5 与发放记录 GR-9 都钉这条）；
 * - 昵称不区分大小写做子串匹配；
 * - UID 只在整串是数字时按**精确号**匹配：uid 是数值编号，子串匹配会把 1001 与 11001 混成一堆。
 *   库里的 uid 混着 int 与 string 两种 BSON 类型（存量数据），两种表示都要命中：
 *   数值档走普通条件（可命中 sparse unique 索引），字符串档只能走 `$expr` ——
 *   Mongoose 会把 `$in: [1000, '1000']` 里的字符串按 schema 强转成数字，两种表示合成一个条件（实测），
 *   存量字符串 uid 就永远搜不到。
 *
 * 返回 null = 空关键词，调用方不加任何条件（不是「匹配空串」）。
 */
export function userKeywordFilter(keyword: unknown): { $or: Record<string, unknown>[] } | null {
  const kw = String(keyword ?? '').trim();
  if (!kw) return null;
  const or: Record<string, unknown>[] = [{ nickname: { $regex: escapeRegex(kw), $options: 'i' } }];
  if (/^\d+$/.test(kw)) {
    or.push({ uid: Number(kw) }, { $expr: { $in: ['$uid', [Number(kw), kw]] } });
  }
  return { $or: or };
}
