import StsClient from '@alicloud/sts20150401';
import { AssumeRoleRequest } from '@alicloud/sts20150401';
import { Config as OpenApiConfig } from '@alicloud/openapi-client';
import { config, isOssConfigured } from '../config/index.js';
import { AppError } from '../utils/app-error.js';

// CJS 双形态包类型缺陷：d.ts 为 ESM 声明、运行时是 exports.default，
// TS NodeNext 将 default import 解析为命名空间，这里显式断言为构造器
interface StsAssumeRoleResponse {
  body?: {
    credentials?: {
      accessKeyId?: string;
      accessKeySecret?: string;
      securityToken?: string;
      expiration?: string;
    };
  };
}
const StsClientCtor = StsClient as unknown as new (config: OpenApiConfig) => {
  assumeRole(request: AssumeRoleRequest): Promise<StsAssumeRoleResponse>;
};

export interface StsCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  expiration: string;
  /** 上传目标目录（OSS key 前缀） */
  dir: string;
  /** 直传域名 */
  endpoint: string;
  bucket: string;
  region: string;
}

/**
 * 阿里云 OSS STS 临时凭证签发（决策 D12）
 *
 * 安全模型：
 * - 最小权限：仅允许 PutObject，禁止 List/Delete/其他 Action
 * - 目录隔离：资源限定在 users/{userId}/{dir}/ 下
 * - 短时效：默认 15 分钟
 * - 前端拿凭证直传 OSS，后端只存 URL，不接触文件内容
 */
export async function issueStsCredentials(userId: string, dir = 'common'): Promise<StsCredentials> {
  if (!isOssConfigured()) {
    throw new AppError(
      503,
      'OSS 未配置，请联系管理员（需设置 OSS_REGION/OSS_BUCKET/OSS_AK_ID/OSS_AK_SECRET/OSS_ROLE_ARN）',
    );
  }

  const { region, bucket, accessKeyId, accessKeySecret, roleArn, stsDuration, endpoint, baseDir } =
    config.oss;

  // 目录规则：{baseDir}/users/{userId}/{dir}/  —— 按用户隔离，防越权
  const ossDir = `${baseDir}/users/${userId}/${dir}/`;

  const policy = JSON.stringify({
    Version: '1',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['oss:PutObject'],
        Resource: [`acs:oss:*:*:${bucket}/${ossDir}*`],
      },
    ],
  });

  const openApiConfig = new OpenApiConfig({
    accessKeyId,
    accessKeySecret,
  });
  const client = new StsClientCtor(openApiConfig);

  const req = new AssumeRoleRequest({
    roleArn,
    roleSessionName: `sport-track-${userId.slice(-8)}`,
    durationSeconds: stsDuration,
    policy,
  });

  const res = await client.assumeRole(req);
  const creds = res.body?.credentials;

  if (!creds?.accessKeyId || !creds?.accessKeySecret || !creds?.securityToken) {
    throw new AppError(500, 'STS 凭证签发失败：返回数据不完整');
  }

  return {
    accessKeyId: creds.accessKeyId,
    accessKeySecret: creds.accessKeySecret,
    securityToken: creds.securityToken,
    expiration: creds.expiration ?? '',
    dir: ossDir,
    endpoint,
    bucket,
    region,
  };
}
