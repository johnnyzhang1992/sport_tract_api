/**
 * 后台发放与发放记录（spec §6.1/§6.4/§7.2）：三来源里的 admin / system 都从这里写出去。
 *
 * 口径：
 * - 发放不动积分账本：一条 PointRecord 都不写、余额不变（GR-1 钉这条）。它是「白送一张卡」，
 *   不是「用户花了分」，混进账本会把 §6.5 的发放/消耗不变式搅浑；
 * - 发放照样出货（spec §6.1 裁定）：库存语义是「这个道具总共能出去多少张」，白送也算，
 *   unlimited: true 时既不筛 stock 也不 $inc；
 * - 整单闸门 all-or-nothing：一次性按 `userIds.length × count` 预占，不足直接 400 点名
 *   「需要 N，当前 M」，绝不发部分——半单发出去的库存/名单要人工对账，比拒绝一次难得多；
 * - 逐用户失败只跳过：某个用户不存在不能让整单回滚（前面的人已经拿到卡了），
 *   失败记进返回的 failed[] 让操作台看得见，末尾按实际发出数回补多占的库存（need - granted）；
 * - 下架不影响发放：客服补发/活动补偿恰恰要发已经下架的卡，所以这里只校验存在性，不看 active；
 * - count 是「每个用户发几张」（默认 1），不是总量；
 * - source 只有 admin / system 两个值可选，差别只在台账归类（spec §6.4），行为完全一致；
 *   exchange 由用户端兑换路径写入（points-items.exchangeItem），不是这里的生产者；
 * - benefitDays 发卡时从目录快照（与兑换同一口径）：后台改档不该影响已发出去的卡；
 * - 发放记录以 PointCard 为主体，老行物理缺 source 字段，聚合里 $addFields 必须排在按来源
 *   $match 之前（GR-6）：先筛后补等于把 10-27 之前写入的每一行都悄悄漏掉。
 */
import { Types, type PipelineStage } from 'mongoose';
import { PointCardModel, PointItemModel } from '../models/point.model.js';
import { UserModel } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { assertObjectIdLike, isObjectIdLike } from '../utils/object-id.js';
import { userKeywordFilter } from '../utils/user-keyword.js';
import { STATUS_TEXT, cardStatus } from './points-items.js';
// CardStatus 是 points-items 那份唯一口径（含 cardStatus 的实时推导），这里只引类型不再另立
import type { CardStatus } from './points-items.js';
import type { ItemDoc } from './points-catalog.js';

const DAY_MS = 86400000;

/** grant 接口能写的来源：exchange 是用户自己花分兑换的，后台不能替用户「兑换」 */
export const GRANT_SOURCES = ['admin', 'system'] as const;
export type GrantSource = typeof GRANT_SOURCES[number];

/** 发放记录列表能筛的全部来源（含兑换写入的那一档） */
const ISSUANCE_SOURCES = ['exchange', ...GRANT_SOURCES] as const;
export type IssuanceSource = typeof ISSUANCE_SOURCES[number];

/** 一次后台发放的入参：userIds 是名单，count 是每个用户发几张 */
export interface GrantInput {
  userIds?: string[];
  /** 每个用户发几张（默认 1） */
  count?: number;
  /** 台账归类：admin 后台手动 / system 系统赠送（活动补偿、客服补发这类要留痕的动作） */
  source?: GrantSource;
  note?: string;
}

/** 发放结果：granted 是实际落卡张数，failed 逐个点名原因；refundFailed 是回补失败、仍多扣着的库存张数 */
export interface GrantResult {
  granted: number;
  failed: { userId: string; reason: string }[];
  /**
   * 回补失败的库存张数。>0 表示预占多扣的库存没能原路退回（例如写库失败），
   * 卡已经发出去了，不能靠抛错让调用方误以为整单失败——操作台必须提示「库存回补失败，请人工核对」。
   */
  refundFailed: number;
}

/** 发放记录查询：itemKey / source / userId / keyword 都可选，page 与 pageSize 走缺省 */
export interface IssuanceQuery {
  itemKey?: string;
  source?: string;
  userId?: string;
  /** 持卡人昵称或 UID，字面量、不区分大小写（spec §7.2） */
  keyword?: string;
  page?: number;
  pageSize?: number;
}

/**
 * 发放记录行（spec §8.4 表体）：用户 / 道具 / 来源 / 时间 / 卡状态 / 操作人 / 备注。
 * uid 是 Number（实测 sport-track-dev：存量行的 uid 混着 int 与 string 两种 BSON 类型，一律 Number
 * 归一下发，缺号或未补号给 0 而不是 undefined，前端列渲染才不会显示空白）；
 * itemName 在目录被改名后跟随新名（读时 join 目录），道具被删除才是空串。
 */
