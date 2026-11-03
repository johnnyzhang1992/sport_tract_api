/**
 * 推送事件的业务处理（spec §7.2 发货、§7.4 iOS 问询、§7.5 退款）+ 懒查单兜底（§7.3）。
 *
 * 三条不可协商：
 * 1) 幂等钉在 CAS 与唯一索引上，不靠「先查再改」——推送会重试最多 15 次，且同一单可能并发到达；
 * 2) 陌生单与「处理不了」分开应答：前者回 0 吞掉（重试改变不了结果），后者回非 0 让微信重试。
 *    两类都留 lastError，任何一类都不许静默成功（付了钱没权益比收不到推送更糟）；
 * 3) iOS 问询的应答只读本地（3 秒预算内不许外部 HTTP），查不到就放过——宁可少赚，
 *    不因自己数据缺失去坑用户。
 *
 * 顺延的串行：区间起点在发货时算（max(now, 当前到期)），所以同一用户的多笔必须串行，
 * 否则两笔都读到同一个 until 会重叠、用户少拿一整段。用按 userId 串行的进程内单飞链兜住，
 * 残留风险＝多实例部署下两实例同时发货（当前 api 是单容器；真上多实例要换成 DB 级的
 * `{userId, delivering: true}` partial unique 抢占，本计划不做，但别以为是安全的）。
 */
import { Types } from 'mongoose';
import { XpayOrderModel } from '../models/xpay-order.model.js';
import { UserModel } from '../models/user.model.js';
import { createNotification } from './notification.js';
import { membershipUntilOf } from './entitlements.js';
import { xpayQueryOrder, XPAY_REFUND_SETTLED_STATUSES } from './xpay-api.js';
import { isObjectIdLike } from '../utils/object-id.js';
import { fmtCnDate, MEMBER_DELIVER_NOTICE, IOS_QUERY_EVIDENCE } from '../config/member-copy.js';
import type { NotifyResult } from '../routes/pay-notify.routes.js';

const DAY_MS = 86_400_000;
const QUERY_MIN_INTERVAL_MS = 60_000;
const QUERY_MAX_ATTEMPTS = 20;
const DELIVER_RETRY_ALERT_AT = 5;
const REFUND_COUNT_ALERT_AT = 5;

/** 按用户串行（同用户的多笔发货排队，不重叠） */
const chains = new Map<string, Promise<void>>();
function withinUserChain<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(userId) ?? Promise.resolve();
  // 前一笔无论成败都要放行下一笔（否则一次查库失败会把这个人之后的所有发货永久卡住）
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  chains.set(userId, tail);
  // 链尾还是自己就清键：Map 不该随用户数无限增长
  void tail.then(() => { if (chains.get(userId) === tail) chains.delete(userId); });
  return run;
}

function isDuplicateKey(e: unknown, field: string): boolean {
  const err = e as { code?: number; keyPattern?: Record<string, unknown> };
  return err?.code === 11000 && Boolean(err.keyPattern?.[field]);
}

/**
 * 发货：CAS 把 created/paid 翻成 delivered 并落区间快照。
 * 幂等：已经 delivered 的行不再重算区间、不再补通知。
 */
