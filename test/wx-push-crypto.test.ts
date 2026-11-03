/**
 * 消息推送信封（spec §6.2、§10.7）。
 * 兼容模式解密的字节布局：random(16) + msgLen(4, 网络序) + msg + appId，AES-256-CBC，
 * key = Base64Decode(EncodingAESKey + '=')，iv = key 前 16 字节。
 * 这里用测试自己造的 key/appId 走一遍「加密→解密→拿回原文」，
 * 再加三刀：错 key、错 appId、截断——三种都必须被拒而不是返回乱码。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/wx-push-crypto.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { verifyPushGet, decryptPushMessage, encryptPushMessageForTest } from '../src/utils/wx-push-crypto.js';

const AES_KEY = randomBytes(32).toString('base64').replace(/=+$/, ''); // 43 位，与后台那个同形态
const APP_ID = 'wxtestappid000000';

function decodeRaw(key: Buffer, raw: Buffer): Buffer {
  const d = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  d.setAutoPadding(false);
  const out = Buffer.concat([d.update(raw), d.final()]);
  return out.subarray(0, out.length - out[out.length - 1]);
}

test('WP-1 GET 校验：sha1(sort(token,timestamp,nonce)) 通过，改一个字节就失败', () => {
  const token = 'push-token-for-test';
  const timestamp = '1730000000';
  const nonce = 'abc123';
  const signature = createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex');
  assert.equal(verifyPushGet({ token, timestamp, nonce, signature }), true);
  const flipped = (signature[0] === '0' ? '1' : '0') + signature.slice(1);
  assert.equal(verifyPushGet({ token, timestamp, nonce, signature: flipped }), false);
  assert.equal(verifyPushGet({ token: 'other', timestamp, nonce, signature }), false, 'token 不同不该仍验过');
});

test('WP-1b 任一参数为空直接拒：token 未配时不能靠「空串也能算出签名」把校验混过去', () => {
  const emptyTokenSig = createHash('sha1').update(['', '1', '2'].sort().join('')).digest('hex');
  assert.equal(verifyPushGet({ token: '', timestamp: '1', nonce: '2', signature: emptyTokenSig }), false);
  assert.equal(verifyPushGet({ token: 't', timestamp: '', nonce: '2', signature: emptyTokenSig }), false);
});

test('WP-2 兼容模式回环：加密→解密逐字相等（含中文与 JSON）', () => {
  const plain = JSON.stringify({ Event: 'xpay_goods_deliver_notify', 备注: '中文' });
  const enc = encryptPushMessageForTest({ aesKey: AES_KEY, appId: APP_ID, plain });
  assert.equal(decryptPushMessage({ aesKey: AES_KEY, appId: APP_ID, encryptBase64: enc }), plain);
});

test('WP-3 错密钥→抛（不返回乱码）', () => {
  const enc = encryptPushMessageForTest({ aesKey: AES_KEY, appId: APP_ID, plain: '{"a":1}' });
  const otherKey = randomBytes(32).toString('base64').replace(/=+$/, '');
  assert.throws(() => decryptPushMessage({ aesKey: otherKey, appId: APP_ID, encryptBase64: enc }));
});

test('WP-4 内层 appId 与配置不符→抛（这是密文模式下的来源证明，不能只解密成功就放行）', () => {
  const enc = encryptPushMessageForTest({ aesKey: AES_KEY, appId: 'wxOTHEROTHEROTHER', plain: '{"a":1}' });
  assert.throws(() => decryptPushMessage({ aesKey: AES_KEY, appId: APP_ID, encryptBase64: enc }), /appid/i);
});

test('WP-5 msgLen 越界（比实际明文长）→抛，而不是多读一段', () => {
  const enc = encryptPushMessageForTest({ aesKey: AES_KEY, appId: APP_ID, plain: '{"a":1}' });
  const buf = Buffer.from(enc, 'base64');
  const len = buf.readUInt32BE(16);
  buf.writeUInt32BE(len + 5, 16);
  assert.throws(() => decryptPushMessage({ aesKey: AES_KEY, appId: APP_ID, encryptBase64: buf.toString('base64') }));
});

test('WP-6 真实实现的布局自检：random 16 + len 4 + msg + appid，长度字段网络序', () => {
  const plain = 'X'.repeat(100);
  const enc = encryptPushMessageForTest({ aesKey: AES_KEY, appId: APP_ID, plain });
  const raw = Buffer.from(enc, 'base64');
  const key = Buffer.from(`${AES_KEY}=`, 'base64');
  const dec = decodeRaw(key, raw);
  assert.equal(dec.readUInt32BE(16), 100);
  assert.equal(dec.subarray(20, 120).toString('utf8'), plain);
  assert.equal(dec.subarray(120).toString('utf8'), APP_ID);
});
