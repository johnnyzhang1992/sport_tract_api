/**
 * CLI 薄壳：driftScore 批量回填（判据与落库在 services/drift-score-backfill.ts 一份实现）。
 * 线上跑管理端接口 POST /admin/activities/backfill-drift-score —— 容器没有 tsx、scripts 不进镜像。
 *
 * 用法：
 *   node --import tsx scripts/backfill-drift-score.ts              # 干跑，只打印分布
 *   node --import tsx scripts/backfill-drift-score.ts --apply      # 落库
 *   node --import tsx scripts/backfill-drift-score.ts --limit=500  # 限量
 */
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { backfillDriftScore } from '../src/services/drift-score-backfill.js';

const flag = (name: string) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || '';
const apply = process.argv.includes('--apply');
const limit = Number(flag('limit')) || 0;

async function main() {
  if (mongoose.connection.readyState !== 1) await mongoose.connect(config.mongodbUri);
  const r = await backfillDriftScore({ apply, limit });
  console.log(`扫描 ${r.scanned} 条${r.apply ? `，落库 ${r.updated} 条` : '（干跑，加 --apply 落库）'}`);
  for (const b of r.buckets) console.log(`  driftScore ${b.bucket}: ${b.count}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
