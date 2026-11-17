import { buildApp } from './app.js';
import { config } from './config/index.js';
import { warnIfBoardSettleFromUnset } from './config/points.js';
import { startMemberReminderJob } from './services/member-reminder.js';
import { startAdminDailyStatsJob } from './services/admin-daily-stats.js';
import { startWeeklySportsJob } from './services/weekly-sports-reminder.js';
import { startBoardOnTheListJob } from './services/board-onthelist-job.js';
import { startPlanSnapshotJob } from './services/exercise-plan.js';
import { initRedis, closeRedis } from './services/redis.js';

async function start() {
  // 开闸但没钉结算起点时大声告警（不 throw）：缺省是固定上线日，运营应把它钉成实际开闸日。
  warnIfBoardSettleFromUnset();
  // Redis 是可选加速层：未配置/连不上都会降级内存，不阻塞启动
  initRedis();
  const fastify = await buildApp();

  try {
    await fastify.listen({ port: config.port, host: config.host });
    startMemberReminderJob();
    startAdminDailyStatsJob();
    startWeeklySportsJob();
    startBoardOnTheListJob();
    startPlanSnapshotJob();
    registerShutdown(fastify);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

/**
 * 优雅退出（2026-11-17）：容器 restart/滚动发布时会收到 SIGTERM。
 * 不处理的话 ioredis 会一直重连刷 ECONNREFUSED 日志，进程也可能被拖住不退。
 * 兜底 5s 强制退出：任何一步卡住都不能让容器挂死。
 */
function registerShutdown(fastify: Awaited<ReturnType<typeof buildApp>>): void {
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref?.();
    try {
      await closeRedis();
      await fastify.close();
    } catch (e) {
      console.warn(`[server] ${signal} 关闭清理失败：`, (e as Error).message);
    }
    process.exit(0);
  };
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => void shutdown(sig));
  }
}

start();