export async function deliverOrder(p: {
  outTradeNo: string;
  wxOrderId: string;
  paidAt?: number;
  channel?: string;
  /** 推送入口必须传 true：明文分支无来源证明，发货前先向微信复核已支付（见 handleXpayNotify） */
  verifyWithWechat?: boolean;
}): Promise<NotifyResult> {
  const row = await XpayOrderModel.findOne({ outTradeNo: p.outTradeNo }).lean();
  if (!row) {
    console.error(`[xpay] 陌生单推送（outTradeNo=${p.outTradeNo}, wxOrderId=${p.wxOrderId}）——需人工对账`);
    return { ok: true, dropNoRetry: true };
  }
  const userId = String(row.userId);
  return withinUserChain(userId, async () => {
    const fresh = await XpayOrderModel.findById(row._id).lean();
    if (!fresh) return { ok: true, dropNoRetry: true };
    if (fresh.status === 'delivered' || fresh.status === 'refunding' || fresh.status === 'refunded') {
      // 短路优化，不是幂等防线：真正的幂等由下面的 CAS（status ∈ created/paid）保证。
      // 留着它是为了 15 次重试时不再多查一遍会员到期、不再白算区间。
      return { ok: true };
    }
    if (fresh.wxOrderId && fresh.wxOrderId !== p.wxOrderId) {
      console.error(`[xpay] 同 outTradeNo 收到不同商户单号（${fresh.wxOrderId} vs ${p.wxOrderId}），交人工`);
      return { ok: true, dropNoRetry: true };
    }

    // 推送不可信（兼容模式明文分支没有来源证明，密文也只证明「包出自我们配置的 AESKey」，
    // 证明不了「这笔支付真发生过」）：发货前必须以微信查单为准。查询只带我方 outTradeNo
    // + 库内 openid，不把推送带来的 wxOrderId 传给微信——那是攻击者可控字段，不能当定位键。
    if (p.verifyWithWechat) {
      let verdict: Awaited<ReturnType<typeof xpayQueryOrder>>;
      try {
        verdict = await xpayQueryOrder({ openid: fresh.openid, outTradeNo: fresh.outTradeNo });
      } catch (e) {
        // 网络/网关失败：既没证实也没证伪，回非 0 让微信重试（真单稍后重推即可发出去）
        console.error(`[xpay] 发货复核查单失败（${fresh.outTradeNo}）：`, (e as Error).message);
        return { ok: false, errcode: 7, errmsg: 'paid-verify query failed' };
      }
      if (!verdict.paid) {
        console.error(`[xpay] 推送声称已支付但微信查单 status=${verdict.status}（${fresh.outTradeNo}）——拒绝发货（疑似伪造推送；真单的懒查单兜底不受影响）`);
        await XpayOrderModel.updateOne(
          { _id: row._id },
          { $set: { lastError: `查单复核未支付（status=${verdict.status}），拒绝发货` } },
        );
        return { ok: true, dropNoRetry: true };
      }
    }

    // 推送带来的 paid_at 不可信（伪造包可任意填），权益起点不许被 future-date 到未来
    const now = Math.min(Number(p.paidAt) > 0 ? Number(p.paidAt) : Date.now(), Date.now());
    const user = await UserModel.findById(userId).select('openid').lean();
    if (!user) {
      const attempts = (fresh.deliverAttempts ?? 0) + 1;
      await XpayOrderModel.updateOne(
        { _id: row._id },
        { $set: { deliverAttempts: attempts, lastError: `用户反查失败（openid=${fresh.openid}）` } },
      );
      if (attempts > DELIVER_RETRY_ALERT_AT) console.error(`[xpay] 发货重试超 ${DELIVER_RETRY_ALERT_AT} 次仍失败：${p.outTradeNo}`);
      return { ok: false, errcode: 1, errmsg: 'user not found' };
    }

    const prevUntil = await membershipUntilOf(userId);
    const periodStart = Math.max(now, prevUntil);
    const periodEnd = periodStart + fresh.durationDays * DAY_MS;
    if (!(periodEnd > periodStart)) {
      // 目录被改成 0 天之类的脏数据：区间算不出就是「处理不了」，要重试而不是假成功
      await XpayOrderModel.updateOne({ _id: row._id }, { $set: { lastError: `区间计算异常：${periodStart}/${periodEnd}` } });
      return { ok: false, errcode: 1, errmsg: 'bad period' };
    }

    // CAS：并发/重试里只有一次能翻动态，败者落到上面的幂等分支
    let updated;
    try {
      updated = await XpayOrderModel.updateOne(
        { _id: row._id, status: { $in: ['created', 'paid'] } },
        {
          $set: {
            status: 'delivered',
            wxOrderId: p.wxOrderId,
            periodStart,
            periodEnd,
            channel: p.channel ?? fresh.channel ?? '',
          },
        },
      );
    } catch (e) {
      if (isDuplicateKey(e, 'wxOrderId')) {
        console.error(`[xpay] wxOrderId 撞唯一键（${p.wxOrderId}）：同笔支付被挂到两个下单号，需人工对账`);
        await XpayOrderModel.updateOne({ _id: row._id }, { $set: { lastError: 'wxOrderId 重复' } });
        return { ok: true, dropNoRetry: true };
      }
      throw e;
    }
    if (updated.modifiedCount !== 1) {
      const after = await XpayOrderModel.findById(row._id).select('status').lean();
      return after?.status === 'delivered' ? { ok: true } : { ok: false, errcode: 1, errmsg: 'cas lost' };
    }

    // 到账通知：dedupeKey 让「发成功但没写 stamp」的失败窗口靠重试收敛成一条
    try {
      await createNotification({
        title: MEMBER_DELIVER_NOTICE.title,
        content: MEMBER_DELIVER_NOTICE.content(fresh.name, fmtCnDate(periodEnd)),
        published: true,
        userId,
      }, `xpay_deliver:${p.wxOrderId || p.outTradeNo}`);
      await XpayOrderModel.updateOne({ _id: row._id }, { $set: { notifiedAt: Date.now() } });
    } catch (e) {
      console.error(`[xpay] 到账通知未发出（钱与权益已成对，请按日志补发）outTradeNo=${p.outTradeNo}:`, (e as Error).message);
    }
    console.warn(`[xpay] 发货成功 ${p.outTradeNo} → ${fmtCnDate(periodStart)} 起 ${fresh.durationDays} 天`);
    return { ok: true };
  });
}

