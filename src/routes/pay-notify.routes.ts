/**
 * 微信消息推送接收端（spec §6.2）：公开、无 JWT、不走统一 success() 封装。
 *
 * 三条纪律：
 * 1) 应答形态按「数据格式」二选一——JSON 回对象、XML 回 <xml> 串，回错形态微信判失败并重试；
 * 2) 未知事件回 ErrCode 0 吞掉：不吞就有 15 次重试，把日志刷满且没有任何信息量；
 * 3) 业务处理失败回非 0 让微信重试（发货这类可重试），但格式/来源不对的包直接回 0 丢掉并告警
 *    （重试改变不了结果）。
 * 业务实现与信封解耦：handler 由 services/xpay-deliver.ts 注入（测试用 __setNotifyHandlerForTest）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { XMLParser } from 'fast-xml-parser';
import { pushEnvelopeConfig, isXpayPushConfigured } from '../config/xpay.js';
import { verifyPushGet, decryptPushMessage } from '../utils/wx-push-crypto.js';

export interface NotifyResult {
  ok: boolean;
  /** 非 0 时微信会重试；缺省 1 */
  errcode?: number;
  errmsg?: string;
  /** true＝处理过但不许重试（陌生单这类丢掉了结的），仍回 0 */
  dropNoRetry?: boolean;
  /** iOS 退款问询的业务应答（spec §7.4）；其余事件不用 */
  iosAnswer?: { result_code: 0 | 1; evidence: string };
}

export type NotifyHandler = (event: string, payload: Record<string, unknown>) => Promise<NotifyResult>;

let handler: NotifyHandler = async () => {
  // 默认实现：业务处理器还没接上时按失败处理，绝不假成功（付了钱没权益比收不到推送更糟）
  console.error('[pay-notify] 业务处理器未接入');
  return { ok: false, errcode: 2, errmsg: 'handler not wired' };
};

export function __setNotifyHandlerForTest(f: NotifyHandler | null): void {
  handler = f ?? handler;
}

/** Task 9 正式接入用（非测试） */
export function setNotifyHandler(f: NotifyHandler): void {
  handler = f;
}

const KNOWN_EVENTS = [
  'xpay_goods_deliver_notify',
  'xpay_refund_notify',
  'xpay_subscribe_ios_refund_query_notify',
  'xpay_complaint_notify',
];

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });

/** fast-xml-parser 会把根 <xml> 留成一层：剥掉它拿正文 */
function unwrap(node: unknown): Record<string, unknown> {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const o = node as Record<string, unknown>;
    if (Object.keys(o).length === 1 && o.xml && typeof o.xml === 'object') {
      return unwrap((o.xml as Record<string, unknown>).xml ?? o.xml);
    }
    return o;
  }
  return {};
}

function wantsXml(request: FastifyRequest): boolean {
  const q = request.query as { data_format?: string };
  const ct = String(request.headers['content-type'] ?? '');
  return q.data_format === 'xml' || ct.includes('xml');
}

function replyOk(reply: FastifyReply, xml: boolean) {
  return xml
    ? reply.type('application/xml').send('<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>')
    : reply.type('application/json').send({ ErrCode: 0, ErrMsg: 'success' });
}

function replyRetry(reply: FastifyReply, xml: boolean, errcode: number, errmsg: string) {
  return xml
    ? reply.type('application/xml').send(`<xml><ErrCode>${errcode}</ErrCode><ErrMsg><![CDATA[${errmsg}]]></ErrMsg></xml>`)
    : reply.type('application/json').send({ ErrCode: errcode, ErrMsg: errmsg });
}

/**
 * iOS 退款问询的应答：ErrCode 0 + 业务字段。
 * ⚠ 字段名以第一笔真实问询为准（spec §12.2）；业务判定不在这里，集中在 services/xpay-deliver.ts。
 */
