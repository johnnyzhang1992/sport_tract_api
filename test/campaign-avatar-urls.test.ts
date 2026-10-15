/**
 * 活动内头像下发口径：bucket 私有，裸链直连实测渲染失败（用户报 <image> net::OK 但载不出图）。
 * 活动三处 DTO —— 详情成员列表 / 待审批列表 / 活动内排行榜 —— 都必须把 avatarUrl 换成签名链，
 * 与全场既有口径一致（leaderboard.ts / user.routes.ts / auth.routes.ts / admin.routes.ts 都签名）。
 * 外链（微信头像等）不应被签名逻辑接管，原样放行。
 *
 * 做法照 test/admin-image-urls.test.ts：未配置 OSS 时 getSignedUrl 原样返回，断言跟着分叉。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { CampaignModel } from '../src/models/campaign.model.js';
import { CampaignMemberModel } from '../src/models/campaign-member.model.js';
import { config, isOssConfigured } from '../src/config/index.js';
import {
  createCampaign,
  joinCampaign,
  getCampaignDetail,
  listPending,
  campaignLeaderboard,
} from '../src/services/campaign.js';
import type { CreateCampaignInput } from '../src/utils/validators.js';

const OSS = `${config.oss.endpoint.replace(/\/$/, '')}/${config.oss.baseDir}/campaign-avatar-test`;
const CREATOR_AVATAR = `${OSS}/creator.png`;
const MEMBER_AVATAR = `${OSS}/member.png`;
const APPLICANT_AVATAR = `${OSS}/applicant.png`;
// 外部域名（微信头像）不该被签名接管
const EXT_AVATAR = 'https://wx.qlogo.cn/mmopen/zzz/132';

let app: FastifyInstance;

const U = {
  creator: new mongoose.Types.ObjectId(),
  member: new mongoose.Types.ObjectId(),
  applicant: new mongoose.Types.ObjectId(),
  ext: new mongoose.Types.ObjectId(),
};
const createdIds: mongoose.Types.ObjectId[] = [];

const base = (over: Partial<CreateCampaignInput> = {}): CreateCampaignInput => ({
  title: 'AV',
  description: '',
  visibility: 'public',
  allowedTypes: [],
  memberLimit: null,
  startDate: '2099-01-01',
  endDate: '2099-01-07',
  ...over,
});

async function mk(creator: string, over: Partial<CreateCampaignInput> = {}): Promise<string> {
  const dto = await createCampaign(creator, base(over));
  createdIds.push(new mongoose.Types.ObjectId(dto.id));
  return dto.id;
}

// 未配置 OSS 时原样返回裸链（本地裸跑不该红），断言跟着分叉
const expectSigned = (got: string, bare: string) => {
  if (isOssConfigured()) {
    assert.ok(got.startsWith(`${bare}?`), `应是 ${bare} 的签名链，实际 ${got}`);
    assert.match(got, /[?&]Signature=/, '签名链要带 Signature');
    assert.match(got, /x-oss-process=/, '头像签名链要带 x-oss-process 裁切档');
  } else {
    assert.equal(got, bare, 'OSS 未配置时原样返回裸链');
  }
};

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await UserModel.insertMany([
    { _id: U.creator, openid: 'campaign-avatar-creator', nickname: '发起人', avatarUrl: CREATOR_AVATAR, avatarPreset: 'default-1' },
    { _id: U.member, openid: 'campaign-avatar-member', nickname: '成员', avatarUrl: MEMBER_AVATAR, avatarPreset: 'default-2' },
    { _id: U.applicant, openid: 'campaign-avatar-applicant', nickname: '申请人', avatarUrl: APPLICANT_AVATAR, avatarPreset: 'default-3' },
    { _id: U.ext, openid: 'campaign-avatar-ext', nickname: '外链头像', avatarUrl: EXT_AVATAR },
  ]);
});

after(async () => {
  await CampaignMemberModel.deleteMany({ campaignId: { $in: createdIds } });
  await CampaignModel.deleteMany({ _id: { $in: createdIds } });
  await UserModel.deleteMany({ _id: { $in: Object.values(U) } });
  await app.close();
});

test('CAV1 详情成员列表：joined 成员头像给签名链，外链头像原样放行', async () => {
  const cid = await mk(String(U.creator));
  await joinCampaign(cid, String(U.member));
  await joinCampaign(cid, String(U.ext));

  const d = await getCampaignDetail(cid, String(U.creator));
  assert.ok(d.members, '成员可见时详情必带成员列表');
  const byId = new Map(d.members.map((m) => [m.userId, m]));
  assert.equal(byId.size, 3, 'creator + member + ext 都在成员列表里');
  expectSigned(byId.get(String(U.creator))!.avatarUrl, CREATOR_AVATAR);
  expectSigned(byId.get(String(U.member))!.avatarUrl, MEMBER_AVATAR);
  assert.equal(
    byId.get(String(U.ext))!.avatarUrl,
    EXT_AVATAR,
    '非本桶域名不该被签名接管，原样下发',
  );
});

test('CAV2 待审批列表：pending 申请人头像给签名链', async () => {
  const cid = await mk(String(U.creator), { visibility: 'private' });
  await joinCampaign(cid, String(U.applicant)); // private → pending

  const rows = await listPending(cid, String(U.creator));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, String(U.applicant));
  expectSigned(rows[0].avatarUrl, APPLICANT_AVATAR);
});

test('CAV3 活动内排行榜：成员头像给签名链', async () => {
  const cid = await mk(String(U.creator));
  await joinCampaign(cid, String(U.member));

  const { rows } = await campaignLeaderboard(cid, String(U.creator), { page: 1, pageSize: 20 });
  const byId = new Map(rows.map((r) => [r.userId, r]));
  expectSigned(byId.get(String(U.creator))!.avatarUrl, CREATOR_AVATAR);
  expectSigned(byId.get(String(U.member))!.avatarUrl, MEMBER_AVATAR);
});
