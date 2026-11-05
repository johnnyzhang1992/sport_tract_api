import axios from 'axios';
import { config } from '../config/index.js';
import { AppError } from '../utils/app-error.js';

interface Code2SessionResult {
  openid: string;
  sessionKey: string;
  unionid?: string;
}

/**
 * 微信小程序登录：code 换 openid
 * 文档：POST /api/auth/login → jscode2session
 *
 * 本地开发（WX_MOCK_LOGIN=true）时不需要真实 AppID，
 * code 直接映射为固定测试 openid，方便联调。
 */
export async function code2Session(code: string): Promise<Code2SessionResult> {
  // ── mock 模式（仅开发环境）──
  if (config.wxMockLogin) {
    if (!config.isDev) {
      throw new AppError(500, 'WX_MOCK_LOGIN 仅允许在开发环境开启');
    }
    // session_key 按真实口径给 base64：真实值是 Base64_Decode 后 16 字节的 AES key，
    // mock 给定长 base64（'0123456789abcdef' 的编码）才能让 werun 解密在测试里跑通加解密回环
    const mockSessionKey = 'MDEyMzQ1Njc4OWFiY2RlZg==';
    // 不同 code 映射不同 openid，便于测试多账号
    // code 形如 "openid:自定义" 时直接透传自定义 openid——测试可用独立命名空间，
    // 避免被其他测试文件的全局 mock_openid_ 清理误伤（并行跑时互相删用户）
    if (code.startsWith('openid:')) {
      return { openid: code.slice('openid:'.length), sessionKey: mockSessionKey };
    }
    const hash = [...code].reduce((acc, c) => acc + c.charCodeAt(0), 0);
    return {
      openid: `mock_openid_${(hash % 10000).toString().padStart(4, '0')}`,
      sessionKey: mockSessionKey,
    };
  }

  if (!config.wxAppid || !config.wxSecret) {
    throw new AppError(
      500,
      'WX_APPID / WX_SECRET 未配置，请设置环境变量或开启 WX_MOCK_LOGIN=true',
    );
  }

  const url = 'https://api.weixin.qq.com/sns/jscode2session';
  const { data } = await axios.get<{
    openid?: string;
    session_key?: string;
    unionid?: string;
    errcode?: number;
    errmsg?: string;
  }>(url, {
    params: {
      appid: config.wxAppid,
      secret: config.wxSecret,
      js_code: code,
      grant_type: 'authorization_code',
    },
    timeout: 5000,
  });

  if (data.errcode && data.errcode !== 0) {
    throw new AppError(401, `微信登录失败: ${data.errmsg ?? data.errcode}`);
  }
  if (!data.openid) {
    throw new AppError(401, '微信登录失败: 未获取到 openid');
  }

  return {
    openid: data.openid,
    sessionKey: data.session_key ?? '',
    unionid: data.unionid,
  };
}
