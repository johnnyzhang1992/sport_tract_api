import axios from 'axios';
import FormData from 'form-data';
import { config } from '../config/index.js';

/**
 * 微信内容安全检测（官方免费 API，服务端调用，决策：昵称/图片上传前合规检测）
 * - 文本：security.msgSecCheck（v2 场景化，scene=2 用户资料）
 * - 图片：security.imgSecCheck（同步；图片 ≤1MB，errcode 87014 = 违规）
 *
 * 降级策略：未配置 AppID/SECRET 或微信接口异常时放行（skipped），不阻塞本地联调
 */
let cachedToken: { token: string; expireAt: number } | null = null;

function configured(): boolean {
  return Boolean(config.wxAppid && config.wxSecret);
}

/** 获取小程序 access_token（stable_token 接口：同 appid 重复获取返回同一 token，不会被其他环境刷新顶掉；缓存提前 1 分钟过期） */
export async function getAccessToken(): Promise<string | null> {
  if (!configured()) return null;
  if (cachedToken && cachedToken.expireAt > Date.now() + 60_000) return cachedToken.token;

  const res = await axios.post(
    'https://api.weixin.qq.com/cgi-bin/stable_token',
    { grant_type: 'client_credential', appid: config.wxAppid, secret: config.wxSecret },
    { timeout: 5000 },
  );
  if (res.data?.errcode || !res.data?.access_token) {
    throw new Error(`微信 access_token 获取失败: ${res.data?.errmsg ?? res.data?.errcode ?? 'unknown'}`);
  }
  cachedToken = {
    token: res.data.access_token,
    expireAt: Date.now() + (res.data.expires_in ?? 7200) * 1000,
  };
  return cachedToken.token;
}

export interface SecCheckResult {
  /** true = 违规，应拒绝 */
  risky: boolean;
  suggest?: string;
  errcode?: number;
  /** true = 未配置/异常降级放行（调用方自行决定） */
  skipped?: boolean;
}

/** 带 token 失效重试的调用封装：业务回调抛 40001/42001 时清 token 缓存并重试一次（内容安全/小程序码共用） */
export async function callWithRetry<T>(fn: (token: string) => Promise<T>): Promise<T> {
  try {
    const token = await getAccessToken();
    if (!token) throw new Error('access_token 不可用');
    return await fn(token);
  } catch (err) {
    // 40001/42001：token 失效（axios 错误或带 extra.errcode 的 AppError），清缓存重试一次
    const e = err as { response?: { data?: { errcode?: number } }; extra?: { errcode?: number } };
    const code = e?.response?.data?.errcode ?? e?.extra?.errcode;
    if (code === 40001 || code === 42001) {
      cachedToken = null;
      const token2 = await getAccessToken();
      if (token2) return await fn(token2);
    }
    throw err;
  }
}

/**
 * 文本检测（昵称等用户资料，scene=2）
 * 注意：openid 需为近两小时访问过小程序的用户（真实登录场景有效）
 */
export async function checkText(
  text: string,
  openid?: string,
): Promise<SecCheckResult> {
  if (!configured()) return { risky: false, skipped: true };
  try {
    return await callWithRetry(async (token) => {
      const res = await axios.post(
        `https://api.weixin.qq.com/wxa/msg_sec_check?access_token=${token}`,
        {
          version: 2,
          scene: 2,
          openid: openid || 'unknown',
          content: String(text || '').slice(0, 500),
        },
        { timeout: 5000 },
      );
      const d = res.data;
      if (d.errcode) return { risky: false, errcode: d.errcode, skipped: true };
      return { risky: d.result?.suggest === 'risky', suggest: d.result?.suggest, errcode: 0 };
    });
  } catch (err) {
    console.error('[wechat-sec] checkText 异常（降级放行）:', (err as Error).message);
    return { risky: false, skipped: true };
  }
}

/**
 * 图片检测（头像/打点照片，imgSecCheck 同步）
 * 限制：图片 ≤1MB；返回 errcode 87014 = 内容违规
 */
export async function checkImage(
  buf: Buffer,
  openid?: string,
  filename = 'image.jpg',
): Promise<SecCheckResult> {
  if (!configured()) return { risky: false, skipped: true };
  try {
    return await callWithRetry(async (token) => {
      const form = new FormData();
      form.append('media', buf, { filename, contentType: 'image/jpeg' });
      form.append('version', '2');
      form.append('scene', '2');
      form.append('openid', openid || 'unknown');

      const res = await axios.post(
        `https://api.weixin.qq.com/wxa/img_sec_check?access_token=${token}`,
        form,
        { headers: form.getHeaders(), timeout: 8000 },
      );
      const d = res.data;
      if (d.errcode === 87014) return { risky: true, errcode: 87014, suggest: 'risky' };
      if (d.errcode) return { risky: false, errcode: d.errcode, skipped: true };
      return { risky: d.result?.suggest === 'risky', suggest: d.result?.suggest, errcode: 0 };
    });
  } catch (err) {
    console.error('[wechat-sec] checkImage 异常（降级放行）:', (err as Error).message);
    return { risky: false, skipped: true };
  }
}
