/**
 * 照片管理（2026-11-05）：额度超额时的可操作入口。
 *
 * 覆盖：
 * - PM-1 总览：按轨迹/足迹分组，只含自己的照片；额度读数带 over
 * - PM-2 删除：轨迹打点照片可删、额度回补、photoUrl 同步为首图
 * - PM-3 删除：足迹照片可删、额度回补
 * - PM-4 越权：别人的文档按 404，且不改任何数据
 * - PM-5 幂等：重复删同一批 URL 不报错、不二次扣减
 * - PM-6 超额文案：会员到期 300→100 时给出「回落 + 超出张数 + 两条出路」
 *
 * 运行：WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/photo-manager.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { ActivityModel } from '../src/models/activity.model.js';
import { FootprintRecordModel } from '../src/models/footprint-record.model.js';
import { UserModel } from '../src/models/user.model.js';
import { PointCardModel, PointRecordModel, PointAccountModel, PointLotModel, PointDailyModel } from '../src/models/point.model.js';
import { XpayOrderModel } from '../src/models/xpay-order.model.js';
import { config } from '../src/config/index.js';
import { deleteMyPhotos, listMyPhotos } from '../src/services/photo-manager.js';
import { photoQuotaFullMessage, MEMBER_PHOTO_QUOTA } from '../src/config/member-copy.js';
import { MAX_USER_PHOTOS } from '../src/config/constants.js';

const RUN = Date.now().toString(36);
const OWNER_OPENID = `pm_owner_${RUN}`;
const OTHER_OPENID = `pm_other_${RUN}`;
const DAY = 86_400_000;

let ownerId = '';
let otherId = '';

const PHOTO = (n: number) => `https://sports-track.oss-cn-wuhan-lr.aliyuncs.com/miniapp_test/pm/${RUN}-${n}.jpg`;

async function mkUser(openid: string) {
  const u = await UserModel.findOneAndUpdate(
    { openid },
    { $setOnInsert: { openid, nickname: openid } },
    { upsert: true, new: true, lean: true },
  );
  return String((u as { _id: Types.ObjectId })._id);
}

async function mkActivity(userId: string, photos: string[], markerPhotos: string[][] = []) {
  return ActivityModel.create({
    userId: new Types.ObjectId(userId),
    type: 'running',
    status: 'finished',
    startTime: Date.now() - DAY,
    distance: 5000,
    name: '晨跑',
    markers: markerPhotos.map((ps, i) => ({
      id: `m${i}`, lat: 30, lng: 120, timestamp: Date.now(), type: 'photo',
      photoUrl: ps[0] || '', photos: ps,
    })),
    photoUrl: photos[0] || '',
    photos,
  });
}

async function mkFootprint(userId: string, photos: string[]) {
  return FootprintRecordModel.create({
    userId: new Types.ObjectId(userId),
    visitDate: '2026-11-01',
    title: '西湖',
    location: { name: '西湖', address: '', latitude: 30, longitude: 120 },
    photos,
  });
}

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  ownerId = await mkUser(OWNER_OPENID);
  otherId = await mkUser(OTHER_OPENID);
});

after(async () => {
  await ActivityModel.deleteMany({ userId: { $in: [new Types.ObjectId(ownerId), new Types.ObjectId(otherId)] } });
  await FootprintRecordModel.deleteMany({ userId: { $in: [new Types.ObjectId(ownerId), new Types.ObjectId(otherId)] } });
  await UserModel.deleteMany({ openid: { $in: [OWNER_OPENID, OTHER_OPENID] } });
  await XpayOrderModel.deleteMany({ userId: { $in: [new Types.ObjectId(ownerId), new Types.ObjectId(otherId)] } });
  await PointCardModel.deleteMany({ userId: { $in: [new Types.ObjectId(ownerId), new Types.ObjectId(otherId)] } });
  await PointRecordModel.deleteMany({ userId: { $in: [new Types.ObjectId(ownerId), new Types.ObjectId(otherId)] } });
  await PointAccountModel.deleteMany({ userId: { $in: [new Types.ObjectId(ownerId), new Types.ObjectId(otherId)] } });
  await PointLotModel.deleteMany({ userId: { $in: [new Types.ObjectId(ownerId), new Types.ObjectId(otherId)] } });
  await PointDailyModel.deleteMany({ userId: { $in: [new Types.ObjectId(ownerId), new Types.ObjectId(otherId)] } });
  await mongoose.disconnect().catch(() => {});
});

test('PM-1 总览：只含自己的照片，按来源分组，读数带 over', async () => {
  await mkActivity(ownerId, [], [[PHOTO(1), PHOTO(2)]]);
  await mkFootprint(ownerId, [PHOTO(3)]);
  await mkActivity(otherId, [], [[PHOTO(9)]]); // 别人的：绝不该出现
  await UserModel.updateOne({ _id: ownerId }, { $set: { photoQuotaUsed: 3 } });

  const res = await listMyPhotos(ownerId);
  assert.equal(res.groups.length, 2, '一组轨迹 + 一组足迹');
  const kinds = res.groups.map((g) => g.kind).sort();
  assert.deepEqual(kinds, ['activity', 'footprint']);
  const all = res.groups.flatMap((g) => g.photos.map((p) => p.url));
  assert.ok(all.every((u) => !u.includes(`${RUN}-9`)), '别人的照片不能出现');
  assert.equal(res.used, 3);
  assert.equal(res.limit, MAX_USER_PHOTOS, '普通用户基础额度');
  assert.equal(res.over, 0);
});

test('PM-2 删除轨迹打点照片：额度回补、photoUrl 同步首图', async () => {
  await ActivityModel.deleteMany({ userId: new Types.ObjectId(ownerId) });
  const a = await mkActivity(ownerId, [], [[PHOTO(11), PHOTO(12)]]);
  await UserModel.updateOne({ _id: ownerId }, { $set: { photoQuotaUsed: 2 } });

  const r = await deleteMyPhotos(ownerId, [{ kind: 'activity', id: String(a._id), urls: [PHOTO(12)] }]);
  assert.equal(r.deleted, 1);
  assert.equal(r.used, 1, '删一张额度回补一张');
  const after = await ActivityModel.findById(a._id).lean();
  const marker = (after?.markers ?? [])[0] as { photos: string[]; photoUrl: string };
  assert.deepEqual(marker.photos, [PHOTO(11)]);
  assert.equal(marker.photoUrl, PHOTO(11), 'photoUrl 同步为剩余首图');
});

test('PM-3 删除足迹照片：额度回补', async () => {
  await FootprintRecordModel.deleteMany({ userId: new Types.ObjectId(ownerId) });
  const f = await mkFootprint(ownerId, [PHOTO(21), PHOTO(22)]);
  await UserModel.updateOne({ _id: ownerId }, { $set: { photoQuotaUsed: 2 } });

  const r = await deleteMyPhotos(ownerId, [{ kind: 'footprint', id: String(f._id), urls: [PHOTO(21), PHOTO(22)] }]);
  assert.equal(r.deleted, 2);
  assert.equal(r.used, 0);
  assert.deepEqual((await FootprintRecordModel.findById(f._id).lean())?.photos, []);
});

test('PM-4 越权：删别人的照片按 404，且不改数据', async () => {
  const foreign = await mkActivity(otherId, [], [[PHOTO(31)]]);
  await UserModel.updateOne({ _id: otherId }, { $set: { photoQuotaUsed: 1 } });
  await assert.rejects(
    () => deleteMyPhotos(ownerId, [{ kind: 'activity', id: String(foreign._id), urls: [PHOTO(31)] }]),
    /轨迹不存在/,
  );
  const still = await ActivityModel.findById(foreign._id).lean();
  const marker = (still?.markers ?? [])[0] as { photos: string[] };
  assert.deepEqual(marker.photos, [PHOTO(31)], '别人的照片不能被删');
});

test('PM-5 幂等：重复删同一批 URL 不报错、不二次扣减', async () => {
  await ActivityModel.deleteMany({ userId: new Types.ObjectId(ownerId) });
  const a = await mkActivity(ownerId, [], [[PHOTO(41)]]);
  await UserModel.updateOne({ _id: ownerId }, { $set: { photoQuotaUsed: 1 } });
  await deleteMyPhotos(ownerId, [{ kind: 'activity', id: String(a._id), urls: [PHOTO(41)] }]);
  const first = (await UserModel.findById(ownerId).lean())?.photoQuotaUsed;
  const again = await deleteMyPhotos(ownerId, [{ kind: 'activity', id: String(a._id), urls: [PHOTO(41)] }]);
  assert.equal(again.deleted, 0, '第二次没东西可删');
  assert.equal((await UserModel.findById(ownerId).lean())?.photoQuotaUsed, first, '额度不会被二次扣');
});

test('PM-6 满额文案：升级长期有效、指引去「照片管理」删旧的；无「回落」说法', () => {
  const memberFull = photoQuotaFullMessage(MEMBER_PHOTO_QUOTA, MEMBER_PHOTO_QUOTA, true);
  assert.match(memberFull, /已是上限/);
  assert.match(memberFull, /照片管理/);
  assert.ok(!memberFull.includes('回落'), '额度一次升级永久保留，不应出现回落文案');

  const freeFull = photoQuotaFullMessage(MAX_USER_PHOTOS, MAX_USER_PHOTOS, false);
  assert.match(freeFull, new RegExp(`开通会员可提升到 ${MEMBER_PHOTO_QUOTA} 张`));
  assert.match(freeFull, /长期有效/);

  // 超额只可能是脏数据：仍要给出可执行的删除建议
  const over = photoQuotaFullMessage(MEMBER_PHOTO_QUOTA + 20, MEMBER_PHOTO_QUOTA, true);
  assert.match(over, /超出 20 张/);
  assert.match(over, /删除 20 张以上/);
});

test('PM-7 额度一次升级永久保留：会员拿过会员额度后过期，上限仍保持（不回落）', async () => {
  const openid = `pm_hw_${RUN}`;
  const uid = await mkUser(openid);
  const { resolvePhotoQuotaLimit, getPhotoQuota } = await import('../src/services/photo-quota.js');

  // 1) 未开通会员：基础 100
  assert.equal((await resolvePhotoQuotaLimit(uid)).limit, MAX_USER_PHOTOS);

  // 2) 造一笔「已生效」的会员订单（300 张权益）→ 上限升到 300 并落高水位
  const now = Date.now();
  await XpayOrderModel.create({
    outTradeNo: `PMHW${RUN}`.slice(0, 20),
    userId: new Types.ObjectId(uid),
    openid,
    productKey: 'month_card',
    name: '会员月卡',
    priceFen: 199,
    durationDays: 30,
    perksSnapshot: { adFree: true, exportBundle: true, photoQuota: MEMBER_PHOTO_QUOTA, subscribeNotice: true },
    status: 'delivered',
    wxOrderId: `wxhw${RUN}`.slice(0, 20),
    periodStart: now - 1000,
    periodEnd: now + 30 * DAY,
    attach: '',
    channel: 'android',
  });
  assert.equal((await resolvePhotoQuotaLimit(uid)).limit, MEMBER_PHOTO_QUOTA, '会员期内升到会员额度');
  assert.equal((await UserModel.findById(uid).lean())?.photoQuotaLimit, MEMBER_PHOTO_QUOTA, '高水位已落库');

  // 3) 会员到期（把区间改到过去）→ 上限**不回落**，仍是 300
  await XpayOrderModel.updateOne(
    { userId: new Types.ObjectId(uid) },
    { $set: { periodStart: now - 60 * DAY, periodEnd: now - 30 * DAY } },
  );
  const after = await resolvePhotoQuotaLimit(uid);
  assert.equal(after.limit, MEMBER_PHOTO_QUOTA, '会员到期不回落（一次升级永久保留）');
  assert.equal(after.isMember, false, '此时确实已不是会员');
  assert.equal((await getPhotoQuota(uid)).limit, MEMBER_PHOTO_QUOTA);

  // 4) 已用 250 张：过期后仍可继续上传到 300（不会因过期被卡在 100）
  await UserModel.updateOne({ _id: uid }, { $set: { photoQuotaUsed: MEMBER_PHOTO_QUOTA - 10 } });
  const q = await getPhotoQuota(uid);
  assert.equal(q.remaining, 10);

  await UserModel.deleteOne({ openid });
});

test('PM-8 同一张图挂在两处：删一处会保留 OSS 文件（引用守卫），两处都删才彻底清理', async () => {
  await ActivityModel.deleteMany({ userId: new Types.ObjectId(ownerId) });
  await FootprintRecordModel.deleteMany({ userId: new Types.ObjectId(ownerId) });
  const shared = PHOTO(51);
  const a = await mkActivity(ownerId, [], [[shared]]);
  const f = await mkFootprint(ownerId, [shared]); // 同一张图也挂在足迹上
  await UserModel.updateOne({ _id: ownerId }, { $set: { photoQuotaUsed: 2 } });

  // 删轨迹这一份：DB 里轨迹已无这张图，但足迹仍引用 → 守卫判定「文件不可删」
  const r1 = await deleteMyPhotos(ownerId, [{ kind: 'activity', id: String(a._id), urls: [shared] }]);
  assert.equal(r1.deleted, 1);
  const afterAct = await ActivityModel.findById(a._id).lean();
  const actPhotos = ((afterAct?.markers ?? []) as Array<{ photos: string[] }>).flatMap((m) => m.photos);
  assert.deepEqual(actPhotos, [], '轨迹侧照片已删');
  assert.deepEqual(((await FootprintRecordModel.findById(f._id).lean())?.photos ?? []) as string[], [shared], '足迹侧仍保留');

  // 再删足迹那一份：此时无任何文档引用，OSS 清理才会执行（测试环境 OSS 未配置时静默跳过）
  const r2 = await deleteMyPhotos(ownerId, [{ kind: 'footprint', id: String(f._id), urls: [shared] }]);
  assert.equal(r2.deleted, 1);
  assert.deepEqual(((await FootprintRecordModel.findById(f._id).lean())?.photos ?? []) as string[], []);
});
