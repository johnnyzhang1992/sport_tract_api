import { config } from './index.js';

export const POINTS = {
  SIGNIN_MAX: 7,
  DAILY_CAP: 100,
  /** 过期提醒阈值（天）：最早到期批次只剩这么多天以内才在积分页提示（2026-10-28 用户拍板 30） */
  EXPIRE_NOTICE_DAYS: 30,
  MAKEUP_CARD_VALID_DAYS: 30,
  /**
   * 补签卡**种子默认价**：只在目录行不存在时写入（`$setOnInsert`），改价走后台道具编辑，
   * 存量行不会被这个值冲掉。2026-10-28 从 200 降到 49；2026-10-29 主人定稿 49 → 99——
   * 一张卡的收益上限是 28 分（补签日 7 分 + 后面 6 天爬坡差额 21 分），99 分仍留 71 分净回收，
   * 既不让补签变成白嫖，也不至于高到没人补得起。dev 存量行已由后台改到 99，本值只管新环境。
   */
  MAKEUP_CARD_PRICE: 99,
  /**
   * 激励视频单次分值：2026-10-28 用户拍板 5 → 10，配合榜单发分抬累计速度；
   * 见 specs/2026-10-28-points-board-rewards-design.md
   */
  VIDEO_REWARD: 10,
  /** 补签段长上限（天）：窗口内未签段超过该值不可补。7 = 窗口本身的大小，等于"窗口内全部可补"
   *  （2026-10-25 用户拍板放宽；产品要收紧只改这个数字）。窗口内没有任何已签行时仍然不可补——
   *  补签只能接在已有记录上，新用户不能凭卡从零买连签 */
  MAX_MAKEUP_GAP_DAYS: 7,
} as const;

export const POINT_TASKS = {
  newbie_profile: { title: '完善头像和昵称', points: 5, period: 'once', claim: 'manual' },
  newbie_first_activity: { title: '首次完成运动', points: 10, period: 'once', claim: 'manual' },
  newbie_first_import: { title: '首次导入轨迹', points: 5, period: 'once', claim: 'manual' },
  // 2026-10-28 用户拍板，配合榜单发分抬累计速度（1 → 5）；见 specs/2026-10-28-points-board-rewards-design.md
  daily_activity: { title: '运动记录', points: 5, period: 'daily', claim: 'manual' },
  // claim='manual'：发分走显式 claim 接口。流量主激励视频没有服务端验签接口可接，
  // "看完才发分"只能信任客户端 onClose(isEnded)——刷分风险（现在 10 分 × 3 次/天/号）是接受的资损上限
  daily_video: {
    title: '观看广告视频',
    points: POINTS.VIDEO_REWARD,
    period: 'daily',
    claim: 'manual',
    /** 每天可领几次（2026-10-28 用户拍板 1 → 3）；periodKey 逐次记成「日期#n」，唯一键保证逐槽幂等 */
    dailyTimes: 3,
  },
} as const;

export type TaskKey = keyof typeof POINT_TASKS;

/**
 * 榜单奖励的**缺省结算起点**：2026-11-01 00:00（东八区）——固定常量，绝不随进程启动时钟漂移。
 *
 * 为什么是 2026-11-01：这是本功能的上线日（2026-10-28/29 设计与终审，11-01 开闸）。
 * 缺省必须写死一个日期，而不是「今天」：`BOARD_SETTLE_FROM` 在进程启动时只解析一次。
 * 若缺省取启动当天 00:00，一个「周一 00:00 结束」的周单元通常在周一当天或次日才被首次处理，
 * 此时 `boundary(= 周一 00:00) < 今天 00:00` 恒成立 ⇒ 该期被**永久跳过**且没有任何日志，
 * 开关打开后几乎不发分。固定成上线日则与重启时刻无关：上线前结束的周期永不发（不补历史），
 * 上线后结束的照常发。运营开闸时应把 `BOARD_SETTLE_FROM` 显式钉成实际开闸日期
 * （未钉时启动会告警，见 warnIfBoardSettleFromUnset）。
 */
