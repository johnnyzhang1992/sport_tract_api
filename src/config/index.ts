import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 优先加载 .env.local（本地覆盖），再加载 .env（默认）
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function int(v: string | undefined, def: number): number {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isNaN(n) ? def : n;
}

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return v === 'true' || v === '1';
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isDev: (process.env.NODE_ENV ?? 'development') !== 'production',

  // 服务
  port: int(process.env.PORT, 3004),
  host: process.env.HOST ?? '0.0.0.0',
  apiPrefix: '/sport-track/api', // 前缀区分同域名下的其他服务（nginx 按 /sport-track/ 转发）
  // 防刷：一起运动活动，每个用户滚动 1 小时 / 东八自然日的最多创建数。
  // 测试态放宽，避免用例连续建活动撞限额（与 activity.routes 的 CREATE_LIMIT 同思路）。
  campaignCreateHourlyLimit:
    process.env.WX_MOCK_LOGIN === 'true' && (process.env.NODE_ENV ?? 'development') !== 'production'
      ? 100000
      : 5,
  campaignCreateDailyLimit:
    process.env.WX_MOCK_LOGIN === 'true' && (process.env.NODE_ENV ?? 'development') !== 'production'
      ? 100000
      : 10,
  // 每个用户同时存在的「未开始 + 进行中」活动数上限（已结束/已解散不占）
  campaignActiveLimit: 99,

  // MongoDB
  mongodbUri:
    process.env.MONGODB_URI ?? 'mongodb://localhost:27017/sport-track-dev',

  // 榜单奖励灰度开关（spec §6）：默认 false——线上先小流量验一轮结算再放开。
  // 短路点在 settlePeriod/settleDueForUser 入口；回滚＝关掉它（已发的分不回收，台账保留）。
  boardRewardsEnabled: bool(process.env.BOARD_REWARDS_ENABLED, false),
  // 配套的发分起点 BOARD_SETTLE_FROM（东八日期串 'YYYY-MM-DD' 或毫秒，缺省＝今天 00:00）：
  // **窗口终点 >= 它的周期单元才结算**。开闸时务必显式设成上线日，别指望"从历史开头补发"；
  // 解析与语义见 config/points.ts 的 parseSettleFrom。

  // 管理后台（admin 接口独立鉴权，与小程序用户隔离）
  adminUsername: process.env.ADMIN_USERNAME ?? 'admin',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'admin123456',
  adminJwtSecret: process.env.ADMIN_JWT_SECRET ?? 'dev-insecure-admin-secret',
  adminTokenTtl: process.env.ADMIN_TOKEN_TTL ?? '7d',

  // JWT
  jwtSecret: process.env.JWT_SECRET ?? 'dev-insecure-jwt-secret',
  jwtRefreshSecret:
    process.env.JWT_REFRESH_SECRET ?? 'dev-insecure-jwt-refresh-secret',
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? '7d',
  refreshTokenTtl: process.env.REFRESH_TOKEN_TTL ?? '30d',

  // 微信小程序
  wxAppid: process.env.WX_APPID ?? '',
  wxSecret: process.env.WX_SECRET ?? '',
  // 小程序码指向的版本：trial（体验版，默认）/ release（正式版，发布后改这个）
  wxMiniCodeEnv: process.env.WX_MINI_CODE_ENV ?? 'trial',
  // 本地开发无真实 AppID 时开启 mock 登录（任意 code 直接换取测试 openid）
  wxMockLogin: process.env.WX_MOCK_LOGIN === 'true',

  // 腾讯位置服务（WebService API：轨迹纠偏 trace / 逆地理编码等）
  tencentMapKey: process.env.TENCENT_MAP_KEY ?? '',
  // key 为“域名授权”模式时，服务端调用需带授权域 Referer（否则返回 status 110）
  tencentMapReferer: process.env.TENCENT_MAP_REFERER ?? 'https://www.historybook.cn/',

  // 阿里云 OSS（AK 签名直传，无需 STS/RAM 角色；roleArn 不再需要）
  oss: {
    region: process.env.OSS_REGION ?? '',
    bucket: process.env.OSS_BUCKET ?? '',
    endpoint: process.env.OSS_ENDPOINT ?? '',
    accessKeyId: process.env.OSS_AK_ID ?? '',
    accessKeySecret: process.env.OSS_AK_SECRET ?? '',
    // 凭证有效期（秒）
    stsDuration: int(process.env.OSS_STS_DURATION, 900),
    // OSS 内文件根目录，按 userId 隔离
    baseDir: process.env.OSS_BASE_DIR ?? 'sport-track',
  },
} as const;

export function isOssConfigured(): boolean {
  const { region, bucket, accessKeyId, accessKeySecret } = config.oss;
  return Boolean(region && bucket && accessKeyId && accessKeySecret);
}
