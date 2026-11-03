/**
 * 虚拟支付下单签名（spec §7.1）。纯函数、零 IO，所以能全量单测。
 *
 * 两把钥匙的分工不能混：paySig 用平台密钥（现网 AppKey）签「接口名&参数串」，
 * signature 用用户态的 session_key 只签参数串。签名基于的字节串必须与最终发给微信的一模一样，
 * 所以本模块返回 signData 字符串本身，调用方（以及小程序端）不得 JSON.parse 后重新 stringify。
 */
import { createHmac } from 'node:crypto';

export const XPAY_SIGN_PREFIX = 'requestVirtualPayment';

export interface XpaySignFields {
  offerId: string;
  buyQuantity: number;
  /** 固定 0＝现网（spec §7.1；沙箱能否用于个人主体道具直购待实测） */
  env: 0;
  currencyType: 'CNY';
  /** ＝ PaidProduct.key ＝ MP 后台 productId */
  productId: string;
  /** 人民币「分」，必须与 MP 后台道具价（单位元）一致（spec §2.4） */
  goodsPrice: number;
  outTradeNo: string;
  attach: string;
}

/** 键序写死在这里，顺序即协议（改动会被 XS-1 抓红） */
export function buildSignData(f: XpaySignFields): string {
  return JSON.stringify({
    offerId: f.offerId,
    buyQuantity: f.buyQuantity,
    env: f.env,
    currencyType: f.currencyType,
    productId: f.productId,
    goodsPrice: f.goodsPrice,
    outTradeNo: f.outTradeNo,
    attach: f.attach,
  });
}

export function hmacSha256Hex(key: string, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

export function paySigOf(appKey: string, signData: string): string {
  return hmacSha256Hex(appKey, `${XPAY_SIGN_PREFIX}&${signData}`);
}

export function userSignatureOf(sessionKey: string, signData: string): string {
  return hmacSha256Hex(sessionKey, signData);
}

export function buildPayParams(f: XpaySignFields, appKey: string, sessionKey: string) {
  const signData = buildSignData(f);
  return { signData, paySig: paySigOf(appKey, signData), signature: userSignatureOf(sessionKey, signData) };
}