export const BOARD_SETTLE_FROM_DEFAULT_DATE = '2026-11-01';
export const BOARD_SETTLE_FROM_DEFAULT = Date.parse(`${BOARD_SETTLE_FROM_DEFAULT_DATE}T00:00:00+08:00`);

/**
 * 结算起点（2026-10-29 终审 must-fix #4）的解析：`BOARD_SETTLE_FROM` 收
 * **东八日期串 'YYYY-MM-DD'（按当日 00:00）或毫秒时间戳**；
 * 缺省/空＝固定常量 BOARD_SETTLE_FROM_DEFAULT（2026-11-01 00:00 东八区），不再是「今天 00:00」。
 * 语义只有一条：**窗口终点 >= settleFrom 的周期单元才可结算**，早于它的单元永不发分。
 * 为什么缺省是固定日期而不是「今天」：这一版之前 BOARD_REWARDS 没有起点，开关一拨就会把上线前的
 * 所有周/月/年榜一次性补发（全平台 8 个榜 × 全部历史周期，真金白银且没人预期）；另一方面，
 * 用「启动当天」当缺省会让周一/月初刚结束的单元因启动时刻而永久漏发（见上方常量注释）。
 * 环境变量写错（既不是日期也不是正数毫秒）时**退回缺省并留一条 error 日志**：
 * 配错只许少发不许多发，绝不能因为一个笔误把开关当成"从历史开头算起"。
 * `now` 仅为历史调用签名保留，缺省值已与它无关。
 */
export function parseSettleFrom(raw: string | undefined, _now = Date.now()): number {
  const s = String(raw ?? '').trim();
  if (!s) return BOARD_SETTLE_FROM_DEFAULT;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ms = Date.parse(`${s}T00:00:00+08:00`);
    if (!Number.isNaN(ms)) return ms;
  } else {
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) return n;
  }
  console.error(`[points] BOARD_SETTLE_FROM 不是东八日期串（YYYY-MM-DD）也不是毫秒时间戳，已退回固定缺省 ${BOARD_SETTLE_FROM_DEFAULT_DATE} 00:00（东八区）：${s}`);
  return BOARD_SETTLE_FROM_DEFAULT;
}

/**
 * 启动自检：`BOARD_REWARDS_ENABLED` 打开、但 `BOARD_SETTLE_FROM` 未显式配置时大声告警。
 * 不 throw（api 必须照常启动）：只说清楚「正在用缺省日期发钱」，并要求运营把起点钉成实际开闸日。
 * 显式配置后、或开关关着时，一条 warn 都不打。返回是否真的告警（供测试/调用方判断）。
 */
export function warnIfBoardSettleFromUnset(
  env: Record<string, string | undefined> = process.env,
  log: (msg: string) => void = (msg) => console.warn(msg),
): boolean {
  const enabled = env.BOARD_REWARDS_ENABLED === 'true' || env.BOARD_REWARDS_ENABLED === '1';
  if (!enabled) return false;
  if (String(env.BOARD_SETTLE_FROM ?? '').trim() !== '') return false;
  log(
    `[points] BOARD_REWARDS_ENABLED 已打开，但 BOARD_SETTLE_FROM 未显式配置：榜单发分将从缺省起点 ${BOARD_SETTLE_FROM_DEFAULT_DATE} 00:00（东八区）开始，早于该日结束的周期单元永不发分。请把 BOARD_SETTLE_FROM 钉成实际开闸日期（YYYY-MM-DD，东八区）后重启。`,
  );
  return true;
}

/**
 * 榜单奖励结算配置（spec §4.1/§4.2/§6；2026-10-29 裁定后**没有**单榜总额上限项——
 * BOARD_PER_BOARD_CAP_FACTOR 已删，勿再加回：并列全发）。
 *
 * 可变对象（不 as const）：enabled 是灰度开关的运行时候，测试里成对翻/恢复（SP-4）；
 * 线上初值来自 env BOARD_REWARDS_ENABLED，默认 false（spec §6「先小流量验一轮结算再放开」）。
 */
