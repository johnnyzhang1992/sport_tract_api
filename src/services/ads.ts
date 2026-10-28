/**
 * 广告位（webAdmin 配置 → 小程序按 key 取 unit-id 与开关）。
 *
 * 设计口径：
 * - 一条 = 一个可投放位置：key 是代码里引用的稳定标识（如 home_bottom），unitId 是流量主后台的广告单元；
 * - 目前只支持模板广告（原生模板 `<ad-custom>`），kind 先固定在 'template'，将来扩类型再加枚举；
 * - 公开接口只下发在架项且只给 { key, unitId }：广告位 key/unit-id 不是秘密，但下架项不该出现在端上；
 * - 免广告卡不在服务端参与判断：端上已有 ad_free_until，展示条件 = 后台在架 且 未免广告期。
 */
import { Types } from 'mongoose';
import { AdSlotModel } from '../models/ad-slot.model.js';
import { AppError } from '../utils/app-error.js';
import { assertObjectIdLike } from '../utils/object-id.js';

export interface AdSlotRow {
  id: string;
  key: string;
  name: string;
  unitId: string;
  kind: 'template';
  active: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface AdSlotInput {
  key?: unknown;
  name?: unknown;
  unitId?: unknown;
  active?: unknown;
  sortOrder?: unknown;
}

const KEY_RE = /^[a-z][a-z0-9_]{1,31}$/;
// 流量主后台生成的单元 id：adunit- + 16 位十六进制；放宽到 8~32 位以兼容不同批次
const UNIT_RE = /^adunit-[0-9a-z]{8,32}$/;

function shown(value: unknown): string {
  return value === undefined || value === null || value === '' ? '空' : String(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 新建/更新共用的字段校验；返回归一后的可写字段（不含 key） */
function assertContent(input: AdSlotInput): { name: string; unitId: string; active: boolean; sortOrder: number } {
  const name = str(input.name);
  if (!name || name.length > 20) throw new AppError(400, `名称需 1–20 字（收到「${shown(input.name)}」）`);

  const unitId = str(input.unitId);
  if (!UNIT_RE.test(unitId)) {
    throw new AppError(400, `广告单元 ID 格式不对（应形如 adunit-xxxx，收到「${shown(input.unitId)}」）`);
  }

  if (input.active !== true && input.active !== false) {
    throw new AppError(400, `上架状态 active 只能是 true 或 false（收到「${shown(input.active)}」）`);
  }

  const sortOrder = Number(input.sortOrder ?? 0);
  if (!Number.isInteger(sortOrder)) throw new AppError(400, `排序 sortOrder 必须是整数（收到「${shown(input.sortOrder)}」）`);

  return { name, unitId, active: input.active, sortOrder };
}

/**
 * 公开列表：小程序端按 key 取 unit-id。
 * 只给在架项，且只有 { key, unitId }——下架/删除的广告位不该在端上留下痕迹。
 */
export async function listActiveAdSlots(): Promise<{ key: string; unitId: string }[]> {
  const rows = await AdSlotModel.find({ active: true })
    .sort({ sortOrder: 1, _id: 1 })
    .select({ key: 1, unitId: 1 })
    .lean();
  return rows.map((r) => ({ key: String(r.key), unitId: String(r.unitId) }));
}

/** 管理端列表：含下架项，按 sortOrder 排 */
export async function listAdSlotsForAdmin(): Promise<AdSlotRow[]> {
  const rows = await AdSlotModel.find({}).sort({ sortOrder: 1, _id: 1 }).lean();
  return rows.map((r) => ({
    id: String(r._id),
    key: String(r.key),
    name: String(r.name),
    unitId: String(r.unitId),
    kind: 'template',
    active: r.active !== false,
    sortOrder: Number(r.sortOrder ?? 0),
    createdAt: Number(r.createdAt ?? 0),
    updatedAt: Number(r.updatedAt ?? r.createdAt ?? 0),
  }));
}

/** 新建：key 一经创建不可改（端上代码按 key 引用，改了等于换了个广告位） */
export async function createAdSlot(input: AdSlotInput): Promise<AdSlotRow> {
  const key = str(input.key);
  if (!KEY_RE.test(key)) {
    throw new AppError(400, `广告位 key 需小写字母开头、只含小写字母/数字/下划线，2–32 位（收到「${shown(input.key)}」）`);
  }
  const content = assertContent(input);

  const exists = await AdSlotModel.findOne({ key }).select({ _id: 1 }).lean();
  if (exists) throw new AppError(400, `广告位 key「${key}」已存在`);

  const doc = await AdSlotModel.create({ key, kind: 'template', ...content });
  const [row] = (await listAdSlotsForAdmin()).filter((r) => String(r.id) === String(doc._id));
  if (!row) throw new AppError(500, '广告位创建后读取失败');
  return row;
}

/** 更新：只改内容字段；key 不允许改（传了不同的 key 直接 400，别静默忽略） */
export async function updateAdSlot(id: unknown, input: AdSlotInput): Promise<AdSlotRow> {
  assertObjectIdLike(id, '广告位不存在');
  const content = assertContent(input);

  const existing = await AdSlotModel.findById(id).select({ key: 1 }).lean();
  if (!existing) throw new AppError(404, '广告位不存在');
  if (input.key !== undefined && str(input.key) !== String(existing.key)) {
    throw new AppError(400, `广告位 key 不可修改（当前「${existing.key}」，收到「${shown(input.key)}」）`);
  }

  await AdSlotModel.updateOne({ _id: new Types.ObjectId(String(id)) }, { $set: content });

  const row = (await listAdSlotsForAdmin()).find((r) => r.id === String(id));
  if (!row) throw new AppError(404, '广告位不存在');
  return row;
}

/** 删除：物理删除（端上按 key 取不到即不展示，与下架同效果） */
export async function deleteAdSlot(id: unknown): Promise<void> {
  assertObjectIdLike(id, '广告位不存在');
  const r = await AdSlotModel.deleteOne({ _id: new Types.ObjectId(String(id)) });
  if (r.deletedCount === 0) throw new AppError(404, '广告位不存在');
}
