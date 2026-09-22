/**
 * 足迹分类：key + 中文名 + 校验闸门的唯一出处
 *
 * 刻意做成代码内枚举而非后台可配：小程序地图 marker 的 iconPath 只吃打进包里的静态 PNG，
 * 分类一旦做成后台 CRUD，图标就得配套图片上传与包体策略，成本与收益不对等。
 * 新增分类要同时补：这里的 key/label、小程序 config 的 key→图标、以及一张 assets/icons/fp-cat-<key>.png。
 */
export const FOOTPRINT_CATEGORIES = [
  { key: 'scenic', label: '景区' },
  { key: 'mountain', label: '山峰' },
  { key: 'park', label: '公园绿地' },
  { key: 'heritage', label: '古迹寺庙' },
  { key: 'museum', label: '博物馆展馆' },
  { key: 'street', label: '商圈街区' },
  { key: 'food', label: '餐饮咖啡' },
  { key: 'camp', label: '露营户外' },
  { key: 'other', label: '其他' },
] as const;

export type FootprintCategoryKey = (typeof FOOTPRINT_CATEGORIES)[number]['key'];

export const FOOTPRINT_CATEGORY_KEYS = FOOTPRINT_CATEGORIES.map((c) => c.key) as string[];

/** '' = 未分类（历史数据与用户主动清空都走这个值） */
export const FOOTPRINT_CATEGORY_OPTIONS = [...FOOTPRINT_CATEGORY_KEYS, ''];

export function footprintCategoryLabel(key: string): string {
  return FOOTPRINT_CATEGORIES.find((c) => c.key === key)?.label ?? '';
}

/** 拒绝原因里带上实际值与可选清单——只说「分类不合法」用户不知道该填什么 */
export function invalidCategoryMessage(value: unknown): string {
  const options = [...FOOTPRINT_CATEGORIES.map((c) => c.label), '未分类'].join('/');
  return `分类不合法：'${String(value)}' 不在可选范围内（可选：${options}）`;
}