export const BOARD_REWARDS = {
  /** 灰度开关：关 ⇒ settlePeriod / settleDueForUser 直接短路，一分钱都不发 */
  enabled: config.boardRewardsEnabled,
  /** TOP1/2/3 分值（D4）：周 50/30/20、月 100/80/50、年 500/400/300 */
  rewards: {
    week: [50, 30, 20],
    month: [100, 80, 50],
    year: [500, 400, 300],
  } as Record<'week' | 'month' | 'year', [number, number, number]>,
  /** 单榜参与人数**严格大于**该值才发（D2；恰好 10 人不发＝产品拍板） */
  minParticipants: 10,
  /**
   * 结算起点（ms，东八零点）：**窗口终点 >= 此值的单元才结算**（见 parseSettleFrom 的注释）。
   * 缺省是固定常量 2026-11-01 00:00（东八区，功能上线日），与进程启动时刻无关；
   * 运营用 `BOARD_SETTLE_FROM` 覆盖它，开闸时应显式钉成实际开闸日（未钉时启动告警）。
   * 早于它的单元懒结算不再枚举，即便被直接调 settlePeriod 也只返回 0 且不落任何台账行（永远发不出分）。
   */
  settleFrom: parseSettleFrom(process.env.BOARD_SETTLE_FROM),
  /** 同一期每人最多计 N 个榜（D5，取分值最高的 N 个） */
  perUserBoards: 3,
  /**
   * 卡死 pending 的接管窗口（评审裁定 1）：抢锁进程崩在半路时，行会永远占住唯一键。
   * updatedAt 落后超过这个窗口的 pending 行可被重领——creditPoints 对 idemKey 幂等，
   * 接管不会双发。定 10min：远大于一次结算 pass 的正常耗时，又短到用户刷一下页面就能拿到。
   */
  pendingStaleMs: 10 * 60_000,
  /**
   * skipped 占位的有效期（评审裁定 2）：占位是**缓存不是判决**——导入/回填行没有时间上限，
   * 参与人数 9→11 真实可能发生。超过这个窗口就重算门槛。定 24h：与活动懒清理同档，
   * 页面浏览的高频路径上一次聚合都不多跑；后台另有删占位的逃生口（Task 10）。
   */
  skippedFreshMs: 24 * 60 * 60_000,
};

/**
 * 规则页「榜单奖励」六句定稿（spec §4.8 第 1 条，2026-10-28 用户逐字确认）。
 *
 * 分值/门槛/3 榜上限一律从配置插值——文案里不许再写第二份数字，否则后台调了分值
 * 规则页还在说旧数（本轮刚修过「需 200 积分」那个坑）。第 4–6 句是纯文字，
 * 与 spec 逐字一致（test/points-routes.test.ts PR-RULES-1 钉住）。
 */
export function boardRulesText(
  rewards: Record<'week' | 'month' | 'year', [number, number, number]> = BOARD_REWARDS.rewards,
  opts: { minParticipants: number; perUserBoards: number } = BOARD_REWARDS,
): string[] {
  return [
    `每周/每月/每年，各运动类型的全国榜按总距离排名，前三名获得积分：周榜第 1 名 ${rewards.week[0]} 分、第 2 名 ${rewards.week[1]} 分、第 3 名 ${rewards.week[2]} 分；月榜 ${rewards.month.join(' / ')} 分；年榜 ${rewards.year.join(' / ')} 分。`,
    `榜单奖励只发给"大家都来动"的榜：同一周期内，该运动类型的全国榜参与人数超过 ${opts.minParticipants} 人才发放，人数不足则本期不发。`,
    `同一期内，每人最多计成绩最好的 ${opts.perUserBoards} 个榜单，其余名次不再叠加积分。`,
    '奖励在周期结束后顺延发放：上周（周一至周日）的周榜在下周一到账，上月的月榜在下月 1 日到账，上一年的年榜在次年 1 月 1 日到账。',
    '只有可信的运动记录计入排名：疑似搭车、轨迹漂移异常、配速不合理的记录会被剔除。',
    '积分奖励会同时发一条消息通知，并在「积分明细」里留一条记录。',
  ];
}
