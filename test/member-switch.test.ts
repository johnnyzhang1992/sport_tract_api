/**
 * 会员付费总开关（spec §11.7）：app_settings.memberPaymentsEnabled，后台可拨、30s 内全网生效。
 * 逐条照 board-switch 的纪律验：无行=env 缺省、写后本实例立即生效、缓存 TTL 到期才重读库。
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/member-switch.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { AppSettingModel } from '../src/models/app-setting.model.js';
import {
  isMemberPaymentsEnabled,
  setMemberPaymentsEnabled,
  resetMemberSwitchCacheForTest,
  MEMBER_SWITCH_KEY,
} from '../src/services/member-switch.js';

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
});
beforeEach(async () => {
  await AppSettingModel.deleteMany({ _id: MEMBER_SWITCH_KEY });
  resetMemberSwitchCacheForTest();
});
after(async () => {
  await AppSettingModel.deleteMany({ _id: MEMBER_SWITCH_KEY });
  await mongoose.disconnect().catch(() => {});
});

test('MS-1 没有设置行时回落 env 种子值（缺省 false＝部署即关，保留先上线后放量）', async () => {
  assert.equal(config.memberPaymentsEnabled, false, 'env 缺省必须是 false');
  assert.equal(await isMemberPaymentsEnabled(), false);
});

test('MS-2 开→关→开逐次立即生效，且真的写进了库', async () => {
  await setMemberPaymentsEnabled(true);
  assert.equal(await isMemberPaymentsEnabled(), true);
  const row = await AppSettingModel.findById(MEMBER_SWITCH_KEY).lean();
  assert.ok(row, '写侧必须落库，不能只改内存');
  assert.equal(row.value, true);
  await setMemberPaymentsEnabled(false);
  assert.equal(await isMemberPaymentsEnabled(), false);
});

test('MS-3 缓存 30s：库被旁路改掉后 TTL 内仍读到旧值，过期后收敛', async () => {
  await setMemberPaymentsEnabled(true);
  // 写侧把本实例缓存钉成「永不过期」（这是 board-switch 的既定行为），
  // 所以这条测试要显式清一次缓存，模拟「另一个实例/重启后的第一次读」
  resetMemberSwitchCacheForTest();
  assert.equal(await isMemberPaymentsEnabled(), true);
  await AppSettingModel.updateOne({ _id: MEMBER_SWITCH_KEY }, { $set: { value: false } });
  assert.equal(await isMemberPaymentsEnabled(1), true, '未过期仍读缓存');
  assert.equal(await isMemberPaymentsEnabled(Date.now() + 31_000), false, '过期后重读库');
});

test('MS-4 库里存的就是布尔真值（不是字符串 "true"）', async () => {
  await setMemberPaymentsEnabled(true);
  const row = await AppSettingModel.findById(MEMBER_SWITCH_KEY).lean();
  assert.equal(row?.value, true);
});
