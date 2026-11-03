/**
 * 虚拟支付双签名（spec §7.1）。
 *
 * 关于「官方向量」：手上没有可引用的官方样例（spec §10.1 原本要求用它做断言）。
 * 所以这里的证法换成三条结构不变式，它们能抓住真正会犯的错：
 *   a) 待签串逐字确定（键序、attach 空串在场、goodsPrice 是数字）——微信侧按收到的 signData 重算，
 *      差一个字节就是 -15006；
 *   b) 两把钥匙签同一个串必须得到不同结果，且 paySig 用的是「前缀&串」而 signature 用的是「裸串」——
 *      这是唯一能把「两把钥匙写反」和「前缀漏了」抓红的断言；
 *   c) 键序变一次，签名必变（防「某处 JSON.parse 后重新 stringify」把键序洗成插入序/字典序）。
 * Task 14 的第一笔真单跑通后，把该单的 signData + 微信侧接受通过的 paySig 补成一条向量断言。
 *
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/xpay-sign.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  XPAY_SIGN_PREFIX, buildSignData, hmacSha256Hex, paySigOf, userSignatureOf, buildPayParams,
  type XpaySignFields,
} from '../src/services/xpay-sign.js';

const F: XpaySignFields = {
  offerId: 'offer-test',
  buyQuantity: 1,
  env: 0,
  currencyType: 'CNY',
  productId: 'month_card',
  goodsPrice: 199,
  outTradeNo: 'STxxxxx000000abcdef',
  attach: 'STxxxxx000000abcdef',
};
const PLATFORM = 'platform-key';
const SESSION = 'session-key';

test('XS-1 signData 逐字：键序固定、attach 空串仍在场、goodsPrice/env 是数字不带引号', () => {
  const s = buildSignData({ ...F, attach: '' });
  assert.equal(
    s,
    '{"offerId":"offer-test","buyQuantity":1,"env":0,"currencyType":"CNY",'
    + '"productId":"month_card","goodsPrice":199,"outTradeNo":"STxxxxx000000abcdef","attach":""}',
  );
});

test('XS-2 paySig = HMAC-SHA256(平台密钥, "requestVirtualPayment&" + signData)，逐字复核', () => {
  const signData = buildSignData(F);
  const expected = createHmac('sha256', PLATFORM).update(`${XPAY_SIGN_PREFIX}&${signData}`, 'utf8').digest('hex');
  assert.equal(paySigOf(PLATFORM, signData), expected);
  assert.equal(XPAY_SIGN_PREFIX, 'requestVirtualPayment');
});

test('XS-3 signature = HMAC-SHA256(session_key, signData)：不带前缀，且与 paySig 必不相同', () => {
  const signData = buildSignData(F);
  const expected = createHmac('sha256', SESSION).update(signData, 'utf8').digest('hex');
  assert.equal(userSignatureOf(SESSION, signData), expected);
  assert.notEqual(userSignatureOf(SESSION, signData), paySigOf(SESSION, signData), '前缀漏了会被这条抓红');
  assert.notEqual(paySigOf(PLATFORM, signData), userSignatureOf(PLATFORM, signData), '两把钥匙在同一串上必须给出不同结果');
});

test('XS-4 键序变一次签名就变（三个候选串两两互异）', () => {
  const asJson = JSON.stringify(F);
  const reordered = JSON.stringify({
    offerId: F.offerId, env: F.env, buyQuantity: F.buyQuantity, currencyType: F.currencyType,
    productId: F.productId, goodsPrice: F.goodsPrice, outTradeNo: F.outTradeNo, attach: F.attach,
  });
  const sorted = `{${Object.keys(F).sort().map((k) => `"${k}":${JSON.stringify((F as unknown as Record<string, unknown>)[k])}`).join(',')}}`;
  const sigs = [asJson, reordered, sorted].map((s) => paySigOf(PLATFORM, s));
  assert.equal(new Set(sigs).size, 3, '三种键序必须给出三个不同签名');
  assert.equal(buildSignData(F), asJson, 'buildSignData 必须产出规范键序，而不是 sorted');
});

test('XS-5 金额或单号被改写→签名必变（防「拼错了还照样下单」）', () => {
  const a = paySigOf(PLATFORM, buildSignData(F));
  assert.notEqual(paySigOf(PLATFORM, buildSignData({ ...F, goodsPrice: 1699 })), a);
  assert.notEqual(paySigOf(PLATFORM, buildSignData({ ...F, outTradeNo: 'OTHER' })), a);
  assert.notEqual(paySigOf(PLATFORM, buildSignData({ ...F, env: 1 as never })), a);
});

test('XS-6 buildPayParams 一次返回三件套且 signData 与两个签名自洽', () => {
  const p = buildPayParams(F, PLATFORM, SESSION);
  assert.equal(p.signData, buildSignData(F));
  assert.equal(p.paySig, paySigOf(PLATFORM, p.signData));
  assert.equal(p.signature, userSignatureOf(SESSION, p.signData));
  assert.match(p.paySig, /^[0-9a-f]{64}$/);
  assert.match(p.signature, /^[0-9a-f]{64}$/);
  assert.equal(hmacSha256Hex(SESSION, p.signData), p.signature, 'hmac 小工具与 userSignatureOf 同一口径');
});
