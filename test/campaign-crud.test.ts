/**
 * 一起运动活动（campaign）：创建 / 列表 / 详情（身份裁剪）。
 *
 * routes 属 Task 6 → 本文件与 Task 2 同款做法：buildApp 只为连上 Mongo，
 * 断言直接打在 service 上；收尾只 `app.close()`（mongo 插件的 onClose 会断开连接，不再手动 disconnect）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { CampaignModel } from '../src/models/campaign.model.js';
import { CampaignMemberModel } from '../src/models/campaign-member.model.js';
import { config } from '../src/config/index.js';
import { bjToday0 } from '../src/utils/bj-time.js';
import {
  createCampaign,
  getCampaignDetail,
  listCampaigns,
  effectiveStatus,
  assertTextAllowed,
  updateCampaign,
} from '../src/services/campaign.js';
import type { CampaignDoc } from '../src/services/campaign-stats.js';
import type { CreateCampaignInput } from '../src/utils/validators.js';

const DAY_MS = 86400000;

let app: FastifyInstance;

/** 发起人（本文件唯一需要 User 文档的用户：成员行要取昵称 / 预设头像） */
const userId = new mongoose.Types.ObjectId();

/** 本文件创建的 campaign id：after() 只清这些，不碰 dev 库里既有数据 */
const createdIds: mongoose.Types.ObjectId[] = [];

/** createCampaign + 登记 id（清理用） */
async function create(creator: string, input: CreateCampaignInput) {
  const dto = await createCampaign(creator, input);
  createdIds.push(new mongoose.Types.ObjectId(dto.id));
  return dto;
}

/** 时间窗与状态无关的公共表单（10-01..10-02，相对运行时刻已是过去 → 派生状态 'ended'） */
const base = {
  description: '',
  visibility: 'public' as const,
  allowedTypes: [],
  memberLimit: null,
  startDate: '2026-10-01',
  endDate: '2026-10-02',
} satisfies Omit<CreateCampaignInput, 'title'>;

/**
 * 东八区「今天 + N 天」的日期串。
 * 需要断言 canJoin=true / status='active' 的用例必须用**落在 now 之后**的窗口：
 * effectiveStatus 是按 now 派生的（到期即 ended），写死的历史日期只会得到 ended → canJoin 恒为 false。
 */
function bjDateAfter(days: number): string {
  return new Date(Date.now() + days * DAY_MS + 8 * 3600000).toISOString().slice(0, 10);
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await UserModel.create({
    _id: userId,
    openid: `campaign-crud-${String(userId)}`,
    nickname: '小明',
    avatarUrl: '',
    avatarPreset: 'default-1',
  });
});

after(async () => {
  await CampaignMemberModel.deleteMany({ campaignId: { $in: createdIds } });
  await CampaignModel.deleteMany({ _id: { $in: createdIds } });
  await UserModel.deleteMany({ _id: userId });
  await app.close();
});

test('CC1 创建：发起人自动成为 joined 成员，startAt/endAt 落到东八区日边界', async () => {
  const dto = await create(String(userId), {
    title: '周末一起跑', description: '', visibility: 'public',
    allowedTypes: ['running'], memberLimit: null,
    startDate: '2026-10-01', endDate: '2026-10-07',
  });
  assert.equal(dto.myState, 'joined');
  assert.equal(dto.startAt, Date.UTC(2026, 8, 30, 16, 0, 0)); // 东八区 10-01 00:00
  // endDate 10-07 是**含**当日（model 注释：结束日 24:00 ＝ 次日 00:00，左闭右开）
  // → 东八区 10-08 00:00 == Date.UTC(2026, 9, 7, 16)。
  // 注意：brief/计划把这条字面量写成 Date.UTC(2026, 9, 6, 16)（＝东八区 10-07 00:00），
  // 与它自己的注释「10-08 00:00」和实现（endDate + 1 天）都差一天，属笔误，以语义为准。
  assert.equal(dto.endAt, Date.UTC(2026, 9, 7, 16, 0, 0));
  assert.equal(dto.endAt - dto.startAt, 7 * DAY_MS); // 10-01..10-07 含 7 个自然日

  const rows = await CampaignMemberModel.find({ campaignId: dto.id, userId });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'creator');
  assert.equal(rows[0].state, 'joined');
  assert.ok(rows[0].joinedAt, 'joinedAt 应落库（统计时间窗的下界）');
});

test('CC2 标题/描述过内容安全检测（checkText 被调用）', async () => {
  // 见 wechat-sec.checkText：未配置 WX_SECRET 时降级放行；此用例只断言不因检测而 5xx
  const dto = await create(String(userId), {
    title: '合规标题', description: '正常描述', visibility: 'public',
    allowedTypes: [], memberLimit: null, startDate: '2026-10-01', endDate: '2026-10-02',
  });
  assert.ok(dto.id);
});