/**
 * 建议退款金额（只作预填，操作人可改；spec §7.5）。
 * 两个特例给全额：未发货（periodStart 为 0）与尚未生效的顺延单（periodStart > now）——都没有已消费的天数。
 */
export function suggestRefundFeeFen(p: {
  leftFeeFen: number;
  periodStart: number;
  periodEnd: number;
  now?: number;
}): number {
  const now = p.now ?? Date.now();
  if (p.periodStart <= 0 || p.periodStart > now) return p.leftFeeFen;
  const totalDays = Math.max(1, Math.round((p.periodEnd - p.periodStart) / DAY_MS));
  const remainDays = Math.max(0, Math.ceil((p.periodEnd - now) / DAY_MS));
  return Math.floor((p.leftFeeFen * remainDays) / totalDays);
}

/**
 * 退款落账（spec §7.5）：钱按 refundFee 累加，权益一律按时间截断，与金额解耦。
 * 幂等：同一 refundOrderId 只记一次（推送与轮询两条路都会到这里）。
 */
export async function applyRefund(p: {
  outTradeNo?: string;
  wxOrderId?: string;
  refundOrderId?: string;
  refundFeeFen: number;
  refundedAt?: number;
  reason?: string;
  /** 推送入口必须传 true：落账前先向微信复核「这单确实付过」（见 handleXpayNotify） */
  verifyWithWechat?: boolean;
}): Promise<NotifyResult> {
  const filter: Record<string, unknown> = p.outTradeNo ? { outTradeNo: p.outTradeNo } : { wxOrderId: p.wxOrderId };
  const row = await XpayOrderModel.findOne(filter).lean();
  if (!row) {
    console.error(`[xpay] 退款推送找不到订单（${JSON.stringify(filter)}）——需人工对账`);
    return { ok: true, dropNoRetry: true };
  }
  return withinUserChain(String(row.userId), async () => {
    const fee = Math.max(0, Math.round(Number(p.refundFeeFen) || 0));
    const at = Number(p.refundedAt) > 0 ? Number(p.refundedAt) : Date.now();
    const fresh = await XpayOrderModel.findById(row._id).lean();
    if (!fresh) return { ok: true, dropNoRetry: true };
    if (p.refundOrderId && fresh.refundOrderId === p.refundOrderId && (fresh.refundedAt ?? 0) > 0) {
      return { ok: true }; // 重复通知：已经回收过
    }
    // 与发货同一条纪律：退款推送同样不可信，落账前以微信查单复核「这单确实付过」。
    // 只核对支付状态、不再交叉核对退款金额（金额语义与 left_fee 的关系以真单实测定为准，spec §12）——
    // 伪造最多触发「拒落账」，真退款推送重试即可收敛。
    if (p.verifyWithWechat) {
      let verdict: Awaited<ReturnType<typeof xpayQueryOrder>>;
      try {
        verdict = await xpayQueryOrder({ openid: fresh.openid, outTradeNo: fresh.outTradeNo, wxOrderId: fresh.wxOrderId || undefined });
      } catch (e) {
        console.error(`[xpay] 退款复核查单失败（${fresh.outTradeNo}）：`, (e as Error).message);
        return { ok: false, errcode: 7, errmsg: 'paid-verify query failed' };
      }
      if (!verdict.paid && !XPAY_REFUND_SETTLED_STATUSES.has(verdict.status)) {
        // 已退款（5）/用户退款完成（8）的单，重复/迟到的退款推送也要能落账对齐，不算伪造
        console.error(`[xpay] 退款推送但微信查单 status=${verdict.status}（${fresh.outTradeNo}）——拒绝落账（疑似伪造推送）`);
        await XpayOrderModel.updateOne(
          { _id: row._id },
          { $set: { lastError: `退款复核未支付（status=${verdict.status}），拒绝落账` } },
        );
        return { ok: true, dropNoRetry: true };
      }
    }
    if (fee <= 0) {
      await XpayOrderModel.updateOne({ _id: row._id }, { $set: { lastError: `退款通知金额非法：${p.refundFeeFen}` } });
      console.error(`[xpay] 退款金额 0 或缺失（${fresh.outTradeNo}），不改账等人工`);
      return { ok: true, dropNoRetry: true };
    }
    const refundedFen = Math.min(fresh.priceFen, (fresh.refundedFen ?? 0) + fee);
    const full = refundedFen >= fresh.priceFen;
    // 权益截断：收到退款受理时刻（不超过该单的终点）。
    // 「尚未生效的顺延单」不在这里特殊处理——由 entitlements.effectiveEnd 的
    // `truncatedAt <= periodStart → 0` 一处统一判掉（只留一个真相，避免两层各压一半）。
    const truncateAt = fresh.periodStart > 0 ? Math.max(fresh.truncatedAt ?? 0, Math.min(at, fresh.periodEnd)) : 0;
    const set: Record<string, unknown> = {
      status: full ? 'refunded' : 'delivered',
      refundedFen,
      refundedAt: at,
      refundCount: (fresh.refundCount ?? 0) + 1,
      refundReason: p.reason ?? fresh.refundReason ?? '',
      ...(p.refundOrderId ? { refundOrderId: p.refundOrderId } : {}),
      ...(truncateAt > 0 ? { truncatedAt: truncateAt } : {}),
    };
    await XpayOrderModel.updateOne({ _id: row._id }, { $set: set });
    if ((fresh.refundCount ?? 0) + 1 > REFUND_COUNT_ALERT_AT) {
      console.error(`[xpay] 同笔订单部分退款已 ${(fresh.refundCount ?? 0) + 1} 次（${fresh.outTradeNo}），xpay 真实上限待核，先告警自保`);
    }
    console.warn(`[xpay] 退款落账 ${fresh.outTradeNo}：本次 ${fee} 分，累计 ${refundedFen}/${fresh.priceFen}，${full ? '整单退清' : '部分退款仍 delivered'}`);
    return { ok: true };
  });
}

