/**
 * 一起运动活动（campaign）：发起人编辑活动（PUT /campaigns/:id 的 service 层）。
 *
 * 口径（本轮方案确认）：
 *   - 可改 6 个字段：title / description / visibility / allowedTypes / memberLimit / endDate；
 *     **startDate 不可改**（统计时间窗的下界，改了会让成员已计入的轨迹重新洗牌）。
 *   - 只认发起人；已解散一律拒；已到期**允许**改（endAt 推后 → 派生状态自动回 active，即「延期」）。
 *   - 部分更新：请求体里没出现的字段一律不动。
 *
 * 字段格式上限（标题 30 / 描述 120 / 类型白名单 / 空体 400）属 zod → 路由层，见
 * campaign-routes.test.ts 的 CR10–CR13；本文件只钉 service 里的业务闸门。
 *
 * 与 campaign-crud.test.ts 同款：buildApp 只为连上 Mongo，断言直接打在 service 上。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { CampaignModel } from '../src/models/campaign.model.js';
import { CampaignMemberModel } from '../src/models/campaign-member.model.js';
import { createCampaign, getCampaignDetail, dissolveCampaign, updateCampaign } from '../src/services/campaign.js';
import type { CreateCampaignInput } from '../src/utils/validators.js';

const DAY_MS = 86400000;

let app: FastifyInstance;

const creator = new mongoose.Types.ObjectId();
/** 第二个用户：既当「非发起人」，也拿来占成员位测人数上限 */
const other = new mongoose.Types.ObjectId();

const createdIds: mongoose.Types.ObjectId[] = [];

/** 东八区「今天 + N 天」的日期串：编辑用例要造 status='active' 的活动，窗口必须落在 now 之后 */
function bjDateAfter(days: number): string {
  return new Date(Date.now() + days * DAY_MS + 8 * 3600000).toISOString().slice(0, 10);
}

/** 建一个「今天起、7 天后结束」的公开活动，并登记 id 供 after() 清理 */
async function newCampaign(overrides: Partial<CreateCampaignInput> = {}) {
  const dto = await createCampaign(String(creator), {
    title: '原标题',
    description: '原描述',
    visibility: 'public',
    allowedTypes: ['running'],
    memberLimit: null,
    startDate: bjDateAfter(0),
    endDate: bjDateAfter(7),
    ...overrides,
  });
  createdIds.push(new mongoose.Types.ObjectId(dto.id));
  return dto;
}

/** 给活动塞一个 joined 成员（占一个 memberLimit 名额） */
async function addMember(campaignId: string) {
  await CampaignMemberModel.create({
    campaignId: new mongoose.Types.ObjectId(campaignId),
    userId: other,
    role: 'member',
    state: 'joined',
    joinedAt: Date.now(),
  });
}

/** 读库里的原始文档（断言「落库」而不是「返回值好看」） */
async function raw(campaignId: string) {
  return (await CampaignModel.findById(campaignId).lean())!;
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await UserModel.create([
    { _id: creator, openid: `campaign-upd-c-${String(creator)}`, nickname: '小明', avatarUrl: '', avatarPreset: 'default-1' },
    { _id: other, openid: `campaign-upd-o-${String(other)}`, nickname: '小红', avatarUrl: '', avatarPreset: 'default-2' },
  ]);
});

after(async () => {
  await CampaignMemberModel.deleteMany({ campaignId: { $in: createdIds } });
  await CampaignModel.deleteMany({ _id: { $in: createdIds } });
  await UserModel.deleteMany({ _id: { $in: [creator, other] } });
  await app.close();
});

test('UP1 改标题+描述：落库且返回的 detail 回显新值', async () => {
  const c = await newCampaign();
  const dto = await updateCampaign(c.id, String(creator), { title: '新标题', description: '新描述' });
  assert.equal(dto.title, '新标题');
  assert.equal(dto.description, '新描述');
  const db = await raw(c.id);
  assert.equal(db.title, '新标题');
  assert.equal(db.description, '新描述');
});

