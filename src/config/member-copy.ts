/**
 * 会员域的用户可见文案（唯一真值）。
 *
 * 文本于 2026-11-03 逐条批准并冻结（编号见
 * `sport_track_miniapp/docs/superpowers/plans/2026-11-03-virtual-pay-membership-copy.md`）。
 * 实现逐字采用：不许改写、不许合并句子、不许补免责语；数字/日期一律在这里插值，
 * 端上不做换算也不拼句。
 */
import { BJ_OFFSET_MS } from '../utils/bj-time.js';

/** 会员期间的照片上限（D1 拍板 300；商品目录里的 perks.photoQuota 才是每档实际值，这里只用于文案） */
export const MEMBER_PHOTO_QUOTA = 300;

/** MC-14：非会员请求多条轨迹打包 */
export const GPX_BUNDLE_MEMBER_REQUIRED = '多条轨迹打包导出需要开通会员';

/** MC-15 / MC-15b：照片额度已满（会员与非会员是两句：对会员说「开通会员」是废话） */
export function photoQuotaFullMessage(used: number, limit: number, isMember: boolean): string {
  return isMember
    ? `照片额度已满（已用 ${used}/${limit} 张，已是会员上限），删除部分照片后继续上传`
    : `照片额度已满（已用 ${used}/${limit} 张），开通会员可提升到 ${MEMBER_PHOTO_QUOTA} 张，或删除部分照片后继续上传`;
}

/** 中文日期（与批准稿里的示例同形：2026年12月3日） */
export function fmtCnDate(ms: number): string {
  const d = new Date(ms + BJ_OFFSET_MS);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

/** MC-19：总开关关闭；下单侧「密钥未就绪」复用同一句（对用户而言就是「还没开放」） */
export const MEMBER_CLOSED = '会员购买暂未开放';

/** MC-20：wx.login 换出的 openid 与登录账号不一致 */
export const ORDER_IDENTITY_MISMATCH = '微信身份与当前账号不一致，请重新进入会员页';

/** MC-9b：缺 code / 会话过期（同一条用户动作：重进会员页再来） */
export const ORDER_SESSION_EXPIRED = '登录已过期，请重新进入会员页后再购买';

/** MC-21：档位已下架 */
export const ORDER_PRODUCT_UNAVAILABLE = '该档位已下架，请刷新后重新选择';

/** MC-2 / MC-3 / MC-6 相关：档位卡文案 */
export const MEMBER_PRODUCT_COPY = {
  price: (fen: number) => `${(fen / 100).toFixed(2)} 元`,
  perDay: (fen: number, days: number) => `约 ${(fen / 100 / days).toFixed(2)} 元/天`,
  duration: (days: number) => `${days} 天`,
  /** MC-3 四行（第四行本期只是个权益名：订阅开关在第二份计划里做，不得写成「可开启」） */
  perkLines: (photoQuota: number) => [
    '免广告',
    '多条轨迹打包导出 GPX',
    `照片额度 ${photoQuota > 0 ? photoQuota : MEMBER_PHOTO_QUOTA} 张`,
    '订阅消息提醒',
  ],
};

/**
 * MC-4 / MC-5：状态行。
 * 从没开通过（memberUntil＝0）返回空串——端上整行不显示；写成「已到期」会冤枉新用户。
 */
export function memberStatusText(e: { memberActive: boolean; memberUntil: number }, _now = Date.now()): string {
  if (e.memberUntil <= 0) return '';
  return e.memberActive
    ? `会员生效中 · 有效期至 ${fmtCnDate(e.memberUntil)}`
    : `会员已到期 · ${fmtCnDate(e.memberUntil)}到期`;
}

/** MC-12：「我的」入口右侧副标题 */
export function memberEntryHint(e: { memberActive: boolean; memberUntil: number }): string {
  if (e.memberUntil <= 0) return '未开通';
  return `${fmtCnDate(e.memberUntil)}到期`;
}

/** MC-16：会员到账的定向通知 */
export const MEMBER_DELIVER_NOTICE = {
  title: '会员已开通',
  content: (productName: string, untilText: string) => `${productName}已生效，有效期至 ${untilText}`,
};

/**
 * iOS 退款问询的 evidence 文本（spec §7.4）。这不是用户可见文案，是发给 Apple/微信的说明，
 * 但要求具体：写清实际使用天数与总天数。
 */
export const MEMBER_IOS_REFUND_HINT = 'iOS 退款请在 App Store 申请，通过后自动同步到这里';

/** iOS 订单的退款流程指引（用户点开「退款流程」展示；步骤性事实以 Apple/微信官方口径为准） */
export const MEMBER_IOS_REFUND_GUIDE = [
  '1. 在 App Store 提交申请：设置 → 顶部 Apple ID → 媒体与购买项目 → 账户 → 购买记录 → 选中本订单，入口可能是「请求退款」或「报告问题」（点击跳转 reportaproblem.apple.com 网站），选择订单与退款理由、按提示填写资料后提交',
  '2. Apple 会向我们问询：只按你的实际使用情况回复建议（未使用或刚用 1 天内会建议同意，使用超过 1 天会如实说明）',
  '3. 是否退款最终由 Apple 决定：通过后退款原路退回（一般 1-3 个工作日），会员权益立即终止；未通过则订单不受影响',
  '4. 结果在 App Store 申请页查看；退款成功后，本页订单状态会自动更新为「已退款」',
];

export const MEMBER_ORDERS_NOTICE = '退款金额按剩余天数折算，以提交时微信侧额度为准；退款后权益立即截断至退款时刻；支付超过 180 天的退款将扣除支付手续费';

export const IOS_QUERY_EVIDENCE = {
  notFound: '未查到该订单，建议退款',
  notDelivered: '订单未发货，建议退款',
  notStarted: '订单未发货，建议退款',
  lightUse: (used: number, total: number) => `用户已激活会员权益并使用 ${used} 天（共 ${total} 天），使用极短，同意退款`,
  refuse: (used: number, total: number) => `用户已激活会员权益并使用 ${used} 天（共 ${total} 天），不建议退款`,
};
