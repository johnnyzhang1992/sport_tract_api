import axios from 'axios';
import { config } from '../config/index.js';

/**
 * 腾讯位置服务 WebService 逆地理编码（决策：从后端调用，避免前端暴露 key）
 * 文档：https://lbs.qq.com/service/webService/webServiceGuide/overview
 * - key 需在控制台勾选启用 WebService API（否则 status 199）
 * - 失败/未配置时返回空字符串（前端降级不显示地址）
 */
export async function reverseGeocode(lat: number, lng: number): Promise<string> {
  if (!config.tencentMapKey) return '';

  try {
    const { data } = await axios.get('https://apis.map.qq.com/ws/geocoder/v1/', {
      params: { location: `${lat},${lng}`, key: config.tencentMapKey },
      timeout: 5000,
    });
    if (data.status === 0 && data.result?.address) {
      return String(data.result.address);
    }
    return '';
  } catch (err) {
    console.warn('[geo] 逆地理编码失败:', (err as Error).message);
    return '';
  }
}