test('UP2 部分更新：只改 endDate，其余五个字段一律不动', async () => {
  const c = await newCampaign({ visibility: 'private', allowedTypes: ['cycling'], memberLimit: 20 });
  const before = await raw(c.id);
  await updateCampaign(c.id, String(creator), { endDate: bjDateAfter(9) });
  const after = await raw(c.id);
  assert.equal(after.endAt, before.endAt + 2 * DAY_MS, 'endDate 应从 +7 推到 +9（endAt 差两天）');
  // 逐字段钉住：漏掉任一处 $set 会红，把「未出现即不改」写成整体覆盖同样会红
  assert.equal(after.title, before.title);
  assert.equal(after.description, before.description);
  assert.equal(after.visibility, 'private');
  assert.deepEqual(after.allowedTypes, ['cycling']);
  assert.equal(after.memberLimit, 20);
});

test('UP3 非发起人改标题 → 403，库里原值不变', async () => {
  const c = await newCampaign();
  await addMember(c.id);
  await assert.rejects(
    () => updateCampaign(c.id, String(other), { title: '偷改' }),
    (e: any) => e.statusCode === 403,
  );
  assert.equal((await raw(c.id)).title, '原标题');
});

test('UP4 已解散活动 → 403（解散后不能再编辑）', async () => {
  const c = await newCampaign();
  await dissolveCampaign(c.id, String(creator));
  await assert.rejects(
    () => updateCampaign(c.id, String(creator), { title: '改回' }),
    (e: any) => e.statusCode === 403,
  );
});

test('UP13 已结束活动一律不能编辑：只有进行中的可改，且库里 endAt 不动', async () => {
  // 窗口是 2026-10-01..10-02，相对运行时刻早已过去 → effectiveStatus 派生成 'ended'
  const c = await newCampaign({ startDate: '2026-10-01', endDate: '2026-10-02' });
  const before = await raw(c.id);
  assert.equal((await getCampaignDetail(c.id, String(creator))).status, 'ended', '先确认处在已结束态');

  // 不只是「改标题」被拒：连把结束日期往后推（＝延期）也一并拒掉，否则等于绕开这条规则
  for (const input of [{ title: '改回' }, { endDate: bjDateAfter(3) }] as const) {
    await assert.rejects(
      () => updateCampaign(c.id, String(creator), input),
      (e: any) => {
        assert.equal(e.statusCode, 403);
        assert.match(e.message, /已结束/, `提示要说清为什么不能改，实际：${e.message}`);
        return true;
      },
      `输入 ${JSON.stringify(input)} 应被拒`,
    );
  }
  const after = await raw(c.id);
  assert.equal(after.endAt, before.endAt);
  assert.equal(after.title, '原标题');
});

test('UP14 进行中的活动可以把结束日期往后推（延期仍允许，别把新闸门写成一律拒绝）', async () => {
  const c = await newCampaign(); // 今天起、+7 结束 → active
  assert.equal((await getCampaignDetail(c.id, String(creator))).status, 'active');
  const dto = await updateCampaign(c.id, String(creator), { endDate: bjDateAfter(12) });
  assert.equal(dto.status, 'active');
  assert.equal(dto.endDate, bjDateAfter(12));
});

test('UP5 结束日期早于开始日期 → 400，提示带实际值与真正的开始日期', async () => {
  // 窗口必须落在 now 之后：已结束的活动会先被状态闸门 403 挡掉，走不到日期判据（见 UP13）
  const start = bjDateAfter(0);
  const badEnd = bjDateAfter(-1);
  const c = await newCampaign({ startDate: start, endDate: bjDateAfter(6) });
  const startBefore = (await raw(c.id)).startAt;
  await assert.rejects(
    () => updateCampaign(c.id, String(creator), { endDate: badEnd }),
    (e: any) => {
      assert.equal(e.statusCode, 400);
      // 只说「结束日期不能早于开始日期」不够：开始日期不是用户这次传进来的，要点名库里那个值
      assert.ok(e.message.includes(badEnd), `提示应含收到的实际值 ${badEnd}，实际：${e.message}`);
      assert.ok(e.message.includes(start), `提示应含库里的开始日期 ${start}，实际：${e.message}`);
      return true;
    },
  );
  assert.equal((await raw(c.id)).startAt, startBefore);
});

