import mongoose from 'mongoose';
import { Types } from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import { calcDriftScore } from '../utils/drift-score.js';

/**
 * driftScore 批量回填（设计 docs/19 §4.3）——判据与落库口径只有这一份实现，
 * 两个调用方共用：
 * - 管理端接口 POST /admin/activities/backfill-drift-score（线上唯一入口：
 *   容器镜像 npm ci --omit=dev 没有 tsx，scripts/ 不进镜像）
 * - scripts/backfill-drift-score.ts（本地/dev 库 CLI 薄壳，只负责连库与排版）
 */

export interface DriftScoreBackfillOptions {
  /** 默认 false 干跑：只算报告不落库 */
  apply?: boolean;
  /** 限量（0 = 不限） */
  limit?: number;
  /** 可选：只回填该用户（测试封闭用；运维上也可单用户重跑） */
  userId?: string;
  /** 重算已打分的轨迹（公式调整后必须用它，否则只扫 driftScore=null 的漏掉了存量） */
  rescore?: boolean;
}

export interface DriftScoreBackfillReport {
  apply: boolean;
  scanned: number;
  updated: number;
  /** 分数分布（校准/审计用） */
  buckets: Array<{ bucket: string; count: number }>;
}

const bucketOf = (score: number): string =>
  score >= 70 ? '70+' : score >= 40 ? '40-69' : score >= 30 ? '30-39(门禁)' : score >= 15 ? '15-29' : '0-14';

export async function backfillDriftScore(opts: DriftScoreBackfillOptions = {}): Promise<DriftScoreBackfillReport> {
  const apply = opts.apply === true;
  const limit = Number(opts.limit ?? 0);
  const q: Record<string, unknown> = opts.rescore
    ? { status: 'finished' } // 公式改了要重算存量（否则已打分的永远不会更新）
    : { status: 'finished', driftScore: null };
  if (opts.userId) {
    // 非法 ObjectId 直接空结果（不抛）：管理端传错 id 不该 500
    if (!Types.ObjectId.isValid(opts.userId)) {
      return { apply, scanned: 0, updated: 0, buckets: [] };
    }
    q.userId = new Types.ObjectId(opts.userId);
  }
  const query = ActivityModel.find(q).select('_id type distance duration trackPoints');
  if (limit > 0) query.limit(limit);
  const cursor = query.batchSize(200).cursor();

  let scanned = 0;
  let updated = 0;
  const buckets = new Map<string, number>();
  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    scanned += 1;
    const score = calcDriftScore(
      (doc.trackPoints ?? []) as Array<Record<string, unknown>>,
      doc.type,
      { distance: doc.distance ?? undefined, durationSec: doc.duration ?? undefined },
    );
    const bucket = bucketOf(score);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    if (apply) {
      await ActivityModel.updateOne({ _id: doc._id }, { $set: { driftScore: score } });
      updated += 1;
    }
  }

  return {
    apply,
    scanned,
    updated,
    buckets: [...buckets.entries()]
      .map(([bucket, count]) => ({ bucket, count }))
      .sort((a, b) => a.bucket.localeCompare(b.bucket)),
  };
}

/** mongoose 连接态守卫：接口场景由插件接管，CLI 场景脚本自行 connect */
export async function ensureMongodbConnection(uri: string): Promise<void> {
  if (mongoose.connection.readyState !== 1) await mongoose.connect(uri);
}
