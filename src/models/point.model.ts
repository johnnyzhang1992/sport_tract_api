import mongoose from 'mongoose';
const { Schema, model, models } = mongoose;

const accountSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, unique: true, index: true },
  balance: { type: Number, default: 0, min: 0 },
  totalEarned: { type: Number, default: 0 },
  totalSpent: { type: Number, default: 0 },
}, { timestamps: true, versionKey: false });

const recordSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  type: { type: String, required: true },
  title: { type: String, required: true },
  delta: { type: Number, required: true },
  balanceAfter: { type: Number, required: true },
  bizDate: { type: String, required: true },
  refType: { type: String, default: '' },
  refId: { type: String, default: '' },
  idemKey: { type: String, required: true, unique: true },
  expireAt: { type: Number, default: null },
  createdAt: { type: Number, required: true },
}, { versionKey: false });
recordSchema.index({ userId: 1, createdAt: -1 });
// 积分页今日剩余（points-items.listActiveItems）：兑换台账聚合 {type,refType,bizDate,refId $in}。
// 键序是这里选定的规范形状（等值 type/refType/bizDate 做前缀，$in 的 refId 收尾），不是 Mongo 硬要求：
// $in 也能按等值绑定，换序仍可能走 IXSCAN；guard-index 按这个 exact 键组合认，换序即判失效。
// 没有这条索引，每次积分页加载都全表扫整个积分台账（COLLSCAN，随账本增长无限放大）。
recordSchema.index({ type: 1, refType: 1, bizDate: 1, refId: 1 });

const lotSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  recordId: { type: Schema.Types.ObjectId, required: true },
  earned: { type: Number, required: true },
  remaining: { type: Number, required: true, min: 0 },
  earnedAt: { type: Number, required: true },
  expireAt: { type: Number, required: true },
}, { versionKey: false });
lotSchema.index({ userId: 1, expireAt: 1 });

const signinSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  dateKey: { type: String, required: true },
  streakDay: { type: Number, required: true },
  points: { type: Number, required: true },
  source: { type: String, enum: ['sign', 'makeup'], required: true },
  createdAt: { type: Number, required: true },
}, { versionKey: false });
signinSchema.index({ userId: 1, dateKey: 1 }, { unique: true });

const taskSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  taskKey: { type: String, required: true },
  periodKey: { type: String, required: true },
  status: { type: String, enum: ['claimed'], default: 'claimed' },
  points: { type: Number, required: true },
  claimedAt: { type: Number, required: true },
}, { versionKey: false });
taskSchema.index({ userId: 1, taskKey: 1, periodKey: 1 }, { unique: true });

const cardSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  itemKey: { type: String, default: 'makeup_card' },
  status: { type: String, enum: ['unused', 'used', 'expired'], default: 'unused' },
  expiresAt: { type: Number, required: true },
  usedForDate: { type: String, default: '' },
  createdAt: { type: Number, required: true },
  source: { type: String, enum: ['exchange', 'admin', 'system'], default: 'exchange' },
  grantedBy: { type: String, default: '' },
  note: { type: String, default: '' },
  activatedAt: { type: Number, default: 0 },
  benefitDays: { type: Number, default: 0 },
}, { versionKey: false });
cardSchema.index({ userId: 1, status: 1, expiresAt: 1 });
// 导出免广告名单：按道具 + 已激活扫全表，避免 {status,benefitDays} 组合走错索引
cardSchema.index({ itemKey: 1, status: 1, activatedAt: 1 });

const exchangeSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  itemKey: { type: String, required: true },
  cost: { type: Number, required: true },
  cardId: { type: Schema.Types.ObjectId, required: true },
  requestId: { type: String, required: true },
  createdAt: { type: Number, required: true },
}, { versionKey: false });
exchangeSchema.index({ userId: 1, requestId: 1 }, { unique: true });

/**
 * 实物订单状态机：pending_ship → shipped → completed（无取消/退分）。
 * 文案与顺序只写这一份，service 的 ORDER_STATUS 也从这里再导出，避免两处各写一张表。
 */
export const ORDER_STATUS = ['pending_ship', 'shipped', 'completed'] as const;
export type OrderStatus = typeof ORDER_STATUS[number];

/**
 * 实物兑换订单：虚拟道具不会写这张表（兑换只发 PointCard）。
 * itemName / cost / address 都是下单快照（后台改目录名/价格、用户改默认地址都不追认）。
 * (userId, requestId) 唯一：与虚拟兑换共用同一个客户端幂等键空间，并发同键只落一张。
 */
const orderSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  itemKey: { type: String, required: true },
  itemName: { type: String, required: true },
  cost: { type: Number, required: true },
  address: {
    receiver: { type: String, required: true },
    phone: { type: String, required: true },
    detail: { type: String, required: true },
  },
  status: { type: String, enum: ORDER_STATUS, default: 'pending_ship' },
  trackingNo: { type: String, default: '' },
  trackingCompany: { type: String, default: '' },
  shippedAt: { type: Number, default: 0 },
  shippedBy: { type: String, default: '' },
  completedAt: { type: Number, default: 0 },
  requestId: { type: String, required: true },
  createdAt: { type: Number, required: true },
  updatedAt: { type: Number, required: true },
}, { versionKey: false });
orderSchema.index({ userId: 1, requestId: 1 }, { unique: true });
orderSchema.index({ status: 1, createdAt: -1 });

/** 每日已入账计数器：DAILY_CAP 的原子闸门（$inc 预占 + 超限退回），替代聚合 check-then-act */
const dailySchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  bizDate: { type: String, required: true },
  earned: { type: Number, required: true, min: 0 },
}, { versionKey: false });
dailySchema.index({ userId: 1, bizDate: 1 }, { unique: true });

/**
 * 每日投放计数器：dailyQuota（当日全平台投放）与 perUserDaily（每人每日上限）的原子闸门（Task 3）。
 * 行按 { key, dateKey, userId } 定位，userId 为空串＝「当日总量」行，其余＝该用户当日个人行。
 * 为什么不用兑换台账计数（展示字段 todayLeft 的数据源）：闸门要「先占额度、条件不中即拒绝、失败还能原子回退」，
 * count 只能查不能扣——所以强制口径走这里的条件 $inc，展示口径留在台账（裁定 2），两侧一致性由测试钉住。
 * dateKey 一律由调用链的 `now` 经 bjDateStr 派生，不在闸门里现取 Date.now()（裁定 3，防跨 UTC+8 零点错位）。
 */
const dailyQuotaSchema = new Schema({
  key: { type: String, required: true },
  dateKey: { type: String, required: true },
  // 空串＝平台总量行。不写 required：String 的 required 会把 '' 判成「未填」（mongoose 的空值口径），
  // 总量行恰恰要的是 ''；default '' 兜住「没表态就是总量行」的读法，闸门写入一律显式带上 userId。
  userId: { type: String, default: '' },
  count: { type: Number, required: true, default: 0, min: 0 },
}, { versionKey: false });
// unique 是正确性防线不是性能索引：ensureQuotaRow 用 upsert 建基线，两个并发首次都 miss 查询时
// 靠这条唯一索引让败者撞 E11000 退化；没有它基线行会插成多份，条件 $inc 只守得住其中一份。
dailyQuotaSchema.index({ key: 1, dateKey: 1, userId: 1 }, { unique: true });

/**
 * 道具目录：一条 = 一种可兑换/可发放的道具。
 * 价格与有效期以前写死在 points-items.ts + config/points.ts，落库后那两个常量退化为种子值。
 */
/**
 * effect.kind 的唯一口径：schema 的 enum 和管理端 assertItemInput 都从这一份读，
 * 免得两处各写各的——入参越界的 kind 若在 service 放行，落到 schema 就是 Mongoose
 * ValidationError（非 AppError、非 11000），error-handler 只会回 500 + 内部原文。
 */
export const ITEM_EFFECT_KINDS = ['makeup', 'ad_free'] as const;
export type ItemEffectKind = typeof ITEM_EFFECT_KINDS[number];

/**
 * 道具类型：virtual = 权益/卡（兑换即发 PointCard），physical = 实物（兑换落订单 + 收货地址）。
 * 同样只写这一份：schema 的 enum 与管理端 assertItemInput 都读它，越界才能回 400 而不是 500。
 * default 'virtual' 只对「新建且没表态」生效；存量行物理上没有这个字段，读取侧一律按 virtual 兜底。
 */
export const ITEM_KINDS = ['virtual', 'physical'] as const;
export type ItemKind = typeof ITEM_KINDS[number];

