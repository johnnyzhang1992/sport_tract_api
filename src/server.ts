import { buildApp } from './app.js';
import { config } from './config/index.js';
import { warnIfBoardSettleFromUnset } from './config/points.js';
import { startMemberReminderJob } from './services/member-reminder.js';
import { startAdminDailyStatsJob } from './services/admin-daily-stats.js';
import { startWeeklySportsJob } from './services/weekly-sports-reminder.js';

async function start() {
  // 开闸但没钉结算起点时大声告警（不 throw）：缺省是固定上线日，运营应把它钉成实际开闸日。
  warnIfBoardSettleFromUnset();
  const fastify = await buildApp();

  try {
    await fastify.listen({ port: config.port, host: config.host });
    startMemberReminderJob();
    startAdminDailyStatsJob();
    startWeeklySportsJob();
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
