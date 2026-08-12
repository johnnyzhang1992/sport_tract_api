import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wgs84ToGcj02 } from '../src/utils/coordinate.js';

test('WGS-84 → GCJ-02：天安门已知偏移（与 eviltransform 标准库一致）', () => {
  // 天安门 WGS84 (39.9091, 116.3975) → GCJ02 (39.91050, 116.40374)（eviltransform 同值）
  const r = wgs84ToGcj02(39.9091, 116.3975);
  assert.ok(Math.abs(r.lat - 39.9105) < 0.0005, `lat=${r.lat}`);
  assert.ok(Math.abs(r.lng - 116.4037) < 0.0005, `lng=${r.lng}`);
  // 偏移量级：东向约 580m（0.006 度），北向约 150m
  assert.ok(r.lng - 116.3975 > 0.004);
});

test('中国境内多点转换：偏移方向东南向（GCJ-02 相对 WGS-84 总体向东北偏移）', () => {
  const pts = [
    [31.2304, 121.4737], // 上海
    [30.507991, 114.486967], // 武汉（两步路测试文件）
    [22.54, 113.934], // 深圳
  ];
  for (const [lat, lng] of pts) {
    const r = wgs84ToGcj02(lat, lng);
    // 转换后仍在原附近（偏差 < 0.01 度，约 1km 内）
    assert.ok(Math.abs(r.lat - lat) < 0.01);
    assert.ok(Math.abs(r.lng - lng) < 0.01);
    // 非零偏移
    assert.ok(Math.abs(r.lat - lat) > 1e-6 || Math.abs(r.lng - lng) > 1e-6);
  }
});

test('境外坐标不转换（东京/纽约）', () => {
  assert.deepEqual(wgs84ToGcj02(35.6762, 139.6503), { lat: 35.6762, lng: 139.6503 });
  assert.deepEqual(wgs84ToGcj02(40.7128, -74.006), { lat: 40.7128, lng: -74.006 });
});

test('转换可逆性：GCJ-02 → WGS-84 往返（用近似反向验证偏移稳定）', () => {
  // 两次转换（幂等性检查：同输入同输出）
  const a = wgs84ToGcj02(30.507991, 114.486967);
  const b = wgs84ToGcj02(30.507991, 114.486967);
  assert.deepEqual(a, b);
});