test('CC11 接线：注入的 checkText 判 risky 时，创建整条被 400 拒（删掉 assertTextAllowed 调用即变红）', async () => {
  // 端到端无法造 risky（未配 WX_SECRET 时 checkText 恒 skipped）→ 用 DI 注入替身，
  // 这条才真正钉住 createCampaign 里「必须检查 checkText 返回值」这句接线。
  await assert.rejects(
    () =>
      createCampaign(
        String(userId),
        {
          title: '违规标题', description: '', visibility: 'public', allowedTypes: [],
          memberLimit: null, startDate: '2099-01-01', endDate: '2099-01-02',
        },
        async () => ({ risky: true }),
      ),
    (e: any) => e.statusCode === 400,
  );
});

/**
 * CC7-C10：`assertTextAllowed` 是 createCampaign 拦截违规文本的判定核心。
 * 为什么单测纯函数而非端到端：checkText 会真的发 HTTP 到微信，测试环境恒返回 skipped，
 * 无法廉价地造出 risky。纯函数是唯一能真正走到「红」的路径。
 */
test('CC7 assertTextAllowed：任一文本 risky → 400', () => {
  assert.throws(() => assertTextAllowed([{ risky: true }]), (e: any) => e.statusCode === 400);
});

test('CC8 assertTextAllowed：全部合规 → 放行', () => {
  assert.doesNotThrow(() => assertTextAllowed([{ risky: false }]));
});

test('CC9 assertTextAllowed：空数组 → 放行（无文本即无可拦）', () => {
  assert.doesNotThrow(() => assertTextAllowed([]));
});

test('CC10 assertTextAllowed：混合数组按「任一违规即拒」语义拦截', () => {
  assert.throws(() => assertTextAllowed([{ risky: false }, { risky: true }]), (e: any) => e.statusCode === 400);
});

test('CC3 详情按身份裁剪：非成员看不到成员列表与汇总', async () => {
  const outsider = new mongoose.Types.ObjectId();
  // 窗口取「已开赛、还剩一天」：active 与 upcoming 都能 canJoin，这里要钉的是 active 下的裁剪
  const dto = await create(String(userId), {
    title: 'X', description: '', visibility: 'public', allowedTypes: [], memberLimit: null,
    startDate: bjDateAfter(-1), endDate: bjDateAfter(2),
  });
  const asOutsider = await getCampaignDetail(dto.id, String(outsider));
  assert.equal(asOutsider.members, undefined);
  assert.equal(asOutsider.totals, undefined);
  assert.equal(asOutsider.myPanel, undefined);
  assert.equal(asOutsider.myState, 'none');
  assert.equal(asOutsider.status, 'active');
  assert.equal(asOutsider.canJoin, true);

  const asCreator = await getCampaignDetail(dto.id, String(userId));
  assert.ok(Array.isArray(asCreator.members));
  assert.ok(asCreator.totals);
  assert.equal(asCreator.canJoin, false); // 已在队 → 不能再加入
  assert.deepEqual(asCreator.totals, { count: 0, distance: 0, duration: 0 });
  assert.deepEqual(asCreator.myPanel, {
    count: 0,
    distance: 0,
    duration: 0,
    streak: 0,
    rank: 1,
    members: 1,
    gapToLeader: 0,
    gapToPrev: 0,
    share: 0,
  });
  const me = asCreator.members?.find((m) => m.userId === String(userId));
  assert.ok(me, '成员列表应含发起人');
  assert.equal(me.role, 'creator');
  assert.equal(me.name, '小明');
  assert.equal(me.avatarPreset, 'default-1');
});

test('CC12 未开始活动：非成员详情 canJoin=true（可报名，不能显示人数已满）', async () => {
  const outsider = new mongoose.Types.ObjectId();
  const dto = await create(String(userId), {
    title: '未开始', description: '', visibility: 'public', allowedTypes: [], memberLimit: 100,
    startDate: bjDateAfter(2), endDate: bjDateAfter(4),
  });
  const asOutsider = await getCampaignDetail(dto.id, String(outsider));
  assert.equal(asOutsider.status, 'upcoming');
  assert.equal(asOutsider.memberLimit, 100);
  assert.equal(asOutsider.canJoin, true);
});

