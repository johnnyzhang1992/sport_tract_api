/**
 * clean-stranded-board-rewards.mjs —— 清理 dev 库滞留的榜单发分（只读盘点见
 * .superpowers/sdd/2026-10-28-points-board-rewards/devdb-stranded-board-rewards.md）。
 *
 * 背景：test/points-board.test.ts 旧版 SP-4 夹具（2026-12 窗口 + 假时钟 2027-01-04）让
 * settleDueForUser 顺带结算了平台 year:2026 单元，把真实 TOP3 用户的 board_reward 流水
 * 与余额/批次发了出去；测试 after() 删了台账行却删不到这些真实用户 ⇒ 钱滞留、台账无凭据，
 * Task 10 的撤回面看不见它们。本脚本就是那笔人工决定的回滚工具。
 *
 * 用法：
 *   node scripts/clean-stranded-board-rewards.mjs                  # 默认 --dry-run，零写入
 *   node scripts/clean-stranded-board-rewards.mjs --apply          # 需要确认 token，见下
 *   BOARD_REWARD_CLEANUP_CONFIRM=CONFIRM-DEVDB-BOARD-REWARD-CLEANUP \
 *     node scripts/clean-stranded-board-rewards.mjs --apply
 *
 * 安全闸门（全部强制）：
 * 1. 默认 dry-run：只打印「将删除的流水/批次 id、余额扣减额」，一条都不写。
 * 2. --apply 必须带环境变量 BOARD_REWARD_CLEANUP_CONFIRM，值与上方 token 逐字相等，
 *    否则直接退出（防止手滑）。token 只写在脚本里、不进任何文档正文引用连接串。
 * 3. 每笔记录先核对台账：若该 (userId,type,period,periodKey) 还有 credited/revoked 行，
 *    说明 Task 10 撤回面看得见这笔钱，本脚本拒绝代劳（该走后台撤回），跳过并标原因。
 * 4. 三路删除一次过：删 pointrecords → 删其 pointlots → 账户 $inc 扣减；
 *    余额只扣「未消费部分」（Σlot.remaining），totalEarned 扣整笔 delta（与发放镜像）。
 *    已被兑换吃掉的部分不许扣（扣了余额会变负/账实不符），打印告警留人工。
 * 5. 收尾不变式：每个受影响用户重算 Σrecord.delta(非 expired) 与 Σlot.remaining，
 *    与 account.balance 对照；不成立就大声报错退出非零（钱账已不可信，停手）。
 *
 * 范围：type='board_reward' 且 refId ∈ {`${ACTIVITY_TYPES`}:year:${--year}`}，默认 --year 2026。
 * 通知（「榜单积分奖励到账」）残留不在此删——只是运营噪音，不动账本，数量在盘点文档里。
 *
 * 环境变量：复用仓内 src/config 的 .env.local / .env（MONGODB_URI），绝不明文打印连接串。
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

// 与 src/config/constants.ts 的 ACTIVITY_TYPES 同集合（脚本走纯 node，不引 .ts；改动需两处同步）
const ACTIVITY_TYPES = [
  'hiking',
  'walking',
  'running',
  'cycling',
  'mountaineering',
  'swimming',
  'skiing',
  'rowing',
];

dotenv.config({ path: new URL('../.env.local', import.meta.url).pathname });
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

const CONFIRM_TOKEN = 'CONFIRM-DEVDB-BOARD-REWARD-CLEANUP'; // 期望值刻意做成难记的精确串，环境变量供给
const args = process.argv.slice(2);
const apply = args.includes('--apply');
if (args.includes('--dry-run') && apply) { console.error('--dry-run 与 --apply 互斥'); process.exit(2); }
for (const a of args) if (!['--apply', '--dry-run'].includes(a) && !a.startsWith('--year=')) {
  console.error(`未知参数：${a}`); process.exit(2);
}
const yearArg = args.find((a) => a.startsWith('--year='));
const yearKey = yearArg ? yearArg.slice('--year='.length) : '2026';
if (!/^\d{4}$/.test(yearKey)) { console.error('--year 必须是 4 位年份'); process.exit(2); }
if (apply && process.env.BOARD_REWARD_CLEANUP_CONFIRM !== CONFIRM_TOKEN) {
  console.error('--apply 需要环境变量 BOARD_REWARD_CLEANUP_CONFIRM 精确匹配脚本内 token（见脚本头注释）。未确认，退出。');
  process.exit(3);
}

const uri = process.env.MONGODB_URI;
if (!uri) { console.error('缺少 MONGODB_URI（.env.local）'); process.exit(1); }
await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
const db = mongoose.connection.db;
const mode = apply ? 'APPLY' : 'DRY-RUN（零写入）';
console.log(`== clean-stranded-board-rewards | ${mode} | refId ∈ {type:year:${yearKey}} ==`);

const refIds = ACTIVITY_TYPES.map((t) => `${t}:year:${yearKey}`);
const records = await db.collection('pointrecords')
  .find({ type: 'board_reward', refId: { $in: refIds } })
  .project({ userId: 1, delta: 1, refId: 1, idemKey: 1, bizDate: 1 })
  .sort({ userId: 1, refId: 1 })
  .toArray();
console.log(`命中 board_reward 流水：${records.length} 条`);

// 台账核对：撤表面（Task 10）能看见的行不归本脚本管
let planned = 0;
let skippedLedger = 0;
const actions = [];
for (const r of records) {
  const [t, period, key] = [r.refId.split(':')[0], 'year', yearKey];
  const ledgerRow = await db.collection('boardsettlements').findOne({ userId: r.userId, type: t, period, periodKey: key });
  if (ledgerRow) {
    skippedLedger += 1;
    console.log(`SKIP rec=${r._id} user=${r.userId} ref=${r.refId}：台账已有 ${ledgerRow.status} 行（走后台撤回，不在此回滚）`);
    continue;
  }
  const lots = await db.collection('pointlots').find({ recordId: r._id }).project({ earned: 1, remaining: 1 }).toArray();
  const unconsumed = lots.reduce((s, l) => s + l.remaining, 0);
  const consumed = lots.reduce((s, l) => s + (l.earned - l.remaining), 0);
  actions.push({ rec: r, lots, unconsumed, consumed });
  planned += 1;
  console.log(`PLAN rec=${r._id} user=${r.userId} ref=${r.refId} delta=${r.delta} bizDate=${r.bizDate}`);
  console.log(`     lots=[${lots.map((l) => `${l._id}(earned=${l.earned},remaining=${l.remaining})`).join(', ') || '无'}]`);
  console.log(`     将：删 1 流水 + ${lots.length} 批次，balance -${unconsumed}，totalEarned -${r.delta}${consumed > 0 ? `（已消费 ${consumed} 分不回滚，告警）` : ''}`);
}

if (!apply) {
  console.log(`DRY-RUN 结束：计划 ${planned} 笔，跳过（有台账）${skippedLedger} 笔，未写任何数据。`);
  await mongoose.disconnect();
  process.exit(0);
}

const now = Date.now();
for (const a of actions) {
  const { rec, lots } = a;
  await db.collection('pointlots').deleteMany({ _id: { $in: lots.map((l) => l._id) } });
  await db.collection('pointrecords').deleteOne({ _id: rec._id });
  await db.collection('pointaccounts').updateOne(
    { userId: rec.userId },
    { $inc: { balance: -a.unconsumed, totalEarned: -rec.delta } },
  );
  console.log(`DONE rec=${rec._id} user=${rec.userId} 扣 balance ${a.unconsumed} / totalEarned ${rec.delta}`);
}

// 收尾不变式：balance == Σrecord.delta == Σlot.remaining（未过期批次口径）
console.log('== 不变式复核 ==');
let bad = 0;
const touchedUsers = [...new Set(actions.map((a) => String(a.rec.userId)))];
for (const u of touchedUsers) {
  const oid = new mongoose.Types.ObjectId(u);
  const acct = await db.collection('pointaccounts').findOne({ userId: oid });
  const sumDelta = await db.collection('pointrecords').aggregate([
    { $match: { userId: oid, expireAt: { $gt: now } } },
    { $group: { _id: null, s: { $sum: '$delta' } } },
  ]).toArray();
  const sumLot = await db.collection('pointlots').aggregate([
    { $match: { userId: oid, expireAt: { $gt: now } } },
    { $group: { _id: null, s: { $sum: '$remaining' } } },
  ]).toArray();
  const bal = acct?.balance ?? 0;
  const d = sumDelta[0]?.s ?? 0;
  const l = sumLot[0]?.s ?? 0;
  const ok = bal === d && bal === l;
  console.log(`user=${u} balance=${bal} Σrecord.delta=${d} Σlot.remaining=${l} ${ok ? 'OK' : 'MISMATCH!'}`);
  if (!ok) bad += 1;
}
const left = await db.collection('pointrecords').countDocuments({ type: 'board_reward', refId: { $in: refIds } });
console.log(`剩余 ${yearKey} 年榜滞留流水：${left}（跳过${skippedLedger}笔需后台处置）`);
if (bad > 0 || (left > 0 && skippedLedger === 0)) {
  console.error('不变式未全部成立或有残留，请人工复核。');
  await mongoose.disconnect();
  process.exit(4);
}
console.log(`APPLY 完成：${planned} 笔回滚，账本不变式全绿。`);
await mongoose.disconnect();
