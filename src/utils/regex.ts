/** 把用户输入转义成安全的正则字面量：元字符不再是元字符 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
