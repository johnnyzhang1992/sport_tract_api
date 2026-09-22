import crypto from 'node:crypto';
import OSS from 'ali-oss';
import { config, isOssConfigured } from '../config/index.js';
import { AppError } from '../utils/app-error.js';

/** 照片上传大小上限（字节，10MB） */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export interface UploadCredential {
  /** 直传域名 */
  endpoint: string;
  bucket: string;
  region: string;
  /** 上传目标目录（OSS key 前缀） */
  dir: string;
  /** 签名直传表单字段（决策 D12 简化版：固定 AK 签名，无需 RAM 角色/roleArn） */
  OSSAccessKeyId: string;
  policy: string;
  signature: string;
  /** 凭证过期时间（ISO 8601） */
  expiration: string;
}

/**
 * 签发 OSS 表单上传签名（AK 签名直传，无需 STS/RAM 角色）
 *
 * 安全模型：
 * - AK 不落地前端：后端用固定 AK 计算 policy + signature，前端仅持有一次性签名
 * - 目录隔离：policy 限定 key 前缀 users/{userId}/{dir}/，只能传不能读/删
 * - 短时效：默认 15 分钟
 * - 大小限制：content-length-range 0 ~ 10MB
 */
export async function issueUploadCredential(userId: string, dir = 'common'): Promise<UploadCredential> {
  if (!isOssConfigured()) {
    throw new AppError(
      503,
      'OSS 未配置，请联系管理员（需设置 OSS_REGION/OSS_BUCKET/OSS_ENDPOINT/OSS_AK_ID/OSS_AK_SECRET）',
    );
  }

  const { region, bucket, accessKeyId, accessKeySecret, endpoint, baseDir } = config.oss;

  // 目录规则：{baseDir}/users/{userId}/{dir}/ —— 按用户隔离，防越权
  const dirKey = `${baseDir}/users/${userId}/${dir}/`;

  const expiration = new Date(Date.now() + config.oss.stsDuration * 1000).toISOString();
  const policyObj = {
    expiration,
    conditions: [
      ['content-length-range', 0, MAX_FILE_SIZE],
      ['starts-with', '$key', dirKey],
    ],
  };
  const policy = Buffer.from(JSON.stringify(policyObj)).toString('base64');
  const signature = crypto.createHmac('sha1', accessKeySecret).update(policy).digest('base64');

  return {
    endpoint,
    bucket,
    region,
    dir: dirKey,
    OSSAccessKeyId: accessKeyId,
    policy,
    signature,
    expiration,
  };
}

/**
 * 从 OSS URL 提取对象 key（删除文件用）
 * 例：https://bucket.oss-cn-hangzhou.aliyuncs.com/sport-track/users/xxx/a.jpg
 *   → sport-track/users/xxx/a.jpg
 */
export function extractKeyFromUrl(url: string): string | null {
  if (!url) return null;
  const base = config.oss.endpoint.replace(/\/$/, '');
  if (!base || !url.startsWith(base)) return null;
  const path = url.slice(base.length).replace(/^\//, '').split('?')[0];
  return path || null;
}

/**
 * 服务端删除 OSS 文件（固定 AK 管理面操作，删除接口同步清理）
 * - 未配置 OSS 时静默跳过（不影响主流程）
 * - 仅删除属于本服务 baseDir 前缀的对象（防止误删）
 */
export async function deleteOssObjects(urls: string[]): Promise<void> {
  const valid = urls
    .map(extractKeyFromUrl)
    .filter((k): k is string => k !== null && k.startsWith(`${config.oss.baseDir}/`));
  if (valid.length === 0 || !isOssConfigured()) return;

  const { region, bucket, accessKeyId, accessKeySecret } = config.oss;
  const client = new OSS({ region, accessKeyId, accessKeySecret, bucket, secure: true });
  await client.deleteMulti(valid);
}

/**
 * 服务端上传 Buffer 到 OSS（固定 AK；小程序码等后端生成的文件）
 * @returns OSS URL
 */
export async function uploadBuffer(
  buffer: Buffer,
  key: string,
  contentType = 'image/png',
): Promise<string> {
  if (!isOssConfigured()) {
    throw new AppError(503, 'OSS 未配置');
  }
  const { region, bucket, accessKeyId, accessKeySecret, endpoint } = config.oss;
  const client = new OSS({ region, accessKeyId, accessKeySecret, bucket, secure: true });
  await client.put(key, buffer, { headers: { 'Content-Type': contentType } });
  return `${endpoint.replace(/\/$/, '')}/${key}`;
}

/** 去掉 URL 的 query 参数（签名 URL → 裸 URL） */
export function cleanUrl(url: string): string {
  return String(url || '').split('?')[0];
}

/**
 * OSS 图片处理档位（x-oss-process 参与签名，前端拼不出来，只能后端按档签发）
 * 实测样本：996KB 原图 → thumb 9.4KB / avatar 5.2KB / medium 45.7KB
 * 统一转 jpg：小程序 iOS 的 webp 支持不打包票，jpg 到处能渲染
 */
export const IMAGE_PROCESS = {
  /** 卡片/气泡/宫格缩略图：长边 240（端上最大展示位 200rpx ≈ 100 CSS px × 3 倍图） */
  thumb: 'image/resize,w_240/quality,q_80/format,jpg',
  /** 头像：圆形展示位一律方图裁切 */
  avatar: 'image/resize,m_fill,w_160,h_160/quality,q_80/format,jpg',
  /** 全宽封面 / 正文大图位：再大会糊，原图留给点开预览 */
  medium: 'image/resize,w_800/quality,q_80/format,jpg',
} as const;

let cachedClient: OSS | null = null;

/**
 * 签发访问 URL
 * @param process x-oss-process 图片处理参数（缩略图/头像/中图）；不传即原图
 * 非本桶地址（微信头像等）原样返回，签名逻辑不接管第三方域名。
 */
export function getSignedUrl(url: string, expiresSec = 86400, process?: string): string {
  if (!isOssConfigured()) return url;
  const key = extractKeyFromUrl(url);
  if (!key) return url;
  const { region, bucket, accessKeyId, accessKeySecret } = config.oss;
  // 一次详情要签十几条，client 建一次复用（构造里有凭证解析，别按张数重复付）
  cachedClient ??= new OSS({ region, accessKeyId, accessKeySecret, bucket, secure: true });
  return cachedClient.signatureUrl(key, { expires: expiresSec, method: 'GET', ...(process ? { process } : {}) });
}

export const getThumbUrl = (url: string) => getSignedUrl(url, 86400, IMAGE_PROCESS.thumb);
export const getAvatarUrl = (url: string) => getSignedUrl(url, 86400, IMAGE_PROCESS.avatar);
export const getMediumUrl = (url: string) => getSignedUrl(url, 86400, IMAGE_PROCESS.medium);
