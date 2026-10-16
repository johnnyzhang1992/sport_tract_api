import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { FootprintRecordModel } from '../src/models/footprint-record.model.js';
import { config } from '../src/config/index.js';
import { MAX_USER_PHOTOS } from '../src/config/constants.js';

/**
 * 每用户累计照片额度（轨迹打点 + 足迹，合计上限 MAX_USER_PHOTOS 张）。
 *
 * 口径（设计拍板）：
 * - 服务端看不到 OSS 直传（POST /oss/credential 只签凭证），所以额度在**落库时按张数差结算**，
 *   used 恒等于「该用户库里存着的照片 URL 颗数」，删除/替换才能精确回补。
 * - 计数只数 photos 数组；photos 空而 photoUrl 有值时算 1 张（与 activity.routes.ts 下发口径一致）。
 * - 签发凭证处先拦一道（额度已满不必白传流量），保存接口再兜一道（防绕过前端直调）。
 * - 存量用户从 0 起算，不回填历史照片数。
 * 跑法：WX_MOCK_LOGIN=true node --import tsx --test test/photo-quota.test.ts
 */
let app: FastifyInstance;
const madeUids: string[] = [];
const madeRecordIds: string[] = [];
const madeActivityIds: string[] = [];

function userIdFromToken(token: string): string {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString()).userId as string;
}

/**
 * 每人一个独立用户：code 走 `openid:` 直通前缀，拿到唯一的 openid 命名空间。
 * 不加前缀会被 wechat mock 按「字符和 % 10000」折成 `mock_openid_XXXX`——那个空间小到
 * 同一文件里两个用例就能撞上（实测 3 跑 2 撞），撞了就共用一个 user 文档、共用一个额度计数，
 * 断言随执行顺序飘红；而且 `mock_openid_` 全命名空间会被 activity.test.ts 的清理整段删掉。
 */
async function freshUser(tag: string): Promise<{ token: string; uid: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: `openid:quota-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const token = res.json().data.accessToken as string;
  const uid = userIdFromToken(token);
  madeUids.push(uid);
  return { token, uid };
}

const usedOf = async (uid: string) => {
  const u = await UserModel.findById(uid).select('photoQuotaUsed').lean();
  return (u?.photoQuotaUsed ?? 0) as number;
};
const setUsed = async (uid: string, n: number) => {
  await UserModel.updateOne({ _id: new Types.ObjectId(uid) }, { $set: { photoQuotaUsed: n } });
};

/** 本 bucket 下该用户的对象 URL；测试环境未配 endpoint 时退回任意 URL（归属闸门会放行） */
function photo(uid: string, name: string): string {
  const base = config.oss.endpoint.replace(/\/$/, '');
  return base ? `${base}/${config.oss.baseDir}/users/${uid}/${name}` : `https://example.com/${name}`;
}

