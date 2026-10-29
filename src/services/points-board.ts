/**
 * 榜单发分专用的可信轨迹聚合（spec §7：发分口径比展示榜多四道防刷判据）。
 * - 四道判据：疑似搭车（vehicleMs>0）、漂移超标（driftScore>DRIFT_SCORE_PB_GATE）、
 *   配速不合理（avgPace<MIN_PLAUSIBLE_PACE_SEC_PER_KM）、未纠偏（corrected:false），
 *   任一命中都不计入发分距离。
 * - vehicleMs/driftScore/corrected 用 $not/$gt（或 $ne）惯用法（与 leaderboard.ts :260、
 *   :279-281 同源）：缺字段的老文档＝可信，判据写成 $lte/$gte-缺省可省形态会把它们全排掉。
 * - avgPace 对「会算配速」的类型是强要求（$gte，缺失/null 不计），与上面相反——没有可信
 *   配速就不发分，这个不对称是 spec 拍板的，test/points-board.test.ts BR-2/BR-2b 分别钉两侧。
 * - 但配速判据必须按类型生效：游泳/骑行的 avgPace 由 utils/pace.ts 设计为恒 null，
 *   若照旧套 $gte 就把这两类永久挡在发分之外（榜面永远空、§4.8「各运动类型的全国榜按
 *   总距离排名，前三名获得积分」变假话）。豁免表用 pace.ts 导出的 NO_PACE_TYPES/hasNoPace，
 *   不在本文件另抄一份，其余三道判据对所有类型一律照旧生效。
 * - 本文件只建发分查询；结算数学与接线是后续任务。**不改 leaderboard() 的展示口径**
 *   （榜面与发分结果可能不一致，由规则页文案说明），也不做省份过滤（发分是全平台口径）。
 */
import type { Types } from 'mongoose';
import { ActivityModel } from '../models/activity.model.js';
import { DRIFT_SCORE_PB_GATE, MIN_PLAUSIBLE_PACE_SEC_PER_KM } from '../config/constants.js';
import { hasNoPace } from '../utils/pace.js';

export interface BoardCandidate {
  userId: string;
  distance: number;
}

/** 与类型无关的三道判据（缺字段＝可信） */
const BASE_TRUSTED_MATCH = {
  status: 'finished',
  vehicleMs: { $not: { $gt: 0 } },
  driftScore: { $not: { $gt: DRIFT_SCORE_PB_GATE } },
  corrected: { $ne: false },
};

/**
 * 该类型的可信判据：配速判据只对会算配速的类型加（见文件头）。
 * 加了它就要接受：跑步/步行等短行（distance < MIN_PACE_DISTANCE_M，pace.ts 里 avgPace 也是
 * null）继续被挡在发分之外——短到跑不出可信配速的轨迹不发分，是有意的。
 */
function trustedMatch(type: string) {
  return hasNoPace(type)
    ? BASE_TRUSTED_MATCH
    : { ...BASE_TRUSTED_MATCH, avgPace: { $gte: MIN_PLAUSIBLE_PACE_SEC_PER_KM } };
}

/** 某类型某窗口 [startMs, endMs) 内「可信总距离」降序的用户榜（发分口径，比展示多四道判据） */
export async function trustedBoardRows(
  type: string,
  startMs: number,
  endMs: number,
): Promise<BoardCandidate[]> {
  const rows = await ActivityModel.aggregate<{ _id: Types.ObjectId; distance: number }>([
    { $match: { ...trustedMatch(type), type, startTime: { $gte: startMs, $lt: endMs } } },
    { $group: { _id: '$userId', distance: { $sum: '$distance' } } },
    { $sort: { distance: -1 } },
  ]);
  return rows.map((r) => ({ userId: String(r._id), distance: r.distance }));
}