/** iOS 退款问询应答（spec §7.4 四档，纯本地） */
export async function answerIosRefundQuery(payload: Record<string, unknown>): Promise<{ result_code: 0 | 1; evidence: string }> {
  const outTradeNo = String(payload.out_trade_no ?? payload.outTradeNo ?? '');
  const row = outTradeNo ? await XpayOrderModel.findOne({ outTradeNo }).lean() : null;
  if (!row) {
    console.warn(`[xpay] iOS 问询查不到订单（${outTradeNo || '空单号'}），按放过处理`);
    return { result_code: 0, evidence: IOS_QUERY_EVIDENCE.notFound };
  }
  const scheduled = row.status !== 'created' && row.status !== 'paid' && row.periodStart > 0;
  if (!scheduled) return { result_code: 0, evidence: IOS_QUERY_EVIDENCE.notDelivered };
  const now = Date.now();
  if (row.periodStart > now) return { result_code: 0, evidence: IOS_QUERY_EVIDENCE.notStarted };
  const usedDays = Math.max(0, Math.floor((now - row.periodStart) / DAY_MS));
  const totalDays = Math.max(1, Math.round((row.periodEnd - row.periodStart) / DAY_MS));
  if (usedDays <= 1) return { result_code: 0, evidence: IOS_QUERY_EVIDENCE.lightUse(usedDays, totalDays) };
  return { result_code: 1, evidence: IOS_QUERY_EVIDENCE.refuse(usedDays, totalDays) };
}

