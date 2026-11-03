/**
 * 虚拟支付（xpay）配置。
 *
 * 密钥纪律（spec §11.5）：这四个值只允许在这里读一次、只用于签名与解密，
 * 不得拼进日志、不得出现在任何接口返回、不得进测试夹具——需要「有没有配齐」的信号时
 * 调 isXpayConfigured()，而不是打印它们。
 * 沙箱键（XPAY_APP_KEY_SANDBOX）当前不参与签名：个人主体道具直购能否走 env=1 还没实测（spec §12.1），
 * 先把值留着，验通再切；验不通就用现网低价真单测（测完退款，180 天内手续费可退）。
 */
import { config } from './index.js';

export const xpayConfig = {
  offerId: process.env.XPAY_OFFER_ID ?? '',
  appKey: process.env.XPAY_APP_KEY ?? '',
  appKeySandbox: process.env.XPAY_APP_KEY_SANDBOX ?? '',
  pushToken: process.env.WX_PUSH_TOKEN ?? '',
  pushAesKey: process.env.WX_PUSH_AES_KEY ?? '',
  /** 固定 0＝现网（spec §7.1） */
  env: 0 as const,
} as const;

/**
 * 下单侧的两个值（offerId / 现网 AppKey）。与信封那组同一个原因必须经函数取：
 * `xpayConfig` 在 import 期就固化了 env，测试要靠运行期注入才能既跑下单链路、又不把真密钥写进夹具。
 */
let payOverrides: { offerId: string; appKey: string } | null = null;

export function payConfig(): { offerId: string; appKey: string } {
  return payOverrides ?? { offerId: xpayConfig.offerId, appKey: xpayConfig.appKey };
}

/** 测试专用：运行期覆盖 offerId/AppKey（传 null 恢复 env 值） */
export function __setPayConfigForTest(o: { offerId: string; appKey: string } | null): void {
  payOverrides = o;
}

/** 下单签名所需的两把钥匙 + offerId 都在位吗（缺任一则付费功能不可用，接口应报「服务未就绪」而不是 500） */
export function isXpayPayConfigured(): boolean {
  const { offerId, appKey } = payConfig();
  return Boolean(offerId && appKey);
}

/**
 * 回调信封用到的三个值（Token / AESKey / 期望的 appId）。
 * **必须经这个函数取，不要直接读 xpayConfig**：`xpayConfig` 在模块 import 时就固化了 env，
 * 而接收端的测试要在运行期换掉这三个值（用真实 appId/Token 进测试等于把密钥放进测试夹具）。
 * appId 缺省回落 config.wxAppid——密文模式下内层 appid 匹配就是来源证明。
 */
let envelopeOverrides: { pushToken?: string; pushAesKey?: string; appId?: string } | null = null;

export function pushEnvelopeConfig() {
  return {
    token: envelopeOverrides?.pushToken ?? xpayConfig.pushToken,
    aesKey: envelopeOverrides?.pushAesKey ?? xpayConfig.pushAesKey,
    appId: envelopeOverrides?.appId ?? config.wxAppid,
  };
}

/** 测试专用：运行期覆盖信封三值（传 null 恢复 env 值）。真实密钥绝不进测试——测试用自己的假三元组 */
export function __setPushEnvelopeForTest(o: { pushToken?: string; pushAesKey?: string; appId?: string } | null): void {
  envelopeOverrides = o;
}

/** 回调接收端可用吗（Token/AESKey 缺一个就没法校验/解密） */
export function isXpayPushConfigured(): boolean {
  const { token, aesKey, appId } = pushEnvelopeConfig();
  return Boolean(token && aesKey && appId);
}
