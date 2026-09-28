import mongoose from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import { normalizeTrackPoints } from '../utils/track-compact.js';
import { detectGapSteps } from '../utils/track-gap.js';

/**
 * 断档虚高影响评估（**只读**，不写库）
 *
 * 为什么单独一份：gapJump 的视觉断线带第三条横向闸门，"沿跑道把弯切了"那类不标；
 * 但那类恰恰是里程虚高的来源 —— 位置被报到前面，那段地面人当时没到过，里程却照记了。
 * 所以折算口径只看前两条判据（detectGapSteps），跟视觉标记（markGapJumps）不是一回事。
 *
 * 折算属于改指标口径：距离↓ → 平均配速变慢、最快公里/个人最佳/榜单都要重算。
 * 动之前得先看到影响面，而线上不跑脚本 —— 故做成管理端只读接口。
 */

export interface GapImpactOptions {
  /** 只评估这些活动（点名核查用）；不给就是全库 finished */
  ids?: string[];
  /** 只评估某个用户 */
  userId?: string;
  /** 扫描上限（0 = 不限）：线上首次评估建议先小范围试 */
  limit?: number;
  /** 明细最多列几条（汇总不受影响） */
  listCap?: number;
}

export interface GapImpactRow {
  id: string;
  type: string;
  points: number;
  /** 净时长（秒）：折算不动它，所以配速只会被距离拖着走 */
  duration: number;
  distance: number;
  gaps: number;
  /** 断档步实测位移合计（米） */
  chordM: number;
  /** 这些时间按该条自己的中位步速能走出的距离（米） */
  plausibleM: number;
  /** 虚高（米）= chordM - plausibleM */
  overM: number;
  overPct: number;
  /**
   * 虚高吃掉整条里程一半以上 → 这条不是"个别步漂了"，折算前提不成立
   * （点极少的烂轨迹里，中位步速本身就是从几步漂移里取出来的，拿它去折算是拿鬼数换实测数）。
   * 这类只点出来不折算：distanceAfter / avgPaceAfter 给 null，绝不夹一个数出来。
   */
  unreliable: boolean;
  distanceAfter: number | null;
  avgPace: number | null;
  avgPaceAfter: number | null;
}

export interface GapImpactReport {
  /** 连的是哪个库：评估报告也要看清自己算的是哪份数据 */
  db: string;
  scanned: number;
  /** 含断档步的条数（含不可折算的） */
  withGaps: number;
  gaps: number;
  chordM: number;
  plausibleM: number;
  /** 可折算部分的虚高合计（米） */
  overM: number;
  /** 不可折算的条数与它们的虚高合计（单独报出来，不藏进 overM） */
  unreliableCount: number;
  unreliableOverM: number;
  distanceNow: number;
  distanceAfter: number;
  /** 只看可折算行的最大占比 */
  maxOverPct: number;
  overPctBuckets: Array<{ label: string; count: number }>;
  rows: GapImpactRow[];
  /** 明细被 listCap 截断前的总条数 */
  rowsCount: number;
}

/** 虚高占整条里程的比例超过该值 → 判为整条不可信，不做折算 */
export const UNRELIABLE_OVER_PCT = 50;

const BUCKET_LABELS = ['≤1%', '1–3%', '3–5%', '5–10%', '>10%'] as const;

function bucketOf(pct: number): string {
  if (pct <= 1) return BUCKET_LABELS[0];
  if (pct <= 3) return BUCKET_LABELS[1];
  if (pct <= 5) return BUCKET_LABELS[2];
  if (pct <= 10) return BUCKET_LABELS[3];
  return BUCKET_LABELS[4];
}

const paceOf = (durationSec: number, distanceM: number): number | null =>
  durationSec > 0 && distanceM > 0 ? Math.round(durationSec / (distanceM / 1000)) : null;

export async function gapImpact(opts: GapImpactOptions = {}): Promise<GapImpactReport> {
  const limit = Math.max(0, Number(opts.limit) || 0);
  const listCap = Math.max(1, Number(opts.listCap) || 50);

  const filter: Record<string, unknown> = { status: 'finished' };
  if (opts.userId) filter.userId = opts.userId;
  if (opts.ids && opts.ids.length) filter._id = { $in: opts.ids.map((id) => new mongoose.Types.ObjectId(id)) };

  const report: GapImpactReport = {
    db: mongoose.connection.name,
    scanned: 0,
    withGaps: 0,
    gaps: 0,
    chordM: 0,
    plausibleM: 0,
    overM: 0,
    unreliableCount: 0,
    unreliableOverM: 0,
    distanceNow: 0,
    distanceAfter: 0,
    maxOverPct: 0,
    overPctBuckets: BUCKET_LABELS.map((label) => ({ label, count: 0 })),
    rows: [],
    rowsCount: 0,
  };
  const all: GapImpactRow[] = [];

  // 逐条走 cursor：全库 finished 带 trackPoints 一次性 lean 出来会吃掉几百 MB，容器扛不住
  const cursor = ActivityModel.find(filter)
    .select('_id type startTime duration distance avgPace trackPoints')
    .sort({ startTime: -1 })
    .limit(limit)
    .cursor({ batchSize: 50 });

  for await (const doc of cursor) {
    report.scanned += 1;
    const pts = normalizeTrackPoints(doc.trackPoints as Array<Record<string, unknown>> | undefined, doc.startTime);
    const distance = Math.round(doc.distance ?? 0);
    report.distanceNow += distance;
    if (pts.length < 3 || distance <= 0) {
      report.distanceAfter += distance;
      continue;
    }
    const det = detectGapSteps(pts);
    if (!det.steps.length) {
      report.distanceAfter += distance;
      continue;
    }
    const overM = Math.round(det.overM);
    const duration = Math.round(doc.duration ?? 0);
    const overPct = +((overM / distance) * 100).toFixed(1);
    const unreliable = overPct >= UNRELIABLE_OVER_PCT;
    report.withGaps += 1;
    report.gaps += det.steps.length;
    report.chordM += Math.round(det.chordM);
    report.plausibleM += Math.round(det.plausibleM);
    if (unreliable) {
      // 只点出来，不动里程、不进分桶、不折算
      report.unreliableCount += 1;
      report.unreliableOverM += overM;
      report.distanceAfter += distance;
    } else {
      report.overM += overM;
      report.maxOverPct = Math.max(report.maxOverPct, overPct);
      report.overPctBuckets.find((b) => b.label === bucketOf(overPct))!.count += 1;
      report.distanceAfter += Math.max(1, distance - overM);
    }
    const distanceAfter = unreliable ? null : Math.max(1, distance - overM);
    all.push({
      id: String(doc._id),
      type: doc.type,
      points: pts.length,
      duration,
      distance,
      gaps: det.steps.length,
      chordM: Math.round(det.chordM),
      plausibleM: Math.round(det.plausibleM),
      overM,
      overPct,
      unreliable,
      distanceAfter,
      avgPace: doc.avgPace ?? paceOf(duration, distance),
      avgPaceAfter: distanceAfter == null ? null : paceOf(duration, distanceAfter),
    });
  }

  all.sort((a, b) => b.overPct - a.overPct);
  report.rowsCount = all.length;
  report.rows = all.slice(0, listCap);
  return report;
}
