/**
 * 回调路由的信封行为（spec §6.2、§9、§10.7）：
 * E-1 GET 校验通过时原样回 echostr（多一个字符微信就判失败）；
 * E-2 GET 校验不过不回 echostr（否则等于把 URL 白送）；
 * E-3 明文 JSON 与兼容模式密文两种 body 解析出同一个 Event（§10.7）；
 * E-4 未知事件回 ErrCode 0 吞掉（不吞会被重试 15 次）；
 * E-5 业务处理失败回非 0（微信重试）；
 * E-6 数据格式为 XML 时应答是 XML 串；
 * E-7 该路由不走 JWT：不带 authorization 头也要能收到推送；
 * E-8 密文分支 appId 不符→回非 0 且不进业务（验签失败绝不发货）；
 * E-9 推送密钥缺失时拒收（回非 0，运营能在微信侧看到失败而不是静默丢包）。
 *
 * 信封三值走运行期注入（__setPushEnvelopeForTest）：config/xpay.ts 在 import 时就固化了 env，
 * 靠 process.env 赋值无效；真实密钥也绝不进测试夹具。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/pay-notify-envelope.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { __setPushEnvelopeForTest } from '../src/config/xpay.js';
import { encryptPushMessageForTest } from '../src/utils/wx-push-crypto.js';
import { __setNotifyHandlerForTest, type NotifyResult } from '../src/routes/pay-notify.routes.js';

let app: FastifyInstance;
const TOKEN = 'unit-test-push-token';
const AES = randomBytes(32).toString('base64').replace(/=+$/, ''); // 43 位假值：不是真密钥，只在测试内自洽
const APP_ID = 'wxunit-test-appid';                 // 假 appId：真值只在 .env.local，不进夹具
let handlerCalls: Array<{ event: string; payload: Record<string, unknown> }> = [];
let nextResult: NotifyResult = { ok: true };

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  __setPushEnvelopeForTest({ pushToken: TOKEN, pushAesKey: AES, appId: APP_ID });
  app = await buildApp({ logger: false });
  await app.ready();
});
beforeEach(() => {
  handlerCalls = [];
  nextResult = { ok: true };
  __setPushEnvelopeForTest({ pushToken: TOKEN, pushAesKey: AES, appId: APP_ID });
  __setNotifyHandlerForTest(async (event, payload) => {
    handlerCalls.push({ event, payload });
    return nextResult;
  });
});
after(async () => {
  __setNotifyHandlerForTest(null);
  __setPushEnvelopeForTest(null);
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

function qs(over: Record<string, string> = {}) {
  const timestamp = over.timestamp ?? '1730000000';
  const nonce = over.nonce ?? 'n1';
  const signature = over.signature ?? createHash('sha1').update([TOKEN, timestamp, nonce].sort().join('')).digest('hex');
  return new URLSearchParams({ signature, timestamp, nonce, msg_signature: signature, encrypt_type: 'aes' });
}

test('E-1 GET 校验通过时原样回 echostr', async () => {
  const res = await app.inject({ method: 'GET', url: `${config.apiPrefix}/pay/wx-notify?${qs()}&echostr=abcECHO123` });
  assert.equal(res.body, 'abcECHO123');
});

test('E-2 GET 签名不符不回 echostr', async () => {
  const res = await app.inject({ method: 'GET', url: `${config.apiPrefix}/pay/wx-notify?${qs({ signature: 'deadbeef' })}&echostr=abcECHO123` });
  assert.notEqual(res.body, 'abcECHO123');
  assert.equal(res.statusCode, 403);
});

test('E-3 明文 JSON 与密文 JSON 两种 body 解析出同一个 Event', async () => {
  const plainBody = { Event: 'xpay_goods_deliver_notify', openid: 'o1', WeChatPayInfo: { MchOrderNo: 'wx-1' } };
  const r1 = await app.inject({ method: 'POST', url: `${config.apiPrefix}/pay/wx-notify?${qs()}`, payload: plainBody });
  assert.equal(r1.statusCode, 200);
  assert.equal(handlerCalls[0].event, 'xpay_goods_deliver_notify');

  handlerCalls = [];
  const enc = encryptPushMessageForTest({ aesKey: AES, appId: APP_ID, plain: JSON.stringify(plainBody) });
  const r2 = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/pay/wx-notify?${qs()}`,
    payload: { Encrypt: enc, ToUserName: 'x', FromUserName: 'x', CreateTime: 1, MsgType: 'event', Event: 'xpay_goods_deliver_notify' },
  });
  assert.equal(r2.statusCode, 200);
  assert.equal(handlerCalls[0].event, 'xpay_goods_deliver_notify');
  assert.equal(handlerCalls[0].payload.openid, 'o1', '密文分支要拿解密后的正文，不能拿外层信封字段');
});

test('E-4 未知事件回 ErrCode 0 且不进业务处理', async () => {
  const res = await app.inject({ method: 'POST', url: `${config.apiPrefix}/pay/wx-notify?${qs()}`, payload: { Event: 'something_new' } });
  assert.equal(res.json().ErrCode, 0);
  assert.deepEqual(handlerCalls, []);
});

test('E-5 业务失败回非 0（让微信重试）', async () => {
  nextResult = { ok: false, errcode: 1, errmsg: '用户反查失败' };
  const res = await app.inject({ method: 'POST', url: `${config.apiPrefix}/pay/wx-notify?${qs()}`, payload: { Event: 'xpay_goods_deliver_notify' } });
  assert.equal(res.json().ErrCode, 1);
});

test('E-6 XML 数据格式：请求可解析、应答是 XML 串', async () => {
  const xml = '<xml><Event><![CDATA[xpay_goods_deliver_notify]]></Event><openid><![CDATA[o1]]></openid></xml>';
  const res = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/pay/wx-notify?${qs()}&data_format=xml`,
    payload: xml, headers: { 'content-type': 'text/xml' },
  });
  assert.match(res.body, /<ErrCode>0<\/ErrCode>/);
  assert.equal(handlerCalls[0].event, 'xpay_goods_deliver_notify');
  assert.equal(handlerCalls[0].payload.openid, 'o1');
});

test('E-7 无 authorization 头也能收到（该路由不挂 JWT）', async () => {
  const res = await app.inject({ method: 'POST', url: `${config.apiPrefix}/pay/wx-notify?${qs()}`, payload: { Event: 'xpay_refund_notify' } });
  assert.equal(res.statusCode, 200);
});

test('E-8 密文分支 appId 不符→回非 0 且不进业务（验签失败绝不发货，spec §9）', async () => {
  const enc = encryptPushMessageForTest({ aesKey: AES, appId: 'wxNOTOURS', plain: '{"Event":"xpay_goods_deliver_notify"}' });
  const res = await app.inject({ method: 'POST', url: `${config.apiPrefix}/pay/wx-notify?${qs()}`, payload: { Encrypt: enc } });
  assert.notEqual(res.json().ErrCode, 0);
  assert.deepEqual(handlerCalls, []);
});

test('E-9 信封密钥缺失时拒收（回非 0）', async () => {
  __setPushEnvelopeForTest({ pushToken: '', pushAesKey: '', appId: '' });
  const res = await app.inject({ method: 'POST', url: `${config.apiPrefix}/pay/wx-notify?${qs()}`, payload: { Event: 'xpay_goods_deliver_notify' } });
  assert.notEqual(res.json().ErrCode, 0);
  assert.deepEqual(handlerCalls, []);
});

test('E-10 iOS 问询的应答带 result_code 与 evidence（回包字段名待真单核对）', async () => {
  nextResult = { ok: true, iosAnswer: { result_code: 1, evidence: '用户已使用 10 天，不建议退款' } };
  const res = await app.inject({
    method: 'POST', url: `${config.apiPrefix}/pay/wx-notify?${qs()}`,
    payload: { Event: 'xpay_subscribe_ios_refund_query_notify', out_trade_no: 'ST1' },
  });
  assert.equal(res.json().ErrCode, 0);
  assert.equal(res.json().result_code, 1);
  assert.match(res.json().evidence, /不建议退款/);
});
