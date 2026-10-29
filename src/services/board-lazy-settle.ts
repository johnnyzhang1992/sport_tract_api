/**
 * 懒结算入口调度器（Task 9；spec §4.2）。
 *
 * 容器里没有 cron（沿用活动 24h 懒清理的先例），榜单结算挂在用户入口上：
 * 进积分页（/points/summary）或运动榜页（/stats/leaderboard）时对到期单元补算。
 *
 * 三条硬约束（Task 7 评审交接，量出来的是真成本不是偏好）：
 * 1. **绝不在请求路径上 await**：一个到期单元首趟最多 ~8 次聚合，多个到期单元串起来
 *    就是积分页/榜单页的延迟悬崖。fire-and-forget，主响应只读不依赖结算的数据——
 *    用户这一趟看到「还没到账」、下一趟看到到账，是 spec §4.2 认可的懒语义。
 * 2. **每用户限频**：SETTLE_TRIGGER_WINDOW_MS 内同一 userId 只调度一次。这纯粹是负载闸门——
 *    双发防线在台账侧（唯一键抢锁 + 24h 完成标记 + idemKey），即便跨进程同时调度也无害。
 *    check-and-set 之间没有 await，单线程事件循环内同用户并发请求恰有一个放行（其余被拦），
 *    最坏情形（多实例部署）也只是多做一次幂等短路，不会多发钱。
 * 3. **不收 period/periodKey**：结算单元一律由 settleDueForUser 自己派生（§4.2 C2），
 *    调用方只递 userId 与时刻；查询串里的 period 与本模块无关。
 *
 * 本模块不碰结算数学、台账与通知——它只做「调度 + 吞错 + 限频」。
 */
import { BOARD_REWARDS } from '../config/points.js';
import { settleDueForUser } from './points-board.js';

/**
 * 每用户调度窗口：5 分钟。
 * 取值理由：比台账侧卡死 pending 的接管窗口（10min，points-board 配置）短一半——
 * 抢锁进程崩在半路时下一个进页的请求最迟 5 分钟就能重试；
 * 又足够长，把「用户反复刷新页面/两个页面来回切」的首趟全量聚合压到每分钟一次量级。
 */
export const SETTLE_TRIGGER_WINDOW_MS = 5 * 60_000;

/** 闸门表容量上限：超限先清过期条目（量级 = 5 分钟窗口的活跃用户数，正常远碰不到） */
const MAX_TRACKED_USERS = 10_000;

/**
 * 测试缝：真现在这里挂 settleDueForUser；测试用 t.mock.method 替换它
 * （共享 dev 库不许替真实用户跑全榜结算，见 test/points-routes.test.ts Task 9 段注释）。
 */
export const lazySettleDeps: { settle: (userId: string, now: number) => Promise<void> } = {
  settle: settleDueForUser,
};

/** userId → 最近一次调度时刻（毫秒）。模块级 Map，照 ip-locate.ts 的缓存先例，不起定时器 */
const lastTriggerAt = new Map<string, number>();

export function resetLazySettleDebounceForTest(): void {
  lastTriggerAt.clear();
}

/**
 * 后台触发该用户的到期结算。**永不抛错、永不返回需要 await 的东西**：
 * reject 被 .catch 吞掉留 error 日志（下次进页自动重试）；同步抛用 async 包壳转成
 * reject 后同样被吞——挂在页面请求上的顺带动作不能把请求变 500。
 */
export function scheduleLazySettle(userId: string, now: number = Date.now()): void {
  // SP-4 语义在入口层先钉一道：开关关闭连调度都不发起（纯内存判定，零 DB 开销；
  // settleDueForUser 内部还有第二道同款短路，defense in depth）
  if (!BOARD_REWARDS.enabled) return;
  if (!userId) return; // 游客/空 id：绝不替「某个用户」结算
  const last = lastTriggerAt.get(userId);
  if (last !== undefined && now - last < SETTLE_TRIGGER_WINDOW_MS) return;
  if (lastTriggerAt.size >= MAX_TRACKED_USERS) {
    for (const [key, ts] of lastTriggerAt) {
      if (now - ts >= SETTLE_TRIGGER_WINDOW_MS) lastTriggerAt.delete(key);
    }
  }
  lastTriggerAt.set(userId, now);
  void (async () => {
    await lazySettleDeps.settle(userId, now);
  })().catch((e) => {
    console.error('[board-lazy-settle] 后台结算失败（主响应不受影响，下后进页重试）', { userId }, e);
  });
}
