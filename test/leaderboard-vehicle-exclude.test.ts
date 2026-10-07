import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';

/**
 * 本榜最佳「最长距离 / 最快配速」排除疑似搭车（vehicleMs>0）的轨迹。
 *
 * 一条轨迹只要被车辆段检测标过（vehicleMs>0），它的距离 / 配速就不再可信——未检出的行车段
 * 会把「最快 1km」刷成人类做不到的配速，整条纪录不该挂在榜上。
 * 判据必须容忍**缺 vehicleMs 字段的老文档**（字段是后加的）：写成 $lte:0 会把它们全排掉。
 *
 * 确定性：用一个专属省份名隔离，只让本文件播种的轨迹命中榜单，不依赖 dev 库其它数据。
 */

const PROVINCE = '测试省榜单专用';

let app: FastifyInstance;
let token = '';
let userId = '';

const NOW = Date.now();

async function loginMock(openid: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: openid },
  });
  assert.equal(res.statusCode, 200, `登录失败: ${res.body}`);
  const body = res.json().data;
  return { userId: body.user?.id ?? body.user?._id, token: body.accessToken };
}

/** 造一条跑步轨迹（本文件只测跑步：只有 running 有「最快配速」纪录） */
async function seedRunning(fields: Record<string, unknown>) {
  const doc = await ActivityModel.create({
    userId,
    status: 'finished',
    type: 'running',
    startTime: NOW,
    provinces: [PROVINCE],
    ...fields,
  });
  return String(doc._id);
}

async function fetchRunningBest(): Promise<Array<{ key: string; value: number }>> {
  const res = await app.inject({
    method: 'GET',
    url: `/sport-track/api/stats/leaderboard?type=running&period=all&province=${encodeURIComponent(PROVINCE)}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.best;
}

const pick = (best: Array<{ key: string; value: number }>, key: string) => best.find((b) => b.key === key);

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const me = await loginMock('mock_openid_lb_vehicle');
  userId = me.userId;
  token = me.token;
  await ActivityModel.deleteMany({ userId });
});

after(async () => {
  await ActivityModel.deleteMany({ userId });
  await UserModel.deleteMany({ _id: userId });
  await app.close();
});

test('LBV1 疑似搭车的轨迹不占「最长距离 / 最快配速」纪录（纪录落到没搭车的那条）', async () => {
  // 搭车那条两项都更优：距离更远、最快 1km 更快（150 仍在可信下限 130 之上，不是靠"不可能配速"被挡）
  await seedRunning({ distance: 5000, duration: 3000, fastestKm: 150, vehicleMs: 90000, vehicleM: 4000 });
  // 干净那条更差
  await seedRunning({ distance: 4000, duration: 4000, fastestKm: 200 });

  const best = await fetchRunningBest();
  assert.equal(pick(best, 'farthest')?.value, 4000, '最长距离应落到没搭车的那条');
  assert.equal(pick(best, 'fastestKm')?.value, 200, '最快配速应落到没搭车的那条');
});

test('LBV2 缺 vehicleMs 字段的老文档不被误伤（判据写成 $lte:0 会把它整条排掉）', async () => {
  const id = await seedRunning({ distance: 9000, duration: 6000, fastestKm: 220 });
  // 模拟字段上线前入库的老文档：把默认写进去的 0 删掉，让它真的没有这个字段
  await ActivityModel.updateOne({ _id: id }, { $unset: { vehicleMs: 1 } });

  const best = await fetchRunningBest();
  assert.equal(pick(best, 'farthest')?.value, 9000, '没有该字段的老轨迹仍应能占纪录');
});
