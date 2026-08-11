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

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isDev: (process.env.NODE_ENV ?? 'development') !== 'production',

  // 服务
  port: int(process.env.PORT, 3004),
  host: process.env.HOST ?? '0.0.0.0',
  apiPrefix: '/api',

  // MongoDB
  mongodbUri:
    process.env.MONGODB_URI ?? 'mongodb://localhost:27017/sport-track-dev',

  // JWT
  jwtSecret: process.env.JWT_SECRET ?? 'dev-insecure-jwt-secret',
  jwtRefreshSecret:
    process.env.JWT_REFRESH_SECRET ?? 'dev-insecure-jwt-refresh-secret',
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? '7d',
  refreshTokenTtl: process.env.REFRESH_TOKEN_TTL ?? '30d',

  // 微信小程序
  wxAppid: process.env.WX_APPID ?? '',
  wxSecret: process.env.WX_SECRET ?? '',
  // 本地开发无真实 AppID 时开启 mock 登录（任意 code 直接换取测试 openid）
  wxMockLogin: process.env.WX_MOCK_LOGIN === 'true',

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
