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
 * 生成 OSS 签名访问 URL（bucket 私有时前端加载图片用）
 * 库内只存裸 URL，展示时签发；签名 URL 过期后需重新签发
 * @returns 签名 URL；OSS 未配置/无法提取 key 时返回原 URL
 */
export function getSignedUrl(url: string, expiresSec = 86400): string {
  if (!isOssConfigured()) return url;
  const key = extractKeyFromUrl(url);
  if (!key) return url;
  const { region, bucket, accessKeyId, accessKeySecret } = config.oss;
  const client = new OSS({ region, accessKeyId, accessKeySecret, bucket, secure: true });
  return client.signatureUrl(key, { expires: expiresSec, method: 'GET' });
}
