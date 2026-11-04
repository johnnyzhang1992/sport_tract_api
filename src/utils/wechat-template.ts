import { BJ_OFFSET_MS } from './bj-time.js';

/** 按码点截断（thing ≤ 20、short_thing ≤ 5；emoji 不拆） */
export function truncateChars(text: string, max: number): string {
  return Array.from(String(text || '')).slice(0, max).join('');
}

/** time 类型字段：2026年11月8日 10:00（与会员到期模板的 date2 同形） */
export function fmtCnDateTime(ms: number): string {
  const d = new Date(ms + BJ_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
