import axios from 'axios';
import { getAccessToken } from './wechat-sec.js';

export interface SubscribeSendInput {
  openid: string;
  templateId: string;
  page?: string;
  data: Record<string, { value: string }>;
  miniprogramState?: 'developer' | 'trial' | 'formal';
  lang?: 'zh_CN' | 'en_US' | 'zh_HK' | 'zh_TW';
}

export interface SubscribeSendResult {
  errcode: number;
  errmsg: string;
}

/** 小程序订阅消息下发（一次性订阅；每次调用消耗一条用户授权额度） */
export async function sendSubscribeMessage(input: SubscribeSendInput): Promise<SubscribeSendResult> {
  const token = await getAccessToken();
  if (!token) return { errcode: -1, errmsg: 'access_token 不可用' };
  const res = await axios.post(
    `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`,
    {
      touser: input.openid,
      template_id: input.templateId,
      page: input.page,
      miniprogram_state: input.miniprogramState ?? 'formal',
      lang: input.lang ?? 'zh_CN',
      data: input.data,
    },
    { timeout: 8000 },
  );
  return {
    errcode: Number(res.data?.errcode ?? 0),
    errmsg: String(res.data?.errmsg ?? ''),
  };
}