function req(method: string, url: string, token: string, payload?: Record<string, unknown>) {
  return app.inject({
    method: method as 'GET',
    url: `/sport-track/api${url}`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

const fpBody = (uid: string, title: string, n: number) => ({
  visitDate: '2024-05-01',
  title,
  location: { name: '西湖', address: '杭州市西湖区', latitude: 30.24, longitude: 120.15 },
  photos: Array.from({ length: n }, (_, i) => photo(uid, `${title}-${i}.jpg`)),
});

async function createFootprint(token: string, uid: string, title: string, n: number) {
  const res = await req('POST', '/footprint-records', token, fpBody(uid, title, n));
  const id = res.json()?.data?.record?.id as string | undefined;
  if (id) madeRecordIds.push(id);
  return res;
}

async function openActivity(token: string) {
  const res = await req('POST', '/activities', token, { type: 'running', startTime: Date.now() });
  assert.equal(res.statusCode, 200, res.body);
  const id = res.json().data.activityId as string;
  madeActivityIds.push(id);
  return id;
}

const marker = (id: string, photos: string[]) => ({
  id,
  lat: 30.24,
  lng: 120.15,
  timestamp: Date.now(),
  type: 'photo',
  label: '',
  note: '',
  photoUrl: photos[0] ?? '',
  photos,
});

/** 3 个点、相邻约 22m —— 过 MIN_EFFECTIVE_POINTS / MIN_EFFECTIVE_DISTANCE_M 才不会被自动作废 */
const finalPoints = () =>
  [0, 1, 2].map((i) => ({ seq: i + 1, lat: 30.24 + i * 0.0002, lng: 120.15, timestamp: Date.now() + i * 5000 }));

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  if (madeRecordIds.length) await FootprintRecordModel.deleteMany({ _id: { $in: madeRecordIds.map((i) => new Types.ObjectId(i)) } });
  if (madeActivityIds.length) await ActivityModel.deleteMany({ _id: { $in: madeActivityIds.map((i) => new Types.ObjectId(i)) } });
  if (madeUids.length) await UserModel.deleteMany({ _id: { $in: madeUids.map((i) => new Types.ObjectId(i)) } });
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

test('PQ1 足迹存 3 张：额度扣 3', async () => {
  const { token, uid } = await freshUser('pq1');
  const created = await createFootprint(token, uid, '额度PQ1', 3);
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(await usedOf(uid), 3);
});

test('PQ2 剩余额度 1 张时存 2 张：400、文案含上限与本次所需、足迹不落库、额度不动', async () => {
  const { token, uid } = await freshUser('pq2');
  await setUsed(uid, MAX_USER_PHOTOS - 1);

  const res = await createFootprint(token, uid, '额度PQ2', 2);

  assert.equal(res.statusCode, 400, res.body);
  const msg = res.json().message as string;
  assert.match(msg, new RegExp(String(MAX_USER_PHOTOS)), `提示要含上限，实际「${msg}」`);
  assert.match(msg, /2/, `提示要含本次需要的张数，实际「${msg}」`);
  assert.equal(await FootprintRecordModel.countDocuments({ title: '额度PQ2' }), 0, '被拒不能留下半成品');
  assert.equal(await usedOf(uid), MAX_USER_PHOTOS - 1, '结算失败不能把额度扣掉');
});

test('PQ3 剩余额度 1 张时两个并发各存 1 张：只成一个，额度不超', async () => {
  const { token, uid } = await freshUser('pq3');
  await setUsed(uid, MAX_USER_PHOTOS - 1);

  const [a, b] = await Promise.all([
    createFootprint(token, uid, '额度PQ3A', 1),
    createFootprint(token, uid, '额度PQ3B', 1),
  ]);

  const okCount = [a, b].filter((r) => r.statusCode === 200).length;
  assert.equal(okCount, 1, `并发下只能成一个，实际 ${a.statusCode}/${b.statusCode}`);
  assert.equal(await usedOf(uid), MAX_USER_PHOTOS);
  await FootprintRecordModel.deleteMany({ title: /^额度PQ3/ });
});

test('PQ4 足迹等量换图（3→3）：额度不变', async () => {
  const { token, uid } = await freshUser('pq4');
  const created = await createFootprint(token, uid, '额度PQ4', 3);
  const id = created.json().data.record.id as string;

  const res = await req('PUT', `/footprint-records/${id}`, token, fpBody(uid, '额度PQ4', 3));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await usedOf(uid), 3, '换图张数没变，额度不该动');
});

test('PQ5 足迹减图（3→1）：退回 2 张', async () => {
  const { token, uid } = await freshUser('pq5');
  const created = await createFootprint(token, uid, '额度PQ5', 3);
  const id = created.json().data.record.id as string;

  const res = await req('PUT', `/footprint-records/${id}`, token, fpBody(uid, '额度PQ5', 1));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await usedOf(uid), 1);
});

test('PQ6 删除足迹：该条照片数全部退回', async () => {
  const { token, uid } = await freshUser('pq6');
  await createFootprint(token, uid, '额度PQ6', 2);
  assert.equal(await usedOf(uid), 2);

  const id = (await FootprintRecordModel.findOne({ title: '额度PQ6' }).lean())?._id as Types.ObjectId;
  const res = await req('DELETE', `/footprint-records/${id.toString()}`, token);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await usedOf(uid), 0);
});