test('UP6 结束日期＝开始日期允许（含当日，一天活动合法）', async () => {
  const start = bjDateAfter(2);
  const c = await newCampaign({ startDate: start, endDate: bjDateAfter(6) });
  const dto = await updateCampaign(c.id, String(creator), { endDate: start });
  // endAt 是「结束日 24:00」→ 与 startAt 恰好差一天，不是差零
  assert.equal(dto.endAt - dto.startAt, DAY_MS);
});

test('UP7 人数上限低于当前占位 → 400 带占位数；等于占位则放行', async () => {
  const c = await newCampaign({ memberLimit: null });
  await addMember(c.id); // 发起人 1 + 成员 1 = 占位 2
  await assert.rejects(
    () => updateCampaign(c.id, String(creator), { memberLimit: 1 }),
    (e: any) => {
      assert.equal(e.statusCode, 400);
      assert.match(e.message, /2/, '当前占位数要点名，不能只说「太小」');
      return true;
    },
  );
  const dto = await updateCampaign(c.id, String(creator), { memberLimit: 2 });
  assert.equal(dto.memberLimit, 2);
});

test('UP8 文本判 risky → 400，且同批其它字段不能半途落库', async () => {
  const c = await newCampaign();
  await assert.rejects(
    () =>
      updateCampaign(
        c.id,
        String(creator),
        { title: '违规标题', memberLimit: 5 },
        async (text: string) => ({ risky: text.includes('违规') }),
      ),
    (e: any) => e.statusCode === 400,
  );
  const db = await raw(c.id);
  assert.equal(db.title, '原标题');
  assert.equal(db.memberLimit, null, '检测在写库之前：同请求里的 memberLimit 也不该生效');
});

test('UP9 非法 id 与不存在的 id 一律 404', async () => {
  await assert.rejects(
    () => updateCampaign('not-an-id', String(creator), { title: 'x' }),
    (e: any) => e.statusCode === 404,
  );
  await assert.rejects(
    () => updateCampaign('6acf7dc0580a613d64f2d999', String(creator), { title: 'x' }),
    (e: any) => e.statusCode === 404,
  );
});

test('UP10 detail 下发 startDate/endDate 字符串，与 startAt/endAt 互为逆（端上不做时区换算）', async () => {
  const c = await newCampaign({ startDate: '2026-10-01', endDate: '2026-10-07' });
  const dto = await getCampaignDetail(c.id, String(creator));
  assert.equal(dto.startDate, '2026-10-01');
  // endAt 是「结束日 24:00」，逆推回日期必须减 1 天，否则编辑页预填会多一天
  assert.equal(dto.endDate, '2026-10-07');
  assert.equal(dto.endAt - Date.parse('2026-10-08T00:00:00+08:00'), 0);
});

test('UP11 已结束活动改不了，也就不会因为「延期」而悄悄复活（ended 是派生态，闸门必须按派生态判）', async () => {
  const c = await newCampaign({ startDate: '2026-10-01', endDate: '2026-10-02' });
  const detail = await getCampaignDetail(c.id, String(creator));
  assert.equal(detail.status, 'ended');
  assert.equal(detail.myState, 'joined', '发起人自己仍是 joined，403 只能来自状态闸门而非身份闸门');
  await assert.rejects(
    () => updateCampaign(c.id, String(creator), { endDate: bjDateAfter(5) }),
    (e: any) => e.statusCode === 403,
  );
  assert.equal((await getCampaignDetail(c.id, String(creator))).status, 'ended');
});

test('UP12 memberLimit 显式 null＝改回不限；allowedTypes 空数组＝不限类型（与创建同口径）', async () => {
  const c = await newCampaign({ memberLimit: 30, allowedTypes: ['running', 'cycling'] });
  const dto = await updateCampaign(c.id, String(creator), { memberLimit: null, allowedTypes: [] });
  assert.equal(dto.memberLimit, null);
  assert.deepEqual(dto.allowedTypes, []);
});