test('CC13 防刷：每用户每天最多创建 N 个，超限 429 且提示实际值', async () => {
  const fresh = new mongoose.Types.ObjectId();
  const cfg = config as unknown as { campaignCreateDailyLimit: number };
  const old = cfg.campaignCreateDailyLimit;
  cfg.campaignCreateDailyLimit = 2;
  const input = { ...base, startDate: bjDateAfter(2), endDate: bjDateAfter(4) };
  try {
    await create(String(fresh), { ...input, title: '限额1' });
    await create(String(fresh), { ...input, title: '限额2' });
    await assert.rejects(
      () => create(String(fresh), { ...input, title: '限额3' }),
      (e: any) =>
        e.statusCode === 429 &&
        /今天已创建 2 个活动/.test(e.message) &&
        /每天最多创建 2 个/.test(e.message),
    );
  } finally {
    cfg.campaignCreateDailyLimit = old;
  }
});

test('CC14 每日额度按东八区自然日：昨天创建的不占今天额度', async () => {
  const fresh = new mongoose.Types.ObjectId();
  const cfg = config as unknown as { campaignCreateDailyLimit: number };
  const old = cfg.campaignCreateDailyLimit;
  cfg.campaignCreateDailyLimit = 2;
  const input = { ...base, startDate: bjDateAfter(2), endDate: bjDateAfter(4) };
  try {
    const yesterday = await create(String(fresh), { ...input, title: '昨日1' });
    // 直接改原始集合，绕开 mongoose timestamps
    await CampaignModel.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(yesterday.id) },
      { $set: { createdAt: new Date(bjToday0() - 1) } },
    );
    await create(String(fresh), { ...input, title: '今日1' });
    await create(String(fresh), { ...input, title: '今日2' });
    await assert.rejects(
      () => create(String(fresh), { ...input, title: '今日3' }),
      (e: any) => e.statusCode === 429,
    );
  } finally {
    cfg.campaignCreateDailyLimit = old;
  }
});

test('CC15 防刷：每小时最多创建 N 个，超限 429 且提示实际值', async () => {
  const fresh = new mongoose.Types.ObjectId();
  const cfg = config as unknown as { campaignCreateHourlyLimit: number };
  const old = cfg.campaignCreateHourlyLimit;
  cfg.campaignCreateHourlyLimit = 2;
  const input = { ...base, startDate: bjDateAfter(2), endDate: bjDateAfter(4) };
  try {
    await create(String(fresh), { ...input, title: '小时1' });
    await create(String(fresh), { ...input, title: '小时2' });
    await assert.rejects(
      () => create(String(fresh), { ...input, title: '小时3' }),
      (e: any) =>
        e.statusCode === 429 &&
        /最近 1 小时已创建 2 个活动/.test(e.message) &&
        /每小时最多创建 2 个/.test(e.message),
    );
  } finally {
    cfg.campaignCreateHourlyLimit = old;
  }
});

test('CC16 每小时额度按滚动 1 小时：1 小时前创建的不占本小时额度', async () => {
  const fresh = new mongoose.Types.ObjectId();
  const cfg = config as unknown as { campaignCreateHourlyLimit: number };
  const old = cfg.campaignCreateHourlyLimit;
  cfg.campaignCreateHourlyLimit = 1;
  const input = { ...base, startDate: bjDateAfter(2), endDate: bjDateAfter(4) };
  try {
    const stale = await create(String(fresh), { ...input, title: '两小时前' });
    await CampaignModel.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(stale.id) },
      { $set: { createdAt: new Date(Date.now() - 2 * 3600000) } },
    );
    await create(String(fresh), { ...input, title: '本小时1' });
    await assert.rejects(
      () => create(String(fresh), { ...input, title: '本小时2' }),
      (e: any) => e.statusCode === 429 && /最近 1 小时/.test(e.message),
    );
  } finally {
    cfg.campaignCreateHourlyLimit = old;
  }
});

test('CC17 同时存在上限：未开始+进行中最多 N 个，已结束不占', async () => {
  const fresh = new mongoose.Types.ObjectId();
  const cfg = config as unknown as { campaignActiveLimit: number };
  const old = cfg.campaignActiveLimit;
  cfg.campaignActiveLimit = 2;
  const live = { ...base, startDate: bjDateAfter(2), endDate: bjDateAfter(4) };
  try {
    await create(String(fresh), { ...live, title: '进行1' });
    await create(String(fresh), { ...base, title: '已结束不占位' });
    await create(String(fresh), { ...live, title: '进行2' });
    await assert.rejects(
      () => create(String(fresh), { ...live, title: '进行3' }),
      (e: any) =>
        e.statusCode === 409 &&
        /当前还有 2 个未开始\/进行中的活动/.test(e.message) &&
        /最多同时保留 2 个/.test(e.message),
    );
  } finally {
    cfg.campaignActiveLimit = old;
  }
});