test('PQ7 打点新增 2 张→+2；同 id 幂等覆盖成 3 张→只净增 1 张', async () => {
  const { token, uid } = await freshUser('pq7');
  const aid = await openActivity(token);

  const first = await req('POST', `/activities/${aid}/markers`, token, marker('m1', [photo(uid, 'a.jpg'), photo(uid, 'b.jpg')]));
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(await usedOf(uid), 2);

  const again = await req('POST', `/activities/${aid}/markers`, token, marker('m1', [photo(uid, 'a.jpg'), photo(uid, 'b.jpg'), photo(uid, 'c.jpg')]));
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(await usedOf(uid), 3, '同 id 是覆盖不是追加：2→3 只该净增 1 张');
});

test('PQ8 删除打点：照片数退回', async () => {
  const { token, uid } = await freshUser('pq8');
  const aid = await openActivity(token);
  await req('POST', `/activities/${aid}/markers`, token, marker('m1', [photo(uid, 'a.jpg'), photo(uid, 'b.jpg'), photo(uid, 'c.jpg')]));
  assert.equal(await usedOf(uid), 3);

  const res = await req('DELETE', `/activities/${aid}/markers/m1`, token);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await usedOf(uid), 0);
});

test('PQ9 finish 全量替换 markers：净增按差扣、净减按差退；重复 finish 不二次结算', async () => {
  const inc = await freshUser('pq9inc');
  const aidA = await openActivity(inc.token);
  await req('POST', `/activities/${aidA}/markers`, inc.token, marker('m1', [photo(inc.uid, 'a.jpg'), photo(inc.uid, 'b.jpg')]));
  assert.equal(await usedOf(inc.uid), 2);

  const up = await req('PUT', `/activities/${aidA}/finish`, inc.token, {
    trackPoints: finalPoints(),
    endTime: Date.now(),
    pausedMs: 0,
    markers: [
      marker('m1', [photo(inc.uid, 'a.jpg'), photo(inc.uid, 'b.jpg')]),
      marker('m2', [photo(inc.uid, 'c.jpg'), photo(inc.uid, 'd.jpg'), photo(inc.uid, 'e.jpg')]),
    ],
  });
  assert.equal(up.statusCode, 200, up.body);
  assert.equal(await usedOf(inc.uid), 5, 'final 包里多了 m2 的 3 张，要一起扣');

  const retry = await req('PUT', `/activities/${aidA}/finish`, inc.token, {
    trackPoints: finalPoints(),
    endTime: Date.now(),
    pausedMs: 0,
    markers: [marker('m1', [photo(inc.uid, 'a.jpg')])],
  });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(await usedOf(inc.uid), 5, '重复 finish 走幂等早退，不能把同一场再结算一遍');

  const dec = await freshUser('pq9dec');
  const aidB = await openActivity(dec.token);
  await req('POST', `/activities/${aidB}/markers`, dec.token, marker('m1', [photo(dec.uid, 'a.jpg'), photo(dec.uid, 'b.jpg')]));
  const down = await req('PUT', `/activities/${aidB}/finish`, dec.token, {
    trackPoints: finalPoints(),
    endTime: Date.now(),
    pausedMs: 0,
    markers: [marker('m1', [photo(dec.uid, 'a.jpg')])],
  });
  assert.equal(down.statusCode, 200, down.body);
  assert.equal(await usedOf(dec.uid), 1, 'final 包只剩 1 张，另一张要退回来');
});

test('PQ10 finish 超额度：400 且活动仍在进行中（不能被改成已结束）', async () => {
  const { token, uid } = await freshUser('pq10');
  const aid = await openActivity(token);
  await setUsed(uid, MAX_USER_PHOTOS - 1);

  const res = await req('PUT', `/activities/${aid}/finish`, token, {
    trackPoints: finalPoints(),
    endTime: Date.now(),
    pausedMs: 0,
    markers: [marker('m1', [photo(uid, 'a.jpg'), photo(uid, 'b.jpg')])],
  });

  assert.equal(res.statusCode, 400, res.body);
  const doc = await ActivityModel.findById(aid).select('status').lean();
  assert.equal(doc?.status, 'in_progress', '结算失败时不能把活动写成已结束，否则用户删完照片也救不回这场');
  assert.equal(await usedOf(uid), MAX_USER_PHOTOS - 1);
});