const itemSchema = new Schema({
  key: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  subtitle: { type: String, default: '' },
  description: { type: String, default: '' },
  notes: { type: [String], default: [] },
  price: { type: Number, required: true, min: 1 },
  validDays: { type: Number, required: true, min: 1 },
  kind: { type: String, enum: ITEM_KINDS, default: 'virtual' },
  effect: {
    kind: { type: String, enum: ITEM_EFFECT_KINDS, required: true },
    days: { type: Number, default: 0, min: 0 },
  },
  stock: { type: Number, default: 9999, min: 0 },
  unlimited: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
  image: { type: String, default: '' },
  // 实物详情图：存裸链（签名在读取时现签），条数上限 schema 表达不了，由 assertItemInput 拦
  detailImages: { type: [String], default: [] },
  // 每人限购：0 = 不限。实物「未表态」时由 createItem 落 1；这里只兜住负数（范围/整数在 service 校验）
  perUserLimit: { type: Number, default: 0, min: 0 },
  // 每日投放（2026-10-28 榜单发积分同批）：0＝不限；>0＝每个东八区自然日最多兑 N 张，先到先得
  dailyQuota: { type: Number, default: 0, min: 0 },
  // 每人每日上限：0＝不限。没有这条，一个人能把当日额度扫光
  perUserDaily: { type: Number, default: 0, min: 0 },
}, { timestamps: true, versionKey: false });

/**
 * 榜单发放台账（boardsettlements，Task 6）：「某个榜 · 某一期 · 某个人」这笔奖励发过没有的唯一事实源。
 *
 * 为什么必须落库而不能靠调用方判重：发放是**懒结算**（Task 9 挂在积分页/榜单页入口上），
 * 一期会被无数次请求重新触发，还会在两台设备／两个标签页里同时触发。应用层「先查再插」
 * 永远有并发窗口，而积分是真金白银——双发就是资损，且不会有任何报错。
 * 所以幂等钉在 {type,period,periodKey,userId} 这条唯一索引上（与 PointDailyQuota / campaignmembers 同一条教训）。
 *
 * status 四态（'pending' 是 Task 7 抢锁方案的中间态：先落 pending 行占住键，再翻成 credited）：
 * - pending：锁已持有、发放尚未确认。**默认值**——裸 create 忘了表态时落在这一态，
 *   宁可「没发出去」也不能默认「已发过」（方向相反的默认值会把没付款的行了结掉）。
 * - credited：已发放，recordId 指向 pointrecords 那笔流水。
 * - skipped：**只用于整榜级占位行**（人数门槛没过 / 已完成结算的完成标记），一行都不代表某个人的奖励，
 *   永远不发分、永远不可撤回；reason 用下面的常量前缀区分两类（占位是为了别再重算——发分口径
 *   一榜一个 aggregate、一期 8 个榜，每次页面浏览都重算一遍）。
 * - revoked：运营撤回（Task 10）。**不删行**：唯一键继续占位，撤回才是终态，
 *   否则下一次懒结算会把这笔钱原路再发一遍（撤回等于没撤）。
 *
 * 整榜级行用哨兵 userId（12 个 0，Mongo 永不生成这个 id）而不是 null／缺字段：
 * userId 保持 required，才能挡住「发给不存在的用户」这种发放行；同时沿用同一条唯一键，
 * 天然保证「一个榜一期只有一条占位行」。
 */
export const BOARD_SETTLEMENT_STATUSES = ['pending', 'credited', 'skipped', 'revoked'] as const;
export type BoardSettlementStatus = typeof BOARD_SETTLEMENT_STATUSES[number];

/**
 * 榜单周期：与 services/points-board.ts 的 BoardPeriod 同一份口径。
 * 这里不 import 那个类型——models 反向依赖 services 会形成循环导入（points-board.ts 要引本文件），
 * 所以字面量在本文件写一份，由 test/points-board.test.ts BS-6 的**编译期双向可赋值断言**钉住不漂移
 * （改任意一边、另一边没跟上，typecheck 直接红）。
 */
export const BOARD_SETTLEMENT_PERIODS = ['week', 'month', 'year'] as const;
export type BoardSettlementPeriod = typeof BOARD_SETTLEMENT_PERIODS[number];

/** 整榜级（skipped）行的哨兵 userId：不属于任何真人，见上面注释 */
export const BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID = '000000000000000000000000';