export interface IssuanceRow {
  id: string;
  userId: string;
  uid: number;
  nickname: string;
  itemKey: string;
  itemName: string;
  /** 三来源之一（老行物理缺 source，聚合里按 exchange 补齐） */
  source: IssuanceSource;
  sourceText: string;
  createdAt: number;
  expiresAt: number;
  /** 实时推导（unused 且已过 expiresAt 算 expired），与兑换记录同一口径 */
  status: CardStatus;
  statusText: string;
  usedForDate: string;
  activatedAt: number;
  benefitDays: number;
  grantedBy: string;
  note: string;
}

/**
 * 错误文案里回显收到的值：空值写成「空」，对象给 JSON，别把 undefined 直接拼进句子
 * （与管理端目录同一口径：文案必须点名对象 + 实际值 + 限制）。
 */
function shown(value: unknown): string {
  if (value === undefined || value === null || value === '') return '空';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 名单最多 200 人（spec §7.2）：一批发太多人等于把一次误操作放大成 200 倍 */
const MAX_GRANT_USERS = 200;

/**
 * 入参闸门：全部校验都在读目录与预占库存之前。
 * 顺序有讲究——校验之后才是 404 道具不存在，所以非法 userIds 撞不上「道具不存在」，
 * 反过来任何一条闸门被拒都不留下卡行、不动库存（GR-4 末段钉这条）。
 */
function assertGrantInput(input: GrantInput): { userIds: string[]; count: number; source: GrantSource; note: string } {
  const raw = Array.isArray(input.userIds) ? input.userIds : null;
  if (!raw) throw new AppError(400, `发放名单必须是用户 ID 数组（收到「${shown(input.userIds)}」）`);
  const rawIds = raw.map((id) => String(id ?? '').trim());
  if (rawIds.length === 0) throw new AppError(400, '至少选一个用户');
  if (rawIds.length > MAX_GRANT_USERS) throw new AppError(400, `最多 ${MAX_GRANT_USERS} 人（当前 ${rawIds.length}）`);
  for (const id of rawIds) {
    if (!isObjectIdLike(id)) throw new AppError(400, `用户 ID 不合法：${id}`);
  }
  // 形态闸门通过后归一成小写 String(ObjectId)：下面 known 集合按 String(user._id) 建、failed 也按它比对，
  // isObjectIdLike 接受大写 hex（/i），不归一就会把真用户记成「用户不存在」并把库存退回去
  const userIds = rawIds.map((id) => String(new Types.ObjectId(id)));

  const count = input.count === undefined || input.count === null ? 1 : Number(input.count);
  if (!Number.isInteger(count) || count < 1) {
    throw new AppError(400, `每次发放张数必须是 ≥1 的整数（收到「${shown(input.count)}」）`);
  }

  // 路由交上来的是没经校验的外部 body，source 按 unknown 读回来判：
  // 直接信 TS 的 GrantSource 类型等于把闸门交给调用方（后台传 'gift' 也会当成合法值落库）
  const receivedSource = (input as { source?: unknown }).source;
  const rawSource = String(receivedSource ?? '').trim();
  if (rawSource && !(GRANT_SOURCES as readonly string[]).includes(rawSource)) {
    throw new AppError(400, `发放来源 source 仅支持 admin / system（收到「${shown(receivedSource)}」）`);
  }
  const source: GrantSource = rawSource === '' ? 'admin' : rawSource as GrantSource;
  return { userIds, count, source, note: String(input.note ?? '').trim() };
}

/**
 * 后台发放（POST /points/items/:id/grant）：admin 与 system 都走这条路，只差台账归类。
 * 写序：入参闸门 → 读目录（不存在 404，下架照样发）→ 整单预占库存 → 逐用户发卡 → 回补多占的库存。
 */
export async function grantItem(
  itemId: string,
  input: GrantInput,
  /** 操作人：admin 的 _id（由路由从 admin token 取出），落进每张卡的 grantedBy */
  grantedBy: string,
  now = Date.now(),
): Promise<GrantResult> {
  const { userIds, count, source, note } = assertGrantInput(input);

  assertObjectIdLike(itemId, '道具不存在');
  const item = await PointItemModel.findOne({ _id: itemId }).lean() as ItemDoc | null;
  if (!item) throw new AppError(404, '道具不存在');

  // 有效期先归一：存量目录行可能没有 validDays，`undefined * DAY_MS` 会发出 expiresAt=NaN 的卡。
  // 校验必须在库存预占之前——不然坏目录行会先扣库存再报错。
  const validDays = Number(item.validDays);
  if (!Number.isFinite(validDays) || validDays <= 0) {
    throw new AppError(400, `「${item.name}」的卡有效期不合法（validDays=${shown(item.validDays)}，应为正数）`);
  }

  const need = userIds.length * count;
  if (!item.unlimited) {
    // 整单预占：条件更新一次原子扣 need 张，抢不到就是不够，直接 400 点名需要数与当前数
    const taken = await PointItemModel.findOneAndUpdate(
      { _id: item._id, stock: { $gte: need } }, { $inc: { stock: -need } }, { returnDocument: 'after' },
    ).lean();
    if (!taken) {
      const cur = await PointItemModel.findById(item._id).lean();
      throw new AppError(400, `「${item.name}」库存不足（需要 ${need}，当前 ${cur?.stock ?? 0}）`);
    }
  }

  // 一次查出名单里存在的用户：不存在的逐个记进 failed，而不是让 create() 去撞 required 校验
  const existing = await UserModel.find({ _id: { $in: userIds.map((id) => new Types.ObjectId(id)) } })
    .select({ _id: 1 })
    .lean();
  const known = new Set(existing.map((u) => String(u._id)));

  const failed: GrantResult['failed'] = [];
  let granted = 0;
  for (const userId of userIds) {
    if (!known.has(userId)) {
      failed.push({ userId, reason: '用户不存在' });
      continue;
    }
    try {
      await PointCardModel.insertMany(
        Array.from({ length: count }, () => ({
          userId,
          itemKey: item.key,
          status: 'unused',
          source,
          grantedBy: String(grantedBy ?? ''),
          note,
          // 发卡时固化权益天数：后台把 7 天改成 10 天不该影响已经发出去的卡
          benefitDays: item.effect?.kind === 'ad_free' ? item.effect.days : 0,
          expiresAt: now + validDays * DAY_MS,
          createdAt: now,
        })),
      );
      granted += count;
    } catch (e) {
      // insertMany 是 ordered 的：可能已经落了前几张再抛（校验撞在第 N 张）。已落库的张数必须算进
      // granted，否则末尾按「这个人一张没发」回补，等于白退库存、卡却留在库里。
      const partial = (e as { insertedDocs?: unknown[] })?.insertedDocs?.length ?? 0;
      granted += partial;
      failed.push({ userId, reason: (e as Error)?.message ?? '发卡失败' });
    }
  }

  // 回补多占的库存：预占按名单长度算，跳过的人数 × count 那张数要原路退回（不补就是白扣库存）。
  // 此时卡已经落库，不能为了回补失败把整单抛成失败——把缺口放进 refundFailed 让操作台人工核对。
  let refundFailed = 0;
  if (!item.unlimited && need > granted) {
    const refund = need - granted;
    try {
      const res = await PointItemModel.updateOne({ _id: item._id }, { $inc: { stock: refund } });
      if ((res?.matchedCount ?? 0) === 0) refundFailed = refund;
    } catch (e) {
      refundFailed = refund;
      console.error('[points] 发放回补库存失败', item.key, refund, e);
    }
  }

  return { granted, failed, refundFailed };
}

/** 分页归一：page ≥ 1，pageSize 1–100（管理端列表口径，缺省 20） */
function toPaging(q: IssuanceQuery): { p: number; ps: number } {
  const p = Math.max(1, Math.trunc(Number(q.page) || 1) || 1);
  const ps = Math.min(100, Math.max(1, Math.trunc(Number(q.pageSize) || 20) || 20));
  return { p, ps };
}

/** 三来源的中文文案：发放记录与用户详情里的「道具记录」共用这一份（spec §7.1/§8.3） */
export const SOURCE_TEXT: Record<string, string> = {
  exchange: '兑换',
  admin: '后台手动',
  system: '系统赠送',
};

/**
 * 发放记录列表（GET /points/issuances）：以卡为主体，三来源都在，按发放时间倒序。
 * total 跟着筛选条件走（分页控件要看的是「这个条件下一共多少条」）。
 */
export async function listIssuances(q: IssuanceQuery): Promise<{
  total: number; page: number; pageSize: number; items: IssuanceRow[];
}> {
  const { p, ps } = toPaging(q);
  const itemKey = q.itemKey ? String(q.itemKey).trim() : '';
  const source = q.source ? String(q.source).trim() : '';
  if (source && !(ISSUANCE_SOURCES as readonly string[]).includes(source)) {
    throw new AppError(400, `筛选来源只能是 ${ISSUANCE_SOURCES.join(' / ')}（收到「${shown(q.source)}」）`);
  }
  // 查询参数里的 userId 是「筛选条件」不是路径资源：形态非法一律 400（路径 id 才沿用仓内 404 口径）。
  // 通过后同样归一成小写 hex，与库里 userId 的 ObjectId 字节比较口径一致。
  const rawUserId = q.userId ? String(q.userId).trim() : '';
  if (rawUserId && !isObjectIdLike(rawUserId)) {
    throw new AppError(400, `用户 ID 不合法（收到「${shown(q.userId)}」，应为 24 位 ObjectId）`);
  }
  const userId = rawUserId ? String(new Types.ObjectId(rawUserId)) : '';

  // keyword 走「先查人、再按 userId 预筛」而不是 $lookup 之后 $match：
  // - 持卡人字段在 users 里，$lookup 之后的 $match 只能落在 $facet 的 rows 内（已 skip/limit），
  //   筛掉的空页没法用下一页补，total 也得再算一遍；
  // - 预筛在 $facet 之前，total 与分页都按同一条件走；
  // - 代价（有意为之）：用户文档缺失的卡行在「带 keyword」时查不到——它本来也没有昵称/UID 可匹配；
  //   不带 keyword 时这些行仍靠 preserveNullAndEmptyArrays 留在列表里（GR-6 同口径）。
  const keywordFilter = userKeywordFilter(q.keyword);
  const keywordUserIds = keywordFilter
    ? (await UserModel.find(keywordFilter).select({ _id: 1 }).lean()).map((u) => u._id)
    : null;

  const pipeline: PipelineStage[] = [
    // 10-27 之前写入的卡没有 source 字段，先补成 exchange 再筛，否则按来源筛选会漏掉全部老行
    { $addFields: { source: { $ifNull: ['$source', 'exchange'] } } },
  ];
  if (itemKey) pipeline.push({ $match: { itemKey } });
  if (source) pipeline.push({ $match: { source } });
  if (userId) pipeline.push({ $match: { userId: new Types.ObjectId(userId) } });
  // 空数组 = 关键词一个人都没命中 → $in: [] 让结果为空（不能把这条 $match 省掉）
  if (keywordUserIds) pipeline.push({ $match: { userId: { $in: keywordUserIds } } });
  pipeline.push(
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $facet: {
        total: [{ $count: 'n' }],
        rows: [
          { $skip: (p - 1) * ps }, { $limit: ps },
          // 集合名以库为准（实测 sport-track-dev：users / pointitems / pointcards，不是直觉复数形）
          { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'u' } },
          { $unwind: { path: '$u', preserveNullAndEmptyArrays: true } },
          { $lookup: { from: 'pointitems', localField: 'itemKey', foreignField: 'key', as: 'it' } },
          { $unwind: { path: '$it', preserveNullAndEmptyArrays: true } },
        ],
      },
    },
  );

  const [agg] = await PointCardModel.aggregate<{ total: { n: number }[]; rows: Record<string, any>[] }>(pipeline);
  const now = Date.now();
  const items: IssuanceRow[] = (agg?.rows ?? []).map((r) => {
    // 删号的用户保留卡行：用户列空着，但台账不能少行（与目录行的 preserveNullAndEmptyArrays 同口径）
    const status = cardStatus(r, now);
    return {
      id: String(r._id),
      userId: String(r.userId),
      // 存量行的 uid 在库里混着 int 与 string 两种 BSON 类型（实测 sport-track-dev），
      // 原样下发前端会拿到两种类型 → 一律 Number 归一；缺号（未补号用户）给 0
      uid: Number(r.u?.uid ?? 0),
      nickname: String(r.u?.nickname ?? ''),
      itemKey: String(r.itemKey ?? ''),
      itemName: String(r.it?.name ?? ''),
      source: r.source,
      sourceText: SOURCE_TEXT[r.source] ?? '',
      createdAt: Number(r.createdAt ?? 0),
      expiresAt: Number(r.expiresAt ?? 0),
      status,
      statusText: STATUS_TEXT[status],
      usedForDate: String(r.usedForDate ?? ''),
      activatedAt: Number(r.activatedAt ?? 0),
      benefitDays: Number(r.benefitDays ?? 0),
      grantedBy: String(r.grantedBy ?? ''),
      note: String(r.note ?? ''),
    };
  });

  return { total: agg?.total?.[0]?.n ?? 0, page: p, pageSize: ps, items };
}
