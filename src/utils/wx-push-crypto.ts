/**
 * 微信小程序消息推送的信封处理（spec §6.2）。
 * 当前后台配置＝兼容模式 + JSON，所以两条分支都要在：明文（安全模式被切走时）与 Encrypt 密文。
 * 密文模式下的来源证明＝内层 appId 必须与期望 appId 相等——只看「解密成功」是不够的，
 * 任何拿到同一 AESKey 的人都能构造出可解密的包。
 */
import { createCipheriv, createHash, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const PKCS7_BLOCK = 32;

function pkcs7Pad(buf: Buffer): Buffer {
  const pad = PKCS7_BLOCK - (buf.length % PKCS7_BLOCK) || PKCS7_BLOCK;
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

function pkcs7Unpad(buf: Buffer): Buffer {
  const pad = buf[buf.length - 1];
  // 填充字节必须在 1..32 且逐字节一致，否则是坏包（截断/被改过）——不许静默吞下越界读
  if (pad < 1 || pad > PKCS7_BLOCK || pad > buf.length) throw new Error('解密失败：填充不合法');
  for (let i = buf.length - pad; i < buf.length; i++) if (buf[i] !== pad) throw new Error('解密失败：填充不合法');
  return buf.subarray(0, buf.length - pad);
}

function keyOf(aesKey: string): Buffer {
  const key = Buffer.from(`${aesKey}=`, 'base64');
  if (key.length !== 32) throw new Error(`EncodingAESKey 长度不合法（解出 ${key.length} 字节，应为 32）`);
  return key;
}

/** GET 校验：sha1(sort(token, timestamp, nonce))，比对用恒定时间 */
export function verifyPushGet(p: { token: string; timestamp: string; nonce: string; signature: string }): boolean {
  if (!p.token || !p.timestamp || !p.nonce || !p.signature) return false;
  const expected = createHash('sha1').update([p.token, p.timestamp, p.nonce].sort().join('')).digest('hex');
  const sig = String(p.signature);
  // 必须是 40 位 hex（SHA1＝20 字节）：Buffer.from(hex) 会把半截/非法字符静默截短，
  // 长度检查若放在这之后就没有意义了
  if (!/^[0-9a-f]{40}$/i.test(sig)) return false;
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sig, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function decryptPushMessage(p: { aesKey: string; appId: string; encryptBase64: string }): string {
  const key = keyOf(p.aesKey);
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const plain = pkcs7Unpad(Buffer.concat([decipher.update(Buffer.from(p.encryptBase64, 'base64')), decipher.final()]));
  const msgLen = plain.readUInt32BE(16);
  if (msgLen < 0 || 20 + msgLen > plain.length) throw new Error(`解密失败：消息长度越界（${msgLen} > ${plain.length - 20}）`);
  const msg = plain.subarray(20, 20 + msgLen).toString('utf8');
  const fromAppId = plain.subarray(20 + msgLen).toString('utf8');
  if (fromAppId !== p.appId) throw new Error(`解密失败：appid 不符（收到 ${fromAppId || '空'}）`);
  return msg;
}

/** 只给测试用的加密器（把上面的布局反向走一遍，避免测试里手搓字节） */
export function encryptPushMessageForTest(p: { aesKey: string; appId: string; plain: string }): string {
  const key = keyOf(p.aesKey);
  const msg = Buffer.from(p.plain, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(msg.length, 0);
  const body = pkcs7Pad(Buffer.concat([randomBytes(16), len, msg, Buffer.from(p.appId, 'utf8')]));
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(body), cipher.final()]).toString('base64');
}