/**
 * 整榜级占位行（status='skipped'）的两类 reason **前缀常量**（Task 10 评审强制项）。
 *
 * 为什么是「常量前缀 + 谓词」而不是「自由文本」：settlePeriod 会写两种 status='skipped' 的行
 * ——人数门槛没过的占位、以及一个单元全部落定后的完成标记（都是**缓存**，见 points-board.ts）。
 * 只靠中文描述区分，台账页与撤回面稍一改文案就把占位当发放行：占位行 points=0、没有流水凭据，
 * 一旦被当成一笔奖励去撤回，轻则空转（0 分流水），重则把哨兵 userId 当收件人给用户发通知。
 * 所以：写侧只能用这两个常量起头（points-board.ts 的 thresholdSkipReason / markBoardSettled），
 * 读侧用下面的谓词判定，**不许**再出现 `reason.includes('人数')` 这种匹配。
 *
 * 前缀是人读得起眼的中文（后台台账页要直接展示 reason），机器判定靠 startsWith 而不是全文匹配。
 */
export const BOARD_SETTLEMENT_THRESHOLD_SKIP_REASON_PREFIX = '【门槛未过】';
export const BOARD_SETTLEMENT_SETTLED_MARKER_REASON_PREFIX = '【已完成结算】';

/** 谓词的入参形状：lean 读回来的台账行（字段可能是 ObjectId、字符串或缺失） */
type LedgerRowLike = { userId?: unknown; status?: string; reason?: string } | null | undefined;

/**
 * 结构判定（优先级高于 reason 文本）：这一行是不是「整榜级占位行」。
 * 判据＝哨兵 userId **且** status='skipped'——两个都来自 settlePeriod 的写路径，
 * 真人发放行的 userId 永远是真 ObjectId（required 闸门 + 12 个 0 这个 id Mongo 不会生成）。
 * reason 认不出常量的历史行/异类行也从这里被判成整榜级：宁可少给一张撤回按钮，不可把占位当钱。
 */
export function isBoardLevelRow(row: LedgerRowLike): boolean {
  if (!row) return false;
  return String(row.userId ?? '') === BOARD_SETTLEMENT_BOARD_LEVEL_USER_ID && row.status === 'skipped';
}

/** 门槛占位行（参与人数没过大门槛，本期整榜不发） */
export function isThresholdSkip(row: LedgerRowLike): boolean {
  return isBoardLevelRow(row) && String(row!.reason ?? '').startsWith(BOARD_SETTLEMENT_THRESHOLD_SKIP_REASON_PREFIX);
}

/** 完成标记行（这一期已经全部落定，有效期内不重扫；不是判决，过期会重评补发迟到者） */
export function isSettledMarker(row: LedgerRowLike): boolean {
  return isBoardLevelRow(row) && String(row!.reason ?? '').startsWith(BOARD_SETTLEMENT_SETTLED_MARKER_REASON_PREFIX);
}

const boardSettlementSchema = new Schema({
  /** 榜单的运动类型（ACTIVITY_TYPES 里的值）。不在这里 enum：那份表在 config/constants.ts，
   * 抄第二份就会漂移（PB-10 同一条纪律）；测试夹具用 t_ 前缀的假类型也才写得进来。 */
  type: { type: String, required: true },
  period: { type: String, enum: BOARD_SETTLEMENT_PERIODS, required: true },
  /**
   * 周＝该周周一 '2026-10-19'，月＝'2026-10'，年＝'2026'（Task 7 的 boardLabel/boardPeriodTag 认这个形态）。
   * 格式不在这里做正则校验：流水标题还要用 8 位紧凑形态（'20261019周'，用户 2026-10-28 指定），
   * 把正则写死在 schema 上会把两种形态混为一谈，派生规则归 Task 7 的周期工具。
   * 但它**是幂等的一部分**：同一期若被两条代码路径拼成两种写法（'2026-10-19' vs '20261019'），
   * 唯一键会当成两个不同的键 → 同一人同期同榜发两遍。所以派生只许有一处，新增入口必须复用它。
   */
  periodKey: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId, required: true },
  /** 竞赛排名（并列同名次）；0 只用于整榜级 skipped 行 */
  rank: { type: Number, required: true, min: 0 },
  /** 本笔发放的分值；0 只用于整榜级 skipped 行 */
  points: { type: Number, required: true, min: 0 },
  status: { type: String, enum: BOARD_SETTLEMENT_STATUSES, default: 'pending' },
  /**
   * 原因（后台台账页与对账要看）：
   * - status='skipped' → 上面两个常量前缀之一（门槛占位 / 完成标记），**不是发放记录**；
   * - status='revoked' → 后台撤回时填的备注原文（会一并出现在用户收到的通知里）。
   */
  reason: { type: String, default: '' },
  /** 对应的 pointrecords 流水 _id：Task 10 撤回时按它反向冲销；撤回后**不清空**（审计链留全） */
  recordId: { type: Schema.Types.ObjectId, default: null },
  /** 撤回留痕：操作人（admin 的 _id/username）与时刻。反向流水按 idemKey 反查得到，不另存字段 */
  revokedBy: { type: String, default: '' },
  revokedAt: { type: Number, default: 0 },
}, { timestamps: true, versionKey: false });

