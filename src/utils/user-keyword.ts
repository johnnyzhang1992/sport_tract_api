import { escapeRegex } from './regex.js';

/**
 * 管理端「按昵称 / UID 搜人」的唯一口径（spec §6.7 / §7.1 / §7.2）。
 *
 * - 关键词一律按**字面量**处理：先过 escapeRegex，`.`、`(` 这类元字符不通配
 *   （用户列表 AU-5 与发放记录 GR-9 都钉这条）；
 * - 昵称不区分大小写做子串匹配；
 * - UID 只在整串是数字时按**精确号**匹配：uid 是数值编号，子串匹配会把 1001 与 11001 混成一堆。
 *
 * 返回 null = 空关键词，调用方不加任何条件（不是「匹配空串」）。
 */
export function userKeywordFilter(keyword: unknown): { $or: Record<string, unknown>[] } | null {
  const kw = String(keyword ?? '').trim();
  if (!kw) return null;
  const or: Record<string, unknown>[] = [{ nickname: { $regex: escapeRegex(kw), $options: 'i' } }];
  if (/^\d+$/.test(kw)) or.push({ uid: Number(kw) });
  return { $or: or };
}
