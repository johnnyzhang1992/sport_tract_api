import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { FootprintRecordModel } from '../src/models/footprint-record.model.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { TopicModel } from '../src/models/topic.model.js';
import { UserModel } from '../src/models/user.model.js';
import { config, isOssConfigured } from '../src/config/index.js';
import { getAvatarUrl, getMediumUrl, getSignedUrl, getThumbUrl } from '../src/services/oss.js';

/**
 * 小程序端渲染缩略图：签名时带 x-oss-process（该参数进签名串，前端拼不了，只能后端出）
 * 口径：列表/气泡/头像一律缩略图，原图留给「点开看大图」，所以两个地址要能并存。
 */

// 上传闸门要求照片 key 必须在 {baseDir}/users/{userId}/ 下，所以种子路径等登录拿到 userId 再拼
let PIC_A = '';
let PIC_B = '';
let AVATAR = '';
const EXT = 'https://wx.qlogo.cn/mmopen/yyy/132';

const processOf = (url: string) => {
  try {
    return new URL(url).searchParams.get('x-oss-process') ?? '';
  } catch {
    return '';
  }
};
// 未配置 OSS 时三档都原样返回（本地裸跑不该红）
const expectLevel = (url: string, bare: string, level: string) => {
  if (!isOssConfigured()) {
    assert.equal(url, bare, 'OSS 未配置时原样返回');
    return;
  }
  assert.notEqual(url, bare);
  assert.match(url, /[?&]Signature=/, '缩略图链也必须签名（process 进签名串）');
  assert.ok(processOf(url).includes(level), `x-oss-process 应是 ${level}，实际 ${processOf(url)}`);
};

let app: FastifyInstance;
let token = '';
let userId = '';
let actId = '';