function replyIos(reply: FastifyReply, xml: boolean, a: { result_code: 0 | 1; evidence: string }) {
  return xml
    ? reply.type('application/xml').send(
      `<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg>`
      + `<result_code>${a.result_code}</result_code><evidence><![CDATA[${a.evidence}]]></evidence></xml>`,
    )
    : reply.type('application/json').send({ ErrCode: 0, ErrMsg: 'success', result_code: a.result_code, evidence: a.evidence });
}

export async function payNotifyRoutes(fastify: FastifyInstance) {
  // 微信推 XML 时 content-type 是 text/xml，Fastify 默认不认 → 在本插件作用域内注册原始解析器
  fastify.addContentTypeParser(
    ['text/xml', 'application/xml', 'text/plain'],
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  );

  fastify.get('/wx-notify', async (request, reply) => {
    const q = request.query as { signature?: string; timestamp?: string; nonce?: string; echostr?: string };
    const { token } = pushEnvelopeConfig();
    const pass = isXpayPushConfigured() && verifyPushGet({
      token,
      timestamp: String(q.timestamp ?? ''),
      nonce: String(q.nonce ?? ''),
      signature: String(q.signature ?? ''),
    });
    if (!pass || !q.echostr) {
      fastify.log.warn('[pay-notify] GET 校验未通过（signature/timestamp/nonce 或密钥缺失）');
      return reply.code(403).type('text/plain').send('invalid signature');
    }
    // 原样返回，不加引号、不包 JSON：微信按字面比对 echostr
    return reply.type('text/plain').send(q.echostr);
  });

  fastify.post('/wx-notify', async (request, reply) => {
    const xml = wantsXml(request);
    if (!isXpayPushConfigured()) {
      console.error('[pay-notify] 推送密钥未配置，拒收（回非 0 让微信侧能看见失败）');
      return replyRetry(reply, xml, 3, 'push not configured');
    }

    let envelope: Record<string, unknown>;
    try {
      const raw = request.body;
      if (typeof raw === 'string') envelope = unwrap(parser.parse(raw));
      else if (raw && typeof raw === 'object') envelope = raw as Record<string, unknown>;
      else return replyRetry(reply, xml, 4, 'empty body');
    } catch (e) {
      console.error('[pay-notify] 报文解析失败:', (e as Error).message);
      return replyOk(reply, xml); // 坏包重试也解不开，吞掉并留日志
    }

    let payload = envelope;
    const encrypted = typeof envelope.Encrypt === 'string' && envelope.Encrypt.length > 0;
    if (encrypted) {
      try {
        const { aesKey, appId } = pushEnvelopeConfig();
        const plain = decryptPushMessage({ aesKey, appId, encryptBase64: String(envelope.Encrypt) });
        payload = JSON.parse(plain) as Record<string, unknown>;
      } catch (e) {
        // 解不开/appid 不符＝不是我们的推送，绝不进业务（spec §9：验签失败绝不发货）
        console.error('[pay-notify] 解密或来源校验失败:', (e as Error).message);
        return replyRetry(reply, xml, 5, 'decrypt failed');
      }
    }

    const event = String(payload.Event ?? envelope.Event ?? '');
    if (!event) {
      console.warn('[pay-notify] 报文缺 Event，丢弃', Object.keys(payload).join(','));
      return replyOk(reply, xml);
    }
    if (!KNOWN_EVENTS.includes(event)) {
      // 未知事件必须吞：不吞就是 15 次重试（spec §6.2）
      console.warn(`[pay-notify] 未识别的事件 ${event}，按成功吞掉`);
      return replyOk(reply, xml);
    }

    try {
      const r = await handler(event, payload);
      if (r.iosAnswer) return replyIos(reply, xml, r.iosAnswer);
      if (r.ok || r.dropNoRetry) return replyOk(reply, xml);
      return replyRetry(reply, xml, r.errcode ?? 1, r.errmsg ?? 'retry');
    } catch (e) {
      console.error(`[pay-notify] ${event} 处理异常:`, (e as Error).message);
      return replyRetry(reply, xml, 6, 'internal error');
    }
  });
}
