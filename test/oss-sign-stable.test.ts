/**
 * 签名 URL 稳定性（防图片反复重载闪烁）：
 * 同一 key+档位在一个量化窗口内多次签发必须返回完全相同的 URL，
 * 否则小程序/浏览器图片缓存永远不命中，每次 onShow 重拉都整屏重载闪一遍。
 * 跨窗口才允许换 URL（签名过期刷新）。
 * 用注入 Date.now 模拟不同签发时刻；OSS 未配置时跳过（本地裸跑不红）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, isOssConfigured } from '../src/config/index.js';
import { getThumbUrl, getAvatarUrl } from '../src/services/oss.js';

const WINDOW = 900; // 与实现保持一致的量化窗口（秒）

test('同一窗口内多次签发 URL 逐字相同；跨窗口才变化', () => {
  if (!isOssConfigured()) return; // 未配置 OSS 时原样返回，无签名可谈
  const key = `${config.oss.endpoint.replace(/\/$/, '')}/${config.oss.baseDir}/users/stability-test/a.png`;

  const realNow = Date.now;
  // 取一个窗口起点，避免 t 恰好跨窗
  const t = Math.floor(realNow() / 1000 / WINDOW) * WINDOW * 1000;
  try {
    Date.now = () => t;
    const a1 = getThumbUrl(key);
    Date.now = () => t + 5000; // 同窗口内 +5s
    const a2 = getThumbUrl(key);
    assert.equal(a2, a1, '同窗口内 URL 必须逐字相同（缓存才能命中）');

    Date.now = () => t + 1000; // 跨秒但仍同窗
    const a3 = getThumbUrl(key);
    assert.equal(a3, a1, '跨秒不跨窗也应相同');

    Date.now = () => t + WINDOW * 1000; // 下一个窗口
    const b1 = getThumbUrl(key);
    assert.notEqual(b1, a1, '跨窗口应换 URL（签名刷新）');

    // 档位不同 URL 不同（process 进签名串）
    Date.now = () => t;
    assert.notEqual(getAvatarUrl(key), a1, 'avatar 与 thumb 档位 URL 不同');
    assert.match(a1, /[?&]Signature=/, '仍须签名');
  } finally {
    Date.now = realNow;
  }
});