async function api(method: string, url: string, payload?: Record<string, unknown>) {
  return await app.inject({
    method: method as 'GET',
    url: `/sport-track/api${url}`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/sport-track/api/auth/login', payload: { code: 'thumb_openid_u1' } });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().data.accessToken;
  userId = login.json().data.user.id;
  const dir = `${config.oss.endpoint.replace(/\/$/, '')}/${config.oss.baseDir}/users/${userId}/thumb-test`;
  PIC_A = `${dir}/a.png`;
  PIC_B = `${dir}/b.png`;
  AVATAR = `${dir}/avatar/avatar_test.png`;

  await cleanData();
  // 头像 + 一条带两张打点照片的轨迹（排行榜也要它有成绩）+ 两条足迹
  await UserModel.updateOne({ _id: new Types.ObjectId(userId) }, { $set: { avatarUrl: AVATAR } });
  const act = await ActivityModel.create({
    userId: new Types.ObjectId(userId),
    type: 'running',
    status: 'finished',
    startTime: Date.now() - 3600000,
    endTime: Date.now() - 1800000,
    duration: 1800,
    distance: 5200,
    markers: [
      { id: 'k1', lat: 30.2, lng: 120.1, timestamp: Date.now() - 2000000, type: 'photo', photos: [PIC_A, PIC_B], photoUrl: PIC_A },
      { id: 'k2', lat: 30.3, lng: 120.2, timestamp: Date.now() - 1900000, type: 'photo', photos: [], photoUrl: EXT },
    ],
  });
  actId = String(act._id);
  const created = await api('POST', '/footprint-records', {
    visitDate: '2024-06-01',
    title: '缩略图测试-两图',
    location: { name: '西湖', address: '杭州市西湖区', latitude: 30.24, longitude: 120.15 },
    photos: [PIC_A, PIC_B],
  });
  assert.equal(created.statusCode, 200, created.body);
  await api('POST', '/footprint-records', {
    visitDate: '2024-06-02',
    title: '缩略图测试-外链图',
    location: { name: '断桥', address: '杭州市西湖区', latitude: 30.26, longitude: 120.15 },
    photos: [EXT],
  });
  await TopicModel.create({
    title: '缩略图测试专题',
    content: `![封面](${PIC_A})`,
    coverUrl: PIC_B,
    published: true,
    effectiveAt: Date.now() - 1000,
  });
});

async function cleanData() {
  // mock 登录把 code 映射成 mock_openid_<hash>，按 openid 前缀清不到 → 只按本轮 userId 清，别碰别人的测试用户
  if (!userId) return;
  const id = new Types.ObjectId(userId);
  await FootprintRecordModel.deleteMany({ userId: id });
  await ActivityModel.deleteMany({ userId: id });
  await TopicModel.deleteMany({ title: '缩略图测试专题' });
}

after(async () => {
  await cleanData();
  // 用户本体最后删：before() 里清数据时它还得留着继续登录用
  if (userId) await UserModel.deleteOne({ _id: new Types.ObjectId(userId) });
  await app.close();
  await mongoose.disconnect().catch(() => {});
});

test('三档签名：thumb/avatar/medium 各自带 resize 参数，外链原样放行', () => {
  expectLevel(getThumbUrl(PIC_A), PIC_A, 'resize,w_240');
  expectLevel(getAvatarUrl(PIC_A), PIC_A, 'm_fill,w_160,h_160');
  expectLevel(getMediumUrl(PIC_A), PIC_A, 'resize,w_800');
  assert.equal(processOf(getSignedUrl(PIC_A)), '', '原图档不该带处理参数');
  for (const fn of [getSignedUrl, getThumbUrl, getAvatarUrl, getMediumUrl]) {
    assert.equal(fn(EXT), EXT, '非本桶地址原样返回');
  }
});

test('足迹列表：photoThumbs 缩略档 + photos 原图档并存（老版本小程序读 photos，不能赌升级），详情同序', async () => {
  const list = (await (await api('GET', '/footprint-records?pageSize=20')).json()).data;
  const two = list.items.find((i: { title: string }) => i.title === '缩略图测试-两图');
  assert.ok(two, '列表应有该条');
  assert.equal(two.photoThumbs.length, 2);
  two.photoThumbs.forEach((u: string) => expectLevel(u, PIC_A, 'resize,w_240'));
  two.photos.forEach((u: string) => assert.equal(processOf(u), '', 'photos 仍是原图档'));

  const detail = (await (await api('GET', `/footprint-records/${two.id}`)).json()).data;
  assert.equal(detail.photos.length, 2);
  assert.equal(detail.photoThumbs.length, 2);
  detail.photos.forEach((u: string) => assert.equal(processOf(u), '', 'photos 仍是原图'));
  assert.deepEqual(
    detail.photoThumbs.map((u: string) => decodeURIComponent(u.split('?')[0])),
    detail.photos.map((u: string) => u.split('?')[0]),
    '缩略图与原图按同一顺序一一对应',
  );
  const extDetail = (await (await api('GET', `/footprint-records/${list.items.find((i: { title: string }) => i.title === '缩略图测试-外链图').id}`)).json()).data;
  assert.deepEqual(extDetail.photoThumbs, [EXT], '外链图不进 OSS 处理链');
});

test('足迹地图 geo：coverPhoto 原图 + coverPhotoThumb 缩略图（气泡照片卡用后者）', async () => {
  const geo = (await (await api('GET', '/footprint-records/geo')).json()).data;
  const hit = geo.items.find((i: { title: string }) => i.title === '缩略图测试-两图');
  assert.ok(hit, 'geo 应返回该点');
  expectLevel(hit.coverPhotoThumb, PIC_A, 'resize,w_240');
  assert.equal(processOf(hit.coverPhoto), '', 'coverPhoto 仍是原图');
});

test('轨迹详情打点照片：photoThumbs 与 photos 同序，老数据只有 photoUrl 也有一条缩略图', async () => {
  // 只认自己那条（用户端列表按 startTime 倒序，别的测试用户的数据也可能进来）
  const d = (await (await api('GET', `/activities/${actId}`)).json()).data;
  assert.equal(d.markers.length, 2);
  const [m1, m2] = d.markers;
  assert.equal(m1.photoThumbs.length, 2);
  m1.photoThumbs.forEach((u: string) => expectLevel(u, PIC_A, 'resize,w_240'));
  m1.photos.forEach((u: string) => assert.equal(processOf(u), '', 'photos 给原图（点大图用）'));
  assert.equal(m2.photoThumbs[0], EXT, '外链图原样');
});

test('头像走 avatar 档：/users/me 与登录返回都变小', async () => {
  const me = (await (await api('GET', '/users/me')).json()).data;
  expectLevel(me.avatarUrl, AVATAR, 'm_fill,w_160,h_160');
  const login = await app.inject({ method: 'POST', url: '/sport-track/api/auth/login', payload: { code: 'thumb_openid_u1' } });
  expectLevel(login.json().data.user.avatarUrl, AVATAR, 'm_fill,w_160,h_160');
});

test('排行榜行头像同样走 avatar 档（一屏十几行，方图裁切最省）', async () => {
  const lb = await api('GET', '/stats/leaderboard?type=running&period=all');
  assert.equal(lb.statusCode, 200, lb.body);
  const d = lb.json().data;
  // 榜上只留 TOP 若干，种子用户里程进不了前几，me 行一定带我的头像
  assert.ok(d.me, `应查到我的排名：${lb.body.slice(0, 160)}`);
  expectLevel(d.me.avatarUrl, AVATAR, 'm_fill,w_160,h_160');
});

test('专题：列表封面缩略图档，详情封面与正文内联图 medium 档（全宽展示 240 会糊）', async () => {
  const active = (await (await api('GET', '/topics/active')).json()).data;
  const row = active.find((t: { title: string }) => t.title === '缩略图测试专题');
  assert.ok(row, '专题应在生效列表');
  expectLevel(row.coverUrl, PIC_B, 'resize,w_240');

  const detail = (await (await api('GET', `/topics/${row.id}`)).json()).data;
  expectLevel(detail.coverUrl, PIC_B, 'resize,w_800');
  const inline = String(detail.content).match(/\]\(([^)]+)\)/)?.[1] ?? '';
  expectLevel(inline, PIC_A, 'resize,w_800');
});