test('CC4 非法 id → 404', async () => {
  await assert.rejects(() => getCampaignDetail('not-an-id', String(userId)), (e: any) => e.statusCode === 404);
});

test('CC5 列表 role：created 只回我发起的，joined 含我参与的+我发起的（发起人也是成员）', async () => {
  const a = new mongoose.Types.ObjectId();
  const b = new mongoose.Types.ObjectId();
  const c1 = await create(String(a), { ...base, title: 'A1' });
  const c2 = await create(String(a), { ...base, title: 'A2' });
  const c3 = await create(String(b), { ...base, title: 'B1' });
  // 直接造一行「a 参与 b 的活动」——joinCampaign 属 Task 4，本任务还不能用
  await CampaignMemberModel.create({ campaignId: new mongoose.Types.ObjectId(c3.id), userId: a, role: 'member', state: 'joined', joinedAt: Date.now() });

  const created = await listCampaigns(String(a), { role: 'created', page: 1, pageSize: 20 });
  assert.deepEqual(created.items.map((i) => i.id).sort(), [c1.id, c2.id].sort());
  assert.equal(created.total, 2);
  assert.equal(created.page, 1);
  assert.equal(created.pageSize, 20);

  const joined = await listCampaigns(String(a), { role: 'joined', page: 1, pageSize: 20 });
  assert.deepEqual(joined.items.map((i) => i.id).sort(), [c1.id, c2.id, c3.id].sort());
  assert.equal(joined.total, 3);
  // 卡片自带我在该活动的汇总（无轨迹 → 全 0）
  assert.deepEqual(joined.items.find((i) => i.id === c3.id)!.myStats, { count: 0, distance: 0, duration: 0 });
});

test('CC6 effectiveStatus：到期即 ended（不写库），dissolved 优先于时间', async () => {
  const dto = await create(String(userId), { ...base, title: '状态判定' });
  const doc = (await CampaignModel.findById(dto.id).lean()) as unknown as CampaignDoc;
  assert.equal(effectiveStatus(doc, dto.endAt - 1), 'active'); // 结束前一刻仍是 active
  assert.equal(effectiveStatus(doc, dto.endAt), 'ended');      // now >= endAt 即到期
  // 10-01..10-02 相对运行时刻已过 → 详情里派生为 ended，但库里 status 未被改写
  assert.equal((await getCampaignDetail(dto.id, String(userId))).status, 'ended');
  assert.equal((await CampaignModel.findById(dto.id).lean())!.status, 'active');

  await CampaignModel.updateOne({ _id: dto.id }, { status: 'dissolved' });
  const dissolved = (await CampaignModel.findById(dto.id).lean()) as unknown as CampaignDoc;
  assert.equal(effectiveStatus(dissolved, dto.endAt - 1), 'dissolved');
  assert.equal((await getCampaignDetail(dto.id, String(userId))).status, 'dissolved');
});

test('CC18 活动最长 365 天：365 天放行、366 天 400，提示带实际跨度', async () => {
  // 含首尾数天数：2026-01-01 ~ 2026-12-31 正好 365 天（闰年）
  const ok = await create(String(userId), {
    ...base, title: '整整一年', startDate: '2026-01-01', endDate: '2026-12-31',
  });
  assert.ok(ok.id, '365 天不该被拦');

  await assert.rejects(
    () =>
      create(String(userId), {
        ...base, title: '超一天', startDate: '2026-01-01', endDate: '2027-01-01',
      }),
    (e: any) => {
      assert.equal(e.statusCode, 400, e.message);
      assert.match(e.message, /365/, '要说清上限');
      assert.match(e.message, /366/, '要报出实际跨了多少天');
      assert.match(e.message, /2026-01-01/, '要点名收到的开始日期');
      assert.match(e.message, /2027-01-01/, '要点名收到的结束日期');
      return true;
    },
  );
});

test('CC19 编辑把结束日期改到超一年 → 400（开始日期不在请求里，判据取库里那个）', async () => {
  const start = bjDateAfter(0);
  const dto = await create(String(userId), {
    ...base, title: '先建四个月', startDate: start, endDate: bjDateAfter(120),
  });
  await assert.rejects(
    () => updateCampaign(dto.id, String(userId), { endDate: bjDateAfter(400) }),
    (e: any) => {
      assert.equal(e.statusCode, 400, e.message);
      assert.match(e.message, /365/);
      assert.match(e.message, new RegExp(start.replace(/-/g, '\\-')), '开始日期是库里的，提示要把它点名出来');
      return true;
    },
  );
  // 收回到含首尾正好 365 天，照常放行
  const back = await updateCampaign(dto.id, String(userId), { endDate: bjDateAfter(364) });
  assert.equal(back.endDate, bjDateAfter(364));
});
