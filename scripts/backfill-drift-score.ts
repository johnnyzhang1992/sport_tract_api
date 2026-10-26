/**
 * 一次性回填：给 finished 轨迹补 driftScore（设计 docs/19 §4.3）。
 *
 * bestRecords 的惰性回填只覆盖「进过个人最佳页的用户」，全局榜（leaderboard）需要
 * 一次性把所有老轨迹算齐，否则老文档长期按「缺字段 = 可信」参与榜单。
 *
 * 线上跑优先加管理端接口（运行镜像没有 tsx），本地/dev 库直接跑本脚本：
 *   node --import tsx scripts/backfill-drift-score.ts              # 干跑，只打印分布
 *   node --import tsx scripts/backfill-drift-score.ts --apply      # 落库
 *   node --import tsx scripts/backfill-drift-score.ts --limit=500  # 限量
 */
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { calcDriftScore } from '../src/utils/drift-score.js';
import { ActivityModel } from '../src/models/activity.model.js';

const flag = (name: string) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || '';
const apply = process.argv.includes('--apply');
const limit = Number(flag('limit')) || 0;

async function main() {
  await mongoose.connect(config.mongodbUri);
  const query = { status: 'finished', driftScore: null } as Record<string, unknown>;
  const q = limit > 0 ? { ...query } : query;
  const cursor = ActivityModel.find(q)
    .select('_id type trackPoints')
    .limit(limit > 0 ? limit : 0)
    .batchSize(200)
    .cursor();

  let scanned = 0;
  let updated = 0;
  const buckets = new Map<string, number>();
  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    scanned += 1;
    const score = calcDriftScore((doc.trackPoints ?? []) as Array<Record<string, unknown>>, doc.type);
    const bucket = score >= 70 ? '70+' : score >= 40 ? '40-69' : score >= 30 ? '30-39(门禁)' : score >= 15 ? '15-29' : '0-14';
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    if (apply) {
      await ActivityModel.updateOne({ _id: doc._id }, { $set: { driftScore: score } });
      updated += 1;
      if (updated % 500 === 0) console.log(`已落库 ${updated}/${scanned}...`);
    }
  }

  console.log(`扫描 ${scanned} 条${apply ? `，落库 ${updated} 条` : '（干跑，加 --apply 落库）'}`);
  for (const [k, v] of [...buckets.entries()].sort()) console.log(`  driftScore ${k}: ${v}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
