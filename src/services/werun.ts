import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { AppError } from '../utils/app-error.js';

/** 微信运动解密后的单日步数（官方 stepInfoList 项） */
export interface WeRunStep {
  /** 当天零点时间戳（秒，北京时区） */
  timestamp: number;
  step: number;
}

export interface WeRunPayload {
  stepInfoList: WeRunStep[];
  watermark: { appid: string; timestamp: number };
}

/** 落库口径：东八区日期 + 合理步数 */
export interface WeRunDay {
  date: string;
  step: number;
}

/** 官方没有单日上限口径；取一个明显超出人类极限的值当脏数据线（马拉松级一天 ~5-10 万步） */
const MAX_STEP_PER_DAY = 200000;
/** stepInfoList 只覆盖 31 天，放宽到 40 天窗口防边界漂移 */
const WINDOW_DAYS = 40;
/** watermark 时效：防重放，7 天内的解密产物才算新鲜 */
const WATERMARK_TTL_SECONDS = 7 * 24 * 3600;

/**
 * 解密微信运动开放数据（官方算法，文档 → 开放能力/用户信息/开放数据校验与解密）：
 * AES-128-CBC / PKCS#7，key = Base64_Decode(session_key)（16 字节），iv 随接口下发。
 *
 * session_key 不匹配时（wx.login 轮换、多设备竞争）解密必然失败——抛 409 让客户端
 * 重新 login 换新 code 再试一次（与 xpay 下单「现拿现用」同一时序约定）。
 */
export function decryptWeRunData(encryptedData: string, iv: string, sessionKey: string): WeRunPayload {
  const fail = () => new AppError(409, '步数解密失败，登录态已过期，请重试', { code: 'WERUN_DECRYPT_FAILED' });
  try {
    const key = Buffer.from(sessionKey, 'base64');
    if (key.length !== 16) throw new Error('session_key 解出不是 16 字节');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.from(iv, 'base64'));
    decipher.setAutoPadding(false); // 手动去 PKCS#7：填充非法时能给出明确的解密失败，而不是越界异常
    const out = Buffer.concat([decipher.update(Buffer.from(encryptedData, 'base64')), decipher.final()]);
    const pad = out[out.length - 1];
    if (pad < 1 || pad > 16) throw new Error('PKCS#7 填充非法');
    return JSON.parse(out.subarray(0, out.length - pad).toString('utf8')) as WeRunPayload;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw fail();
  }
}

/** 东八区 YYYY-MM-DD：微信 timestamp 是北京时区当天零点，用 UTC+8 偏移取日期（与端上 bjDate 同口径）。
 *  入参是「秒」（微信步数时间戳口径）——毫秒时间戳别用这个，会被乘成几万年外 */
export function werunDateOf(timestampSeconds: number): string {
  return new Date((timestampSeconds + 8 * 3600) * 1000).toISOString().slice(0, 10);
}

/**
 * 清洗 stepInfoList：微信按天给总量，但历史脏数据/端上异常可能出现缺字段或离谱值。
 * 只保留 timestamp 合法、step 在 [0, MAX] 的项；同一天多条保留 step 最大的一条（部分上报口径）。
 */
export function sanitizeStepInfoList(list: unknown): WeRunDay[] {
  if (!Array.isArray(list)) return [];
  const floorOf = Date.now() / 1000 - WINDOW_DAYS * 24 * 3600;
  const byDate = new Map<string, number>();
  for (const item of list) {
    const ts = (item as WeRunStep)?.timestamp;
    const step = (item as WeRunStep)?.step;
    if (!Number.isInteger(ts) || ts <= 0 || ts < floorOf) continue;
    if (!Number.isInteger(step) || step < 0 || step > MAX_STEP_PER_DAY) continue;
    const date = werunDateOf(ts);
    const prev = byDate.get(date);
    if (prev === undefined || step > prev) byDate.set(date, step);
  }
  return [...byDate.entries()].map(([date, step]) => ({ date, step })).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * watermark 校验（官方建议的防伪口径）：
 * - appid 必须是本小程序的（防把别家小程序拿到的密文转发过来凑数）；mock 登录环境没配 appid，跳过
 * - timestamp 距今不超过 7 天：wx.getWeRunData 是现取现传，过老的产物只可能是重放
 */
export function assertWatermarkTrustworthy(watermark: WeRunPayload['watermark']): void {
  if (!watermark || typeof watermark.timestamp !== 'number') {
    throw new AppError(400, '步数数据缺少水印，已拒绝入库', { code: 'WERUN_WATERMARK_MISSING' });
  }
  if (config.wxAppid && watermark.appid && watermark.appid !== config.wxAppid) {
    throw new AppError(400, '步数数据水印与小程序不匹配', { code: 'WERUN_WATERMARK_MISMATCH' });
  }
  const ageSeconds = Date.now() / 1000 - watermark.timestamp;
  if (ageSeconds > WATERMARK_TTL_SECONDS || ageSeconds < -600) {
    // 容 10 分钟时钟漂移
    throw new AppError(400, '步数数据已过期，请重新获取', { code: 'WERUN_WATERMARK_STALE' });
  }
}