test('PQ11 删除整场轨迹：里面所有照片数退回', async () => {
  const { token, uid } = await freshUser('pq11');
  const aid = await openActivity(token);
  await req('POST', `/activities/${aid}/markers`, token, marker('m1', [photo(uid, 'a.jpg'), photo(uid, 'b.jpg')]));
  await req('POST', `/activities/${aid}/markers`, token, marker('m2', [photo(uid, 'c.jpg')]));
  assert.equal(await usedOf(uid), 3);

  const res = await req('DELETE', `/activities/${aid}`, token);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await usedOf(uid), 0);
});

test('PQ12 签发直传凭证：额度已满直接拒，未满时下发剩余额度', async () => {
  const { token, uid } = await freshUser('pq12');
  await setUsed(uid, MAX_USER_PHOTOS);

  const full = await req('POST', '/oss/credential', token, { dir: 'footprint' });
  assert.equal(full.statusCode, 400, full.body);
  assert.match(full.json().message, new RegExp(String(MAX_USER_PHOTOS)));

  await setUsed(uid, MAX_USER_PHOTOS - 2);
  const ok = await req('POST', '/oss/credential', token, { dir: 'footprint' });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().data.photoQuotaRemaining, 2, '把剩余额度带出去，前端才不用自己算');
});

test('PQ13 存量用户文档没有该字段：按 0 起算，能正常扣', async () => {
  const { token, uid } = await freshUser('pq13');
  await UserModel.updateOne({ _id: new Types.ObjectId(uid) }, { $unset: { photoQuotaUsed: 1 } });

  const created = await createFootprint(token, uid, '额度PQ13', 2);

  assert.equal(created.statusCode, 200, created.body);
  assert.equal(await usedOf(uid), 2);
});

test('PQ15 编辑打点减图（3→1）：额度退回 2 张', async () => {
  const { token, uid } = await freshUser('pq15');
  const aid = await openActivity(token);
  await req('POST', `/activities/${aid}/markers`, token, marker('m1', [photo(uid, 'a.jpg'), photo(uid, 'b.jpg'), photo(uid, 'c.jpg')]));
  assert.equal(await usedOf(uid), 3);

  const res = await req('PUT', `/activities/${aid}/markers/m1`, token, {
    photos: [photo(uid, 'a.jpg'), photo(uid, 'b.jpg')],
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await usedOf(uid), 2, '编辑打点把第三张换掉了，额度要跟着退');
});

test('PQ16 老口径打点（只有 photoUrl、无 photos）：算 1 张', async () => {
  const { token, uid } = await freshUser('pq16');
  const aid = await openActivity(token);

  const res = await req('POST', `/activities/${aid}/markers`, token, {
    id: 'm1', lat: 30.24, lng: 120.15, timestamp: Date.now(), type: 'photo', note: '', photoUrl: photo(uid, 'a.jpg'),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await usedOf(uid), 1, 'photos 缺失时要回退 photoUrl 计数，否则老客户端能绕开额度');
});

test('PQ17 空串占位不算一张', async () => {
  const { token, uid } = await freshUser('pq17');
  const aid = await openActivity(token);

  const res = await req('POST', `/activities/${aid}/markers`, token, marker('m1', ['', '']));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await usedOf(uid), 0, '未拍照时端上提交的是空串，占额度就是冤枉的');
});

test('PQ14 回补数大于已用数：归零不出现负数', async () => {
  const { token, uid } = await freshUser('pq14');
  const created = await createFootprint(token, uid, '额度PQ14', 3);
  const id = created.json().data.record.id as string;
  await setUsed(uid, 1); // 人为把账做坏（例如手工清过库）

  const res = await req('DELETE', `/footprint-records/${id}`, token);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await usedOf(uid), 0, '退 3 只用了 1，兜平到 0 而不是 -2');
});