// unique 是**正确性防线**不是性能索引：一期 8 个榜的懒结算会被反复、并发地触发，
// 两个并发请求同时_miss 查询时靠这条唯一索引让败者撞 E11000 退回「安静跳过」。
// 删了它的症状：同一笔榜单奖励发两遍（资损）且不报错，台账多出一行，
// claimBoardSettlement 的败者分支同时变成死代码（与上面 PointDailyQuota 同一条教训）。
// 键序 {type,period,periodKey,userId}＝brief 钉死的形状：唯一性约束与键序无关，但 Task 7 的
// 读路径按 {type,period,periodKey} 前缀捞的是**某一个具体榜单**（8 个类型之一）这一期的行——
// 那里头只有真人发放行；整榜级占位行（门槛/完成标记）的键是哨兵 userId，由 isBoardLevelRow /
// isBoardSettlementSkipped 单独认，不属于任何人的发放台账（Task 10 的列表与撤回都据它排除）。
boardSettlementSchema.index({ type: 1, period: 1, periodKey: 1, userId: 1 }, { unique: true });

/**
 * 管理端台账列表的读索引（Task 10）：`{period, periodKey, status, type, userId}` 等值前缀。
 * 为什么不是复用上面那条唯一索引：它的前缀是 **type**，后台的主路径是「按周期单元看这一期」
 * （period + periodKey，八张榜一起列出来对账），type 缺席时唯一索引帮不上忙——Task 6 评审
 * 点名的 `{period, status}` 读路径就是这个缺口。
 * 键序（等值在前、按筛选频率递降）：period（周期档）→ periodKey（具体哪一期）→ status
 * （默认视图 = 三个发放态 $in / 显式 skipped = 整榜级行）→ type → userId。
 * 覆盖（等值前缀**必须连续**，只数能接上键序的那些）：period｜period+periodKey｜
 * period+periodKey+status｜再 +type｜再 +userId —— 这五条走满索引。
 * 修复轮 1 更正（原来写「覆盖 period｜period+periodKey｜+status…」被读成评审点名的 `{period, status}`
 * 也整条覆盖，是过头话）：`{period, status}` 缺了中间的 periodKey ⇒ 只有 **period** 这一段算前缀，
 * `status` 退化成键上的附加过滤（扫该 period 全部键再筛），不是 COLLSCAN，但也不叫"覆盖"。
 * 服务层因此强制 periodKey 与 period 同传（AB-8 钉那条 400），主路径不落进这个残差形状。
 * 不覆盖（走 _id 索引 + 残差过滤，**不是**集合扫描）：只给 userId 或什么都不给的默认翻页。
 * 排序另走 _id（落库顺序＝结算顺序），与本索引无关——列表默认按 _id 倒序翻页，稳定不跳行。
 */
boardSettlementSchema.index({ period: 1, periodKey: 1, status: 1, type: 1, userId: 1 });

export type BoardSettlement = mongoose.InferSchemaType<typeof boardSettlementSchema>;

export const PointAccountModel = models.PointAccount ?? model('PointAccount', accountSchema);
export const PointRecordModel = models.PointRecord ?? model('PointRecord', recordSchema);
export const PointLotModel = models.PointLot ?? model('PointLot', lotSchema);
export const PointSigninModel = models.PointSignin ?? model('PointSignin', signinSchema);
export const PointTaskModel = models.PointTask ?? model('PointTask', taskSchema);
export const PointCardModel = models.PointCard ?? model('PointCard', cardSchema);
export const PointExchangeModel = models.PointExchange ?? model('PointExchange', exchangeSchema);
export const PointOrderModel = models.PointOrder ?? model('PointOrder', orderSchema);
export const PointDailyModel = models.PointDaily ?? model('PointDaily', dailySchema);
export const PointDailyQuotaModel = models.PointDailyQuota ?? model('PointDailyQuota', dailyQuotaSchema);
export const PointItemModel = models.PointItem ?? model('PointItem', itemSchema);
export const BoardSettlementModel = models.BoardSettlement ?? model('BoardSettlement', boardSettlementSchema);
