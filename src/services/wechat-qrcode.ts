import axios from 'axios';
import { config } from '../config/index.js';
import { AppError } from '../utils/app-error.js';
import { callWithRetry } from './wechat-sec.js';

/**
 * 生成小程序码（决策 F22 分享海报）
 * 调 wx.getUnlimitedQRCode，scene 传 activityId（≤32 字符），扫码直达轨迹详情
 * @returns PNG buffer
 */
export async function getUnlimitedQRCode(scene: string, page = 'pages/track-detail/track-detail'): Promise<Buffer> {
  if (!config.wxAppid || !config.wxSecret) {
    throw new AppError(503, 'WX_APPID / WX_SECRET 未配置');
  }

  return callWithRetry(async (token) => {
    const res = await axios.post(
      `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${token}`,
      {
        scene: String(scene).slice(0, 32),
        page,
        width: 430,
        check_path: false,
        env_version: config.nodeEnv === 'production' ? 'release' : 'develop',
      },
      { responseType: 'arraybuffer', timeout: 8000 },
    );

    // 错误时返回 JSON（buffer 内含 errcode）；带 errcode 抛出，token 失效时 callWithRetry 清缓存重试
    const contentType = String(res.headers['content-type'] || '');
    if (contentType.includes('json')) {
      const text = Buffer.from(res.data).toString('utf8');
      let msg = text;
      let errcode: number | undefined;
      try {
        const d = JSON.parse(text);
        msg = d.errmsg || `errcode=${d.errcode}`;
        errcode = d.errcode;
      } catch {
        // keep raw
      }
      throw new AppError(500, `小程序码生成失败: ${msg}`, errcode !== undefined ? { errcode } : undefined);
    }

    return Buffer.from(res.data);
  });
}