/** 推送分流表的实现（pay-notify.routes.ts 注册它） */
export async function handleXpayNotify(event: string, payload: Record<string, unknown>): Promise<NotifyResult> {
  // ⚠ 推送入口是唯一不可信的发货/退款触发点：兼容模式的明文分支没有任何来源证明，
  //   伪造者可对「自己刚建单未支付」的订单推送 deliver_notify 白拿会员。所以两条资金事件都带
  //   verifyWithWechat，发货/落账前先向微信复核支付状态；代价＝每次推送多一笔 query_order
  //   （推送量＝支付量，可忽略）。懒查单/管理端路径刚查过单，不带此开关、零额外开销。
  const wp = (payload.WeChatPayInfo ?? {}) as Record<string, unknown>;
  if (event === 'xpay_goods_deliver_notify') {
    const outTradeNo = String(payload.out_trade_no ?? payload.OutTradeNo ?? payload.attach ?? '');
    const wxOrderId = String(wp.MchOrderNo ?? payload.wx_order_id ?? payload.order_id ?? '');
    if (!outTradeNo || !wxOrderId) {
      console.error(`[xpay] 发货推送缺关键字段（out_trade_no=${outTradeNo || '空'} wxOrderId=${wxOrderId || '空'}），丢弃并留痕：${JSON.stringify(Object.keys(payload))}`);
      return { ok: true, dropNoRetry: true };
    }
    return deliverOrder({
      outTradeNo,
      wxOrderId,
      paidAt: Number(wp.paid_dt ?? wp.PaidTime ?? payload.pay_time ?? 0) || undefined,
      channel: payload.platform === 'ios' ? 'ios' : payload.platform === 'android' ? 'android' : undefined,
      verifyWithWechat: true,
    });
  }
  if (event === 'xpay_refund_notify') {
    return applyRefund({
      outTradeNo: String(payload.out_trade_no ?? payload.OutTradeNo ?? '') || undefined,
      wxOrderId: String(wp.MchOrderNo ?? payload.wx_order_id ?? payload.order_id ?? '') || undefined,
      refundOrderId: String(payload.refund_id ?? payload.RefundId ?? '') || undefined,
      refundFeeFen: Number(payload.refund_fee ?? payload.RefundFee ?? 0),
      refundedAt: Number(payload.refund_succ_time ?? wp.refund_succ_time ?? payload.succ_time ?? 0) || undefined,
      reason: String(payload.reason ?? payload.refund_reason ?? '') || undefined,
      verifyWithWechat: true,
    });
  }
  if (event === 'xpay_subscribe_ios_refund_query_notify') {
    const a = await answerIosRefundQuery(payload);
    return { ok: true, iosAnswer: a };
  }
  if (event === 'xpay_complaint_notify') {
    // 本期只留痕，后台投诉列表延后（见计划「两处范围裁定」第 2 条）
    console.warn('[xpay] 收到投诉事件（仅记录，后台列表二期）：', JSON.stringify(payload).slice(0, 500));
    return { ok: true, dropNoRetry: true };
  }
  return { ok: true, dropNoRetry: true };
}

/**
 * 懒查单（spec §7.3，容器里没有 cron）：进会员页时对本人的 created/paid 单补查一次。
 * 限频 60s、单次最多 3 条、超 20 次转 closed。
 */
export async function lazySyncOrders(userId: string, now = Date.now()): Promise<number> {
  if (!isObjectIdLike(userId)) return 0;
  const rows = await XpayOrderModel.find({
    userId: new Types.ObjectId(userId),
    status: { $in: ['created', 'paid'] },
    $or: [{ lastQueryAt: 0 }, { lastQueryAt: { $lte: now - QUERY_MIN_INTERVAL_MS } }],
  }).sort({ createdAt: -1 }).limit(3).lean();

  let delivered = 0;
  for (const row of rows) {
    const attempts = (row.queryAttempts ?? 0) + 1;
    await XpayOrderModel.updateOne({ _id: row._id }, { $set: { lastQueryAt: now, queryAttempts: attempts } });
    try {
      const r = await xpayQueryOrder({ openid: row.openid, outTradeNo: row.outTradeNo, wxOrderId: row.wxOrderId || undefined });
      if (r.leftFeeFen > 0 || r.paid) {
        await XpayOrderModel.updateOne(
          { _id: row._id },
          { $set: { leftFeeFen: r.leftFeeFen, leftFeeAt: Date.now(), ...(r.wxOrderId ? { wxOrderId: r.wxOrderId } : {}) } },
        );
      }
      if (r.paid) {
        const res = await deliverOrder({ outTradeNo: row.outTradeNo, wxOrderId: r.wxOrderId || row.wxOrderId || `q_${row.outTradeNo}` });
        if (res.ok) delivered += 1;
      }
    } catch (e) {
      const msg = (e as Error).message.slice(0, 200);
      await XpayOrderModel.updateOne({ _id: row._id }, { $set: { lastError: msg } });
      if (attempts >= QUERY_MAX_ATTEMPTS) {
        await XpayOrderModel.updateOne(
          { _id: row._id, status: { $in: ['created', 'paid'] } },
          { $set: { status: 'closed', lastError: `查单 ${attempts} 次仍无结果：${msg}` } },
        );
        console.error(`[xpay] 订单 ${row.outTradeNo} 查单超上限，转 closed——需人工确认用户是否已付款`);
      }
    }
  }
  return delivered;
}

/** 后台触发：不等它、也不因它失败（与 scheduleLazySettle 同一条口径） */
export function scheduleLazySync(userId: string): void {
  if (!userId) return;
  void lazySyncOrders(userId).catch((e) => console.warn('[xpay] 懒查单失败（不影响页面）:', (e as Error).message));
}
