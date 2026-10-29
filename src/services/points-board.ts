/**
 * 榜单发分专用的可信轨迹聚合（spec §7：发分口径比展示榜多四道防刷判据）。
 * - 四道判据：疑似搭车（vehicleMs>0）、漂移超标（driftScore>DRIFT_SCORE_PB_GATE）、
 *   配速不合理（avgPace<MIN_PLAUSIBLE_PACE_SEC_PER_KM）、未纠偏（corrected:false），
 *   任一命中都不计入发分距离。
 * - vehicleMs/driftScore/corrected 用 $not/$gt（或 $ne）惯用法（与 leaderboard.ts :260、
 *   :279-281 同源）：缺字段的老文档＝可信，判据写成 $lte/$gte-缺省可省形态会把它们全排掉。
 * - avgPace 是强要求（$gte，缺失/null 不计），与上面相反——没有可信配速就不发分，
 *   这个不对称是 spec 拍板的，test/points-board.test.ts BR-2/BR-2b 分别钉两侧。
 * - 本文件只建发分查询；结算数学与接线是后续任务。**不改 leaderboard() 的展示口径**
 *   （榜面与发分结果可能不一致，由规则页文案说明），也不做省份过滤（发分是全平台口径）。
 */
import type { Types } from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import { DRIFT_SCORE_PB_GATE, MIN_PLAUSIBLE_PACE_SEC_PER_KM } from '../config/constants.js';

export interface BoardCandidate {
  userId: string;
  distance: number;
}

const TRUSTED_MATCH = {
  status: 'finished',
  vehicleMs: { $not: { $gt: 0 } },
  driftScore: { $not: { $gt: DRIFT_SCORE_PB_GATE } },
  avgPace: { $gte: MIN_PLAUSIBLE_PACE_SEC_PER_KM },
  corrected: { $ne: false },
};

/** 某类型某窗口 [startMs, endMs) 内「可信总距离」降序的用户榜（发分口径，比展示多四道判据） */
export async function trustedBoardRows(
  type: string,
  startMs: number,
  endMs: number,
): Promise<BoardCandidate[]> {
  const rows = await ActivityModel.aggregate<{ _id: Types.ObjectId; distance: number }>([
    { $match: { ...TRUSTED_MATCH, type, startTime: { $gte: startMs, $lt: endMs } } },
    { $group: { _id: '$userId', distance: { $sum: '$distance' } } },
    { $sort: { distance: -1 } },
  ]);
  return rows.map((r) => ({ userId: String(r._id), distance: r.distance }));
}
